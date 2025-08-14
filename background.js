/**
 * BizTone Chrome Extension - Background Script
 * Handles OpenAI API integration, context menus, and message routing
 */

// ==================== CONSTANTS ====================

const CONFIG = {
  MENU_ID: "biztone-convert",
  DEBUG: false,
  DEBOUNCE_MS: 400,
  DEFAULT_MODEL: "gpt-4o-mini",
  OPENAI_API_URL: "https://api.openai.com/v1/chat/completions"
};

const MESSAGE_TYPES = {
  BIZTONE_PING: "BIZTONE_PING",
  BIZTONE_LOADING: "BIZTONE_LOADING",
  BIZTONE_RESULT: "BIZTONE_RESULT",
  BIZTONE_ERROR: "BIZTONE_ERROR",
  BIZTONE_REPLACE_WITH: "BIZTONE_REPLACE_WITH",
  BIZTONE_TEST_CONVERT: "BIZTONE_TEST_CONVERT",
  BIZTONE_GUARD_DECIDE: "BIZTONE_GUARD_DECIDE",
  BIZTONE_CONVERT_TEXT: "BIZTONE_CONVERT_TEXT",
  BIZTONE_ADVANCED_RISK: "BIZTONE_ADVANCED_RISK",
  OPEN_OPTIONS: "OPEN_OPTIONS"
};

const ERROR_MESSAGES = {
  NO_SELECTION: "선택된 텍스트가 없습니다.",
  NO_API_KEY: "API Key가 설정되지 않았습니다. 설정에서 입력해 주세요.",
  CONVERSION_FAILED: "변환에 실패했습니다. 다시 시도해 주세요."
};

// ==================== GLOBAL STATE ====================

let debounceTimestamp = 0;
let compiledPatterns = null;
let patternCompilationPromise = null;

// ==================== UTILITY FUNCTIONS ====================

/**
 * Logs debug messages when DEBUG mode is enabled
 * @param {string} context - Context of the debug message
 * @param {...any} args - Arguments to log
 */
function debugLog(context, ...args) {
  if (CONFIG.DEBUG) {
    console.debug(`[BizTone ${context}]:`, ...args);
  }
}

/**
 * Creates a standardized error response
 * @param {string} message - Error message
 * @param {Error} [error] - Original error object
 * @returns {Object} Error response object
 */
function createErrorResponse(message, error = null) {
  debugLog("Error", message, error);
  return {
    ok: false,
    error: message
  };
}

/**
 * Creates a standardized success response
 * @param {any} result - Result data
 * @returns {Object} Success response object
 */
function createSuccessResponse(result) {
  return {
    ok: true,
    result
  };
}

// ==================== ADVANCED PROFANITY FILTERING SYSTEM ====================

/**
 * Korean text normalization and preprocessing
 */
