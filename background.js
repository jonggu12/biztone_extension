/**
 * BizTone Chrome Extension - Background Script
 * Handles OpenAI API integration, context menus, and message routing
 */

// ==================== CONSTANTS ====================

const CONFIG = {
  MENU_ID: "biztone-convert",
  DEBUG: true,
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
  OPEN_OPTIONS: "OPEN_OPTIONS",
  // Guard mode settings
  BIZTONE_GET_GUARD_MODE: "BIZTONE_GET_GUARD_MODE",
  BIZTONE_GUARD_WARNING: "BIZTONE_GUARD_WARNING",
  // Domain management
  BIZTONE_GET_DOMAIN_STATUS: "BIZTONE_GET_DOMAIN_STATUS",
  BIZTONE_TOGGLE_DOMAIN: "BIZTONE_TOGGLE_DOMAIN",
  BIZTONE_PAUSE_DOMAIN: "BIZTONE_PAUSE_DOMAIN",
  BIZTONE_GET_DOMAIN_RULES: "BIZTONE_GET_DOMAIN_RULES",
  BIZTONE_SET_DOMAIN_RULE: "BIZTONE_SET_DOMAIN_RULE",
  BIZTONE_REMOVE_DOMAIN_RULE: "BIZTONE_REMOVE_DOMAIN_RULE"
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
let guardModeSettings = {
  GUARD_MODE: "warn" // Default: warn mode (recommended)
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Logs debug messages when DEBUG mode is enabled
 * @param {string} context - Context of the debug message
 * @param {...any} args - Arguments to log
 */
function debugLog(context, ...args) {
  if (CONFIG.DEBUG) {
    console.log(`[BizTone ${context}]:`, ...args);
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

/**
 * Loads guard mode settings from storage
 */
async function loadGuardModeSettings() {
  try {
    const result = await chrome.storage.sync.get(['GUARD_MODE']);
    guardModeSettings.GUARD_MODE = result.GUARD_MODE || "warn";
    debugLog("Settings", "Guard mode loaded:", guardModeSettings.GUARD_MODE);
  } catch (error) {
    debugLog("Settings", "Failed to load guard mode settings:", error);
    guardModeSettings.GUARD_MODE = "warn"; // Fallback to default
  }
}

/**
 * Gets current guard mode setting
 * @returns {string} "convert" or "warn"
 */
function getGuardMode() {
  return guardModeSettings.GUARD_MODE || "convert";
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
 * Generate categorized noise-tolerant regex pattern
 */
function generateCategorizedPattern(item) {
  const normalized = normalizeKoreanText(item.word);
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
    original: item.word,
    skeleton,
    pattern: new RegExp(`${noisyPattern}`, 'iu'), // Remove 'g' flag, add 'u' for Unicode
    skeletonPattern: new RegExp(`${skeletonPattern}`, 'iu'),
    category: item.category,
    locale: item.locale,
    weight: getCategoryWeight(item.category)
  };
}

/**
 * Generate noise-tolerant regex pattern (legacy compatibility)
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
 * Get category weight for scoring
 */
function getCategoryWeight(category) {
  const weights = {
    strong: 3,
    slur: 3,
    adult: 2,
    weak: 1
  };
  return weights[category] || 1;
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
    debugLog('PatternCompiler', '🔄 패턴 컴파일 시작...');
    try {
      // Load categorized word list
      const categoriesUrl = chrome.runtime.getURL('data/fword_categories.json');
      debugLog('PatternCompiler', `📂 JSON 파일 로딩 시도: ${categoriesUrl}`);
      const categoriesResponse = await fetch(categoriesUrl);
      
      if (!categoriesResponse.ok) {
        throw new Error(`HTTP ${categoriesResponse.status}: ${categoriesResponse.statusText}`);
      }
      
      const categorizedWords = await categoriesResponse.json();
      debugLog('PatternCompiler', `✅ JSON 로딩 성공: ${categorizedWords.length}개 단어`);
      
      // Generate patterns with category metadata
      const patterns = categorizedWords.map(item => generateCategorizedPattern(item));
      
      // Group by category for optimized lookup
      const categorizedPatterns = {
        strong: patterns.filter(p => p.category === 'strong'),
        weak: patterns.filter(p => p.category === 'weak'),
        adult: patterns.filter(p => p.category === 'adult'),
        slur: patterns.filter(p => p.category === 'slur'),
        ko: patterns.filter(p => p.locale === 'ko'),
        en: patterns.filter(p => p.locale === 'en'),
        all: patterns
      };
      
      debugLog('PatternCompiler', `✅ 패턴 컴파일 완료: ${patterns.length}개 패턴 생성`);
      debugLog('PatternCompiler', `📊 카테고리별 분포:`);
      debugLog('PatternCompiler', `  • STRONG: ${categorizedPatterns.strong.length}개 (가중치 +3)`);
      debugLog('PatternCompiler', `  • ADULT: ${categorizedPatterns.adult.length}개 (가중치 +2)`);
      debugLog('PatternCompiler', `  • SLUR: ${categorizedPatterns.slur.length}개 (가중치 +3)`);
      debugLog('PatternCompiler', `  • WEAK: ${categorizedPatterns.weak.length}개 (가중치 +1)`);
      debugLog('PatternCompiler', `🌐 언어별 분포: 한국어(${categorizedPatterns.ko.length}), 영어(${categorizedPatterns.en.length})`);
      
      compiledPatterns = {
        ...categorizedPatterns,
        compiled: true,
        timestamp: Date.now()
      };
      
      return compiledPatterns;
    } catch (error) {
      debugLog('PatternCompiler', '❌ 카테고리 JSON 로딩 실패:', error);
      debugLog('PatternCompiler', '🔄 기본 fword_list.txt 로딩 시도 중...');
      
      try {
        // Fallback to original fword_list.txt
        const fileUrl = chrome.runtime.getURL('data/fword_list.txt');
        const response = await fetch(fileUrl);
        const rawData = await response.text();
        
        const rawWords = Array.from(new Set(rawData
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))));
        
        debugLog('PatternCompiler', `📄 기본 목록에서 ${rawWords.length}개 단어 로딩됨`);
        
        const fallbackPatterns = rawWords.map(word => generateNoisePattern(word));
        const strongPatterns = fallbackPatterns.filter(p => p.strength === 'strong');
        const weakPatterns = fallbackPatterns.filter(p => p.strength === 'weak');
        
        debugLog('PatternCompiler', `⚠️ Fallback 모드: strong(${strongPatterns.length}), weak(${weakPatterns.length})`);
        
        compiledPatterns = {
          strong: strongPatterns,
          weak: weakPatterns,
          adult: [],
          slur: [],
          ko: fallbackPatterns,
          en: [],
          all: fallbackPatterns,
          compiled: false,
          timestamp: Date.now()
        };
        
        return compiledPatterns;
      } catch (fallbackError) {
        debugLog('PatternCompiler', '❌ Fallback도 실패:', fallbackError);
        
        // Last resort: hardcoded patterns
        const basicWords = [
          {word: '씨발', category: 'strong', locale: 'ko'},
          {word: '시발', category: 'strong', locale: 'ko'},
          {word: '좆', category: 'strong', locale: 'ko'},
          {word: '병신', category: 'strong', locale: 'ko'},
          {word: '개새끼', category: 'strong', locale: 'ko'},
          {word: '미친', category: 'weak', locale: 'ko'}
        ];
        
        const emergencyPatterns = basicWords.map(item => generateCategorizedPattern(item));
        
        debugLog('PatternCompiler', `🚨 비상 모드: ${emergencyPatterns.length}개 하드코딩된 패턴 사용`);
        
        compiledPatterns = {
          strong: emergencyPatterns.filter(p => p.category === 'strong'),
          weak: emergencyPatterns.filter(p => p.category === 'weak'),
          adult: [],
          slur: [],
          ko: emergencyPatterns,
          en: [],
          all: emergencyPatterns,
          compiled: false,
          timestamp: Date.now()
        };
        
        return compiledPatterns;
      }
    }
  })();
  
  return patternCompilationPromise;
}

