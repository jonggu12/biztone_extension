/**
 * BizTone Chrome Extension - Background Script
 * Enterprise-grade profanity filtering and business tone conversion
 * 
 * @author BizTone Team
 * @version 2.0
 * @description Handles OpenAI API integration, Korean profanity detection, and message routing
 */

// ==================== CONFIGURATION ====================

/**
 * Main configuration object
 * @readonly
 */
const CONFIG = {
  MENU_ID: "biztone-convert",
  DEBOUNCE_MS: 400,
  DEFAULT_MODEL: "gpt-4o-mini",
  OPENAI_API_URL: "https://api.openai.com/v1/chat/completions",
  
  // Performance settings
  API_TIMEOUT_MS: 15000,
  MAX_RETRIES: 3,
  RATE_LIMIT_DELAY: 500,
  
  // Cache settings
  GUARD_MODE_CACHE_MS: 30000
};

/**
 * Message type constants for inter-script communication
 * @readonly
 */
const MESSAGE_TYPES = {
  // Core functionality
  BIZTONE_PING: "BIZTONE_PING",
  BIZTONE_LOADING: "BIZTONE_LOADING",
  BIZTONE_RESULT: "BIZTONE_RESULT",
  BIZTONE_ERROR: "BIZTONE_ERROR",
  BIZTONE_REPLACE_WITH: "BIZTONE_REPLACE_WITH",
  
  // Text processing
  BIZTONE_TEST_CONVERT: "BIZTONE_TEST_CONVERT",
  BIZTONE_CONVERT_TEXT: "BIZTONE_CONVERT_TEXT",
  BIZTONE_GUARD_DECIDE: "BIZTONE_GUARD_DECIDE",
  BIZTONE_ADVANCED_RISK: "BIZTONE_ADVANCED_RISK",
  
  // Settings and configuration
  BIZTONE_GET_GUARD_MODE: "BIZTONE_GET_GUARD_MODE",
  BIZTONE_GUARD_WARNING: "BIZTONE_GUARD_WARNING",
  BIZTONE_GET_PROFANITY_DATA: "BIZTONE_GET_PROFANITY_DATA",
  
  // Whitelist/Blacklist management
  BIZTONE_GET_WHITELIST: "BIZTONE_GET_WHITELIST",
  BIZTONE_SET_WHITELIST: "BIZTONE_SET_WHITELIST",
  BIZTONE_ADD_WHITELIST_ITEM: "BIZTONE_ADD_WHITELIST_ITEM",
  BIZTONE_REMOVE_WHITELIST_ITEM: "BIZTONE_REMOVE_WHITELIST_ITEM",
  BIZTONE_GET_BLACKLIST: "BIZTONE_GET_BLACKLIST",
  BIZTONE_SET_BLACKLIST: "BIZTONE_SET_BLACKLIST",
  BIZTONE_ADD_BLACKLIST_ITEM: "BIZTONE_ADD_BLACKLIST_ITEM",
  BIZTONE_REMOVE_BLACKLIST_ITEM: "BIZTONE_REMOVE_BLACKLIST_ITEM",
  
  // Domain management
  BIZTONE_GET_DOMAIN_STATUS: "BIZTONE_GET_DOMAIN_STATUS",
  BIZTONE_TOGGLE_DOMAIN: "BIZTONE_TOGGLE_DOMAIN",
  BIZTONE_PAUSE_DOMAIN: "BIZTONE_PAUSE_DOMAIN",
  BIZTONE_GET_DOMAIN_RULES: "BIZTONE_GET_DOMAIN_RULES",
  BIZTONE_SET_DOMAIN_RULE: "BIZTONE_SET_DOMAIN_RULE",
  BIZTONE_REMOVE_DOMAIN_RULE: "BIZTONE_REMOVE_DOMAIN_RULE",
  
  // System
  OPEN_OPTIONS: "OPEN_OPTIONS"
};

/**
 * Localized error messages
 * @readonly
 */
const ERROR_MESSAGES = {
  NO_SELECTION: "선택된 텍스트가 없습니다.",
  NO_API_KEY: "API Key가 설정되지 않았습니다. 설정에서 입력해 주세요.",
  CONVERSION_FAILED: "변환에 실패했습니다. 다시 시도해 주세요.",
  RISK_ASSESSMENT_FAILED: "위험도 평가 실패",
  DECISION_FAILED: "결정 실패",
  DOMAIN_OPERATION_FAILED: "도메인 작업 실패",
  WHITELIST_OPERATION_FAILED: "화이트리스트 작업 실패",
  BLACKLIST_OPERATION_FAILED: "블랙리스트 작업 실패"
};

/**
 * Constants for whitelist/blacklist management
 * @readonly
 */
