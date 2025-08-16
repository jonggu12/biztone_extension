/**
 * BizTone Chrome Extension - Content Script
 * Handles hybrid guard system, UI bubbles, and text replacement
 */

(() => {
  // Prevent duplicate injection
  if (window.__BIZTONE_CS_LOADED__) {
    console.warn(`❌ BizTone ContentScript already loaded in frame: ${window.self === window.top ? 'TOP' : 'IFRAME'} - ${window.location.href}`);
    return;
  }
  window.__BIZTONE_CS_LOADED__ = true;
  
  const loadFrameInfo = window.self === window.top ? 'TOP-FRAME' : `IFRAME(${window.location.href})`;
  console.log(`✅ BizTone ContentScript loading in ${loadFrameInfo}`);

  // ==================== CONSTANTS & CONFIGURATION ====================

  const CONFIG = {
    // Prefilter thresholds - Balanced for warn mode
    PREFILTER: {
      PASS_MAX: 1,     // Score ≤ 1: allow immediate send
      CONVERT_MIN: 4   // Score ≥ 4: strong profanity/convert, 2-3: medium risk/prompt
    },
    
    // Cache settings
    CACHE: {
      TTL_MS: 90_000, // 90 seconds
    },
    
    // Guard settings
    GUARD: {
      ENABLED: true,               // Master guard enable/disable
      PROMPT_ENABLED: true,
      AUTO_SEND_CONVERTED: false,
      FAIL_OPEN_ON_CONVERT_ERROR: false, // Security: don't auto-send on conversion failure
      FAIL_OPEN_ON_DECISION_ERROR: true  // UX: allow send if AI decision fails
    },
    
    // UI settings
    UI: {
      TOAST_DURATION: 1800,
      BUBBLE_OFFSET: 8,
      MIN_POSITION: 10
    },
    
    // Performance settings
    DEBOUNCE_MS: 350 // Prevent duplicate processing
  };

  const MESSAGE_TYPES = {
    BIZTONE_PING: "BIZTONE_PING",
    BIZTONE_LOADING: "BIZTONE_LOADING", 
    BIZTONE_RESULT: "BIZTONE_RESULT",
    BIZTONE_ERROR: "BIZTONE_ERROR",
    BIZTONE_REPLACE_WITH: "BIZTONE_REPLACE_WITH",
    BIZTONE_CONVERT_TEXT: "BIZTONE_CONVERT_TEXT",
    BIZTONE_GUARD_DECIDE: "BIZTONE_GUARD_DECIDE",
    BIZTONE_GET_GUARD_MODE: "BIZTONE_GET_GUARD_MODE",
    BIZTONE_GUARD_WARNING: "BIZTONE_GUARD_WARNING",
    BIZTONE_GET_PROFANITY_DATA: "BIZTONE_GET_PROFANITY_DATA",
    OPEN_OPTIONS: "OPEN_OPTIONS"
  };

  // Risk assessment vocabulary (will be loaded from background)
  let RISK_VOCABULARY = {
    PROFANITY: [],
    AGGRESSIVE: ["당장","빨리","왜이러","대체","책임져","뭐하","최악","말이 됩니까","어이가","화나","짜증","열받","죽을","해명","지금 당장"],
    RUDE: ["너네","니들","야","정신차려","하라는"]
  };

  // Profanity categories loaded from background
  let PROFANITY_CATEGORIES = {
    strong: [],
    weak: [],
    adult: [],
    slur: []
  };

  // ==================== GLOBAL STATE ====================

  let bubbleElement = null;
  let lastSelectionRange = null;
  let lastInputSelection = null;
  let lastActiveElement = null;

  // Guard processing state
  let __BIZTONE_PENDING = false;
  let __BIZTONE_LAST_TS = 0;
  let __BIZTONE_GUARD_MODE = "warn"; // Default mode: warn (recommended)
  let __BIZTONE_GUARD_MODE_CACHED = false; // Cache flag for guard mode
  let __BIZTONE_WARNING_SHOWN = false;
  let __BIZTONE_FORM_CLEANUP = null; // Store form prevention cleanup function
  
  // Message processing state to prevent duplicates
  let __BIZTONE_LAST_MESSAGE_TS = 0;
  let __BIZTONE_LAST_MESSAGE_TYPE = null;

  // Real-time detection state
  let __BIZTONE_REALTIME_BADGES = new Map(); // Track active warning badges
  let __BIZTONE_REALTIME_DEBOUNCE = null;
  let __BIZTONE_MONITORED_INPUTS = new Set(); // Track inputs we're monitoring
  let __BIZTONE_LAST_DETECTION_TIME = 0; // For adaptive timing
  let __BIZTONE_BADGE_TIMERS = new Map(); // Track badge removal timers

  // Initialize cache and regex - Use element-specific cache to prevent cross-element issues
  const guardCache = new Map(); // Global cache for compatibility
  const elementSpecificCache = new WeakMap(); // Element-specific cache
  const profanityRegex = new RegExp(
    RISK_VOCABULARY.PROFANITY.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), 
    "i"
  );

  // Local whitelist for fallback (sync with background)
  const LOCAL_WHITELIST = ["시발점", "始發", "시발역", "출발점", "미친 듯이", "미친 척", "개발자", "개같이", "열받아"];

  // ==================== DATA LOADING ====================

  /**
   * Loads profanity categories data from background script
   */
  function loadProfanityData() {
    return new Promise((resolve) => {
      safeSendMessage({
        type: MESSAGE_TYPES.BIZTONE_GET_PROFANITY_DATA
      }, (response) => {
        if (response && response.ok && response.result) {
          const data = response.result;
          
          // Update profanity categories
          PROFANITY_CATEGORIES.strong = data.strong || [];
          PROFANITY_CATEGORIES.weak = data.weak || [];
          PROFANITY_CATEGORIES.adult = data.adult || [];
          PROFANITY_CATEGORIES.slur = data.slur || [];
          
          // Update RISK_VOCABULARY.PROFANITY with all categories
          RISK_VOCABULARY.PROFANITY = [
            ...PROFANITY_CATEGORIES.strong,
            ...PROFANITY_CATEGORIES.weak,
            ...PROFANITY_CATEGORIES.adult,
            ...PROFANITY_CATEGORIES.slur
          ];
          
          console.debug("[BizTone] Profanity data loaded:", {
            strong: PROFANITY_CATEGORIES.strong.length,
            weak: PROFANITY_CATEGORIES.weak.length,
            adult: PROFANITY_CATEGORIES.adult.length,
            slur: PROFANITY_CATEGORIES.slur.length,
            total: RISK_VOCABULARY.PROFANITY.length
          });
          
          resolve(true);
        } else {
          console.warn("[BizTone] Failed to load profanity data from background");
          resolve(false);
        }
      });
    });
  }

  // ==================== UTILITY FUNCTIONS ====================

  /**
   * Checks if the extension context is still valid
   * @returns {boolean} True if extension context is valid
   */
  function isExtensionContextValid() {
    try {
      // Check all essential runtime APIs
      if (!chrome || !chrome.runtime) return false;
      
      // Check runtime.id (fails when extension is invalidated)
      if (!chrome.runtime.id) return false;
      
      // Test runtime.getURL with a safe path
      try {
        chrome.runtime.getURL('manifest.json');
      } catch {
        return false;
      }
      
      // Test sendMessage availability
      if (typeof chrome.runtime.sendMessage !== 'function') return false;
      
      return true;
    } catch (error) {
      console.debug("[BizTone] Extension context check failed:", error);
      return false;
    }
  }

  /**
   * Safely sends a message to the background script with error handling
   * @param {Object} message - Message to send
   * @param {Function} callback - Callback function
   * @returns {boolean} True if message was sent successfully
   */
  function safeSendMessage(message, callback) {
    if (!isExtensionContextValid()) {
      console.warn("[BizTone] Extension context invalidated - message not sent:", message.type);
      if (callback) callback(null);
      return false;
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[BizTone] Message sending failed:", chrome.runtime.lastError.message);
          if (callback) callback(null);
        } else {
          if (callback) callback(response);
        }
      });
      return true;
    } catch (error) {
      console.warn("[BizTone] Exception during message sending:", error);
      if (callback) callback(null);
      return false;
    }
  }

  /**
   * Normalizes text by trimming and collapsing whitespace
   * @param {string} text - Text to normalize
   * @returns {string} Normalized text
   */
  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  /**
   * Checks if event is Enter key (including NumpadEnter)
   * @param {KeyboardEvent} event - Keyboard event
   * @returns {boolean} True if it's an Enter key
   */
  function isEnterKey(event) {
    return event.key === "Enter" || event.code === "NumpadEnter";
  }

  /**
   * Debounced guard to prevent duplicate processing
   * @returns {boolean} True if should skip processing (duplicate)
   */
  function shouldSkipDuplicate() {
    const now = Date.now();
    if (__BIZTONE_PENDING) return true; // Already processing
    if (now - __BIZTONE_LAST_TS < CONFIG.DEBOUNCE_MS) return true; // Debounce
    
    __BIZTONE_PENDING = true;
    __BIZTONE_LAST_TS = now;
    return false;
  }

  /**
   * Clear pending guard state
   */
  function clearPendingGuard() {
    __BIZTONE_PENDING = false;
  }

  /**
   * Get current guard mode setting from background (cached)
   */
  async function getGuardMode() {
    // Return cached value if available
    if (__BIZTONE_GUARD_MODE_CACHED) {
      return __BIZTONE_GUARD_MODE;
    }
    
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.BIZTONE_GET_GUARD_MODE
      });
      
      if (response?.ok && response.result?.guardMode) {
        __BIZTONE_GUARD_MODE = response.result.guardMode;
        __BIZTONE_GUARD_MODE_CACHED = true;
        console.debug(`[BizTone] Guard mode loaded and cached: ${__BIZTONE_GUARD_MODE}`);
      }
    } catch (error) {
      console.warn('[BizTone] Failed to get guard mode, using default:', error);
      __BIZTONE_GUARD_MODE = "warn"; // fallback to default
      __BIZTONE_GUARD_MODE_CACHED = true; // Cache the default too
    }
    
    return __BIZTONE_GUARD_MODE;
  }

  /**
   * Dispatches synthetic Enter key events with enhanced submit support
   */
  function dispatchEnterKey() {
    const target = document.activeElement || document.querySelector("[contenteditable],textarea,input[type='text']");
    if (!target) return;
    
    // 1) Dispatch key events
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    
    // 2) Form submit fallback
    const form = target.form || target.closest?.("form");
    if (form) {
      try {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else if (typeof form.submit === "function") {
          form.submit();
        }
      } catch (error) {
        console.debug("[BizTone] Form submit fallback failed:", error);
      }
    }
  }

  /**
   * Dispatches input-like events to notify editors of changes
   * @param {Element} element - Element that was modified
   */
  function dispatchInputEvents(element) {
    try {
      element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    } catch (error) {
      // Silently ignore dispatch errors
    }
  }

  // ==================== DOMAIN RULES SUPPORT ====================
  
  /**
   * Get current domain from window location
   */
  function getCurrentDomain() {
    try {
      return window.location.hostname.toLowerCase();
    } catch (error) {
      console.warn('[BizTone] Failed to get current domain:', error);
      return null;
    }
  }

  /**
   * Checks if the current element is a search input
   */
  function isSearchElement(element) {
    if (!element) return false;
    
    // Check input type
    if (element.tagName === 'INPUT' && element.type === 'search') return true;
    
    // Check common search input patterns
    const searchPatterns = [
      /search/i,
      /query/i,
      /찾기/i,
      /검색/i
    ];
    
    const name = element.name || '';
    const id = element.id || '';
    const className = element.className || '';
    const placeholder = element.placeholder || '';
    
    return searchPatterns.some(pattern => 
      pattern.test(name) || 
      pattern.test(id) || 
      pattern.test(className) || 
      pattern.test(placeholder)
    );
  }

  /**
   * Prevents form submission for search elements
   */
  function preventSearchFormSubmission(element) {
    if (!element) return null;
    
    const form = element.form || element.closest('form');
    if (!form) return null;
    
    // Add comprehensive prevention
    const preventSubmit = (e) => {
      console.log('🚫 [BizTone] Preventing search form submission during processing');
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      return false;
    };

    const preventKeydown = (e) => {
      if (e.key === 'Enter' && e.target === element) {
        console.log('🚫 [BizTone] Preventing Enter key in search during processing');
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        return false;
      }
    };
    
    // Add multiple event listeners for comprehensive blocking
    form.addEventListener('submit', preventSubmit, true);
    element.addEventListener('keydown', preventKeydown, true);
    element.addEventListener('keypress', preventKeydown, true);
    
    // Return cleanup function
    return () => {
      form.removeEventListener('submit', preventSubmit, true);
      element.removeEventListener('keydown', preventKeydown, true);
      element.removeEventListener('keypress', preventKeydown, true);
    };
  }
  
  /**
   * Check if guard should be disabled for current domain
   */
  // Domain status cache to avoid repeated calls
  let domainStatusCache = new Map();
  let domainStatusCacheTime = 0;
  const DOMAIN_CACHE_TTL = 30000; // 30 seconds

  async function shouldDisableGuardForDomain() {
    const domain = getCurrentDomain();
    if (!domain) return false;
    
    // Check cache first
    const now = Date.now();
    if (domainStatusCacheTime + DOMAIN_CACHE_TTL > now && domainStatusCache.has(domain)) {
      return domainStatusCache.get(domain);
    }
    
    // Check if extension context is valid before making API call
    if (!isExtensionContextValid()) {
      console.debug('[BizTone] Extension context invalid, defaulting to enabled');
      return false;
    }
    
    try {
      const response = await new Promise((resolve, reject) => {
        if (!chrome.runtime?.sendMessage) {
          reject(new Error('Runtime not available'));
          return;
        }
        
        chrome.runtime.sendMessage({
          type: 'BIZTONE_GET_DOMAIN_STATUS',
          domain: domain
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      
      if (response && response.ok && response.result) {
        const status = response.result;
        let isDisabled = false;
        
        // Check if domain is disabled
        if (!status.enabled) {
          console.log(`[BizTone] 🔇 Domain ${domain} is disabled`);
          isDisabled = true;
        }
        
        // Check if domain is paused
        if (status.paused) {
          console.log(`[BizTone] ⏸️ Domain ${domain} is paused (${status.pauseRemaining} min remaining)`);
          isDisabled = true;
        }
        
        if (!isDisabled) {
          console.debug(`[BizTone] ✅ Domain ${domain} is enabled`);
        }
        
        // Cache the result
        domainStatusCache.set(domain, isDisabled);
        domainStatusCacheTime = now;
        
        return isDisabled;
      } else {
        console.warn('[BizTone] Failed to get domain status, defaulting to enabled');
        return false; // Default to enabled on error
      }
    } catch (error) {
      console.warn('[BizTone] Error checking domain rules:', error);
      // Cache the failure as "enabled" for a short time
      domainStatusCache.set(domain, false);
      domainStatusCacheTime = now;
      return false; // Default to enabled on error
    }
  }

  // ==================== RISK ASSESSMENT SYSTEM ====================

  // ==================== LEGACY RISK ASSESSMENT (KEPT FOR REFERENCE) ====================
  
  /**
   * Enhanced basic risk assessment with detailed risk factors
   * Used for synchronous prefiltering to prevent race conditions
   */
  function calculateBasicRiskScore(text) {
    // Check local whitelist first
    for (const whitelistItem of LOCAL_WHITELIST) {
      if (text.includes(whitelistItem)) {
        console.debug("[BizTone] Text matches local whitelist:", whitelistItem);
        return {
          score: 0,
          matches: [],
          contextual: { score: 0, factors: [] },
          whitelisted: true,
          isAdvanced: false,
          riskFactors: {}
        };
      }
    }

    let score = 0;
    const riskFactors = {};

    // 1) Profanity/offensive language - Optimized category-based weights
    let profanityScore = 0;
    let profanityMatches = [];
    
    // Performance optimization: Check categories in order of severity and stop early if high score
    const categoryChecks = [
      { words: PROFANITY_CATEGORIES.strong, weight: 5, category: 'strong' },
      { words: PROFANITY_CATEGORIES.adult, weight: 4, category: 'adult' },
      { words: PROFANITY_CATEGORIES.slur, weight: 4, category: 'slur' },
      { words: PROFANITY_CATEGORIES.weak, weight: 2, category: 'weak' }
    ];
    
    for (const check of categoryChecks) {
      for (const word of check.words) {
        if (text.includes(word)) {
          profanityScore += check.weight;
          profanityMatches.push({ word, category: check.category });
          
          // Early exit for performance if we already have high risk
          if (profanityScore >= 6) break;
        }
      }
      if (profanityScore >= 6) break; // Exit category loop early
    }
    
    if (profanityScore > 0) {
      score += Math.min(6, profanityScore); // Cap at 6 points
      riskFactors.profanity = true;
      riskFactors.profanityMatches = profanityMatches;
      console.debug("[BizTone] Profanity detected:", profanityMatches, "Score:", profanityScore);
    }

    // 2) Aggressive/rude vocabulary
    let aggressiveHits = 0;
    for (const word of RISK_VOCABULARY.AGGRESSIVE) {
      if (text.includes(word)) aggressiveHits++;
    }
    if (aggressiveHits > 0) {
      score += Math.min(2, aggressiveHits);
      riskFactors.aggressive = true;
    }

    // 3) Rude vocabulary
    let rudeHits = 0;
    for (const word of RISK_VOCABULARY.RUDE) {
      if (text.includes(word)) rudeHits++;
    }
    if (rudeHits > 0) {
      score += Math.min(1, rudeHits);
      riskFactors.rude = true;
    }

    // 4) Excessive punctuation
    const exclamationCount = (text.match(/!+/g) || []).length;
    const questionCount = (text.match(/\?+/g) || []).length;
    if (exclamationCount >= 2 || questionCount >= 2 || text.includes("?!") || text.includes("!?")) {
      score += 1;
      riskFactors.punctuation = true;
    }

    // 5) Excessive uppercase (English)
    const letters = (text.match(/[A-Za-z]/g) || []);
    const uppercase = (text.match(/[A-Z]/g) || []);
    if ((letters.length >= 6 && uppercase.length / letters.length >= 0.5) || /\b[A-Z]{4,}\b/.test(text)) {
      score += 1;
      riskFactors.uppercase = true;
    }

    // 6) Imperative endings (Korean)
    if (/[가-힣]{2,}해라\b|[가-힣]{2,}하라\b/.test(text)) {
      score += 1;
      riskFactors.imperative = true;
    }

    // 7) Urgency words
    const urgencyWords = ["당장", "빨리", "지금", "ASAP", "즉시"];
    if (urgencyWords.some(word => text.includes(word))) {
      score += 0.5;
      riskFactors.urgency = true;
    }

    return {
      score: Math.round(score * 10) / 10, // Round to 1 decimal
      matches: [],
      contextual: { score: 0, factors: [] },
      whitelisted: false,
      isAdvanced: false,
      riskFactors
    };
  }

  // ==================== CACHE MANAGEMENT ====================

  /**
   * Retrieves cached result for text from element-specific cache
   * @param {string} text - Text to look up
   * @param {HTMLElement} element - Input element (optional)
   * @returns {Object|null} Cached result or null
   */
  function getCachedResult(text, element = null) {
    const key = normalizeText(text);
    
    // Try element-specific cache first if element provided
    if (element && elementSpecificCache.has(element)) {
      const elementCache = elementSpecificCache.get(element);
      const item = elementCache.get(key);
      
      if (item) {
        if (Date.now() - item.timestamp > CONFIG.CACHE.TTL_MS) {
          elementCache.delete(key);
          return null;
        }
        console.debug("[BizTone] Using element-specific cache for:", key);
        return item;
      }
    }
    
    // Fallback to global cache
    const item = guardCache.get(key);
    if (!item) return null;
    
    if (Date.now() - item.timestamp > CONFIG.CACHE.TTL_MS) {
      guardCache.delete(key);
      return null;
    }
    
    return item;
  }

  /**
   * Stores result in element-specific cache
   * @param {string} text - Text key
   * @param {Object} result - Result to cache
   * @param {HTMLElement} element - Input element (optional)
   */
  function setCachedResult(text, result, element = null) {
    const key = normalizeText(text);
    const cacheItem = {
      timestamp: Date.now(),
      ...result
    };
    
    // Store in element-specific cache if element provided
    if (element) {
      if (!elementSpecificCache.has(element)) {
        elementSpecificCache.set(element, new Map());
      }
      const elementCache = elementSpecificCache.get(element);
      elementCache.set(key, cacheItem);
      console.debug("[BizTone] Cached in element-specific cache:", key, result);
    }
    
    // Also store in global cache for compatibility
    guardCache.set(key, cacheItem);
  }

  /**
   * Clears cache for specific element
   * @param {HTMLElement} element - Input element
   */
  function clearElementCache(element) {
    if (element && elementSpecificCache.has(element)) {
      elementSpecificCache.delete(element);
      console.debug("[BizTone] Cleared element-specific cache");
    }
  }

  // ==================== TEXT EXTRACTION & MANIPULATION ====================

  /**
   * Extracts current text from editing context
   * @returns {Object} Text info with content, mode, and element
   */
  function getCurrentTextContext() {
    const activeElement = document.activeElement;
    console.log(`🎯 [BizTone] Checking active element:`, {
      tagName: activeElement?.tagName,
      type: activeElement?.type,
      role: activeElement?.getAttribute('role'),
      contentEditable: activeElement?.contentEditable,
      className: activeElement?.className,
      value: activeElement?.value,
      textContent: activeElement?.textContent?.slice(0, 50)
    });
    
    // Handle input/textarea elements
    if (activeElement && 
        (activeElement.tagName === "TEXTAREA" || 
         (activeElement.tagName === "INPUT" && (activeElement.type === "text" || activeElement.type === "search")))) {
      
      const { selectionStart, selectionEnd } = activeElement;
      const hasSelection = typeof selectionStart === "number" && 
                          typeof selectionEnd === "number" && 
                          selectionStart !== selectionEnd;
      
      if (hasSelection) {
        return { 
          text: activeElement.value.slice(selectionStart, selectionEnd), 
          mode: "selection", 
          element: activeElement 
        };
      }
      
      return { 
        text: activeElement.value, 
        mode: "full", 
        element: activeElement 
      };
    }

    // Handle div with role="textbox" (common in modern web apps)
    if (activeElement && activeElement.getAttribute('role') === 'textbox') {
      return { 
        text: activeElement.innerText || activeElement.textContent || "", 
        mode: "full", 
        element: activeElement 
      };
    }

    // Handle contentEditable elements
    if (activeElement && activeElement.contentEditable === 'true') {
      const selection = window.getSelection && window.getSelection();
      const hasSelection = selection && selection.rangeCount > 0 && String(selection).length > 0;
      
      if (hasSelection) {
        return { 
          text: String(selection), 
          mode: "selection", 
          element: activeElement 
        };
      }
      
      return { 
        text: activeElement.innerText || activeElement.textContent || "", 
        mode: "full", 
        element: activeElement 
      };
    }

    // Global selection fallback
    const selection = window.getSelection && window.getSelection();
    const hasSelection = selection && selection.rangeCount > 0 && String(selection).length > 0;
    
    if (hasSelection) {
      return { 
        text: String(selection), 
        mode: "selection", 
        element: null 
      };
    }

    // Fallback to any contentEditable in document
    const editableHost = document.querySelector("[contenteditable='true'], [role='textbox']");
    if (editableHost) {
      return { 
        text: editableHost.innerText || editableHost.textContent || "", 
        mode: "full", 
        element: editableHost 
      };
    }

    return { text: "", mode: "none", element: null };
  }

  /**
   * Replaces full text in active element
   * @param {string} newText - Text to replace with
   * @returns {boolean} Success status
   */
  function replaceFullText(newText) {
    const activeElement = document.activeElement;
    
    // Handle input/textarea
    if (activeElement && 
        (activeElement.tagName === "TEXTAREA" || 
         (activeElement.tagName === "INPUT" && activeElement.type === "text"))) {
      
      activeElement.value = newText;
      activeElement.selectionStart = activeElement.selectionEnd = newText.length;
      dispatchInputEvents(activeElement);
      return true;
    }

    // Handle contentEditable
    const editableHost = document.querySelector("[contenteditable=''], [contenteditable='true']");
    if (editableHost) {
      try {
        const range = document.createRange();
        range.selectNodeContents(editableHost);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        
        // Try execCommand first, fallback to textContent
        const success = document.execCommand && document.execCommand("insertText", false, newText);
        if (!success) {
          editableHost.textContent = newText;
        }
        
        if (editableHost.focus) editableHost.focus();
        dispatchInputEvents(editableHost);
        return true;
      } catch (error) {
        // Fallback failed
      }
    }

    return false;
  }

  /**
   * Restores focus and selection for contentEditable elements
   */
  function focusAndRestoreSelection() {
    if (lastSelectionRange) {
      const selection = window.getSelection();
      if (selection) {
        try {
          selection.removeAllRanges();
          selection.addRange(lastSelectionRange);
        } catch (error) {
          // Selection restoration failed
        }
      }

      const editableHost = lastSelectionRange.startContainer?.parentElement?.closest("[contenteditable=''], [contenteditable='true']");
      if (editableHost && typeof editableHost.focus === "function") {
        try {
          editableHost.focus();
        } catch (error) {
          // Focus failed
        }
      }
    }
  }

  /**
   * Replaces selected text with new content
   * @param {string} newText - Text to replace with
   * @returns {boolean} Success status
   */
  function replaceSelectedText(newText) {
    console.log(`🔄 replaceSelectedText called with: "${newText?.slice(0, 50)}..."`);    
    let replaced = false;

    // Handle input/textarea selection
    if (lastActiveElement && lastInputSelection && (lastActiveElement === document.activeElement)) {
      const element = lastActiveElement;
      const { start, end, value } = lastInputSelection;
      
      if (typeof start === "number" && typeof end === "number") {
        console.log(`📝 Replacing input text: [${start}-${end}] "${value.slice(start, end)}" → "${newText.slice(0, 30)}..."`);        
        element.value = value.slice(0, start) + newText + value.slice(end);
        element.selectionStart = element.selectionEnd = start + newText.length;
        dispatchInputEvents(element);
        replaced = true;
        console.log(`✅ Input replacement successful`);
      }
    }

    // Handle contentEditable selection
    if (!replaced) {
      try {
        let selection = window.getSelection && window.getSelection();
        
        // Restore selection if none exists
        if (!selection || selection.rangeCount === 0) {
          focusAndRestoreSelection();
          selection = window.getSelection && window.getSelection();
        }

        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          
          // Try execCommand first
          const success = document.execCommand && document.execCommand("insertText", false, newText);
          if (!success) {
            // Fallback to manual range manipulation
            range.deleteContents();
            const textNode = document.createTextNode(newText);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          }

          // Notify host element of change
          const hostElement = (range.startContainer.nodeType === 1 ? 
                              range.startContainer : 
                              range.startContainer.parentElement)?.closest("[contenteditable=''], [contenteditable='true']");
          if (hostElement) {
            dispatchInputEvents(hostElement);
          }
          
          replaced = true;
          console.log(`✅ ContentEditable replacement successful`);
        }
      } catch (error) {
        console.log(`❌ ContentEditable replacement failed:`, error);
      }
    }
    
    console.log(`🔄 replaceSelectedText result: ${replaced}`);
    return replaced;
  }
  
  // Global function for manual testing from browser console
  window.testBizToneReplace = function(text = '안녕하세요, 잘 부탁드립니다.') {
    console.log('🛠️ Manual REPLACE_WITH test triggered');
    if (window.chrome?.runtime?.sendMessage) {
      // This won't work from content script, but shows the attempt
      console.log('💫 Attempting direct message simulation...');
    }
    
    // Direct function test
    const result = replaceSelectedText(text);
    console.log(`🛠️ Direct function test result: ${result}`);
    return result;
  };
  
  console.log('🛠️ Run testBizToneReplace() in console to test text replacement directly');

  // ==================== UI COMPONENTS ====================

  /**
   * Shows a toast notification
   * @param {string} message - Message to display
   */
  function showToast(message) {
    try {
      const toast = document.createElement("div");
      toast.textContent = message;
      
      Object.assign(toast.style, {
        position: "fixed",
        zIndex: "2147483647",
        bottom: "18px",
        right: "18px",
        background: "#111827",
        color: "#e5e7eb",
        padding: "8px 10px",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: "8px",
        fontSize: "12px",
        boxShadow: "0 8px 24px rgba(0,0,0,.28)"
      });

      document.documentElement.appendChild(toast);
      setTimeout(() => toast.remove(), CONFIG.UI.TOAST_DURATION);
    } catch (error) {
      // Toast creation failed
    }
  }

  /**
   * Removes the current bubble UI
   */
  function removeBubble() {
    if (bubbleElement?.parentNode) {
      bubbleElement.parentNode.removeChild(bubbleElement);
    }
    bubbleElement = null;
  }

  /**
   * Gets rectangle for current selection
   * @returns {Object|null} Selection rectangle and range
   */
  function getSelectionRect() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    return { rect, range };
  }

  /**
   * Shows the main bubble UI
   * @param {string} contentHTML - HTML content for bubble
   * @param {boolean} isLoading - Whether this is a loading state
   */
  function showBubble(contentHTML, isLoading = false) {
    removeBubble();

    // Store selection info
    const selectionInfo = getSelectionRect();
    if (selectionInfo?.range) {
      lastSelectionRange = selectionInfo.range.cloneRange();
    }

    // Store input selection info
    const activeElement = document.activeElement;
    lastActiveElement = activeElement || null;
    if (activeElement && 
        (activeElement.tagName === "TEXTAREA" || 
         (activeElement.tagName === "INPUT" && activeElement.type === "text"))) {
      lastInputSelection = {
        start: activeElement.selectionStart,
        end: activeElement.selectionEnd,
        value: activeElement.value
      };
    } else {
      lastInputSelection = null;
    }

    // Create bubble
    bubbleElement = document.createElement("div");
    bubbleElement.className = "biztone-bubble";
    bubbleElement.innerHTML = `
      <div class="biztone-header">
        <span class="biztone-title">BizTone</span>
        <button class="biztone-close" title="닫기">×</button>
      </div>
      <div class="biztone-body">
        ${contentHTML}
      </div>
    `;

    document.documentElement.appendChild(bubbleElement);

    // Setup close button
    const closeButton = bubbleElement.querySelector(".biztone-close");
    closeButton.addEventListener("click", removeBubble);

    // Position bubble
    let top = window.scrollY + 80;
    let left = window.scrollX + 80;
    
    if (selectionInfo?.rect) {
      top = Math.max(CONFIG.UI.MIN_POSITION, window.scrollY + selectionInfo.rect.bottom + CONFIG.UI.BUBBLE_OFFSET);
      left = Math.max(CONFIG.UI.MIN_POSITION, window.scrollX + selectionInfo.rect.left);
    }
    
    bubbleElement.style.top = `${top}px`;
    bubbleElement.style.left = `${left}px`;

    // Set loading state
    if (isLoading) {
      bubbleElement.classList.add("biztone-loading");
    } else {
      bubbleElement.classList.remove("biztone-loading");
    }
  }

  /**
   * Shows loading bubble
   */
  function showLoadingBubble() {
    showBubble(`<div class="biztone-loading-row"><div class="biztone-spinner"></div><span>변환 중…</span></div>`, true);
  }

  /**
   * Shows result bubble with conversion result
   * @param {string} text - Converted text to display
   */
  function showResultBubble(text) {
    const escapedText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `
      <textarea class="biztone-textarea" readonly>${escapedText}</textarea>
      <div class="biztone-actions">
        <button class="biztone-btn" id="biztone-copy">복사</button>
        <button class="biztone-btn" id="biztone-replace">선택 영역 교체</button>
      </div>
      <div class="biztone-tip">입력창(메일/메신저)에서 선택 후 교체를 누르면 바로 대체됩니다.</div>
    `;
    
    showBubble(html, false);

    // Setup action buttons
    const copyButton = bubbleElement.querySelector("#biztone-copy");
    const replaceButton = bubbleElement.querySelector("#biztone-replace");

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyButton.textContent = "복사됨 ✔";
        setTimeout(() => (copyButton.textContent = "복사"), 1200);
      } catch (error) {
        alert("클립보드 복사 실패: " + error);
      }
    });

    replaceButton.addEventListener("click", () => {
      let replaced = false;

      // Try input/textarea replacement
      if (lastActiveElement && lastInputSelection && (lastActiveElement === document.activeElement)) {
        const element = lastActiveElement;
        const { start, end, value } = lastInputSelection;
        
        if (typeof start === "number" && typeof end === "number") {
          element.value = value.slice(0, start) + text + value.slice(end);
          element.selectionStart = element.selectionEnd = start + text.length;
          replaced = true;
        }
      }

      // Try contentEditable replacement
      if (!replaced && lastSelectionRange) {
        try {
          lastSelectionRange.deleteContents();
          const textNode = document.createTextNode(text);
          lastSelectionRange.insertNode(textNode);
          replaced = true;
        } catch (error) {
          // Replacement failed
        }
      }

      if (replaced) {
        replaceButton.textContent = "교체됨 ✔";
        setTimeout(removeBubble, 800);
      } else {
        // Fallback to copy with proper focus handling
        try {
          if (document.hasFocus && !document.hasFocus()) {
            window.focus();
            setTimeout(() => {
              navigator.clipboard.writeText(text)
                .then(() => { replaceButton.textContent = "복사됨 ✔"; })
                .catch(() => { replaceButton.textContent = "복사 실패"; });
            }, 50);
          } else {
            navigator.clipboard.writeText(text).then(() => {
              replaceButton.textContent = "복사됨 ✔";
            });
          }
        } catch (error) {
          replaceButton.textContent = "복사 실패";
        }
      }
    });
  }

  /**
   * Shows error bubble
   * @param {string} message - Error message to display
   */
  function showErrorBubble(message) {
    const html = `
      <div class="biztone-error">⚠ ${message}</div>
      <div class="biztone-actions">
        <button class="biztone-btn" id="biztone-open-options">설정 열기</button>
      </div>
    `;
    
    showBubble(html, false);
    
    const optionsButton = bubbleElement.querySelector("#biztone-open-options");
    optionsButton.addEventListener("click", () => {
      safeSendMessage({ type: MESSAGE_TYPES.OPEN_OPTIONS });
    });
  }

  /**
   * Shows conversion result bubble with before/after comparison
   * @param {string} convertedText - Converted text
   * @param {string} originalText - Original text
   */
  function showConversionResultBubble(convertedText, originalText) {
    const escapedOriginal = originalText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escapedConverted = convertedText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
    const html = `
      <div class="conversion-header">✨ 정중화 완료</div>
      
      <div class="text-comparison">
        <div class="text-before">
          <div class="text-label">변환 전</div>
          <div class="text-content original">${escapedOriginal}</div>
        </div>
        <div class="conversion-arrow">→</div>
        <div class="text-after">
          <div class="text-label">변환 후</div>
          <div class="text-content converted">${escapedConverted}</div>
        </div>
      </div>
      
      <div class="biztone-actions">
        <button class="biztone-btn" id="biztone-use-original">원문 사용</button>
        <button class="biztone-btn biztone-btn-primary" id="biztone-use-converted">변환문 사용</button>
        <button class="biztone-btn" id="biztone-copy-converted">복사</button>
      </div>
      <div class="biztone-tip">💡 변환문 사용: 입력창에 바로 적용 • 원문 사용: 경고 없이 원문 전송</div>
    `;
    
    showBubble(html, false);

    // Setup action buttons
    const useOriginalButton = bubbleElement.querySelector("#biztone-use-original");
    const useConvertedButton = bubbleElement.querySelector("#biztone-use-converted");
    const copyButton = bubbleElement.querySelector("#biztone-copy-converted");

    useOriginalButton.addEventListener("click", () => {
      removeBubble();
      // Cache as warning acknowledged to allow original send - will be cleared after one use
      setCachedResult(originalText, { mode: "warning_acknowledged", originalText: originalText }, lastActiveElement);
      showToast("다음 Enter 키로 원문 전송됩니다");
    });

    useConvertedButton.addEventListener("click", () => {
      removeBubble();
      
      // Replace text with converted version
      const textContext = getCurrentTextContext();
      const selectedReplaced = (textContext.mode === "selection" && 
                               typeof replaceSelectedText === "function") ? 
                               replaceSelectedText(convertedText) : false;
      const replaced = selectedReplaced || replaceFullText(convertedText);
      
      if (replaced) {
        // Don't cache converted text to allow future detection of same profanity
        showToast("변환 완료 — Enter를 다시 누르면 전송됩니다");
      } else {
        showToast("텍스트 교체 실패 - 수동으로 복사해주세요");
      }
    });

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(convertedText);
        copyButton.textContent = "복사됨 ✔";
        setTimeout(() => (copyButton.textContent = "복사"), 1200);
      } catch (error) {
        showToast("클립보드 복사 실패");
      }
    });
  }

  /**
   * Shows warning bubble for warn mode
   * @param {string} text - Original text that triggered warning
   * @param {string} riskReason - Reason for the warning
   * @param {Object} riskInfo - Additional risk information
   */
  function showWarningBubble(text, riskReason = "감정적인 표현이 감지되었습니다", riskInfo = {}) {
    const escapedText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const shortText = escapedText.length > 100 ? escapedText.slice(0, 100) + "..." : escapedText;
    
    // Generate risk tags based on detected patterns
    let riskTags = '';
    if (riskInfo.profanity) riskTags += '<span class="risk-tag risk-profanity">욕설</span>';
    if (riskInfo.aggressive) riskTags += '<span class="risk-tag risk-aggressive">공격적</span>';
    if (riskInfo.punctuation) riskTags += '<span class="risk-tag risk-punctuation">과도한 구두점</span>';
    if (riskInfo.uppercase) riskTags += '<span class="risk-tag risk-uppercase">대문자 남용</span>';
    
    const html = `
      <div class="biztone-warning">⚠️ ${riskReason}</div>
      <div class="biztone-original-text">"${shortText}"</div>
      ${riskTags ? `<div class="risk-tags">${riskTags}</div>` : ''}
      <div class="biztone-actions">
        <button class="biztone-btn biztone-btn-primary" id="biztone-send-anyway">그래도 보내기</button>
        <button class="biztone-btn" id="biztone-edit-text">수정하기</button>
        <button class="biztone-btn" id="biztone-convert-option">정중화</button>
      </div>
      <div class="biztone-tip">💡 수정: 입력창으로 돌아가기 • 정중화: AI가 정중한 표현으로 변환</div>
    `;
    
    showBubble(html, false);

    // Setup action buttons
    const sendButton = bubbleElement.querySelector("#biztone-send-anyway");
    const editButton = bubbleElement.querySelector("#biztone-edit-text");
    const convertButton = bubbleElement.querySelector("#biztone-convert-option");

    sendButton.addEventListener("click", () => {
      removeBubble();
      __BIZTONE_WARNING_SHOWN = true; // Mark warning as acknowledged
      // Cleanup form prevention when user chooses to send anyway
      if (__BIZTONE_FORM_CLEANUP) {
        __BIZTONE_FORM_CLEANUP();
        __BIZTONE_FORM_CLEANUP = null;
      }
      // Cache acknowledgment for ONE use only - will be cleared after use
      setCachedResult(text, { mode: "warning_acknowledged", originalText: text }, lastActiveElement);
      showToast("다음 Enter 키로 원본 전송됩니다");
    });

    editButton.addEventListener("click", () => {
      removeBubble();
      // Focus back to the input element for manual editing
      const activeElement = document.activeElement;
      if (activeElement && (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT' || activeElement.contentEditable === 'true')) {
        activeElement.focus();
        // Move cursor to end
        if (activeElement.setSelectionRange) {
          const len = activeElement.value?.length || 0;
          activeElement.setSelectionRange(len, len);
        }
      }
      showToast("입력창에서 내용을 수정해주세요");
    });

    convertButton.addEventListener("click", async () => {
      removeBubble();
      showLoadingBubble();
      
      // Request conversion
      safeSendMessage({
        type: MESSAGE_TYPES.BIZTONE_CONVERT_TEXT,
        text: text
      }, (response) => {
        // Cleanup form prevention when conversion is done
        if (__BIZTONE_FORM_CLEANUP) {
          __BIZTONE_FORM_CLEANUP();
          __BIZTONE_FORM_CLEANUP = null;
        }
        
        if (response && response.ok && response.result) {
          removeBubble();
          // Show conversion result in popup instead of auto-replacing
          showConversionResultBubble(response.result, text);
        } else {
          removeBubble();
          showErrorBubble("변환에 실패했습니다. 다시 시도해 주세요.");
        }
      });
    });
  }

  // ==================== REAL-TIME DETECTION SYSTEM ====================

  /**
   * Creates and shows a real-time warning badge for an input element
   * @param {HTMLElement} element - The input element to attach badge to
   * @param {number} riskScore - Risk score (1-5)
   * @param {Object} riskFactors - Risk factors detected
   */
  function showRealtimeBadge(element, riskScore, riskFactors) {
    // Cancel any pending removal timer
    const existingTimer = __BIZTONE_BADGE_TIMERS.get(element);
    if (existingTimer) {
      clearTimeout(existingTimer);
      __BIZTONE_BADGE_TIMERS.delete(element);
    }
    
    // Remove existing badge for this element (immediate)
    removeRealtimeBadge(element, true);
    
    // Determine badge style and text based on risk level
    let badgeClass = "biztone-realtime-badge";
    let icon = "⚠️";
    let text = "주의";
    
    if (riskScore >= 4) {
      badgeClass += " high-risk";
      icon = "🚫";
      text = "위험";
    } else if (riskScore >= 2) {
      badgeClass += " medium-risk";
      icon = "⚠️";
      text = "주의";
    } else {
      badgeClass += " low-risk";
      icon = "💭";
      text = "확인";
    }
    
    // Create badge element
    const badge = document.createElement("div");
    badge.className = badgeClass;
    badge.innerHTML = `
      <span class="biztone-badge-icon">${icon}</span>
      <span class="biztone-badge-text">${text}</span>
    `;
    
    // Smart positioning system with priority-based placement
    const rect = element.getBoundingClientRect();
    const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const badgeWidth = 120;
    const badgeHeight = 32;
    const offset = 8;
    
    // Position options in priority order
    const positions = [
      // 1. Top-right corner (preferred for most inputs)
      {
        top: rect.top + scrollTop - badgeHeight - offset,
        left: rect.right + scrollLeft - badgeWidth + offset,
        name: "top-right"
      },
      // 2. Top-left corner
      {
        top: rect.top + scrollTop - badgeHeight - offset,
        left: rect.left + scrollLeft - offset,
        name: "top-left"
      },
      // 3. Bottom-right corner
      {
        top: rect.bottom + scrollTop + offset,
        left: rect.right + scrollLeft - badgeWidth + offset,
        name: "bottom-right"
      },
      // 4. Bottom-left corner
      {
        top: rect.bottom + scrollTop + offset,
        left: rect.left + scrollLeft - offset,
        name: "bottom-left"
      },
      // 5. Right side middle
      {
        top: rect.top + scrollTop + (rect.height - badgeHeight) / 2,
        left: rect.right + scrollLeft + offset,
        name: "right-middle"
      },
      // 6. Left side middle
      {
        top: rect.top + scrollTop + (rect.height - badgeHeight) / 2,
        left: rect.left + scrollLeft - badgeWidth - offset,
        name: "left-middle"
      }
    ];
    
    // Advanced positioning logic with collision detection
    let bestPosition = positions[0]; // Default to top-right
    
    // Check for existing badges to avoid overlap
    const existingBadges = document.querySelectorAll('.biztone-realtime-badge');
    
    for (const pos of positions) {
      const fitsHorizontally = pos.left >= scrollLeft && 
                              pos.left + badgeWidth <= scrollLeft + window.innerWidth;
      const fitsVertically = pos.top >= scrollTop && 
                            pos.top + badgeHeight <= scrollTop + window.innerHeight;
      
      // Check for collisions with existing badges
      let hasCollision = false;
      for (const existingBadge of existingBadges) {
        const existingRect = existingBadge.getBoundingClientRect();
        const existingLeft = existingRect.left + scrollLeft;
        const existingTop = existingRect.top + scrollTop;
        
        // Simple collision detection
        if (!(pos.left + badgeWidth < existingLeft || 
              pos.left > existingLeft + existingRect.width ||
              pos.top + badgeHeight < existingTop ||
              pos.top > existingTop + existingRect.height)) {
          hasCollision = true;
          break;
        }
      }
      
      if (fitsHorizontally && fitsVertically && !hasCollision) {
        bestPosition = pos;
        break;
      }
    }
    
    // Fallback: If all positions have collisions, use a stacked approach
    if (bestPosition === positions[0] && existingBadges.length > 0) {
      // Stack badges vertically with offset
      const stackOffset = existingBadges.length * (badgeHeight + 4);
      bestPosition.top += stackOffset;
      bestPosition.name += `-stacked-${existingBadges.length}`;
    }
    
    // Apply position with smooth transition
    badge.style.top = `${bestPosition.top}px`;
    badge.style.left = `${bestPosition.left}px`;
    badge.classList.add(`biztone-position-${bestPosition.name}`);
    
    console.debug("[BizTone] Badge positioned at:", bestPosition.name, { top: bestPosition.top, left: bestPosition.left });
    
    // Add to DOM and track
    document.documentElement.appendChild(badge);
    __BIZTONE_REALTIME_BADGES.set(element, badge);
    
    // Auto-remove after 10 seconds (increased for better UX)
    setTimeout(() => {
      removeRealtimeBadge(element, true);
    }, 10000);
    
    console.debug("[BizTone] Real-time badge shown:", { riskScore, riskFactors, text });
  }

  /**
   * Removes real-time warning badge for an element
   * @param {HTMLElement} element - The input element
   * @param {boolean} immediate - Whether to remove immediately or with delay
   */
  function removeRealtimeBadge(element, immediate = false) {
    // Clear any existing timer
    const existingTimer = __BIZTONE_BADGE_TIMERS.get(element);
    if (existingTimer) {
      clearTimeout(existingTimer);
      __BIZTONE_BADGE_TIMERS.delete(element);
    }
    
    if (immediate) {
      const badge = __BIZTONE_REALTIME_BADGES.get(element);
      if (badge && badge.parentNode) {
        badge.parentNode.removeChild(badge);
      }
      __BIZTONE_REALTIME_BADGES.delete(element);
    } else {
      // Delayed removal to prevent flickering during fast typing
      const timer = setTimeout(() => {
        const badge = __BIZTONE_REALTIME_BADGES.get(element);
        if (badge && badge.parentNode) {
          badge.parentNode.removeChild(badge);
        }
        __BIZTONE_REALTIME_BADGES.delete(element);
        __BIZTONE_BADGE_TIMERS.delete(element);
      }, 1000); // 1 second delay to prevent flickering
      
      __BIZTONE_BADGE_TIMERS.set(element, timer);
    }
  }

  /**
   * Handles real-time text analysis for an input element
   * @param {HTMLElement} element - The input element
   * @param {string} text - Current text content
   */
  async function handleRealtimeDetection(element, text) {
    const normalizedText = normalizeText(text);
    
    // Skip if text is empty or too short - use delayed removal to prevent flickering
    if (!normalizedText || normalizedText.length < 2) {
      removeRealtimeBadge(element, false); // Delayed removal
      return;
    }
    
    // Performance optimization: Skip very long texts in real-time
    if (normalizedText.length > 500) {
      console.debug("[BizTone] Skipping real-time check for long text (performance)");
      return;
    }
    
    // Check if guard is disabled for current domain (cached to avoid repeated calls)
    if (await shouldDisableGuardForDomain()) {
      removeRealtimeBadge(element, true); // Immediate removal for disabled domains
      return;
    }
    
    // Quick local assessment (no API calls for real-time)
    const quickRisk = calculateBasicRiskScore(normalizedText);
    
    console.debug("[BizTone] Real-time check:", { 
      text: normalizedText.substring(0, 20) + "...", 
      score: quickRisk.score, 
      whitelisted: quickRisk.whitelisted,
      length: normalizedText.length
    });
    
    // Show badge only if there's some risk
    // Use lower threshold for real-time to give early warning
    if (quickRisk.score > 0.5 && !quickRisk.whitelisted) {
      showRealtimeBadge(element, quickRisk.score, quickRisk.riskFactors);
    } else {
      // Use delayed removal to prevent flickering during fast typing
      removeRealtimeBadge(element, false);
    }
  }

  /**
   * Smart debounced real-time detection with adaptive timing
   * @param {HTMLElement} element - Input element
   * @param {string} text - Current text
   */
  function debouncedRealtimeDetection(element, text) {
    const now = Date.now();
    
    // Clear previous debounce
    if (__BIZTONE_REALTIME_DEBOUNCE) {
      clearTimeout(__BIZTONE_REALTIME_DEBOUNCE);
    }
    
    // Adaptive debounce timing based on various factors
    let debounceMs = getAdaptiveDebounceTime(text, now);
    
    // Immediate detection for high-confidence profanity
    if (hasHighConfidenceProfanity(text)) {
      debounceMs = 50; // Almost instant for clear profanity
    }
    
    console.debug(`[BizTone] Scheduled detection in ${debounceMs}ms for text length: ${text.length}`);
    
    // Set new debounce timer
    __BIZTONE_REALTIME_DEBOUNCE = setTimeout(() => {
      const startTime = performance.now();
      handleRealtimeDetection(element, text);
      const endTime = performance.now();
      
      console.debug(`[BizTone] Detection completed in ${(endTime - startTime).toFixed(2)}ms`);
      
      __BIZTONE_REALTIME_DEBOUNCE = null;
      __BIZTONE_LAST_DETECTION_TIME = Date.now();
    }, debounceMs);
  }

  /**
   * Calculates adaptive debounce time based on context
   * @param {string} text - Current text
   * @param {number} now - Current timestamp
   * @returns {number} Debounce time in milliseconds
   */
  function getAdaptiveDebounceTime(text, now) {
    const textLength = text.length;
    const timeSinceLastDetection = now - __BIZTONE_LAST_DETECTION_TIME;
    
    // Base timing: shorter for shorter text
    let baseTime = Math.min(400, Math.max(150, textLength * 20));
    
    // Speed up if user is typing continuously
    if (timeSinceLastDetection < 2000) {
      baseTime *= 0.7; // 30% faster for continuous typing
    }
    
    // Speed up for obvious risk patterns
    if (containsObviousRiskPattern(text)) {
      baseTime *= 0.5; // 50% faster for risky patterns
    }
    
    // Slow down for very long text to prevent performance issues
    if (textLength > 200) {
      baseTime *= 1.5;
    }
    
    return Math.max(50, Math.min(600, baseTime)); // Clamp between 50ms and 600ms
  }

  /**
   * Quick check for high-confidence profanity
   * @param {string} text - Text to check
   * @returns {boolean} True if contains obvious profanity
   */
  function hasHighConfidenceProfanity(text) {
    // Check for most common strong profanity that should trigger immediately
    const highConfidenceWords = ["씨발", "시발", "좆", "개새끼", "병신"];
    return highConfidenceWords.some(word => text.includes(word));
  }

  /**
   * Quick pattern check for obvious risks
   * @param {string} text - Text to check
   * @returns {boolean} True if contains obvious risk patterns
   */
  function containsObviousRiskPattern(text) {
    // Quick regex for common patterns
    return /[ㅅㅆ][ㅂㅄ]|[ㅂㅄ][ㅅㅆ]|개새|병신|좆|꺼져/.test(text) ||
           text.includes("!!!!") || 
           text.includes("????") ||
           /[A-Z]{4,}/.test(text);
  }

  /**
   * Sets up real-time monitoring for an input element
   * @param {HTMLElement} element - Input element to monitor
   */
  function setupRealtimeMonitoring(element) {
    // Skip if already monitoring
    if (__BIZTONE_MONITORED_INPUTS.has(element)) {
      return;
    }
    
    console.debug("[BizTone] Setting up real-time monitoring for element:", element.tagName);
    
    // Add to monitored set
    __BIZTONE_MONITORED_INPUTS.add(element);
    
    // Enhanced input event listener with instant detection
    const inputHandler = () => {
      const text = element.value || element.textContent || element.innerText || "";
      
      // Instant detection for obvious profanity (no debounce)
      if (hasHighConfidenceProfanity(text)) {
        console.debug("[BizTone] Instant detection triggered for:", text.substring(0, 10) + "...");
        handleRealtimeDetection(element, text);
        return;
      }
      
      // Regular debounced detection for other cases
      debouncedRealtimeDetection(element, text);
    };
    
    element.addEventListener('input', inputHandler);
    element.addEventListener('paste', inputHandler);
    
    // Cleanup when element loses focus (after a delay)
    const blurHandler = () => {
      setTimeout(() => {
        removeRealtimeBadge(element, false); // Use delayed removal
      }, 3000); // Keep badge for 3 seconds after blur
    };
    
    element.addEventListener('blur', blurHandler);
    
    // Store cleanup function on element
    element.__BIZTONE_CLEANUP__ = () => {
      element.removeEventListener('input', inputHandler);
      element.removeEventListener('paste', inputHandler);
      element.removeEventListener('blur', blurHandler);
      removeRealtimeBadge(element);
      __BIZTONE_MONITORED_INPUTS.delete(element);
      delete element.__BIZTONE_CLEANUP__;
    };
  }

  /**
   * Automatically detects and sets up monitoring for text input elements
   */
  function autoSetupRealtimeMonitoring() {
    // Find text input elements
    const textInputs = document.querySelectorAll(`
      textarea,
      input[type="text"],
      input[type="search"],
      [contenteditable="true"],
      [role="textbox"]
    `);
    
    textInputs.forEach(element => {
      // Skip if element is not visible or too small
      const rect = element.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 20) return;
      
      setupRealtimeMonitoring(element);
    });
    
    console.debug("[BizTone] Auto-setup real-time monitoring for", textInputs.length, "elements");
  }

  // ==================== GUARD SYSTEM ====================

  /**
   * Processes guard result with optimized performance
   * @param {Object} finalRisk - Risk assessment result
   * @param {Promise} guardModePromise - Promise resolving to guard mode
   * @param {number} startTime - Performance timestamp
   * @param {Object} quickAssessment - Basic assessment for comparison
   */
  async function processGuardResult(finalRisk, guardModePromise, startTime, quickAssessment) {
    // Get guard mode and calculate timing
    const guardMode = await guardModePromise;
    const processingTime = performance.now() - startTime;
    
    console.debug(`[BizTone] Guard processing time: ${processingTime.toFixed(1)}ms, Guard mode: ${guardMode}`);
    if (finalRisk !== quickAssessment) {
      console.debug("[BizTone] Advanced risk assessment completed in", processingTime.toFixed(1) + "ms:", finalRisk);
    } else {
      console.warn("[BizTone] Using basic assessment fallback after", processingTime.toFixed(1) + "ms");
    }
    
    // Re-evaluate with final assessment
    const finalKind = finalRisk.whitelisted ? "pass" :
      finalRisk.score <= CONFIG.PREFILTER.PASS_MAX ? "pass" :
      finalRisk.score >= CONFIG.PREFILTER.CONVERT_MIN ? "convert" : "prompt";

    console.log(`🎯 [BizTone] Final decision:`, {
      score: finalRisk.score,
      whitelisted: finalRisk.whitelisted,
      passMax: CONFIG.PREFILTER.PASS_MAX,
      convertMin: CONFIG.PREFILTER.CONVERT_MIN,
      finalKind: finalKind,
      guardMode: guardMode,
      processingTime: processingTime.toFixed(1) + "ms"
    });

    // Get current text context for operations
    const textContext = getCurrentTextContext();
    const normalizedText = normalizeText(textContext.text);

    // 1) Low risk after advanced assessment: allow send
    if (finalKind === "pass") {
      console.log("✅ [BizTone] Allowing send (low risk)");
      if (__BIZTONE_FORM_CLEANUP) {
        __BIZTONE_FORM_CLEANUP();
        __BIZTONE_FORM_CLEANUP = null;
      }
      setCachedResult(normalizedText, { mode: "send" }, textContext.element);
      dispatchEnterKey();
      return;
    }
    
    // 2) High risk: handle based on guard mode
    if (finalKind === "convert") {
      console.log(`🔥 [BizTone] High risk detected (convert case)`, { guardMode });
      if (guardMode === "warn") {
        // Warning mode: Show warning bubble instead of auto-converting
        console.log("⚠️ [BizTone] Showing warning bubble");
        const riskMessage = finalRisk.score >= 4 ? "강한 표현이 감지되었습니다" : "위험한 표현이 감지되었습니다";
        showWarningBubble(normalizedText, riskMessage, finalRisk.riskFactors || {});
        return;
      } else {
        // Convert mode: Auto-convert (existing behavior)
        console.log("🔄 [BizTone] Auto-converting text");
        safeSendMessage({
          type: MESSAGE_TYPES.BIZTONE_CONVERT_TEXT,
          text: normalizedText
        }, (convertResponse) => {
          if (__BIZTONE_FORM_CLEANUP) {
            __BIZTONE_FORM_CLEANUP();
            __BIZTONE_FORM_CLEANUP = null;
          }
          
          if (!convertResponse || !convertResponse.ok || !convertResponse.result) {
            const errorMsg = "보내기 보호: 변환 실패 — 다시 시도하거나 문장을 완화해 주세요.";
            showToast(errorMsg);
            
            if (CONFIG.GUARD.FAIL_OPEN_ON_CONVERT_ERROR) {
              console.debug("[BizTone] Fail-open on conversion error enabled, allowing send");
              dispatchEnterKey();
            }
            return;
          }
          
          const selectedReplaced = (textContext.mode === "selection" && 
                                   typeof replaceSelectedText === "function") ? 
                                   replaceSelectedText(convertResponse.result) : false;
          const replaced = selectedReplaced || replaceFullText(convertResponse.result);
          
          if (CONFIG.GUARD.AUTO_SEND_CONVERTED && replaced) {
            dispatchEnterKey();
          } else if (replaced) {
            showToast("변환 완료 — Enter를 다시 누르면 전송됩니다.");
          }
        });
      }
      return;
    }
    
    // 3) Medium risk: handle based on guard mode
    console.log(`⚡ [BizTone] Medium risk detected (prompt case)`, { guardMode });
    if (guardMode === "warn") {
      // Warning mode: Show warning for medium risk too
      console.log("⚠️ [BizTone] Showing warning bubble for medium risk");
      showWarningBubble(normalizedText, "주의가 필요한 표현이 감지되었습니다", finalRisk.riskFactors || {});
    } else {
      // Convert mode: Use AI decision (existing behavior)
      console.log("🤖 [BizTone] Using AI decision");
      safeSendMessage({
        type: MESSAGE_TYPES.BIZTONE_GUARD_DECIDE,
        text: normalizedText
      }, (decisionResponse) => {
        if (__BIZTONE_FORM_CLEANUP) {
          __BIZTONE_FORM_CLEANUP();
          __BIZTONE_FORM_CLEANUP = null;
        }
        
        if (!decisionResponse || !decisionResponse.ok) {
          if (CONFIG.GUARD.FAIL_OPEN_ON_DECISION_ERROR) {
            console.debug("[BizTone] Decision failure, fail-open policy allows send");
            dispatchEnterKey();
          } else {
            showToast("보내기 보호: 판정 실패 — 다시 시도해 주세요.");
          }
          return;
        }
        
        if (decisionResponse.action === "send") {
          setCachedResult(normalizedText, { mode: "send" }, textContext.element);
          dispatchEnterKey();
          return;
        }
        
        const convertedText = decisionResponse.converted_text || normalizedText;
        const selectedReplaced = (textContext.mode === "selection" && 
                                 typeof replaceSelectedText === "function") ? 
                                 replaceSelectedText(convertedText) : false;
        const replaced = selectedReplaced || replaceFullText(convertedText);
        
        if (CONFIG.GUARD.AUTO_SEND_CONVERTED && replaced) {
          dispatchEnterKey();
        } else if (replaced) {
          showToast("변환 완료 — Enter를 다시 누르면 전송됩니다.");
        }
      });
    }
  }

  /**
   * Main keydown guard handler with race condition prevention
   * @param {KeyboardEvent} event - Keyboard event
   */
  async function onKeyDownGuard(event) {
    if (event.isComposing) return; // Ignore composition events
    
    // Enhanced Enter key detection (including NumpadEnter)
    const isEnter = isEnterKey(event) && !event.shiftKey && !event.altKey;
    const isCmdEnter = isEnterKey(event) && (event.metaKey || event.ctrlKey);
    if (!isEnter && !isCmdEnter) return;
    
    console.debug("[BizTone] Enter key detected:", { isEnter, isCmdEnter, key: event.key, code: event.code });

    // Prevent duplicate processing
    if (shouldSkipDuplicate()) return;

    try {
      // Check if guard is enabled
      if (!CONFIG.GUARD.ENABLED) {
        console.debug("[BizTone] Guard disabled in config");
        return;
      }
      
      // Check domain-based guard rules
      if (await shouldDisableGuardForDomain()) {
        console.debug("[BizTone] Guard disabled for current domain");
        return;
      }
      
      // If extension context is invalid, disable guard and allow normal operation
      if (!isExtensionContextValid()) {
        console.debug("[BizTone] Extension context invalid - guard disabled");
        return; // Allow normal send behavior
      }

      // Get current text context
      const textContext = getCurrentTextContext();
      lastActiveElement = textContext.element || document.activeElement;
      const normalizedText = normalizeText(textContext.text);
      const isSearch = isSearchElement(textContext.element || document.activeElement);
      
      console.log(`🔍 [BizTone] Text extraction:`, { 
        mode: textContext.mode, 
        originalText: textContext.text, 
        normalizedText: normalizedText, 
        element: textContext.element?.tagName,
        activeElement: document.activeElement?.tagName,
        selectionLength: window.getSelection()?.toString()?.length || 0,
        isSearchElement: isSearch
      });
      
      if (!normalizedText) {
        console.log("❌ [BizTone] Empty text detected - allowing send");
        return; // Allow empty sends
      }
      
      // For search elements, prevent form submission during processing
      if (isSearch) {
        console.log("🔍 [BizTone] Search element detected - preventing form submission");
        __BIZTONE_FORM_CLEANUP = preventSearchFormSubmission(textContext.element || document.activeElement);
      }
      
      // Test basic profanity detection
      const quickRisk = calculateBasicRiskScore(normalizedText);
      console.log(`📊 [BizTone] Quick risk assessment:`, quickRisk);

      // Check cache first - but allow re-detection for warning cases to enable repeated detection
      const cachedResult = getCachedResult(normalizedText, textContext.element);
      if (cachedResult) {
        event.preventDefault();
        event.stopImmediatePropagation();
        
        if (cachedResult.mode === "send") {
          dispatchEnterKey();
          return;
        }
        
        // Handle cached warning acknowledgment - only for single use, then clear cache
        if (cachedResult.mode === "warning_acknowledged") {
          // Clear this cache entry after one use to allow re-detection
          const key = normalizeText(normalizedText);
          guardCache.delete(key);
          if (textContext.element && elementSpecificCache.has(textContext.element)) {
            const elementCache = elementSpecificCache.get(textContext.element);
            elementCache.delete(key);
          }
          dispatchEnterKey();
          return;
        }
        
        // For converted text cache, use it but don't prevent future detection
        if (cachedResult.mode === "convert" && cachedResult.converted) {
          const selectedReplaced = (textContext.mode === "selection" && 
                                   typeof replaceSelectedText === "function") ? 
                                   replaceSelectedText(cachedResult.converted) : false;
          const replaced = selectedReplaced || replaceFullText(cachedResult.converted);
          
          if (CONFIG.GUARD.AUTO_SEND_CONVERTED && replaced) {
            dispatchEnterKey();
          } else if (replaced) {
            showToast("변환 완료 — Enter를 다시 누르면 전송됩니다.");
          }
          // Don't return here - allow re-processing for future detections
        }
        
        // For warning_shown mode, don't use cache - allow fresh detection every time
        if (cachedResult.mode === "warning_shown") {
          // Skip cache and proceed with fresh detection
          console.debug("[BizTone] Skipping warning_shown cache for fresh detection");
        } else {
          return; // Use other cached results normally
        }
      }

      // CRITICAL: Synchronous prefilter to prevent race conditions
      // First, decide immediately whether to block or allow based on basic assessment
      const quickAssessment = calculateBasicRiskScore(normalizedText);
      console.debug("[BizTone] Quick assessment:", quickAssessment);

      const quickKind = quickAssessment.whitelisted ? "pass" :
        quickAssessment.score <= CONFIG.PREFILTER.PASS_MAX ? "pass" :
        quickAssessment.score >= CONFIG.PREFILTER.CONVERT_MIN ? "convert" : "prompt";

      // If safe, allow immediate send without blocking
      if (quickKind === "pass") {
        if (__BIZTONE_FORM_CLEANUP) {
          __BIZTONE_FORM_CLEANUP();
          __BIZTONE_FORM_CLEANUP = null;
        }
        setCachedResult(normalizedText, { mode: "send" }, textContext.element);
        return; // Don't prevent default - allow normal send
      }

      // For convert/prompt candidates, immediately block the send
      event.preventDefault();
      event.stopImmediatePropagation();

      // Start both guard mode retrieval and advanced risk assessment in parallel for speed
      const guardModePromise = getGuardMode();
      const startTime = performance.now();
      
      // Add timeout for advanced risk assessment to prevent hanging
      let responseReceived = false;
      const timeoutMs = 3000; // 3 second timeout
      
      setTimeout(() => {
        if (!responseReceived) {
          console.warn(`[BizTone] Advanced risk assessment timed out after ${timeoutMs}ms, using basic assessment`);
          processGuardResult(quickAssessment, guardModePromise, startTime, quickAssessment);
        }
      }, timeoutMs);
      
      // Get enhanced assessment from background for precision
      safeSendMessage({
        type: "BIZTONE_ADVANCED_RISK", 
        text: normalizedText
      }, async (response) => {
        if (responseReceived) return; // Ignore if timeout already handled
        responseReceived = true;
        // Process the response and determine final risk
        let finalRisk;
        if (response && response.ok && response.result) {
          finalRisk = response.result;
        } else {
          finalRisk = quickAssessment;
        }
        
        processGuardResult(finalRisk, guardModePromise, startTime, quickAssessment);
      });

    } catch (error) {
      console.error("[BizTone] Guard system error:", error);
      if (__BIZTONE_FORM_CLEANUP) {
        __BIZTONE_FORM_CLEANUP();
        __BIZTONE_FORM_CLEANUP = null;
      }
      clearPendingGuard();
    }
  }

  // ==================== EVENT LISTENERS ====================

  // Install keydown guard
  window.addEventListener("keydown", onKeyDownGuard, true);

  // UI event listeners
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") removeBubble();
  }, true);

  document.addEventListener("scroll", () => {
    if (bubbleElement) removeBubble();
  }, true);

  document.addEventListener("click", (event) => {
    if (bubbleElement && !bubbleElement.contains(event.target)) {
      removeBubble();
    }
  }, true);

  // Message handler with extension context validation
  if (isExtensionContextValid()) {
    console.log(`📟 Message listener installed in ${window.self === window.top ? 'TOP-FRAME' : 'IFRAME'}`);
    
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message?.type) return;
      
      // Log all incoming messages for debugging
      console.log(`📬 Incoming message: ${message.type} in ${window.self === window.top ? 'TOP-FRAME' : 'IFRAME'}`);

      switch (message.type) {
        case MESSAGE_TYPES.BIZTONE_PING:
          sendResponse({ ok: true });
          break;

        case MESSAGE_TYPES.BIZTONE_LOADING:
          showLoadingBubble();
          break;

        case MESSAGE_TYPES.BIZTONE_RESULT:
          showResultBubble(message.result || "");
          break;

        case MESSAGE_TYPES.BIZTONE_REPLACE_WITH:
          // Prevent duplicate message processing
          const now = Date.now();
          const frameInfo = window.self === window.top ? 'TOP-FRAME' : 'IFRAME';
          
          // Log debug info from background script
          if (message.__debug_info) {
            console.log(`📨 Background Debug Info:`, message.__debug_info);
            console.log(`🕰️ Message travel time: ${now - message.__debug_info.timestamp}ms`);
          }
          
          console.log(`🎯 REPLACE_WITH message received in ${frameInfo} at ${now} (text: "${message.text?.slice(0, 30)}...")`);
          
          if (__BIZTONE_LAST_MESSAGE_TYPE === message.type && now - __BIZTONE_LAST_MESSAGE_TS < 500) {
            console.warn(`❌ DUPLICATE REPLACE_WITH message ignored in ${frameInfo}! Gap: ${now - __BIZTONE_LAST_MESSAGE_TS}ms`);
            return;
          }
          __BIZTONE_LAST_MESSAGE_TS = now;
          __BIZTONE_LAST_MESSAGE_TYPE = message.type;
          console.log(`✅ Processing REPLACE_WITH message in ${frameInfo} (gap: ${__BIZTONE_LAST_MESSAGE_TS ? now - __BIZTONE_LAST_MESSAGE_TS : 'first'}ms)`);
          
          // Direct replacement from keyboard shortcut - no UI needed
          const activeElement = document.activeElement;
          lastActiveElement = activeElement || null;
          
          if (activeElement && 
              (activeElement.tagName === "TEXTAREA" || 
               (activeElement.tagName === "INPUT" && activeElement.type === "text"))) {
            lastInputSelection = {
              start: activeElement.selectionStart,
              end: activeElement.selectionEnd,
              value: activeElement.value
            };
          } else {
            const selection = window.getSelection && window.getSelection();
            if (selection && selection.rangeCount) {
              try {
                lastSelectionRange = selection.getRangeAt(0).cloneRange();
              } catch (error) {
                // Selection cloning failed
              }
            }
          }
          
          console.log(`🔧 Attempting to replace selected text...`);
          const replaced = replaceSelectedText(message.text || "");
          console.log(`🔧 Text replacement result: ${replaced ? 'SUCCESS' : 'FAILED'}`);
          if (replaced) {
            // Show brief success toast instead of bubble
            console.log(`✅ Text successfully replaced, showing toast`);
            showToast("변환 완료");
          } else {
            console.log(`❌ Text replacement failed, falling back to clipboard`);
            // Fallback to clipboard with proper focus handling
            try {
              // Ensure document is focused for clipboard access
              if (document.hasFocus && !document.hasFocus()) {
                window.focus();
                // Brief delay to allow focus to take effect
                setTimeout(() => {
                  navigator.clipboard.writeText(message.text || "")
                    .then(() => showToast("클립보드에 복사됨"))
                    .catch(() => showToast("클립보드 복사 실패"));
                }, 50);
              } else {
                navigator.clipboard.writeText(message.text || "")
                  .then(() => showToast("클립보드에 복사됨"))
                  .catch(() => showToast("클립보드 복사 실패"));
              }
            } catch (error) {
              // Final fallback: show text in toast for manual copy
              console.log(`❌ Clipboard access failed:`, error);
              showToast(`변환 결과: ${message.text}`);
            }
          }
          break;

        case MESSAGE_TYPES.BIZTONE_ERROR:
          showErrorBubble(message.error || "오류가 발생했습니다.");
          break;
      }
    });
  }

  // ==================== INITIALIZATION ====================

  /**
   * Initialize the BizTone content script with hybrid detection system
   */
  async function initializeBizTone() {
    const initFrameInfo = window.self === window.top ? 'TOP-FRAME' : `IFRAME(${window.location.href})`;
    console.debug(`[BizTone ContentScript] Initializing hybrid guard system in ${initFrameInfo}`);
    
    // Load profanity data first
    await loadProfanityData();
    
    // Setup initial real-time monitoring
    autoSetupRealtimeMonitoring();
    
    // Monitor for new input elements added dynamically
    const observer = new MutationObserver((mutations) => {
      let hasNewInputs = false;
      
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the node itself is a text input
            if (isTextInputElement(node)) {
              setupRealtimeMonitoring(node);
              hasNewInputs = true;
            }
            
            // Check for text inputs within the added node
            const textInputs = node.querySelectorAll && node.querySelectorAll(`
              textarea,
              input[type="text"],
              input[type="search"],
              [contenteditable="true"],
              [role="textbox"]
            `);
            
            if (textInputs && textInputs.length > 0) {
              textInputs.forEach(element => {
                const rect = element.getBoundingClientRect();
                if (rect.width >= 50 && rect.height >= 20) {
                  setupRealtimeMonitoring(element);
                  hasNewInputs = true;
                }
              });
            }
          }
        });
      });
      
      if (hasNewInputs) {
        console.debug("[BizTone] New text inputs detected and monitored");
      }
    });
    
    // Start observing
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    // Re-setup monitoring on navigation/page changes
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.debug("[BizTone] URL changed, re-initializing real-time monitoring");
        setTimeout(autoSetupRealtimeMonitoring, 1000);
      }
    }).observe(document, { subtree: true, childList: true });
    
    console.debug(`[BizTone ContentScript] Hybrid detection system initialized in ${initFrameInfo}`);
  }

  /**
   * Checks if an element is a text input element
   * @param {HTMLElement} element - Element to check
   * @returns {boolean} True if it's a text input element
   */
  function isTextInputElement(element) {
    if (!element || !element.tagName) return false;
    
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'textarea') return true;
    if (tagName === 'input' && ['text', 'search'].includes(element.type)) return true;
    if (element.contentEditable === 'true') return true;
    if (element.getAttribute('role') === 'textbox') return true;
    
    return false;
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeBizTone);
  } else {
    // DOM already loaded
    setTimeout(initializeBizTone, 100);
  }

})();