/**
 * Advanced risk assessment algorithm V2 with categorized patterns and detailed logging
 */
async function calculateAdvancedRiskScore(text) {
  const normalized = normalizeKoreanText(text);
  const skeleton = extractKoreanSkeleton(normalized);
  
  debugLog('RiskAssessment', '='.repeat(60));
  debugLog('RiskAssessment', `📊 점수 계산 시작: "${text}"`);
  debugLog('RiskAssessment', `📝 정규화 텍스트: "${normalized}"`);
  debugLog('RiskAssessment', `🔤 한글 스켈레톤: "${skeleton}"`);
  
  if (!normalized) {
    debugLog('RiskAssessment', '❌ 정규화된 텍스트가 없어서 점수 0 반환');
    return { score: 0, matches: [], contextual: { score: 0, factors: [] } };
  }
  
  const patterns = await loadAndCompilePatterns();
  let score = 0;
  let matches = [];
  let categoryStats = { strong: 0, weak: 0, adult: 0, slur: 0 };
  
  debugLog('RiskAssessment', `🎯 패턴 검사 시작: 총 ${patterns.all.length}개 패턴`);
  
  // Check all patterns with their specific weights
  for (const pattern of patterns.all) {
    const directMatch = pattern.pattern.test(normalized);
    const skeletonMatch = pattern.skeletonPattern.test(skeleton);
    
    if (directMatch || skeletonMatch) {
      score += pattern.weight;
      categoryStats[pattern.category]++;
      
      const matchType = directMatch ? '직접' : '스켈레톤';
      debugLog('RiskAssessment', `🚨 매칭됨: "${pattern.original}" (${pattern.category}/${pattern.locale}, +${pattern.weight}점, ${matchType})`);
      
      matches.push({ 
        word: pattern.word, 
        original: pattern.original,
        category: pattern.category, 
        locale: pattern.locale,
        weight: pattern.weight,
        type: directMatch ? 'direct' : 'skeleton',
        matchedBy: directMatch ? 'normalized' : 'skeleton'
      });
    }
  }
  
  debugLog('RiskAssessment', `📈 패턴 매칭 완료: ${matches.length}개 일치`);
  debugLog('RiskAssessment', `📊 카테고리별 매칭: strong(${categoryStats.strong}), adult(${categoryStats.adult}), slur(${categoryStats.slur}), weak(${categoryStats.weak})`);
  debugLog('RiskAssessment', `🎯 현재 점수 (패턴): ${score}점`);
  
  // Additional context scoring
  const contextScore = calculateContextualRisk(text);
  const patternScore = score;
  score += contextScore.score;
  
  debugLog('RiskAssessment', `🔍 문맥 분석 완료: +${contextScore.score}점`);
  if (contextScore.factors.length > 0) {
    debugLog('RiskAssessment', `📋 문맥 요소들: ${contextScore.factors.join(', ')}`);
  }
  
  const finalScore = Math.min(score, 10);
  debugLog('RiskAssessment', `🎯 최종 점수: ${finalScore}점 (패턴: ${patternScore}점 + 문맥: ${contextScore.score}점 = ${score}점, 최대 10점)`);
  
  // 점수 기준 판정
  let riskLevel = 'LOW';
  if (finalScore >= 4) riskLevel = 'HIGH';
  else if (finalScore >= 2) riskLevel = 'MEDIUM';
  
  debugLog('RiskAssessment', `⚠️ 위험도: ${riskLevel} (기준: 0-1=LOW, 2-3=MEDIUM, 4+=HIGH)`);
  debugLog('RiskAssessment', '='.repeat(60));
  
  return {
    score: finalScore,
    matches,
    contextual: contextScore,
    normalized,
    skeleton,
    categoryStats,
    riskLevel,
    breakdown: {
      patternScore,
      contextScore: contextScore.score,
      totalScore: score,
      finalScore
    }
  };
}