const LIST_CONSTANTS = {
  STORAGE_KEYS: {
    WHITELIST: 'BIZTONE_WHITELIST',
    BLACKLIST: 'BIZTONE_BLACKLIST'
  },
  MATCH_TYPES: {
    EXACT: 'exact',
    CONTAINS: 'contains', 
    REGEX: 'regex'
  },
  LOCALES: {
    KOREAN: 'ko',
    ENGLISH: 'en',
    ALL: 'all'
  },
  WEIGHTS: {
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    VERY_HIGH: 4
  }
};

// ==================== STATE MANAGEMENT ====================

/**
 * Application state manager
 */
class BizToneState {
  constructor() {
    this.debounceTimestamp = 0;
    this.compiledPatterns = null;
    this.patternCompilationPromise = null;
    this.profanityCategoriesCache = null;
    this.guardModeSettings = {
      GUARD_MODE: "warn" // Default: warn mode (recommended)
    };
  }
  
  /**
   * Reset compilation state
   */
  resetPatterns() {
    this.compiledPatterns = null;
    this.patternCompilationPromise = null;
    this.profanityCategoriesCache = null;
  }
  
  /**
   * Check if debounce period has passed
   * @param {number} threshold - Debounce threshold in ms
   * @returns {boolean}
   */
  shouldDebounce(threshold = CONFIG.DEBOUNCE_MS) {
    const now = Date.now();
    const gap = this.debounceTimestamp ? now - this.debounceTimestamp : threshold;
    
    if (gap < threshold) {
      return true;
    }
    
    this.debounceTimestamp = now;
    return false;
  }
}

// Global state instance
const state = new BizToneState();

// ==================== ERROR HANDLING ====================

/**
 * Custom error classes for better error handling
 */
class BizToneError extends Error {
  constructor(message, code = 'UNKNOWN') {
    super(message);
    this.name = 'BizToneError';
    this.code = code;
  }
}

class APIError extends BizToneError {
  constructor(message, statusCode = 0) {
    super(message, 'API_ERROR');
    this.statusCode = statusCode;
  }
}

class ValidationError extends BizToneError {
  constructor(message) {
    super(message, 'VALIDATION_ERROR');
  }
}

// ==================== API SERVICE ====================

/**
 * OpenAI API service with enhanced error handling and retry logic
 */
class OpenAIService {
  constructor() {
    this.baseURL = CONFIG.OPENAI_API_URL;
    this.timeout = CONFIG.API_TIMEOUT_MS;
    this.maxRetries = CONFIG.MAX_RETRIES;
  }
  
  /**
   * Makes authenticated request to OpenAI API
   * @param {Object} requestBody - Request payload
   * @param {string} apiKey - API key
   * @returns {Promise<Object>} API response
   */
  async makeRequest(requestBody, apiKey) {
    if (!apiKey) {
      throw new ValidationError(ERROR_MESSAGES.NO_API_KEY);
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const response = await fetch(this.baseURL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
          });
          
          if (response.status !== 429) {
            if (!response.ok) {
              const errorText = await response.text();
              throw new APIError(`OpenAI API error (${response.status}): ${errorText}`, response.status);
            }
            return await response.json();
          }
          
          // Handle rate limiting with exponential backoff
          if (attempt < this.maxRetries) {
            const delay = CONFIG.RATE_LIMIT_DELAY * attempt * attempt;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } catch (error) {
          if (error.name === 'AbortError') {
            throw new APIError('OpenAI API request timeout');
          }
          if (attempt === this.maxRetries) throw error;
          
          // Network error backoff
          const delay = 1000 * attempt;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  
  /**
   * Convert text to business tone
   * @param {string} text - Text to convert
   * @param {string} model - Model to use
   * @param {string} apiKey - API key
   * @returns {Promise<string>} Converted text
   */
  async convertToBusinessTone(text, model, apiKey) {
    const requestBody = {
      model: model || CONFIG.DEFAULT_MODEL,
      temperature: 0.3,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `너는 한국 직장 문화에 익숙한 '비즈니스 커뮤니케이션 전문가'다.
역할: 입력된 문장을 정중하고 전문적인 비즈니스 톤으로 변환한다.

규칙:
- 감정적 표현을 중립적이고 객관적으로 변경
- 명령형을 정중한 요청형으로 변경  
- 비속어나 부적절한 표현을 적절한 비즈니스 용어로 대체
- 한국어 존댓말과 비즈니스 매너를 반영
- 원문의 핵심 의미는 유지하되 톤만 개선

중요: 변환된 문장만 출력하고, "변경하겠습니다", "로 수정합니다" 등의 설명은 절대 포함하지 마세요.`
        },
        {
          role: "user",
          content: `다음 문장을 비즈니스 톤으로 변환하되, 변환된 문장만 출력하세요:

${text}

변환된 문장:`
        }
      ]
    };
    
    try {
      const data = await this.makeRequest(requestBody, apiKey);
      const result = data?.choices?.[0]?.message?.content || text;
      return result.trim();
    } catch (error) {
      throw new BizToneError(`텍스트 변환 실패: ${error.message}`);
    }
  }
  