function normalizeKoreanText(text) {
  return text
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width characters
    .replace(/[\u0300-\u036F]/g, '') // Remove combining diacritical marks
    .replace(/[\s\-_.~!@#$%^&*()+={}[\]|\\:;"'<>,.?/]/g, '') // Remove separators
    .normalize('NFD');
}

/**
 * Extract Korean consonant skeleton (초성/종성)
 */
function extractKoreanSkeleton(text) {
  const result = [];
  
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    const code = char.charCodeAt(0);
    
    // Korean syllable range (가-힣)
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const syllableIndex = code - 0xAC00;
      const initialIndex = Math.floor(syllableIndex / 588); // 초성
      const finalIndex = syllableIndex % 28; // 종성
      
      // Initial consonants (ㄱ-ㅎ)
      const initials = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
      const finals = ['','ㄱ','ㄲ','ㄱㅅ','ㄴ','ㄴㅈ','ㄴㅎ','ㄷ','ㄹ','ㄹㄱ','ㄹㅁ','ㄹㅂ','ㄹㅅ','ㄹㅌ','ㄹㅍ','ㄹㅎ','ㅁ','ㅂ','ㅂㅅ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
      
      result.push(initials[initialIndex]);
      if (finalIndex > 0) {
        result.push(finals[finalIndex]);
      }
    }
    // Korean consonants (ㄱ-ㅎ)
    else if ((code >= 0x3131 && code <= 0x3163)) {
      result.push(char);
    }
    // Keep other characters as-is for mixed content
    else {
      result.push(char);
    }
  }
  
  return result.join('');
}

/**
 * Generate noise-tolerant regex pattern
 */
function generateNoisePattern(word) {
  const normalized = normalizeKoreanText(word);
  const skeleton = extractKoreanSkeleton(normalized);
  
  // Enhanced noise pattern with broader Unicode categories
  const noise = '[\\p{Z}\\p{P}\\p{S}\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]*';
  
  // Create pattern with noise tolerance
  const noisyPattern = normalized
    .split('')
    .map(char => escapeRegex(char))
    .join(noise);
    
  // Also create skeleton pattern for advanced detection
  const skeletonPattern = skeleton
    .split('')
    .map(char => escapeRegex(char))
    .join(noise);
    
  return {
    word: normalized,
    skeleton,
    pattern: new RegExp(`${noisyPattern}`, 'iu'), // Remove 'g' flag, add 'u' for Unicode
    skeletonPattern: new RegExp(`${skeletonPattern}`, 'iu'),
    strength: classifyWordStrength(word)
  };
}

/**
 * Escape regex special characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Classify word strength (strong vs weak patterns)
 */
function classifyWordStrength(word) {
  const strongIndicators = ['씨발', '시발', '좆', '병신', '개새끼', '꺼져'];
  const isStrong = strongIndicators.some(indicator => 
    normalizeKoreanText(word).includes(normalizeKoreanText(indicator))
  );
  return isStrong ? 'strong' : 'weak';
}

/**
 * Load and compile profanity patterns
 */
async function loadAndCompilePatterns() {
  if (compiledPatterns) {
    return compiledPatterns;
  }
  
  if (patternCompilationPromise) {
    return patternCompilationPromise;
  }
  
  patternCompilationPromise = (async () => {
    try {
      // Load raw word list
      const fileUrl = chrome.runtime.getURL('data/fword_list.txt');
      const response = await fetch(fileUrl);
      const rawData = await response.text();
      
      // Parse and process words with CRLF support and deduplication
      const rawWords = Array.from(new Set(rawData
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))));
      
      // Generate patterns with metadata
      const patterns = rawWords.map(word => generateNoisePattern(word));
      
      // Separate by strength
      const strongPatterns = patterns.filter(p => p.strength === 'strong');
      const weakPatterns = patterns.filter(p => p.strength === 'weak');
      
      debugLog('PatternCompiler', `Compiled ${patterns.length} patterns (${strongPatterns.length} strong, ${weakPatterns.length} weak)`);
      
      compiledPatterns = {
        strong: strongPatterns,
        weak: weakPatterns,
        all: patterns,
        compiled: true,
        timestamp: Date.now()
      };
      
      return compiledPatterns;
    } catch (error) {
      debugLog('PatternCompiler', 'Pattern compilation failed:', error);
      
      // Fallback to basic patterns
      const basicWords = ['씨발', '시발', '좆', '병신', '개새끼', '미친'];
      const fallbackPatterns = basicWords.map(word => generateNoisePattern(word));
      
      compiledPatterns = {
        strong: fallbackPatterns,
        weak: [],
        all: fallbackPatterns,
        compiled: false,
        timestamp: Date.now()
      };
      
      return compiledPatterns;
    }
  })();
  
  return patternCompilationPromise;
}

/**
 * Advanced risk assessment algorithm V2
 */