/**
 * Calculate contextual risk factors with detailed logging
 */
function calculateContextualRisk(text) {
  let score = 0;
  const factors = [];
  
  debugLog('ContextAnalysis', `🔍 문맥 분석 시작: "${text}"`);
  
  // Excessive punctuation
  const exclamationCount = (text.match(/!+/g) || []).length;
  const questionCount = (text.match(/\?+/g) || []).length;
  
  if (exclamationCount >= 2) {
    score += 0.5;
    factors.push('excessive_exclamation');
    debugLog('ContextAnalysis', `❗ 과도한 느낌표 발견: ${exclamationCount}개, +0.5점`);
  }
  
  if (questionCount >= 2) {
    score += 0.5;
    factors.push('excessive_question');
    debugLog('ContextAnalysis', `❓ 과도한 물음표 발견: ${questionCount}개, +0.5점`);
  }
  
  if (text.includes('?!') || text.includes('!?')) {
    score += 0.5;
    factors.push('mixed_punctuation');
    debugLog('ContextAnalysis', `‼️ 혼합 구두점 발견: +0.5점`);
  }
  
  // Aggressive words
  const aggressivePatterns = ['당장', '빨리', '책임져', '최악', '짜증', '열받', '죽을'];
  for (const word of aggressivePatterns) {
    if (text.includes(word)) {
      score += 0.3;
      factors.push(`aggressive_${word}`);
      debugLog('ContextAnalysis', `🔥 공격적 단어 발견: "${word}", +0.3점`);
    }
  }
  
  // Excessive uppercase (for mixed content)
  const letters = (text.match(/[A-Za-z]/g) || []);
  const uppercase = (text.match(/[A-Z]/g) || []);
  if (letters.length >= 6 && uppercase.length / letters.length >= 0.5) {
    score += 0.5;
    factors.push('excessive_caps');
    debugLog('ContextAnalysis', `🔠 과도한 대문자 발견: ${uppercase.length}/${letters.length}, +0.5점`);
  }
  
  debugLog('ContextAnalysis', `✅ 문맥 분석 완료: ${score}점 (${factors.length}개 요소)`);
  
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
  console.log(`📨 safeSendMessage: tab=${tabId}, type=${message.type}, frame=${frameId || 'top'}`);
  
  // Also send debug info to content script if it's a debug scenario
  if (message.type === MESSAGE_TYPES.BIZTONE_REPLACE_WITH) {
    // Add debug metadata to the message
    message.__debug_info = {
      timestamp: Date.now(),
      source: 'background-keyboard-shortcut',
      tabId,
      frameId: frameId || 'top'
    };
  }
  
  return new Promise((resolve) => {
    let resolved = false; // Prevent multiple resolutions
    
    const safeResolve = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      } else {
        console.log(`⚠️ safeSendMessage: Prevented duplicate resolution for ${message.type}`);
      }
    };

    const handleCallback = (response) => {
      if (chrome.runtime.lastError) {
        console.log(`❌ First attempt failed: ${chrome.runtime.lastError.message}`);
        
        // Only try fallback if not already resolved
        if (!resolved) {
          try {
            chrome.tabs.sendMessage(tabId, message, (fallbackResponse) => {
              if (chrome.runtime.lastError) {
                console.log(`❌ Fallback failed: ${chrome.runtime.lastError.message}`);
                safeResolve(false);
              } else {
                console.log(`✅ Fallback succeeded`);
                safeResolve(true);
              }
            });
          } catch (error) {
            console.log(`❌ Fallback exception:`, error);
            safeResolve(false);
          }
        }
      } else {
        console.log(`✅ First attempt succeeded`);
        safeResolve(true);
      }
    };

    try {
      const options = typeof frameId === "number" ? { frameId } : undefined;
      console.log(`📨 Sending message with options:`, options);
      chrome.tabs.sendMessage(tabId, message, options, handleCallback);
    } catch (error) {
      console.log(`❌ Primary exception:`, error);
      safeResolve(false);
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
    console.log(`💫 Injecting content script into tab ${tabId} (allFrames: true)`);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["contentScript.js"],
      injectImmediately: true
    });
    console.log(`✅ Content script injection successful - ${results?.length || 0} frames affected`);
    if (results?.length > 1) {
      console.warn(`⚠️ MULTIPLE FRAMES DETECTED: ${results.length} frames! This might cause duplicate execution.`);
      results.forEach((result, i) => {
        console.log(`   Frame ${i}: ${result.frameId || 'main'}, URL: ${result.documentId || 'unknown'}`);
      });
    }
  } catch (error) {
    console.warn(`❌ Content script injection failed for tab ${tabId}:`, error?.message);
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

규칙:
- 감정적 표현을 중립적이고 객관적으로 변경
- 명령형을 정중한 요청형으로 변경  
- 비속어나 부적절한 표현을 적절한 비즈니스 용어로 대체
- 한국어 존댓말과 비즈니스 매너를 반영
- 원문의 핵심 의미는 유지하되 톤만 개선

중요: 변환된 문장만 출력하고, "변경하겠습니다", "로 수정합니다" 등의 설명은 절대 포함하지 마세요.`;

  const userPrompt = `다음 문장을 비즈니스 톤으로 변환하되, 변환된 문장만 출력하세요:

${text}

변환된 문장:`;

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

문장: ${text}`;

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

      case MESSAGE_TYPES.BIZTONE_GET_DOMAIN_STATUS:
        await handleGetDomainStatus(message, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_TOGGLE_DOMAIN:
        await handleToggleDomain(message, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_PAUSE_DOMAIN:
        await handlePauseDomain(message, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_GET_DOMAIN_RULES:
        await handleGetDomainRules(message, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_SET_DOMAIN_RULE:
        await handleSetDomainRule(message, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_REMOVE_DOMAIN_RULE:
        await handleRemoveDomainRule(message, sendResponse);
        break;

      case MESSAGE_TYPES.BIZTONE_GET_GUARD_MODE:
        sendResponse(createSuccessResponse({ guardMode: getGuardMode() }));
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
let commandCount = 0;
chrome.commands.onCommand.addListener(async (command) => {
  commandCount++;
  const timestamp = Date.now();
  console.log(`🎯 BACKGROUND COMMAND #${commandCount}: "${command}" at ${timestamp}`);
  
  if (command !== "convert-selection") {
    console.log(`❌ Ignoring unknown command: ${command}`);
    return;
  }

  // Debounce rapid key presses
  const now = Date.now();
  const gap = debounceTimestamp ? now - debounceTimestamp : 'FIRST';
  console.log(`🕒 Debounce check: gap=${gap}ms, threshold=${CONFIG.DEBOUNCE_MS}ms, count=${commandCount}`);
  
  if (typeof gap === 'number' && gap < CONFIG.DEBOUNCE_MS) {
    console.warn(`❌ DEBOUNCED: Command #${commandCount} ignored (gap: ${gap}ms < ${CONFIG.DEBOUNCE_MS}ms)`);
    return;
  }
  debounceTimestamp = now;
  console.log(`✅ Processing command #${commandCount}...`);

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    console.log(`❌ No active tab found`);
    return;
  }
  
  console.log(`🎯 Active tab: ${activeTab.id} - ${activeTab.url}`);

  // Ensure content script is ready
  console.log(`📋 Ensuring content listener for tab ${activeTab.id}...`);
  const hasListener = await ensureContentListener(activeTab.id);
  if (!hasListener) {
    console.warn(`❌ Failed to ensure content listener for tab ${activeTab.id}`);
    return;
  }
  console.log(`✅ Content listener ready for tab ${activeTab.id}`);

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
  console.log(`🔄 Converting text: "${selection.text?.slice(0, 50)}..."`);
  try {
    const convertedText = await convertToBusinessTone(selection.text, model, key);
    console.log(`✅ Conversion successful: "${convertedText?.slice(0, 50)}..."`);
    console.log(`📨 Sending REPLACE_WITH message to tab ${activeTab.id}, frame ${selection.frameId || 'top'}`);
    
    const messageSent = await safeSendMessage(activeTab.id, {
      type: MESSAGE_TYPES.BIZTONE_REPLACE_WITH,
      text: convertedText
    }, selection.frameId);
    
    console.log(`📨 Message sent result: ${messageSent}`);
  } catch (error) {
    await safeSendMessage(activeTab.id, {
      type: MESSAGE_TYPES.BIZTONE_ERROR,
      error: String(error.message || error)
    }, selection.frameId);
  }
});

// Listen for storage changes to reload guard mode settings
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.GUARD_MODE) {
    const newValue = changes.GUARD_MODE.newValue;
    debugLog("Settings", "Guard mode changed to:", newValue);
    guardModeSettings.GUARD_MODE = newValue || "convert";
  }
});

debugLog("Init", "Background script initialized");

// ==================== DOMAIN RULES MESSAGE HANDLERS ====================

/**
 * Handle get domain status message
 */
async function handleGetDomainStatus(message, sendResponse) {
  try {
    const domain = message.domain;
    if (!domain) {
      return sendResponse(createErrorResponse('Domain not provided'));
    }
    
    const status = await getDomainStatus(domain);
    sendResponse(createSuccessResponse(status));
  } catch (error) {
    debugLog('DomainHandler', 'Get status failed:', error);
    sendResponse(createErrorResponse('Failed to get domain status'));
  }
}

/**
 * Handle toggle domain message
 */
async function handleToggleDomain(message, sendResponse) {
  try {
    const domain = message.domain;
    if (!domain) {
      return sendResponse(createErrorResponse('Domain not provided'));
    }
    
    const newEnabled = await toggleDomainEnabled(domain);
    const status = await getDomainStatus(domain);
    
    sendResponse(createSuccessResponse({ 
      ...status, 
      toggled: true, 
      newEnabled 
    }));
  } catch (error) {
    debugLog('DomainHandler', 'Toggle failed:', error);
    sendResponse(createErrorResponse('Failed to toggle domain'));
  }
}

/**
 * Handle pause domain message
 */
async function handlePauseDomain(message, sendResponse) {
  try {
    const { domain, minutes } = message;
    if (!domain || !minutes) {
      return sendResponse(createErrorResponse('Domain or minutes not provided'));
    }
    
    await pauseDomain(domain, minutes);
    const status = await getDomainStatus(domain);
    
    sendResponse(createSuccessResponse({ 
      ...status, 
      paused: true, 
      pausedFor: minutes 
    }));
  } catch (error) {
    debugLog('DomainHandler', 'Pause failed:', error);
    sendResponse(createErrorResponse('Failed to pause domain'));
  }
}

/**
 * Handle get domain rules message
 */
async function handleGetDomainRules(message, sendResponse) {
  try {
    const rules = await getDomainRules();
    sendResponse(createSuccessResponse(rules));
  } catch (error) {
    debugLog('DomainHandler', 'Get rules failed:', error);
    sendResponse(createErrorResponse('Failed to get domain rules'));
  }
}

/**
 * Handle set domain rule message
 */
async function handleSetDomainRule(message, sendResponse) {
  try {
    const { domain, options } = message;
    if (!domain) {
      return sendResponse(createErrorResponse('Domain not provided'));
    }
    
    const success = await setDomainRule(domain, options);
    if (success) {
      const status = await getDomainStatus(domain);
      sendResponse(createSuccessResponse(status));
    } else {
      sendResponse(createErrorResponse('Failed to save domain rule'));
    }
  } catch (error) {
    debugLog('DomainHandler', 'Set rule failed:', error);
    sendResponse(createErrorResponse('Failed to set domain rule'));
  }
}

/**
 * Handle remove domain rule message
 */
async function handleRemoveDomainRule(message, sendResponse) {
  try {
    const domain = message.domain;
    if (!domain) {
      return sendResponse(createErrorResponse('Domain not provided'));
    }
    
    const success = await removeDomainRule(domain);
    if (success) {
      const status = await getDomainStatus(domain);
      sendResponse(createSuccessResponse({ 
        ...status, 
        removed: true 
      }));
    } else {
      sendResponse(createErrorResponse('Failed to remove domain rule'));
    }
  } catch (error) {
    debugLog('DomainHandler', 'Remove rule failed:', error);
    sendResponse(createErrorResponse('Failed to remove domain rule'));
  }
}

// ==================== DOMAIN RULES MANAGEMENT ====================

/**
 * Domain rules storage key
 */
const DOMAIN_RULES_KEY = 'BIZTONE_DOMAIN_RULES';

/**
 * Get domain from URL
 */
function getDomainFromUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.toLowerCase();
  } catch (error) {
    debugLog('DomainRules', `Invalid URL: ${url}`);
    return null;
  }
}

