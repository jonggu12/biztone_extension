 # BizTone TODO — 다음 기능 명세(개발/AI용)

 본 문서는 BizTone 확장프로그램의 우선 개선 항목을 다른 개발자/AI가 바로 구현할 수 있도록 요구사항을 정리한 TODO입니다. 각 항목은 범위, 저장소 키, UI/UX, 동작 로직, 수용 기준(AC)을 포함합니다.



 ---

 ## 4) 영어 감정 문장 변환 지원
 - 목적: 한국어 외 영어도 동일하게 감정 문장을 비즈니스 톤으로 변환.
 - 탐지/판정:
   - 간단한 언어 감지(알파벳 비중/영문 단어 존재 등 휴리스틱) → en 우선 규칙 적용.
   - 영어용 공격/비속어/공격적 어조 리스트 최소 셋(예: damn, hell, stupid, ASAP, now!, irresponsible 등) 추가.
 - 변환 프롬프트:
   - 기존 system prompt를 locale 별로 분기(ko/en). en은 “polite, concise, professional tone in English”로 명시.
 - 옵션:
   - “영어 감정문 변환 활성화” 토글.
 - 수용 기준(AC):
   - “Why are you so slow?? Do it now!” → “Could you please proceed as soon as possible?” 등 정중화 결과 반환.

 ---

 ## 5) 메시지 투명성(가드 개입 배지/토스트)
 - 목적: 가드가 왜 개입했는지 사용자가 이해하도록 투명성 제공(오탐 클레임 감소).
 - UI/UX(컨텐츠 스크립트):
   - 전송 차단/변환 시 작은 토스트: “위험도 높음(이유: profanity: ‘씨**’), 문장 정중화 완료. Enter 재입력 시 전송”.
   - 구성: 사유 태그(예: profanity, aggressive, punctuation), 조치(allow/convert/block).
   - 옵션 토글: “이유 토스트 표시” ON/OFF.
 - 수용 기준(AC):
   - 위험 문장 입력 후 Enter 시 토스트에 간단한 사유와 액션 노출.

 ---

 ## 6) 로그/피드백: 로컬 로그 Export + 피드백 연결
 - 목적: 선택적으로 로그를 저장/내보내고, 피드백 페이지에서 사례를 제출.
 - 저장:
   - `BIZTONE_LOGS_LOCAL`(optional, `chrome.storage.local` 권장): 최근 N개(예: 200개) 버퍼링.
   - 항목: { ts, url, locale, textHash, action("send|convert|block"), reasonTags[], score, converted? } (원문 텍스트는 기본 미저장, opt-in 시 저장).
 - 옵션:
   - “로컬 로그 수집” 토글, “원문 포함(주의)” 토글, “로그 내보내기(JSON)” 버튼, “피드백 페이지 열기”.
 - 수용 기준(AC):
   - 수집 ON 상태에서 내보내기 클릭 시 JSON 다운로드 생성.

 ---

 ## 7) 피드백 관리 페이지(새 페이지)
 - 목적: 사용자 피드백 수집(오탐/누락 신고), 로그 첨부로 학습/정책 개선.
 - 파일: `feedback.html`, `feedback.js`(MV3 정적 리소스 등록 필요 시 `manifest.json` 수정).
 - 기능:
   - 간단 폼: 유형(오탐/누락/기타), 설명, 로그 첨부(파일 업로드 or ‘로컬 로그 불러오기’), 연락처(선택).
   - 제출: 임시로 `mailto:` 링크 생성 또는 JSON 다운로드(향후 서버/웹훅 연동 대비 구조화).
   - 개인정보 경고/동의 체크.
 - 수용 기준(AC):
   - 폼 작성 → JSON 파일로 내보내기 또는 메일 클라이언트 열림.

 ---


 ---

 ## 9) 저장 스키마 요약
 - `OPENAI_API_KEY`(string), `OPENAI_MODEL`(string)
 - `BIZTONE_WHITELIST`(array of {text, match, locale})
 - `BIZTONE_BLACKLIST`(array of {text, match, locale, weight})
 - `BIZTONE_DOMAIN_RULES`(object map: { [host]: { enabled, mode, pauseUntil } })
 - `BIZTONE_LOGS_LOCAL`(array or ring buffer in local)

 ---

 ## 10) 개발 노트
 - MV3 제약: service_worker에서 동작, 웹 접근 리소스/옵션/피드백 페이지는 `manifest.json`에 등록.
 - 성능: 화이트/블랙 변경 시 백그라운드의 패턴 캐시 재컴파일 트리거. 캐시 TTL/버전 키 적용 고려.
 - 보안/프라이버시: 키는 sync 저장(평문). 기업용 프록시/토큰 사용 가이드 추가 권장.
 - 테스트: `test.html`로 가드/단축키/버블/토스트 확인. Gmail/Slack/Notion 등 에디터 교체/포커스 케이스 수동 점검.

 ---

 ## 11) 마일스톤(권장)
 - M1: API 키 배너, 도메인 ON/OFF(+일시중지), 화이트/블랙 UI, 메시지 투명성 토스트
 - M2: 영어 지원, 로그 Export, 피드백 페이지 v1
 - M3: fword 정제+카테고리화, 도메인 정책 고도화(모드/임계값), 서버 연동 피드백(선택)

