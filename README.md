# BizTone Chrome Extension (MVP)

웹페이지에서 **감정적인 문장**을 드래그 → 우클릭 → **“비즈니스 문장으로 변경”**을 누르면
정중한 비즈니스 톤으로 즉시 변환해 주는 크롬 확장 프로그램입니다.

## 설치 방법 (개발자 모드)

1. 이 폴더(`biztone-extension`)를 다운로드/압축해제합니다.
2. Chrome에서 `chrome://extensions` 접속 → 우측 상단 **개발자 모드** ON.
3. **압축해제된 확장 프로그램을 로드** → 이 폴더를 선택.
4. 확장 아이콘을 클릭 → **설정**에서 OpenAI **API Key**를 입력.

## 사용 방법

1. 웹페이지에서 문장을 드래그합니다.
2. 우클릭 → **비즈니스 문장으로 변경**을 클릭합니다.
3. 결과 풍선(툴팁)이 뜨면, **복사** 또는 **선택 영역 교체**를 사용할 수 있습니다.

> 선택 영역 교체는 입력창(메일/메신저)의 텍스트 선택에 한해 동작합니다.

## 설정

- **API Key**: `chrome.storage.sync`에 저장됩니다(암호화 없음). 보안에 유의하세요.
- **Model**: 기본 `gpt-4o-mini`. 필요 시 `gpt-4o`, `gpt-3.5-turbo` 등으로 변경 가능.

## 개발 메모

- MV3 Service Worker (`background.js`)에서 OpenAI API 호출
- 컨텍스트 메뉴 생성 → 선택 텍스트 전달 → 콘텐츠 스크립트로 결과 표시
- 콘텐츠 스크립트는 Selection Range/입력창 selectionStart/End를 이용해 **교체** 기능 제공

## 권한

- `contextMenus`, `activeTab`, `storage`, `scripting`, `clipboardWrite`
- `host_permissions`: `https://api.openai.com/*`

## 보안/요금 주의

- API 키는 사용자의 책임 하에 사용됩니다.
- 회사/조직 정책에 따라 **프록시 서버**를 두고 호출하는 구성을 권장합니다.

---

© 2025 BizTone MVP
## 하이브리드 가드(Enter 키 보호)

입력창에서 Enter(또는 Cmd/Ctrl+Enter)를 누르면, 콘텐츠 스크립트가 전송을 가로채어 아래 규칙으로 처리합니다.

- 로컬 프리필터 점수화: 텍스트의 위험도를 0~10 범위로 산정합니다.
  - 안전(≤ 1): 바로 전송 — API 호출 없음
  - 고위험(≥ 4): 즉시 변환 — 결과를 입력창에 치환 후 안내 토스트 표시
  - 애매(2~3): 백그라운드에 “보내기/변환” 결정 요청 → 결과에 따라 전송 또는 변환
- 캐시: 동일 문장은 90초 동안 결과/결정을 캐싱해 즉시 재사용합니다.
- 실패 시 처리: 결정/변환 실패 시에는 안전모드로 원문 전송(fail-open).

추가 설정은 코드 상수로 제어합니다.

- `CONFIG.PREFILTER.PASS_MAX = 1`
- `CONFIG.PREFILTER.CONVERT_MIN = 4`
- `CONFIG.CACHE.TTL_MS = 90_000` (90초)
- `CONFIG.GUARD.AUTO_SEND_CONVERTED = false` (치환 후 자동 전송 여부)

## 단축키

- 선택 변환: `Ctrl+Shift+Y` (Mac: `Command+Shift+Y`)
  - 현재 페이지 선택 텍스트를 비즈니스 톤으로 변환 후 복사/교체 UI 제공