/**
 * Get domain rules from storage
 */
async function getDomainRules() {
  try {
    const result = await chrome.storage.sync.get([DOMAIN_RULES_KEY]);
    return result[DOMAIN_RULES_KEY] || {};
  } catch (error) {
    debugLog('DomainRules', 'Failed to get domain rules:', error);
    return {};
  }
}

/**
 * Save domain rules to storage
 */
async function saveDomainRules(rules) {
  try {
    await chrome.storage.sync.set({ [DOMAIN_RULES_KEY]: rules });
    debugLog('DomainRules', '✅ Domain rules saved successfully');
    return true;
  } catch (error) {
    debugLog('DomainRules', '❌ Failed to save domain rules:', error);
    return false;
  }
}

/**
 * Check if BizTone is enabled for a domain
 */
async function isDomainEnabled(domain) {
  if (!domain) return true; // Default enabled
  
  const rules = await getDomainRules();
  const rule = rules[domain];
  
  if (!rule) return true; // Default enabled for new domains
  
  // Check if paused
  if (rule.pauseUntil && rule.pauseUntil > Date.now()) {
    debugLog('DomainRules', `🔇 Domain ${domain} is paused until ${new Date(rule.pauseUntil)}`);
    return false;
  }
  
  // Check enabled flag
  const enabled = rule.enabled !== false; // Default true
  debugLog('DomainRules', `🎯 Domain ${domain} is ${enabled ? 'enabled' : 'disabled'}`);
  return enabled;
}

