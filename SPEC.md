# Antigravity CLI AI 가상 오피스 (`agent-office-cli`) 개발 명세서

본 문서는 `e:\github\dcim` 프로젝트의 단일 HTML 프로토타입(`virtual_office.html`)과 Node 브리지(`office_bridge.js`)를 기반으로, **Antigravity CLI(`agy.exe`) 전용 Vue 3 + Vite 웹 애플리케이션**을 독립 개인 Git 저장소(`e:\github\agent-office-cli\`)에서 새로 구현하기 위한 이관 명세서다.

---

## 1. 프로젝트 개요 및 경계

- **저장소 루트**: `e:\github\agent-office-cli\` (독립 개인 Git 저장소)
- **제어 대상 작업 경로 (`TARGET_WORKSPACE`)**: 환경 변수 또는 설정으로 지정 (기본값 현재 실행 디렉터리 `process.cwd()`, 필요 시 UI/설정 파일에서 임의 프로젝트 전환 가능)
- **핵심 목표**:
  1. Antigravity CLI(`agy.exe`)의 빠른 실행 속도와 단일 저장소(`~/.gemini/antigravity-cli/`) 특성을 활용한 **CLI 전용 AI 에이전트 관제 및 대화 UI** 구축
  2. 기존 단일 HTML 프로토타입에 부재했던 **에이전트 답변 및 실시간 응답 스트림(`stream-json`) 뷰어** 구현
  3. 2D 오피스 캔버스, 에이전트 대화 스레드 뷰어, 모델/`--effort`/실행 모드 제어 콘솔을 모듈형 Vue 컴포넌트로 분리

---

## 2. 확인된 실행 환경 및 기술 스택 제약

| 항목 | 확인 사양 | 기술 결정 및 제약 |
| :--- | :--- | :--- |
| **로컬 Node.js** | `v16.20.2` (사전 확인 완료) | Vite 5+는 Node 18 이상을 요구하므로, Node 업그레이드 없이 동작하도록 **`vite@^4.5.0` + `@vitejs/plugin-vue@^4.6.0` (Vue 3)** 사용 |
| **로컬 Git** | `2.56.1.windows.1` | 독립 Git 저장소 관리 (`node_modules/`, `dist/`, 로컬 상태 JSON은 `.gitignore` 제외) |
| **프론트엔드** | Vue 3 (Composition API, `<script setup>`) + Pinia | 상태 단방향 관리, 컴포넌트 분리 |
| **캔버스 렌더링** | HTML5 Canvas 2D | 기존 오피스 구역 및 5인 에이전트 + CLI 커스텀 워커 2D 맵 이식 |
| **백엔드 브리지** | Node.js 내장 `http`, `child_process`, `fs`, `path`, `os` | 외부 백엔드 프레임워크 의존성 없이 경량 서버 유지 (`127.0.0.1:3100` 등 설정 가능) |
| **스타일 규격** | 전사 다크 모드 + 무채색/네이비 Flat 스타일 | Scoped SCSS/CSS 사용, 고채도 원색 및 이모지 사용 금지 |

---

## 3. Antigravity CLI (`agy.exe`) 연동 사양 (기존 코드·CLI 확인 완료)

참조 원본 `e:\github\dcim\Rules\Personal\Master\office_bridge.js` 및 `agy --help` 실행 결과 기준 확인된 사항이다.

1. **실행 바이너리 경로**:
   - 환경 변수 `AGY_BIN` 우선, 미설정 시 `%LOCALAPPDATA%\agy\bin\agy.exe` 사용.
2. **CLI 대화 저장소 경로**:
   - `~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl`
   - 본문이 잘린 스텝(`truncated_fields`에 `"content"` 포함)은 같은 폴더의 `transcript_full.jsonl`에서 `step_index` 매칭으로 원문 복원.
   - 데스크톱 앱 저장소(`~/.gemini/antigravity/brain/`)의 세션 ID는 `agy --conversation <id>`에 전달할 수 없음(`trajectory not found` 오류 발생). 본 프로젝트는 **CLI 저장소(`antigravity-cli`) 중심**으로 동작한다.
3. **지원 플래그 (`agy --help` 확인)**:
   - `--model <id>`: 사용 모델 지정 (`agy models` 출력의 탭 구분 1열 ID, 2열 라벨 파싱)
   - `--effort <level>`: 추론 강도 지정 (`low` | `medium` | `high` | `xhigh` | `max`)
   - `--mode <mode>`: 실행 권한 모드 (`plan` | `accept-edits` | `auto`)
   - `--conversation <id>` (`-r`, `--resume`): 기존 CLI 세션 이어하기
   - `--output-format stream-json`: NDJSON 실시간 스트리밍 출력
   - `-p=<prompt>`: 비대화형 단발 실행. **주의: `-p` 뒤 문자열이 플래그(`-`)로 시작하거나 후속 플래그를 오인하지 않도록 프롬프트 앞 공백 처리 및 인자 목록 맨 마지막에 `-p=<prompt>` 형태로 배치**
4. **확인된 `stream-json` 출력 이벤트**:
   - `event === 'init'`: `conversation_id` 포함 (새 세션 생성 시 즉시 식별 및 매핑 가능)
   - `event === 'step_update'`: `step_update` 내부에 `text_delta`, `state`, `step_type`, `usage` (`total_tokens` 등), `duration_seconds` 포함
   - `event === 'result'`: `result.response`(최종 답변 전문), `result.status`, `result.usage` 포함

---

## 4. 참고 원본 파일 경로

이식 시 아래 기존 파일을 직접 읽어 캔버스 좌표·상태 추론·로그 파싱·핸드오버 로직을 재사용한다.

- **프론트엔드 UI & 2D 캔버스 원본**:
  `e:\github\dcim\Rules\Personal\Master\virtual_office.html`
  - 5개 오피스 구역(`ZONES`): `MEETING` (`28,24,460,255`), `MASTER_ROOM` (`512,24,500,255`), `DOMAIN_ZONE` (`28,304,340,332`), `DEV_QA_ZONE` (`392,304,370,332`), `LOUNGE` (`786,304,226,332`)
  - 5인 기본 에이전트(`AGENTS_DEF`): `Master`, `Agent_BMS`, `Agent_Audit`, `Agent_Dev`, `Agent_QA`
  - 팀장 관제실(`MASTER_ROOM`) 벽면 명판: `'사훈'` / `'거짓·추측 금지 — 확인된 코드·문서·실행 결과만 사실로 보고한다.'`
- **백엔드 브리지 원본 (`BRIDGE_VERSION = '2026-11-25-v6'`)**:
  `e:\github\dcim\Rules\Personal\Master\office_bridge.js`
  - 기존 엔드포인트: `GET /api/state`, `GET /api/stream`, `GET /api/models`, `POST /api/prompt`, `POST /api/prompt/stop`, `POST /api/mapping`, `POST /api/handover`, `POST /api/agent/state`, `POST /api/shutdown`
- **표준 핸드오버 양식 & 작성 규칙**:
  - `e:\github\dcim\Rules\Common\SESSION_HANDOVER_TEMPLATE.md`
  - `e:\github\dcim\Rules\Common\ANTI_AI_FLAVOR_GUIDE.md`

---

## 5. 목표 화면 구조 및 추가 기능

### 5.1 3영역 분할 레이아웃 (리사이즈 가능)
1. **좌측 — 2D 오피스 캔버스 (`OfficeCanvas.vue`)**:
   - 에이전트 상태(`IDLE`, `PLANNING`, `WORKING`, `DONE`)별 구역 이동 및 말풍선 표시
   - 세션 용량 건강 상태(`양호` < 5MB / `주의` >= 5MB / `위험` >= 10MB) 인디케이터
   - CLI 동적 워커 세션이 추가될 경우 오피스 내 슬롯 확장 지원
2. **중앙/우측 상단 — 에이전트 답변 & 대화 스레드 뷰어 (`AgentChatPanel.vue`, 핵심 신규 기능)**:
   - **기존 대화 이력 로드**: `GET /api/sessions/:convId/messages`를 통해 `transcript.jsonl` / `transcript_full.jsonl`의 `USER_INPUT`과 `PLANNER_RESPONSE` 최종 답변 및 도구 호출 요약을 시간순 대화 스레드로 렌더링
   - **실시간 스트리밍 출력**: `agy -p --output-format stream-json` 실행 중 발생하는 `step_update`(`text_delta`, 도구 실행, 토큰 사용량)와 `result.response`를 SSE로 실시간 수신해 화면에 즉시 표시
   - **탭 전환**: `[대화 및 답변]` 뷰와 `[실행 로그 (Raw)]` 뷰 분리
3. **우측 하단 — 모델 선택 & 프롬프트 실행 콘솔 (`PromptConsole.vue`)**:
   - AI 모델 선택(`agy models` 연동) + 모델별 특성/토큰 가이드(`?` 모달)
   - `--effort`(`low`, `medium`, `high`, `xhigh`, `max`) 및 `--mode`(`plan`, `accept-edits`, `auto`) 선택
   - 다중 행 입력(`Enter`: 줄바꿈, `Ctrl+Enter`: 전달), 전달 시 입력창 초기화 및 `disabled` 잠금 + 로딩 스피너, `[실행 중단]` 버튼
   - 세션 매핑 선택, `[세션 정리]` 핸드오버 문서 생성 모달

---

## 6. 단계별 구현 계획 (Step-by-Step)

1. **1단계: 프로젝트 초기화 & CLI 백엔드 브리지 구축**
   - `package.json` (`vite@^4.5.0`, `vue@^3`, `@vitejs/plugin-vue@^4.6.0`, `pinia`, 필요 시 마크다운 렌더러 `marked` + `dompurify`) 구성 및 `npm install` 검증
   - `server/bridge.js` 구축 (`office_bridge.js` 기반, CLI 저장소 전용 스캔, `--effort` 지원 추가, `GET /api/sessions/:convId/messages` 추가, `stream-json` `text_delta` / `result` 실시간 SSE 송출)
   - Vite dev 프록시(`/api` -> 브리지 포트) 설정 및 개발/운영 동시 실행 스크립트 구성
2. **2단계: 레이아웃 & 2D 오피스 캔버스 컴포넌트화**
   - 다크 테마 CSS 변수 토큰, 상단 HUD, 3패널 스플리터, `OfficeCanvas.vue` 이식
3. **3단계: 에이전트 대화 스레드 & 실시간 답변 뷰어 구현**
   - `AgentChatPanel.vue` 구현 (과거 대화 로드, `text_delta` 실시간 스트리밍 말풍선, 코드블록/마크다운 렌더링, 도구 호출 접기/펼치기, 실행 로그 탭)
4. **4단계: 프롬프트 제어 콘솔, 모달 & 통합 검증**
   - 모델 가이드 모달, 핸드오버 모달, 프롬프트 전달/중단 연동
   - `npm run build` 성공 확인 및 실제 `agy.exe` 호출을 통한 E2E 응답 수신 검증

---

## 7. 작성 규칙 (필수 준수)

- 사용자 응답 및 주석/문서는 한국어로 작성하되, 사족·미사여구·이모지·과장된 마케팅 용어(`ANTI_AI_FLAVOR_GUIDE.md` 금지어 기준)를 사용하지 않는다.
- 실행하지 않은 테스트나 확인하지 않은 코드 동작을 사실처럼 보고하지 않는다.
- 복잡한 기능 구현 전 단계별 계획을 먼저 점검하고, 한 단계씩 검증 완료 후 다음 단계로 진행한다.
