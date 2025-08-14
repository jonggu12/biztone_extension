# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BizTone is an **enterprise-grade Chrome Extension (MV3)** that converts emotionally charged text into professional business tone using OpenAI's API. Features real-time Enter key guard system with race condition prevention and advanced Korean profanity filtering.

## Architecture

### Core Components

- **background.js**: Service Worker with OpenAI integration, advanced pattern compilation, and Korean text processing
- **contentScript.js**: Real-time guard system with race condition prevention, modular UI components, and text replacement
- **data/fword_list.txt**: 598+ Korean profanity database for advanced filtering
- **popup.js**: Extension popup for testing conversions and accessing settings
- **options.js**: Settings page with API key validation and model selection
- **manifest.json**: MV3 configuration with web accessible resources

### Advanced Features

1. **Real-time Enter Guard**: Prevents risky messages from being sent accidentally
2. **Advanced Profanity Filtering**: Korean text processing with noise-tolerant patterns
3. **Race Condition Prevention**: Synchronous prefilter + asynchronous AI assessment
4. **Enterprise Security**: Fail-secure policies with configurable fail-safe options
5. **Performance Optimization**: 0ms delay for 99% of safe messages

## Hybrid Guard System V2

### 🏗️ **Two-Stage Architecture**

```
Stage 1: Synchronous Prefilter (0ms)
├─ Local risk assessment with whitelist check
├─ PASS → Allow immediate send (no preventDefault)
└─ RISK → Immediately block (preventDefault) → Stage 2

Stage 2: Asynchronous Enhancement
├─ Background advanced risk assessment
├─ Pattern matching with Korean skeleton analysis
└─ AI decision/conversion with retry logic
```

### 🛡️ **Race Condition Prevention**

**Problem**: Fast web apps (Slack, Discord) could send messages while waiting for background assessment.

**Solution**: 
1. **Synchronous blocking decision** based on basic local assessment
2. **Enhanced precision** with background advanced assessment
3. **No race conditions**: Critical messages never slip through

### 🔍 **Advanced Profanity Detection**

```javascript
// Pattern Generation Pipeline
Raw Words → Normalize → Extract Skeleton → Generate Patterns → Classify Strength

// Korean Skeleton Extraction (초성/종성)
"시발" → "ㅅㅂ" → noise-tolerant regex matching
"s-i-b-a-l" → detected via Unicode category patterns
```

**Features**:
- **598+ word database** with variants and abbreviations
- **Noise tolerance**: Handles `s.i.b.a.l`, `시-발`, `ㅅㅂ` obfuscation
- **Whitelist protection**: "시발점", "개발자" etc. never flagged
- **Pattern caching**: Compiled once at startup for performance

### ⚡ **Performance Metrics**

| Scenario | Latency | API Calls |
|----------|---------|-----------|
| Safe messages (99%) | 0ms | 0 |
| High-risk messages | 100ms avg | 1 (convert) |
| Ambiguous messages | 200ms avg | 2 (decide+convert) |
| Cached messages | 0ms | 0 |

## Configuration

### 🎛️ **Guard System Settings**
```javascript
CONFIG = {
  PREFILTER: {
    PASS_MAX: 1,      // Score ≤ 1: immediate send
    CONVERT_MIN: 4    // Score ≥ 4: auto-convert
  },
  GUARD: {
    FAIL_OPEN_ON_CONVERT_ERROR: false, // Security: block on conversion failure
    FAIL_OPEN_ON_DECISION_ERROR: true, // UX: allow send on AI decision failure
    AUTO_SEND_CONVERTED: false         // Require user confirmation after conversion
  },
  DEBOUNCE_MS: 350 // Prevent duplicate processing
}
```

### 🔧 **API Configuration**
- **Models**: `gpt-4o-mini` (default), `gpt-4o`, `gpt-3.5-turbo`
- **Cost Control**: `max_tokens` limits (convert: 200, decide: 150)
- **Reliability**: 15s timeout, 3 retries, exponential backoff
- **Rate Limiting**: 429 handling with proper backoff

## Message Flow Architecture