  /**
   * Decide whether to send or convert text
   * @param {string} text - Text to analyze
   * @param {string} model - Model to use
   * @param {string} apiKey - API key
   * @returns {Promise<Object>} Decision result
   */
  async decideTextAction(text, model, apiKey) {
    const requestBody = {
      model: model || CONFIG.DEFAULT_MODEL,
      temperature: 0.0,
      max_tokens: 150,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `너는 한국 직장 문화에 익숙한 '비즈니스 커뮤니케이션 가드'다.
역할: 입력 문장이 '그대로 보내도 안전한지' 또는 '비즈니스 톤으로 변환해야 하는지'를 결정한다.
출력은 반드시 JSON 한 줄로만 한다.`
        },
        {
          role: "user",
          content: `{"action": "send" 또는 "convert", "label": "적절함" 또는 "부적절함", "rationale": "1줄 이유", "converted_text": "변환된 텍스트"}

- convert일 때만 converted_text에 정중하고 간결(한국 비즈니스 톤, ~150자)하게 변환한 결과를 넣어라.
- rationale은 1줄 한국어로 아주 간단히.

문장: ${text}`
        }
      ]
    };
    
    try {
      const data = await this.makeRequest(requestBody, apiKey);
      const rawResponse = data?.choices?.[0]?.message?.content || "{}";
      
      let parsed;
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        parsed = {};
      }
      
      const action = (parsed.action === "convert" || parsed.action === "send") ? parsed.action : "send";
      
      return {
        action,
        converted_text: parsed.converted_text || "",
        label: parsed.label || "",
        rationale: parsed.rationale || ""
      };
    } catch (error) {
      // Fail-safe: default to sending as-is
      return {
        action: "send",
        converted_text: "",
        label: "",
        rationale: "결정 실패로 인한 안전 모드"
      };
    }
  }
}

// Global API service instance
const openAIService = new OpenAIService();

// ==================== WHITELIST/BLACKLIST MANAGEMENT ====================

/**
 * Whitelist/Blacklist management service
 */
class ListManager {
  constructor() {
    this.whitelistCache = null;
    this.blacklistCache = null;
    this.cacheTimeout = 30000; // 30 seconds
    this.lastWhitelistUpdate = 0;
    this.lastBlacklistUpdate = 0;
  }
  
  /**
   * Validates list item structure
   * @param {Object} item - List item to validate
   * @param {boolean} isBlacklist - Whether this is for blacklist (needs weight)
   * @returns {boolean} True if valid
   */
  validateListItem(item, isBlacklist = false) {
    if (!item || typeof item !== 'object') return false;
    if (!item.text || typeof item.text !== 'string') return false;
    if (!Object.values(LIST_CONSTANTS.MATCH_TYPES).includes(item.match)) return false;
    if (!Object.values(LIST_CONSTANTS.LOCALES).includes(item.locale)) return false;
    
    if (isBlacklist) {
      if (!Object.values(LIST_CONSTANTS.WEIGHTS).includes(item.weight)) return false;
    }
    
    return true;
  }
  
  /**
   * Creates a normalized list item
   * @param {string} text - Text to match
   * @param {string} match - Match type
   * @param {string} locale - Locale
   * @param {number} weight - Weight (blacklist only)
   * @returns {Object} Normalized item
   */
  createListItem(text, match = LIST_CONSTANTS.MATCH_TYPES.CONTAINS, locale = LIST_CONSTANTS.LOCALES.ALL, weight = null) {
    const item = {
      text: text.trim(),
      match,
      locale,
      createdAt: Date.now(),
      id: this.generateId()
    };
    
    if (weight !== null) {
      item.weight = weight;
    }
    
    return item;
  }
  
  /**
   * Generates unique ID for list items
   * @returns {string} Unique ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
  
  /**
   * Gets whitelist from storage with caching
   * @returns {Promise<Array>} Whitelist items
   */
  async getWhitelist() {
    const now = Date.now();
    
    if (this.whitelistCache && (now - this.lastWhitelistUpdate) < this.cacheTimeout) {
      return this.whitelistCache;
    }
    
    try {
      const result = await chrome.storage.sync.get([LIST_CONSTANTS.STORAGE_KEYS.WHITELIST]);
      const whitelist = result[LIST_CONSTANTS.STORAGE_KEYS.WHITELIST] || [];
      
      this.whitelistCache = whitelist;
      this.lastWhitelistUpdate = now;
      
      return whitelist;
    } catch (error) {
      return [];
    }
  }
  