async function calculateAdvancedRiskScore(text) {
  const normalized = normalizeKoreanText(text);
  const skeleton = extractKoreanSkeleton(normalized);
  
  if (!normalized) return { score: 0, matches: [], contextual: { score: 0, factors: [] } };
  
  const patterns = await loadAndCompilePatterns();
  let score = 0;
  let matches = [];
  
  // Strong pattern matching (high weight)
  for (const pattern of patterns.strong) {
    if (pattern.pattern.test(normalized) || pattern.skeletonPattern.test(skeleton)) {
      score += 3;
      matches.push({ word: pattern.word, strength: 'strong', type: 'direct' });
    }
  }
  
  // Weak pattern matching (lower weight)
  for (const pattern of patterns.weak) {
    if (pattern.pattern.test(normalized) || pattern.skeletonPattern.test(skeleton)) {
      score += 1.5;
      matches.push({ word: pattern.word, strength: 'weak', type: 'direct' });
    }
  }
  
  // Additional context scoring
  const contextScore = calculateContextualRisk(text);
  score += contextScore.score;
  
  debugLog('AdvancedRisk', `Text: "${text}" → Score: ${score}, Matches:`, matches);
  
  return {
    score: Math.min(score, 10), // Cap at 10
    matches,
    contextual: contextScore,
    normalized,
    skeleton
  };
}

/**
 * Calculate contextual risk factors
 */
function calculateContextualRisk(text) {
  let score = 0;
  const factors = [];
  
  // Excessive punctuation
  const exclamationCount = (text.match(/!+/g) || []).length;
  const questionCount = (text.match(/\?+/g) || []).length;
  
  if (exclamationCount >= 2) {
    score += 0.5;
    factors.push('excessive_exclamation');
  }
  
  if (questionCount >= 2) {
    score += 0.5;
    factors.push('excessive_question');
  }
  
  if (text.includes('?!') || text.includes('!?')) {
    score += 0.5;
    factors.push('mixed_punctuation');
  }
  
  // Aggressive words
  const aggressivePatterns = ['당장', '빨리', '책임져', '최악', '짜증', '열받', '죽을'];
  for (const word of aggressivePatterns) {
    if (text.includes(word)) {
      score += 0.3;
      factors.push(`aggressive_${word}`);
    }
  }
  
  // Excessive uppercase (for mixed content)
  const letters = (text.match(/[A-Za-z]/g) || []);
  const uppercase = (text.match(/[A-Z]/g) || []);
  if (letters.length >= 6 && uppercase.length / letters.length >= 0.5) {
    score += 0.5;
    factors.push('excessive_caps');
  }
  
  return { score, factors };
}

// ==================== STORAGE & WHITELIST SYSTEM ====================

/**
 * Load whitelist from storage with default seeds
 */
async function loadWhitelist() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['BIZTONE_WHITELIST'], (result) => {
      // Default seed words that should never be flagged
      const seed = ["시발점", "始發", "시발역", "출발점", "미친 듯이", "미친 척", "개발자", "개같이", "열받아"];
      const userWhitelist = Array.isArray(result.BIZTONE_WHITELIST) ? result.BIZTONE_WHITELIST : [];
      const merged = Array.from(new Set([...seed, ...userWhitelist]));
      resolve(merged);
    });
  });
}

/**
 * Save whitelist to storage
 */
async function saveWhitelist(whitelist) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ 'BIZTONE_WHITELIST': whitelist }, resolve);
  });
}

/**
 * Check if text is whitelisted
 */
async function isTextWhitelisted(text) {
  const whitelist = await loadWhitelist();
  const normalized = normalizeKoreanText(text);
  
  return whitelist.some(whitelistItem => {
    const normalizedItem = normalizeKoreanText(whitelistItem);
    return normalized.includes(normalizedItem) || normalizedItem.includes(normalized);
  });
}

/**
 * Enhanced risk assessment with whitelist check
 */
async function calculateAdvancedRiskScoreWithWhitelist(text) {
  // Check whitelist first
  if (await isTextWhitelisted(text)) {
    debugLog('AdvancedRisk', `Text whitelisted: "${text}"`);
    return {
      score: 0,
      matches: [],
      contextual: { score: 0, factors: [] },
      whitelisted: true
    };
  }
  
  // Proceed with normal risk assessment
  const result = await calculateAdvancedRiskScore(text);
  return { ...result, whitelisted: false };
}

