# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BizTone is a Chrome Extension (Manifest V3) that converts emotionally charged text into professional business tone using OpenAI's API. Users can drag-select text on any webpage, right-click to access "비즈니스 문장으로 변경", and get polite business-appropriate alternatives.

## Architecture

### Core Components

- **background.js**: Refactored Service Worker with modular structure, comprehensive error handling, and JSDoc documentation
- **contentScript.js**: Modular content script with hybrid guard system, organized into logical sections with proper separation of concerns
- **popup.js**: Extension popup for testing conversions and accessing settings
- **options.js**: Settings page for API key configuration
- **manifest.json**: Extension configuration with permissions and commands

### Code Quality Improvements

- **Modular Organization**: Code split into logical sections with clear separation of concerns
- **Comprehensive Documentation**: JSDoc annotations for all major functions
- **Error Handling**: Robust error handling with fail-safe mechanisms
- **Constants Management**: Centralized configuration objects for easy maintenance
- **Performance Optimization**: Efficient caching and debouncing mechanisms

### Key Features

1. **Context Menu Integration**: Right-click selected text → "비즈니스 문장으로 변경"
2. **Keyboard Shortcuts**: Ctrl+Shift+Y (Cmd+Shift+Y on Mac) for instant conversion
3. **Smart Guard System**: Intercepts Enter key presses to convert before sending
4. **Text Replacement**: Works with input fields, textareas, and contentEditable elements
5. **Floating UI**: Shows conversion results in positioned bubbles with copy/replace actions

### Message Flow

```
Context Menu/Shortcut → background.js → OpenAI API → contentScript.js → DOM Replacement
```

## Hybrid Guard System

The extension now features a **3-tier hybrid guard system** for optimal performance:

1. **Local Prefilter**: Lightweight risk scoring (0ms latency)
   - Safe messages (score ≤ 1): Immediate send-through without API calls
   - High-risk messages (score ≥ 4): Direct conversion without decision prompt
   - Ambiguous messages (score 2-3): Single decision API call

2. **Result Caching**: 90-second TTL cache prevents repeated API calls for identical text

3. **Smart Text Processing**: Handles both selected text and full content with proper DOM event handling

### Performance Benefits
- **99% of normal messages**: 0ms delay (no API calls)
- **High-risk messages**: 1 API call (conversion only)
- **Ambiguous messages**: 1-2 API calls maximum
- **Repeated text**: Cache hit (0ms delay)

## Development Commands

No package.json found - this is a vanilla JavaScript Chrome extension. Development workflow:

1. **Loading Extension**: Chrome → chrome://extensions → Developer mode → Load unpacked
2. **Testing**: Use the popup test feature or on-page context menu
3. **Debugging**: Chrome DevTools → Extensions → Service Worker for background.js

## Configuration

- **API Key Storage**: `chrome.storage.sync` (unencrypted)
- **Models**: Supports gpt-4o-mini (default), gpt-4o, gpt-3.5-turbo
- **Permissions**: contextMenus, activeTab, storage, scripting, clipboardWrite
- **Host Permissions**: https://api.openai.com/*

## Security Considerations

- API keys stored in plain text in chrome.storage.sync
- Extension requests external API access to OpenAI
- Content script injection on all URLs with proper frame isolation
- Guard system prevents malicious text conversion attempts

## File Structure Patterns

- Single-purpose modules with clear separation of concerns
- Event-driven architecture using Chrome extension messaging
- Defensive programming with extensive error handling
- Korean language UI with English technical implementation
## Hybrid Guard Details (Implementation)

- Keydown Intercept: `window.addEventListener('keydown', onKeyDownGuard, true)` handles `Enter`/`Cmd+Enter` only.
- Prefilter Thresholds:
  - `CONFIG.PREFILTER.PASS_MAX = 1` → pass-through (no preventDefault, cached as `{mode:'send'}`)
  - `CONFIG.PREFILTER.CONVERT_MIN = 4` → direct convert (preventDefault; call background → replace)
  - Else (2–3) → decision prompt (`BIZTONE_GUARD_DECIDE`) then send or convert
- Caching:
  - `Map` keyed by `normalizeText(text)` with `timestamp`
  - `CONFIG.CACHE.TTL_MS = 90_000`
  - Shapes: `{mode:'send'}` or `{mode:'convert', converted: string}`
- Messaging:
  - Convert: `BIZTONE_CONVERT_TEXT`
  - Decide: `BIZTONE_GUARD_DECIDE`
  - UI: `BIZTONE_LOADING`, `BIZTONE_RESULT`, `BIZTONE_ERROR`, `BIZTONE_REPLACE_WITH`
- Fail-Open:
  - Conversion/decision failure → call `dispatchEnterKey()` to send original message
- Replacement:
  - Selection-aware via `replaceSelectedText` else `replaceFullText`
  - Dispatches `input`/`change` events for editors
- UX:
  - Toast: "변환 완료 — Enter를 다시 누르면 전송됩니다." (auto-send toggle: `CONFIG.GUARD.AUTO_SEND_CONVERTED`)
- Safety:
  - `isExtensionContextValid()` guards messaging; disables guard if extension context lost
- Background Notes:
  - `decideTextAction()` returns `{ action: 'send'|'convert', converted_text? }` using JSON mode
  - Advanced profanity detector (noise-tolerant Hangul patterns) is prepared for risk scoring V2