  /**
   * Gets blacklist from storage with caching
   * @returns {Promise<Array>} Blacklist items
   */
  async getBlacklist() {
    const now = Date.now();
    
    if (this.blacklistCache && (now - this.lastBlacklistUpdate) < this.cacheTimeout) {
      return this.blacklistCache;
    }
    
    try {
      const result = await chrome.storage.sync.get([LIST_CONSTANTS.STORAGE_KEYS.BLACKLIST]);
      const blacklist = result[LIST_CONSTANTS.STORAGE_KEYS.BLACKLIST] || [];
      
      this.blacklistCache = blacklist;
      this.lastBlacklistUpdate = now;
      
      return blacklist;
    } catch (error) {
      return [];
    }
  }
  
  /**
   * Saves whitelist to storage
   * @param {Array} whitelist - Whitelist items
   * @returns {Promise<boolean>} Success status
   */
  async saveWhitelist(whitelist) {
    try {
      await chrome.storage.sync.set({ [LIST_CONSTANTS.STORAGE_KEYS.WHITELIST]: whitelist });
      this.whitelistCache = whitelist;
      this.lastWhitelistUpdate = Date.now();
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Saves blacklist to storage
   * @param {Array} blacklist - Blacklist items
   * @returns {Promise<boolean>} Success status
   */
  async saveBlacklist(blacklist) {
    try {
      await chrome.storage.sync.set({ [LIST_CONSTANTS.STORAGE_KEYS.BLACKLIST]: blacklist });
      this.blacklistCache = blacklist;
      this.lastBlacklistUpdate = Date.now();
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Adds item to whitelist
   * @param {Object} item - Item to add
   * @returns {Promise<boolean>} Success status
   */
  async addWhitelistItem(item) {
    if (!this.validateListItem(item, false)) {
      return false;
    }
    
    const whitelist = await this.getWhitelist();
    
    // Check for duplicates
    const isDuplicate = whitelist.some(existing => 
      existing.text === item.text && existing.match === item.match && existing.locale === item.locale
    );
    
    if (isDuplicate) {
      return false;
    }
    
    whitelist.push(item);
    return await this.saveWhitelist(whitelist);
  }
  
  /**
   * Adds item to blacklist
   * @param {Object} item - Item to add
   * @returns {Promise<boolean>} Success status
   */
  async addBlacklistItem(item) {
    if (!this.validateListItem(item, true)) {
      return false;
    }
    
    const blacklist = await this.getBlacklist();
    
    // Check for duplicates
    const isDuplicate = blacklist.some(existing => 
      existing.text === item.text && existing.match === item.match && existing.locale === item.locale
    );
    
    if (isDuplicate) {
      return false;
    }
    
    blacklist.push(item);
    return await this.saveBlacklist(blacklist);
  }
  
  /**
   * Removes item from whitelist by ID
   * @param {string} itemId - Item ID to remove
   * @returns {Promise<boolean>} Success status
   */
  async removeWhitelistItem(itemId) {
    const whitelist = await this.getWhitelist();
    const filteredList = whitelist.filter(item => item.id !== itemId);
    
    if (filteredList.length === whitelist.length) {
      return false; // Item not found
    }
    
    return await this.saveWhitelist(filteredList);
  }
  
  /**
   * Removes item from blacklist by ID
   * @param {string} itemId - Item ID to remove
   * @returns {Promise<boolean>} Success status
   */
  async removeBlacklistItem(itemId) {
    const blacklist = await this.getBlacklist();
    const filteredList = blacklist.filter(item => item.id !== itemId);
    
    if (filteredList.length === blacklist.length) {
      return false; // Item not found
    }
    
    return await this.saveBlacklist(filteredList);
  }
  
  /**
   * Checks if text matches whitelist
   * @param {string} text - Text to check
   * @param {string} locale - Text locale
   * @returns {Promise<boolean>} True if whitelisted
   */
  async isTextWhitelisted(text, locale = LIST_CONSTANTS.LOCALES.ALL) {
    const whitelist = await this.getWhitelist();
    const normalizedText = TextUtils.normalizeText(text).toLowerCase();
    
    return whitelist.some(item => {
      // Check locale match
      if (item.locale !== LIST_CONSTANTS.LOCALES.ALL && item.locale !== locale) {
        return false;
      }
      
      const itemText = item.text.toLowerCase();
      
      switch (item.match) {
        case LIST_CONSTANTS.MATCH_TYPES.EXACT:
          return normalizedText === itemText;
        case LIST_CONSTANTS.MATCH_TYPES.CONTAINS:
          return normalizedText.includes(itemText) || itemText.includes(normalizedText);
        case LIST_CONSTANTS.MATCH_TYPES.REGEX:
          try {
            const regex = new RegExp(item.text, 'i');
            return regex.test(normalizedText);
          } catch {
            return false;
          }
        default:
          return false;
      }
    });
  }
  
  /**
   * Gets blacklist matches and their weights
   * @param {string} text - Text to check
   * @param {string} locale - Text locale
   * @returns {Promise<Array>} Array of matches with weights
   */
  async getBlacklistMatches(text, locale = LIST_CONSTANTS.LOCALES.ALL) {
    const blacklist = await this.getBlacklist();
    const normalizedText = TextUtils.normalizeText(text).toLowerCase();
    const matches = [];
    
    blacklist.forEach(item => {
      // Check locale match
      if (item.locale !== LIST_CONSTANTS.LOCALES.ALL && item.locale !== locale) {
        return;
      }
      
      const itemText = item.text.toLowerCase();
      let isMatch = false;
      
      switch (item.match) {
        case LIST_CONSTANTS.MATCH_TYPES.EXACT:
          isMatch = normalizedText === itemText;
          break;
        case LIST_CONSTANTS.MATCH_TYPES.CONTAINS:
          isMatch = normalizedText.includes(itemText);
          break;
        case LIST_CONSTANTS.MATCH_TYPES.REGEX:
          try {
            const regex = new RegExp(item.text, 'i');
            isMatch = regex.test(normalizedText);
          } catch {
            isMatch = false;
          }
          break;
      }
      
      if (isMatch) {
        matches.push({
          item,
          weight: item.weight,
          matchedText: itemText
        });
      }
    });
    
    return matches;
  }
  
  /**
   * Clears all caches
   */
  clearCache() {
    this.whitelistCache = null;
    this.blacklistCache = null;
    this.lastWhitelistUpdate = 0;
    this.lastBlacklistUpdate = 0;
  }
}

// Global list manager instance
const listManager = new ListManager();

// ==================== DATA LOADING ====================

/**
 * Loads and parses profanity categories from JSON file
 * @returns {Promise<Object>} Categories object with strong, weak, adult, slur arrays
 */
async function loadProfanityCategories() {
  if (state.profanityCategoriesCache) {
    return state.profanityCategoriesCache;
  }

  try {
    const response = await fetch(chrome.runtime.getURL('data/fword_categories.json'));
    const data = await response.json();
    
    // Organize by category
    const categories = {
      strong: [],
      weak: [],
      adult: [],
      slur: []
    };
    
    data.forEach(item => {
      if (item.word && item.category && categories[item.category]) {
        categories[item.category].push(item.word);
      }
    });
    
    state.profanityCategoriesCache = categories;
    
    return categories;
  } catch (error) {
    return {
      strong: [],
      weak: [],
      adult: [],
      slur: []
    };
  }
}

// ==================== UTILITY FUNCTIONS ====================

// ==================== UTILITY FUNCTIONS ====================

/**
 * Text normalization utilities
 */
class TextUtils {
  /**
   * Normalizes text by trimming and collapsing whitespace
   * @param {string} text - Text to normalize
   * @returns {string} Normalized text
   */
  static normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }
  
  /**
   * Normalizes Korean text for profanity detection
   * @param {string} text - Korean text to normalize
   * @returns {string} Normalized Korean text
   */
  static normalizeKoreanText(text) {
    return text
      .toLowerCase()
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width characters
      .replace(/[\u0300-\u036F]/g, '') // Remove combining diacritical marks
      .replace(/[\s\-_.~!@#$%^&*()+={}[\]|\\:;"'<>,.?/]/g, '') // Remove separators
      .normalize('NFD');
  }
  
  /**
   * Escapes regex special characters
   * @param {string} string - String to escape
   * @returns {string} Escaped string
   */
  static escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * Logs debug messages when DEBUG mode is enabled
 * @param {string} context - Context of the debug message
 * @param {...any} args - Arguments to log
 */
function debugLog(context, ...args) {
  // Debug logging disabled for production
}

/**
 * Creates a standardized error response
 * @param {string} message - Error message
 * @param {Error} [error] - Original error object
 * @returns {Object} Error response object
 */
function createErrorResponse(message, error = null) {
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
 * @returns {Promise<void>}
 */
async function loadGuardModeSettings() {
  try {
    const result = await chrome.storage.sync.get(['GUARD_MODE']);
    state.guardModeSettings.GUARD_MODE = result.GUARD_MODE || "warn";
  } catch (error) {
    state.guardModeSettings.GUARD_MODE = "warn"; // Fallback to default
  }
}

/**
 * Gets current guard mode setting
 * @returns {string} "convert" or "warn"
 */
function getGuardMode() {
  return state.guardModeSettings.GUARD_MODE || "warn";
}

// ==================== ADVANCED PROFANITY FILTERING SYSTEM ====================


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
  const normalized = TextUtils.normalizeKoreanText(item.word);
  const skeleton = extractKoreanSkeleton(normalized);
  
  // Enhanced noise pattern with broader Unicode categories
  const noise = '[\\p{Z}\\p{P}\\p{S}\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]*';
  
  // Create pattern with noise tolerance
  const noisyPattern = normalized
    .split('')
    .map(char => TextUtils.escapeRegex(char))
    .join(noise);
    
  // Also create skeleton pattern for advanced detection
  const skeletonPattern = skeleton
    .split('')
    .map(char => TextUtils.escapeRegex(char))
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
  const normalized = TextUtils.normalizeKoreanText(word);
  const skeleton = extractKoreanSkeleton(normalized);
  
  // Enhanced noise pattern with broader Unicode categories
  const noise = '[\\p{Z}\\p{P}\\p{S}\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]*';
  
  // Create pattern with noise tolerance
  const noisyPattern = normalized
    .split('')
    .map(char => TextUtils.escapeRegex(char))
    .join(noise);
    
  // Also create skeleton pattern for advanced detection
  const skeletonPattern = skeleton
    .split('')
    .map(char => TextUtils.escapeRegex(char))
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
    strong: 4,
    slur: 4,
    adult: 2,
    weak: 1
  };
  return weights[category] || 1;
}


/**
 * Classify word strength (strong vs weak patterns)
 */
function classifyWordStrength(word) {
  const strongIndicators = ['씨발', '시발', '좆', '병신', '개새끼', '꺼져'];
  const isStrong = strongIndicators.some(indicator => 
    TextUtils.normalizeKoreanText(word).includes(TextUtils.normalizeKoreanText(indicator))
  );
  return isStrong ? 'strong' : 'weak';
}

/**
 * Load and compile profanity patterns
 */
async function loadAndCompilePatterns() {
  if (state.compiledPatterns) {
    return state.compiledPatterns;
  }
  
  if (state.patternCompilationPromise) {
    return state.patternCompilationPromise;
  }
  
  state.patternCompilationPromise = (async () => {
    try {
      // Load categorized word list
      const categoriesUrl = chrome.runtime.getURL('data/fword_categories.json');
      const categoriesResponse = await fetch(categoriesUrl);
      
      if (!categoriesResponse.ok) {
        throw new Error(`HTTP ${categoriesResponse.status}: ${categoriesResponse.statusText}`);
      }
      
      const categorizedWords = await categoriesResponse.json();
      
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
      
      
      state.compiledPatterns = {
        ...categorizedPatterns,
        compiled: true,
        timestamp: Date.now()
      };
      
      return state.compiledPatterns;
    } catch (error) {
      
      try {
        // Fallback to original fword_list.txt
        const fileUrl = chrome.runtime.getURL('data/fword_list.txt');
        const response = await fetch(fileUrl);
        const rawData = await response.text();
        
        const rawWords = Array.from(new Set(rawData
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'))));
        
        const fallbackPatterns = rawWords.map(word => generateNoisePattern(word));
        const strongPatterns = fallbackPatterns.filter(p => p.strength === 'strong');
        const weakPatterns = fallbackPatterns.filter(p => p.strength === 'weak');
        
        state.compiledPatterns = {
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
        
        return state.compiledPatterns;
      } catch (fallbackError) {
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
        
        state.compiledPatterns = {
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
        
        return state.compiledPatterns;
      }
    }
  })();
  
  return state.patternCompilationPromise;
}

/**
 * Advanced risk assessment algorithm with categorized Korean profanity detection
 * 
 * Uses compiled regex patterns to detect various categories of inappropriate content:
 * - Strong profanity (weight: 3 points)
 * - Slurs (weight: 3 points) 
 * - Adult content (weight: 2 points)
 * - Weak profanity (weight: 1 point)
 * 
 * @param {string} text - Text to analyze for risk factors
 * @returns {Promise<Object>} Risk assessment result
 * @property {number} result.score - Final risk score (0-10)
 * @property {Array} result.matches - Array of detected profanity matches
 * @property {Object} result.contextual - Contextual risk factors
 * @property {string} result.riskLevel - 'LOW', 'MEDIUM', or 'HIGH'
 * @property {Object} result.categoryStats - Count of matches by category
 * @example
 * // Usage
 * const result = await calculateAdvancedRiskScore("안녕하세요");
 * console.log(result.score); // 0
 * console.log(result.riskLevel); // 'LOW'
 */
async function calculateAdvancedRiskScore(text) {
  const normalized = TextUtils.normalizeKoreanText(text);
  const skeleton = extractKoreanSkeleton(normalized);
  
  if (!normalized) {
    return { score: 0, matches: [], contextual: { score: 0, factors: [] } };
  }
  
  const patterns = await loadAndCompilePatterns();
  let score = 0;
  let matches = [];
  let categoryStats = { strong: 0, weak: 0, adult: 0, slur: 0 };
  
  // Check all patterns with their specific weights
  for (const pattern of patterns.all) {
    const directMatch = pattern.pattern.test(normalized);
    const skeletonMatch = pattern.skeletonPattern.test(skeleton);
    
    if (directMatch || skeletonMatch) {
      score += pattern.weight;
      categoryStats[pattern.category]++;
      
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
  
  // Additional context scoring
  const contextScore = calculateContextualRisk(text);
  const patternScore = score;
  score += contextScore.score;
  
  const finalScore = Math.min(score, 10);
  
  // 점수 기준 판정
  let riskLevel = 'LOW';
  if (finalScore >= 4) riskLevel = 'HIGH';
  else if (finalScore >= 2) riskLevel = 'MEDIUM';
  
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
 * Enhanced risk assessment with whitelist check
 */
async function calculateAdvancedRiskScoreWithWhitelist(text) {
  // Check whitelist first
  const isWhitelisted = await listManager.isTextWhitelisted(text);
  if (isWhitelisted) {
    return {
      score: 0,
      matches: [],
      contextual: { score: 0, factors: [] },
      riskLevel: 'LOW',
      categoryStats: { strong: 0, weak: 0, adult: 0, slur: 0 },
      whitelisted: true
    };
  }
  
  // Proceed with normal risk assessment and add blacklist matches
  const result = await calculateAdvancedRiskScore(text);
  
  // Add blacklist risk factors
  const blacklistMatches = await listManager.getBlacklistMatches(text);
  
  if (blacklistMatches.length > 0) {
    const blacklistScore = blacklistMatches.reduce((total, match) => total + match.weight, 0);
    result.score = Math.min(result.score + blacklistScore, 10);
    
    // Add blacklist matches to the result
    result.blacklistMatches = blacklistMatches;
    result.blacklistScore = blacklistScore;
    
    // Recalculate risk level with new score
    if (result.score >= 4) result.riskLevel = 'HIGH';
    else if (result.score >= 2) result.riskLevel = 'MEDIUM';
    else result.riskLevel = 'LOW';
  }
  
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
      }
    };

    const handleCallback = () => {
      if (chrome.runtime.lastError) {
        // Only try fallback if not already resolved
        if (!resolved) {
          try {
            chrome.tabs.sendMessage(tabId, message, () => {
              if (chrome.runtime.lastError) {
                safeResolve(false);
              } else {
                safeResolve(true);
              }
            });
          } catch (error) {
            safeResolve(false);
          }
        }
      } else {
        safeResolve(true);
      }
    };

    try {
      const options = typeof frameId === "number" ? { frameId } : undefined;
      chrome.tabs.sendMessage(tabId, message, options, handleCallback);
    } catch (error) {
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
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["contentScript.js"],
      injectImmediately: true
    });
    return results;
  } catch (error) {
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
        await new Promise(resolve => setTimeout(resolve, delay));
        
      } catch (error) {
        if (error.name === 'AbortError') {
          throw new Error('OpenAI API request timeout (15s)');
        }
        if (attempt === 3) throw error;
        
        // Network error backoff
        const delay = 1000 * attempt;
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
    // Context menu created
  } catch (error) {
    // Context menu creation failed (may already exist)
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

      case MESSAGE_TYPES.BIZTONE_GET_PROFANITY_DATA:
        const profanityData = await loadProfanityCategories();
        sendResponse(createSuccessResponse(profanityData));
        break;

      case MESSAGE_TYPES.OPEN_OPTIONS:
        chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        break;

      // Whitelist/Blacklist management
      case MESSAGE_TYPES.BIZTONE_GET_WHITELIST:
        await handleGetWhitelist(sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_SET_WHITELIST:
        await handleSetWhitelist(message.whitelist, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_ADD_WHITELIST_ITEM:
        await handleAddWhitelistItem(message.item, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_REMOVE_WHITELIST_ITEM:
        await handleRemoveWhitelistItem(message.itemId, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_GET_BLACKLIST:
        await handleGetBlacklist(sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_SET_BLACKLIST:
        await handleSetBlacklist(message.blacklist, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_ADD_BLACKLIST_ITEM:
        await handleAddBlacklistItem(message.item, sendResponse);
        break;
        
      case MESSAGE_TYPES.BIZTONE_REMOVE_BLACKLIST_ITEM:
        await handleRemoveBlacklistItem(message.itemId, sendResponse);
        break;

      default:
        // Unknown message type
    }
  })();

  return true; // Indicates async response
});

// Handle keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "convert-selection") {
    return;
  }

  // Debounce rapid key presses
  if (state.shouldDebounce()) {
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    return;
  }

  // Ensure content script is ready
  const hasListener = await ensureContentListener(activeTab.id);
  if (!hasListener) {
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

// Listen for storage changes to reload guard mode settings
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.GUARD_MODE) {
    const newValue = changes.GUARD_MODE.newValue;
    state.guardModeSettings.GUARD_MODE = newValue || "warn";
  }
});

// Background script initialized

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
    sendResponse(createErrorResponse('Failed to remove domain rule'));
  }
}

// ==================== WHITELIST/BLACKLIST HANDLERS ====================

/**
 * Handle get whitelist message
 */
async function handleGetWhitelist(sendResponse) {
  try {
    const whitelist = await listManager.getWhitelist();
    sendResponse(createSuccessResponse({ whitelist }));
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.WHITELIST_OPERATION_FAILED));
  }
}

/**
 * Handle set whitelist message
 */
async function handleSetWhitelist(whitelist, sendResponse) {
  try {
    if (!Array.isArray(whitelist)) {
      return sendResponse(createErrorResponse('Invalid whitelist format'));
    }
    
    const success = await listManager.saveWhitelist(whitelist);
    if (success) {
      sendResponse(createSuccessResponse({ whitelist }));
    } else {
      sendResponse(createErrorResponse('Failed to save whitelist'));
    }
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.WHITELIST_OPERATION_FAILED));
  }
}

/**
 * Handle add whitelist item message
 */
async function handleAddWhitelistItem(item, sendResponse) {
  try {
    if (!item) {
      return sendResponse(createErrorResponse('Item not provided'));
    }
    
    const success = await listManager.addWhitelistItem(item);
    if (success) {
      const whitelist = await listManager.getWhitelist();
      sendResponse(createSuccessResponse({ whitelist, added: true }));
    } else {
      sendResponse(createErrorResponse('Failed to add whitelist item (validation failed or duplicate)'));
    }
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.WHITELIST_OPERATION_FAILED));
  }
}

