/**
 * BizTone Chrome Extension - Content Script
 * Handles hybrid guard system, UI bubbles, and text replacement
 */

(() => {
  // Prevent duplicate injection
  if (window.__BIZTONE_CS_LOADED__) return;
  window.__BIZTONE_CS_LOADED__ = true;

  // ==================== CONSTANTS & CONFIGURATION ====================

  const CONFIG = {
    // Prefilter thresholds
    PREFILTER: {
      PASS_MAX: 1,     // Score ≤ 1: allow immediate send
      CONVERT_MIN: 4   // Score ≥ 4: direct conversion (skip decision prompt)
    },
    
    // Cache settings
    CACHE: {
      TTL_MS: 90_000, // 90 seconds
    },
    
    // Guard settings
    GUARD: {
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
    OPEN_OPTIONS: "OPEN_OPTIONS"
  };

  // Risk assessment vocabulary
  const RISK_VOCABULARY = {
    PROFANITY: ["씨발","시발","좆","병신","개새끼","꺼져","좆같","ㅅㅂ","ㅂㅅ","개같","미친","염병","시팔","씨팔"],
    AGGRESSIVE: ["당장","빨리","왜이러","대체","책임져","뭐하","최악","말이 됩니까","어이가","화나","짜증","열받","죽을","해명","지금 당장"],
    RUDE: ["너네","니들","야","정신차려","하라는"]
  };

  // ==================== GLOBAL STATE ====================

  let bubbleElement = null;
  let lastSelectionRange = null;
  let lastInputSelection = null;
  let lastActiveElement = null;

  // Guard processing state
  let __BIZTONE_PENDING = false;
  let __BIZTONE_LAST_TS = 0;

  // Initialize cache and regex
  const guardCache = new Map();
  const profanityRegex = new RegExp(
    RISK_VOCABULARY.PROFANITY.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), 
    "i"
  );

  // Local whitelist for fallback (sync with background)
  const LOCAL_WHITELIST = ["시발점", "始發", "시발역", "출발점", "미친 듯이", "미친 척", "개발자", "개같이", "열받아"];

  // ==================== UTILITY FUNCTIONS ====================

  /**
   * Checks if the extension context is still valid
   * @returns {boolean} True if extension context is valid
   */
  function isExtensionContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
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

  // ==================== RISK ASSESSMENT SYSTEM ====================

  // ==================== LEGACY RISK ASSESSMENT (KEPT FOR REFERENCE) ====================
  
  /**
   * Basic risk assessment with local whitelist support
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
          isAdvanced: false
        };
      }
    }

    let score = 0;

    // 1) Profanity/offensive language
    if (profanityRegex.test(text)) {
      score += 2;
      console.debug("[BizTone] Profanity detected:", text, "Score:", score);
    }

    // 2) Aggressive/rude vocabulary
    let vocabularyHits = 0;
    for (const word of [...RISK_VOCABULARY.AGGRESSIVE, ...RISK_VOCABULARY.RUDE]) {
      if (text.includes(word)) vocabularyHits++;
    }
    score += Math.min(2, vocabularyHits);

    // 3) Excessive punctuation
    const exclamationCount = (text.match(/!+/g) || []).length;
    const questionCount = (text.match(/\?+/g) || []).length;
    if (exclamationCount >= 2) score += 1;
    if (questionCount >= 2) score += 1;
    if (text.includes("?!") || text.includes("!?")) score += 1;

    // 4) Excessive uppercase (English)
    const letters = (text.match(/[A-Za-z]/g) || []);
    const uppercase = (text.match(/[A-Z]/g) || []);
    if (letters.length >= 6 && uppercase.length / letters.length >= 0.5) score += 1;
    if (/\b[A-Z]{4,}\b/.test(text)) score += 1;

    // 5) Imperative endings (Korean)
    if (/[가-힣]{2,}해라\b|[가-힣]{2,}하라\b/.test(text)) score += 1;

    return {
      score,
      matches: [],
      contextual: { score: 0, factors: [] },
      whitelisted: false,
      isAdvanced: false
    };
  }

  // ==================== CACHE MANAGEMENT ====================

  /**
   * Retrieves cached result for text
   * @param {string} text - Text to look up
   * @returns {Object|null} Cached result or null
   */
  function getCachedResult(text) {
    const key = normalizeText(text);
    const item = guardCache.get(key);
    
    if (!item) return null;
    
    if (Date.now() - item.timestamp > CONFIG.CACHE.TTL_MS) {
      guardCache.delete(key);
      return null;
    }
    
    return item;
  }

  /**
   * Stores result in cache
   * @param {string} text - Text key
   * @param {Object} result - Result to cache
   */
  function setCachedResult(text, result) {
    guardCache.set(normalizeText(text), {
      timestamp: Date.now(),
      ...result
    });
  }

  // ==================== TEXT EXTRACTION & MANIPULATION ====================

  /**
   * Extracts current text from editing context
   * @returns {Object} Text info with content, mode, and element
   */
  function getCurrentTextContext() {
    const activeElement = document.activeElement;
    
    // Handle input/textarea elements
    if (activeElement && 
        (activeElement.tagName === "TEXTAREA" || 
         (activeElement.tagName === "INPUT" && activeElement.type === "text"))) {
      
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

    // Handle contentEditable elements
    const selection = window.getSelection && window.getSelection();
    const hasSelection = selection && selection.rangeCount > 0 && String(selection).length > 0;
    
    if (hasSelection) {
      return { 
        text: String(selection), 
        mode: "selection", 
        element: null 
      };
    }

    // Fallback to contentEditable host
    const editableHost = document.querySelector("[contenteditable=''], [contenteditable='true']");
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
    let replaced = false;

    // Handle input/textarea selection
    if (lastActiveElement && lastInputSelection && (lastActiveElement === document.activeElement)) {
      const element = lastActiveElement;
      const { start, end, value } = lastInputSelection;
      
      if (typeof start === "number" && typeof end === "number") {
        element.value = value.slice(0, start) + newText + value.slice(end);
        element.selectionStart = element.selectionEnd = start + newText.length;
        dispatchInputEvents(element);
        replaced = true;
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
        }
      } catch (error) {
        // Selection replacement failed
      }
    }

    return replaced;
  }

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
        // Fallback to copy
        navigator.clipboard.writeText(text).then(() => {
          replaceButton.textContent = "복사됨 ✔";
        });
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

  // ==================== GUARD SYSTEM ====================

  /**
   * Main keydown guard handler with race condition prevention
   * @param {KeyboardEvent} event - Keyboard event
   */
  function onKeyDownGuard(event) {
    if (event.isComposing) return; // Ignore composition events
    
    // Enhanced Enter key detection (including NumpadEnter)
    const isEnter = isEnterKey(event) && !event.shiftKey && !event.altKey;
    const isCmdEnter = isEnterKey(event) && (event.metaKey || event.ctrlKey);
    if (!isEnter && !isCmdEnter) return;

    // Prevent duplicate processing
    if (shouldSkipDuplicate()) return;

    try {
      // If extension context is invalid, disable guard and allow normal operation
      if (!isExtensionContextValid()) {
        console.warn("[BizTone] Extension context invalid - guard disabled");
        return; // Allow normal send behavior
      }

      // Get current text context
      const textContext = getCurrentTextContext();
      const normalizedText = normalizeText(textContext.text);
      if (!normalizedText) return; // Allow empty sends

      // Check cache first
      const cachedResult = getCachedResult(normalizedText);
      if (cachedResult) {
        event.preventDefault();
        event.stopImmediatePropagation();
        
        if (cachedResult.mode === "send") {
          dispatchEnterKey();
          return;
        }
        
        // Apply cached conversion
        const selectedReplaced = (textContext.mode === "selection" && 
                                 typeof replaceSelectedText === "function") ? 
                                 replaceSelectedText(cachedResult.converted) : false;
        const replaced = selectedReplaced || replaceFullText(cachedResult.converted);
        
        if (CONFIG.GUARD.AUTO_SEND_CONVERTED && replaced) {
          dispatchEnterKey();
        } else if (replaced) {
          showToast("변환 완료 — Enter를 다시 누르면 전송됩니다.");
        }
        return;
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
        setCachedResult(normalizedText, { mode: "send" });
        return; // Don't prevent default - allow normal send
      }

      // For convert/prompt candidates, immediately block the send
      event.preventDefault();
      event.stopImmediatePropagation();

      // Now get enhanced assessment from background for precision
      safeSendMessage({
        type: "BIZTONE_ADVANCED_RISK", 
        text: normalizedText
      }, (response) => {
        let finalRisk;
        
        // Use advanced assessment if available, otherwise fallback to quick assessment
        if (response && response.ok && response.result) {
          finalRisk = response.result;
          console.debug("[BizTone] Advanced risk assessment:", finalRisk);
        } else {
          console.warn("[BizTone] Advanced risk assessment failed, using basic assessment");
          finalRisk = quickAssessment;
        }
        
        // Re-evaluate with advanced assessment (might upgrade PASS to CONVERT, etc.)
        const finalKind = finalRisk.whitelisted ? "pass" :
          finalRisk.score <= CONFIG.PREFILTER.PASS_MAX ? "pass" :
          finalRisk.score >= CONFIG.PREFILTER.CONVERT_MIN ? "convert" : "prompt";

        // 1) Low risk after advanced assessment: allow send
        if (finalKind === "pass") {
          setCachedResult(normalizedText, { mode: "send" });
          dispatchEnterKey();
          return;
        }
        
        // 2) High risk: direct conversion without prompt
        if (finalKind === "convert") {
          safeSendMessage({
            type: MESSAGE_TYPES.BIZTONE_CONVERT_TEXT,
            text: normalizedText
          }, (convertResponse) => {
            if (!convertResponse || !convertResponse.ok || !convertResponse.result) {
              const errorMsg = "보내기 보호: 변환 실패 — 다시 시도하거나 문장을 완화해 주세요.";
              showToast(errorMsg);
              
              // Configurable fail-safe: don't auto-send on conversion failure by default
              if (CONFIG.GUARD.FAIL_OPEN_ON_CONVERT_ERROR) {
                console.debug("[BizTone] Fail-open on conversion error enabled, allowing send");
                dispatchEnterKey();
              }
              return;
            }
            
            setCachedResult(normalizedText, { mode: "convert", converted: convertResponse.result });
            
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
          return;
        }
        
        // 3) Medium risk: use AI decision prompt
        safeSendMessage({
          type: MESSAGE_TYPES.BIZTONE_GUARD_DECIDE,
          text: normalizedText
        }, (decisionResponse) => {
          if (!decisionResponse || !decisionResponse.ok) {
            // Configurable fail-safe for decision errors (default: allow send for UX)
            if (CONFIG.GUARD.FAIL_OPEN_ON_DECISION_ERROR) {
              console.debug("[BizTone] Decision failure, fail-open policy allows send");
              dispatchEnterKey();
            } else {
              showToast("보내기 보호: 판정 실패 — 다시 시도해 주세요.");
            }
            return;
          }
          
          if (decisionResponse.action === "send") {
            setCachedResult(normalizedText, { mode: "send" });
            dispatchEnterKey();
            return;
          }
          
          const convertedText = decisionResponse.converted_text || normalizedText;
          setCachedResult(normalizedText, { mode: "convert", converted: convertedText });
          
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
      });

    } finally {
      // Always clear pending state
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
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message?.type) return;

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
          
          const replaced = replaceSelectedText(message.text || "");
          if (replaced) {
            // Show brief success toast instead of bubble
            showToast("변환 완료");
          } else {
            // Fallback to clipboard
            try {
              navigator.clipboard.writeText(message.text || "");
              showToast("클립보드에 복사됨");
            } catch (error) {
              showToast("변환 실패");
            }
          }
          break;

        case MESSAGE_TYPES.BIZTONE_ERROR:
          showErrorBubble(message.error || "오류가 발생했습니다.");
          break;
      }
    });
  }

  console.debug("[BizTone ContentScript] Initialized with hybrid guard system");
})();