// ==================== CHROME EXTENSION UTILITIES ====================

/**
 * Safely sends a message to content script with fallback handling
 * @param {number} tabId - Tab ID to send message to
 * @param {Object} message - Message to send
 * @param {number} [frameId] - Optional frame ID
 * @returns {Promise<boolean>} Success status
 */
async function safeSendMessage(tabId, message, frameId = undefined) {
  return new Promise((resolve) => {
    const handleCallback = () => {
      if (chrome.runtime.lastError) {
        debugLog("SendMessage", "First attempt failed:", chrome.runtime.lastError.message);
        // Fallback to top frame
        try {
          chrome.tabs.sendMessage(tabId, message, () => {
            if (chrome.runtime.lastError) {
              debugLog("SendMessage", "Fallback failed:", chrome.runtime.lastError.message);
              resolve(false);
            } else {
              resolve(true);
            }
          });
        } catch (error) {
          debugLog("SendMessage", "Fallback exception:", error);
          resolve(false);
        }
      } else {
        resolve(true);
      }
    };

    try {
      const options = typeof frameId === "number" ? { frameId } : undefined;
      chrome.tabs.sendMessage(tabId, message, options, handleCallback);
    } catch (error) {
      debugLog("SendMessage", "Primary exception:", error);
      // Final fallback
      try {
        chrome.tabs.sendMessage(tabId, message, () => {
          if (chrome.runtime.lastError) {
            debugLog("SendMessage", "Final fallback failed:", chrome.runtime.lastError.message);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      } catch (finalError) {
        debugLog("SendMessage", "Final fallback exception:", finalError);
        resolve(false);
      }
    }
  });
}

/**
 * Injects content script into specified tab
 * @param {number} tabId - Tab ID to inject into
 * @throws {Error} When injection fails on restricted pages
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["contentScript.js"],
      injectImmediately: true
    });
    debugLog("ContentScript", `Injected into tab ${tabId}`);
  } catch (error) {
    debugLog("ContentScript", `Injection failed for tab ${tabId}:`, error?.message);
    throw new Error(`Content script injection failed: ${error?.message || error}`);
  }
}

/**
 * Pings content script to check if it's responsive
 * @param {number} tabId - Tab ID to ping
 * @param {number} [frameId] - Optional frame ID
 * @returns {Promise<boolean>} Whether content script responded
 */
async function pingContentScript(tabId, frameId = undefined) {
  return new Promise((resolve) => {
    try {
      const options = typeof frameId === "number" ? { frameId } : undefined;
      chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.BIZTONE_PING }, options, (response) => {
        resolve(!chrome.runtime.lastError && Boolean(response?.ok));
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Ensures content script listener is available, injecting if necessary
 * @param {number} tabId - Tab ID to ensure listener for
 * @param {number} [frameId] - Optional frame ID
 * @returns {Promise<boolean>} Whether listener is available
 */
async function ensureContentListener(tabId, frameId = undefined) {
  // Check if already available
  if (await pingContentScript(tabId, frameId) || await pingContentScript(tabId)) {
    return true;
  }

  // Inject if not available
  try {
    await ensureContentScript(tabId);
  } catch {
    return false;
  }

  // Verify injection worked
  return await pingContentScript(tabId, frameId) || await pingContentScript(tabId);
}

// ==================== STORAGE & CONFIG ====================

/**
 * Retrieves API configuration from storage
 * @returns {Promise<{key: string|null, model: string}>} API configuration
 */
async function getApiConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["OPENAI_API_KEY", "OPENAI_MODEL"], (result) => {
      const rawKey = result.OPENAI_API_KEY || "";
      const cleanKey = rawKey.replace(/^(['"])+|(['"])+$/g, "").trim() || null;
      
      resolve({
        key: cleanKey,
        model: result.OPENAI_MODEL || CONFIG.DEFAULT_MODEL
      });
    });
  });
}

// ==================== OPENAI API INTEGRATION ====================

/**
 * Makes a request to OpenAI API with timeout and retry logic
 * @param {Object} requestBody - Request body for OpenAI API
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<Object>} API response data
 * @throws {Error} When API request fails
 */
async function callOpenAI(requestBody, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
  
  let attempt = 0;
  let response;
  
  try {
    while (attempt < 3) {
      attempt++;
      
      try {
        response = await fetch(CONFIG.OPENAI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        
        // Break if not rate limited
        if (response.status !== 429) break;
        
        // Exponential backoff for rate limit
        const delay = 500 * attempt * attempt; // 0.5s, 2s, 4.5s
        debugLog("OpenAI", `Rate limited (429), retrying in ${delay}ms (attempt ${attempt}/3)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error('OpenAI API request timeout (15s)');
        }
        if (attempt === 3) throw error;
        
        // Network error backoff
        const delay = 1000 * attempt;
        debugLog("OpenAI", `Network error, retrying in ${delay}ms (attempt ${attempt}/3):`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    return response.json();
    
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

/**
 * Converts text to professional business tone
 * @param {string} text - Text to convert
 * @param {string} model - OpenAI model to use
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<string>} Converted text
 */
async function convertToBusinessTone(text, model, apiKey) {
  const systemPrompt = `너는 한국 직장 문화에 익숙한 '비즈니스 커뮤니케이션 전문가'다.
역할: 입력된 문장을 정중하고 전문적인 비즈니스 톤으로 변환한다.
- 감정적 표현을 중립적이고 객관적으로 변경
- 명령형을 정중한 요청형으로 변경  
- 비속어나 부적절한 표현을 적절한 비즈니스 용어로 대체
- 한국어 존댓말과 비즈니스 매너를 반영
- 원문의 핵심 의미는 유지하되 톤만 개선
- 결과는 간결하고 명확하게 (150자 내외)`;

  const userPrompt = `다음 문장을 정중한 비즈니스 톤으로 변환해 주세요:

"""${text}"""`;

  const requestBody = {
    model: model || CONFIG.DEFAULT_MODEL,
    temperature: 0.3,
    max_tokens: 200, // Limit response length for cost control
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  try {
    const data = await callOpenAI(requestBody, apiKey);
    const result = data?.choices?.[0]?.message?.content || text;
    return result.trim();
  } catch (error) {
    debugLog("ConvertTone", "Conversion failed:", error);
    throw new Error(`텍스트 변환 실패: ${error.message}`);
  }
}

/**
 * Uses AI to decide whether text should be sent as-is or converted
 * @param {string} text - Text to analyze
 * @param {string} model - OpenAI model to use  
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<Object>} Decision result with action and optional converted text
 */
async function decideTextAction(text, model, apiKey) {
  const systemPrompt = `너는 한국 직장 문화에 익숙한 '비즈니스 커뮤니케이션 가드'다.
역할: 입력 문장이 '그대로 보내도 안전한지' 또는 '비즈니스 톤으로 변환해야 하는지'를 결정한다.
출력은 반드시 JSON 한 줄로만 한다.`;

  const userPrompt = `다음 문장을 평가해라.
- 안전 판단 기준 예시: 비속어/모욕/공격/비난, 과도한 명령/책임전가, 과격한 감정 표현 등.
- 안전하면 action:"send", 아니면 action:"convert".
- convert일 때만 converted_text에 정중하고 간결(한국 비즈니스 톤, ~150자)하게 변환한 결과를 넣어라.
- rationale은 1줄 한국어로 아주 간단히.

문장: """${text}"""`;

  const requestBody = {
    model: model || CONFIG.DEFAULT_MODEL,
    temperature: 0.0,
    max_tokens: 150, // JSON response should be compact
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  try {
    const data = await callOpenAI(requestBody, apiKey);
    const rawResponse = data?.choices?.[0]?.message?.content || "{}";
    
    let parsed;
    try {
      parsed = JSON.parse(rawResponse);
    } catch {
      parsed = {};
    }

    // Validate and normalize response
    const action = (parsed.action === "convert" || parsed.action === "send") ? parsed.action : "send";
    
    return {
      action,
      converted_text: parsed.converted_text || "",
      label: parsed.label || "",
      rationale: parsed.rationale || ""
    };
  } catch (error) {
    debugLog("DecideAction", "Decision failed:", error);
    // Fail-safe: default to sending as-is
    return {
      action: "send",
      converted_text: "",
      label: "",
      rationale: "결정 실패로 인한 안전 모드"
    };
  }
}

// ==================== SELECTION EXTRACTION ====================

/**
 * Extracts selected text from all frames in a tab
 * @param {number} tabId - Tab ID to extract from
 * @returns {Promise<Object>} Selection info with text, frameId, and kind
 */
async function getSelectionFromAllFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        try {
          // Check input/textarea selection first
          const activeElement = document.activeElement;
          if (activeElement && 
              (activeElement.tagName === "TEXTAREA" || 
               (activeElement.tagName === "INPUT" && activeElement.type === "text"))) {
            const { selectionStart, selectionEnd } = activeElement;
            if (typeof selectionStart === "number" && typeof selectionEnd === "number" && 
                selectionStart !== selectionEnd) {
              return { 
                text: activeElement.value.slice(selectionStart, selectionEnd), 
                kind: "input" 
              };
            }
          }

          // Check DOM selection
          const selection = window.getSelection && window.getSelection();
          const text = selection && selection.rangeCount ? String(selection).trim() : "";
          return { text, kind: "dom" };
        } catch (error) {
          return { text: "", kind: "error" };
        }
      }
    });

    // Find first non-empty selection
    for (const result of results || []) {
      if (result?.result?.text?.trim()) {
        return {
          text: result.result.text.trim(),
          frameId: result.frameId || undefined,
          kind: result.result.kind
        };
      }
    }

    return { text: "", frameId: undefined, kind: "none" };
  } catch (error) {
    debugLog("Selection", "Failed to extract selection:", error);
    return { text: "", frameId: undefined, kind: "error" };
  }
}

// ==================== MESSAGE HANDLERS ====================

/**
 * Handles text conversion requests
 * @param {string} text - Text to convert
 * @param {Function} sendResponse - Response callback
 */
async function handleTextConversion(text, sendResponse) {
  const { key, model } = await getApiConfig();
  
  if (!key) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.NO_API_KEY));
    chrome.runtime.openOptionsPage();
    return;
  }

  try {
    const result = await convertToBusinessTone(text || "", model, key);
    sendResponse(createSuccessResponse(result));
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.CONVERSION_FAILED));
  }
}

/**
 * Handles guard decision requests  
 * @param {string} text - Text to analyze
 * @param {Function} sendResponse - Response callback
 */
async function handleGuardDecision(text, sendResponse) {
  const { key, model } = await getApiConfig();
  
  if (!key) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.NO_API_KEY));
    chrome.runtime.openOptionsPage();
    return;
  }

  try {
    const result = await decideTextAction(String(text || ""), model, key);
    sendResponse({ ok: true, ...result });
  } catch (error) {
    sendResponse(createErrorResponse("결정 실패"));
  }
}

/**
 * Handles advanced risk assessment requests
 * @param {string} text - Text to analyze
 * @param {Function} sendResponse - Response callback
 */
async function handleAdvancedRiskAssessment(text, sendResponse) {
  try {
    const result = await calculateAdvancedRiskScoreWithWhitelist(String(text || ""));
    sendResponse(createSuccessResponse(result));
  } catch (error) {
    debugLog("AdvancedRisk", "Assessment failed:", error);
    sendResponse(createErrorResponse("위험도 평가 실패"));
  }
}

// ==================== EVENT LISTENERS ====================

// Initialize context menu on extension install
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({
      id: CONFIG.MENU_ID,
      title: "비즈니스 문장으로 변경",
      contexts: ["selection"]
    });
    debugLog("Init", "Context menu created");
  } catch (error) {
    debugLog("Init", "Context menu creation failed (may already exist):", error);
  }
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONFIG.MENU_ID || !tab?.id) return;

  const selectedText = (info.selectionText || "").trim();
  if (!selectedText) {
    await safeSendMessage(tab.id, { 
      type: MESSAGE_TYPES.BIZTONE_ERROR, 
      error: ERROR_MESSAGES.NO_SELECTION 
    }, info.frameId);
    return;
  }

  const { key, model } = await getApiConfig();
  if (!key) {
    await safeSendMessage(tab.id, { 
      type: MESSAGE_TYPES.BIZTONE_ERROR, 
      error: ERROR_MESSAGES.NO_API_KEY 
    }, info.frameId);
    chrome.runtime.openOptionsPage();
    return;
  }

  // Show loading indicator
  await safeSendMessage(tab.id, { 
    type: MESSAGE_TYPES.BIZTONE_LOADING 
  }, info.frameId);

  try {
    const result = await convertToBusinessTone(selectedText, model, key);
    await safeSendMessage(tab.id, { 
      type: MESSAGE_TYPES.BIZTONE_RESULT, 
      result 
    }, info.frameId);
  } catch (error) {
    await safeSendMessage(tab.id, { 
      type: MESSAGE_TYPES.BIZTONE_ERROR, 
      error: String(error.message || error) 
    }, info.frameId);
  }
});

// Handle runtime messages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message?.type) return;

    switch (message.type) {
      case MESSAGE_TYPES.BIZTONE_TEST_CONVERT:
      case MESSAGE_TYPES.BIZTONE_CONVERT_TEXT:
        await handleTextConversion(message.text, sendResponse);
        break;

      case MESSAGE_TYPES.BIZTONE_GUARD_DECIDE:
        await handleGuardDecision(message.text, sendResponse);
        break;

      case MESSAGE_TYPES.BIZTONE_ADVANCED_RISK:
        await handleAdvancedRiskAssessment(message.text, sendResponse);
        break;

      case MESSAGE_TYPES.OPEN_OPTIONS:
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;

      default:
        debugLog("Message", "Unknown message type:", message.type);
    }
  })();

  return true; // Indicates async response
});

// Handle keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "convert-selection") return;

  // Debounce rapid key presses
  const now = Date.now();
  if (now - debounceTimestamp < CONFIG.DEBOUNCE_MS) return;
  debounceTimestamp = now;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) return;

  // Ensure content script is ready
  const hasListener = await ensureContentListener(activeTab.id);
  if (!hasListener) {
    debugLog("Shortcut", "Failed to ensure content listener");
    return;
  }

  // Get selected text
  const selection = await getSelectionFromAllFrames(activeTab.id);
  if (!selection.text) {
    await safeSendMessage(activeTab.id, {
      type: MESSAGE_TYPES.BIZTONE_ERROR,
      error: ERROR_MESSAGES.NO_SELECTION
    }, selection.frameId);
    return;
  }

  // Check API configuration
  const { key, model } = await getApiConfig();
  if (!key) {
    await safeSendMessage(activeTab.id, {
      type: MESSAGE_TYPES.BIZTONE_ERROR,
      error: ERROR_MESSAGES.NO_API_KEY
    }, selection.frameId);
    chrome.runtime.openOptionsPage();
    return;
  }

  // Convert and replace text directly
  try {
    const convertedText = await convertToBusinessTone(selection.text, model, key);
    await safeSendMessage(activeTab.id, {
      type: MESSAGE_TYPES.BIZTONE_REPLACE_WITH,
      text: convertedText
    }, selection.frameId);
  } catch (error) {
    await safeSendMessage(activeTab.id, {
      type: MESSAGE_TYPES.BIZTONE_ERROR,
      error: String(error.message || error)
    }, selection.frameId);
  }
});

debugLog("Init", "Background script initialized");