/**
 * Handle remove whitelist item message
 */
async function handleRemoveWhitelistItem(itemId, sendResponse) {
  try {
    if (!itemId) {
      return sendResponse(createErrorResponse('Item ID not provided'));
    }
    
    const success = await listManager.removeWhitelistItem(itemId);
    if (success) {
      const whitelist = await listManager.getWhitelist();
      sendResponse(createSuccessResponse({ whitelist, removed: true }));
    } else {
      sendResponse(createErrorResponse('Failed to remove whitelist item (not found)'));
    }
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.WHITELIST_OPERATION_FAILED));
  }
}

/**
 * Handle get blacklist message
 */
async function handleGetBlacklist(sendResponse) {
  try {
    const blacklist = await listManager.getBlacklist();
    sendResponse(createSuccessResponse({ blacklist }));
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.BLACKLIST_OPERATION_FAILED));
  }
}

/**
 * Handle set blacklist message
 */
async function handleSetBlacklist(blacklist, sendResponse) {
  try {
    if (!Array.isArray(blacklist)) {
      return sendResponse(createErrorResponse('Invalid blacklist format'));
    }
    
    const success = await listManager.saveBlacklist(blacklist);
    if (success) {
      sendResponse(createSuccessResponse({ blacklist }));
    } else {
      sendResponse(createErrorResponse('Failed to save blacklist'));
    }
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.BLACKLIST_OPERATION_FAILED));
  }
}