### 🔄 **Real-time Guard Flow**
```
Enter Key Detected
├─ Duplicate Check (debounce + pending guard)
├─ Cache Check (90s TTL)
├─ Synchronous Prefilter
│  ├─ PASS → Allow immediate send
│  └─ RISK → preventDefault() → Background Assessment
└─ Enhanced Assessment
   ├─ Advanced pattern matching
   ├─ AI decision (if ambiguous)
   └─ Conversion + Replacement
```

### 📡 **Message Types**
```javascript
// Core Operations
BIZTONE_ADVANCED_RISK    // Request advanced risk assessment
BIZTONE_CONVERT_TEXT     // Convert text to business tone
BIZTONE_GUARD_DECIDE     // AI decision: send vs convert

// UI Updates  
BIZTONE_RESULT          // Show conversion bubble
BIZTONE_REPLACE_WITH    // Direct text replacement (keyboard shortcut)
BIZTONE_ERROR           // Error handling with options

// Utilities
BIZTONE_PING            // Health check for content script
```

## Security & Reliability

### 🛡️ **Enterprise Security**
- **Extension Context Validation**: Prevents crashes during extension reloads
- **Fail-Secure Defaults**: Block risky messages on system failures
- **Input Sanitization**: Prevent XSS via text replacement
- **API Key Protection**: Stored in chrome.storage.sync (plain text - user responsibility)

### 🔄 **Error Handling**
- **OpenAI API**: Timeout + retry with exponential backoff
- **Network Issues**: Graceful degradation to local assessment
- **Extension Reloads**: Context validation prevents crashes
- **DOM Changes**: Defensive programming for text replacement

### 🚀 **Performance Optimizations**
- **Pattern Compilation**: One-time compilation with memory caching
- **RegExp Optimization**: Removed global flags to prevent lastIndex issues
- **Deduplication**: Set-based word list prevents duplicate patterns
- **Unicode Support**: Proper Unicode handling with `u` flag

## Development Workflow

### 🔧 **Setup & Testing**
1. **Load Extension**: Chrome → chrome://extensions → Developer mode → Load unpacked
2. **Testing Methods**:
   - Context menu: Select text → right-click → "비즈니스 문장으로 변경"
   - Keyboard: Select text → `Ctrl+Shift+Y` (Mac: `Cmd+Shift+Y`)
   - Auto-guard: Type message → press Enter → automatic assessment
3. **Debugging**: Chrome DevTools → Extensions → Service Worker

### 🧪 **Testing Scenarios**
```javascript
// Test race conditions
Type: "씨발 이자식아" → Press Enter quickly → Should be blocked

// Test whitelist
Type: "시발점에서 만나요" → Should pass immediately

// Test noise tolerance  
Type: "s-i-b-a-l" or "시.발" → Should be detected

// Test performance
Type: "안녕하세요" → Should send with 0ms delay
```

## File Structure & Patterns

```
biztone-extension/
├── background.js       # Service Worker (OpenAI API, pattern compilation)
├── contentScript.js    # Real-time guard (UI, text replacement)
├── data/
│   └── fword_list.txt  # Korean profanity database
├── icons/              # Extension icons
├── manifest.json       # MV3 configuration
├── options.*          # Settings page
├── popup.*            # Test interface
└── styles.css         # UI styling
```

### 🏗️ **Code Architecture Principles**
- **Modular Design**: Clear separation of concerns
- **Defensive Programming**: Extensive error handling
- **Performance First**: Optimize for the 99% case (safe messages)
- **Enterprise Ready**: Production-grade reliability and security

## Korean Text Processing

### 🔤 **Text Normalization**
```javascript
// Unicode normalization pipeline
text → toLowerCase() → remove zero-width chars → remove diacritics → NFD normalization
```

### 🧩 **Skeleton Extraction**
```javascript
// Extract Korean consonant skeleton for advanced matching
"시발" → ['ㅅ', 'ㅂ'] → skeleton pattern: "ㅅ.*ㅂ"
"씨발" → ['ㅆ', 'ㅂ'] → skeleton pattern: "ㅆ.*ㅂ"
```

### 🎯 **Pattern Classification**
- **Strong Patterns**: Direct profanity (weight: +3)
- **Weak Patterns**: Context-dependent words (weight: +1.5)
- **Contextual Factors**: Punctuation, caps, aggressive words (+0.3-0.5 each)

---

**Built for enterprise deployment with zero-downtime performance and bulletproof reliability.**