/**
 * Set domain rule
 */
async function setDomainRule(domain, options = {}) {
  const rules = await getDomainRules();
  
  const defaultRule = {
    enabled: true,
    mode: 'guard',
    pauseUntil: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  rules[domain] = {
    ...defaultRule,
    ...rules[domain], // Keep existing data
    ...options, // Apply new options
    updatedAt: Date.now()
  };
  
  debugLog('DomainRules', `🔧 Set rule for ${domain}:`, rules[domain]);
  return await saveDomainRules(rules);
}

/**
 * Remove domain rule (revert to default enabled)
 */
async function removeDomainRule(domain) {
  const rules = await getDomainRules();
  if (rules[domain]) {
    delete rules[domain];
    debugLog('DomainRules', `🗑️ Removed rule for ${domain}`);
    return await saveDomainRules(rules);
  }
  return true;
}

/**
 * Pause domain for specific duration
 */
async function pauseDomain(domain, minutes) {
  const pauseUntil = Date.now() + (minutes * 60 * 1000);
  return await setDomainRule(domain, { 
    pauseUntil,
    enabled: true // Keep enabled, just paused
  });
}

/**
 * Resume domain (clear pause)
 */
async function resumeDomain(domain) {
  return await setDomainRule(domain, { 
    pauseUntil: 0 
  });
}

/**
 * Toggle domain enabled status
 */
async function toggleDomainEnabled(domain) {
  const rules = await getDomainRules();
  const currentRule = rules[domain] || { enabled: true };
  const newEnabled = !currentRule.enabled;
  
  await setDomainRule(domain, { 
    enabled: newEnabled,
    pauseUntil: 0 // Clear any pause when toggling
  });
  
  debugLog('DomainRules', `🔄 Toggled ${domain}: ${newEnabled ? 'ON' : 'OFF'}`);
  return newEnabled;
}

/**
 * Get domain status for popup/UI
 */
async function getDomainStatus(domain) {
  if (!domain) return { enabled: true, paused: false, rule: null };
  
  const rules = await getDomainRules();
  const rule = rules[domain];
  
  if (!rule) {
    return { 
      enabled: true, 
      paused: false, 
      rule: null,
      domain 
    };
  }
  
  const now = Date.now();
  const paused = rule.pauseUntil && rule.pauseUntil > now;
  const pauseRemaining = paused ? Math.ceil((rule.pauseUntil - now) / (60 * 1000)) : 0;
  
  return {
    enabled: rule.enabled !== false,
    paused,
    pauseRemaining,
    rule,
    domain
  };
}

// ==================== STARTUP PATTERN COMPILATION ====================

/**
 * Pre-compile patterns on extension startup for optimal performance
 */
(async () => {
  try {
    debugLog("Startup", "🚀 Starting initialization...");
    const startTime = Date.now();
    
    // Load settings first
    await loadGuardModeSettings();
    
    // Then compile patterns
    await loadAndCompilePatterns();
    
    const duration = Date.now() - startTime;
    debugLog("Startup", `✅ Initialization completed in ${duration}ms`);
    debugLog("Startup", `📊 Ready for zero-latency guard operations with ${getGuardMode()} mode`);
  } catch (error) {
    debugLog("Startup", "⚠️ Initialization failed:", error);
  }
})();