/**
 * Handle add blacklist item message
 */
async function handleAddBlacklistItem(item, sendResponse) {
  try {
    if (!item) {
      return sendResponse(createErrorResponse('Item not provided'));
    }
    
    const success = await listManager.addBlacklistItem(item);
    if (success) {
      const blacklist = await listManager.getBlacklist();
      sendResponse(createSuccessResponse({ blacklist, added: true }));
    } else {
      sendResponse(createErrorResponse('Failed to add blacklist item (validation failed or duplicate)'));
    }
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.BLACKLIST_OPERATION_FAILED));
  }
}

/**
 * Handle remove blacklist item message
 */
async function handleRemoveBlacklistItem(itemId, sendResponse) {
  try {
    if (!itemId) {
      return sendResponse(createErrorResponse('Item ID not provided'));
    }
    
    const success = await listManager.removeBlacklistItem(itemId);
    if (success) {
      const blacklist = await listManager.getBlacklist();
      sendResponse(createSuccessResponse({ blacklist, removed: true }));
    } else {
      sendResponse(createErrorResponse('Failed to remove blacklist item (not found)'));
    }
  } catch (error) {
    sendResponse(createErrorResponse(ERROR_MESSAGES.BLACKLIST_OPERATION_FAILED));
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
    return {};
  }
}

/**
 * Save domain rules to storage
 */
async function saveDomainRules(rules) {
  try {
    await chrome.storage.sync.set({ [DOMAIN_RULES_KEY]: rules });
    return true;
  } catch (error) {
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
  
  return await saveDomainRules(rules);
}

/**
 * Remove domain rule (revert to default enabled)
 */
async function removeDomainRule(domain) {
  const rules = await getDomainRules();
  if (rules[domain]) {
    delete rules[domain];
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
    // Load settings first
    await loadGuardModeSettings();
    
    // Then compile patterns
    await loadAndCompilePatterns();
  } catch (error) {
    // Initialization failed - extension will still work with reduced functionality
  }
})();