# Antigravity CLI AI 가상 오피스 (`agent-office-cli`) 사용 가이드

본 문서는 `agent-office-cli` 웹 애플리케이션의 실행 방법, 화면 구역별 기능, `agy.exe` CLI 연동 및 화면 동작 방식을 설명합니다.

---

## 1. 시스템 개요 및 실행 방법

`agent-office-cli`는 Antigravity CLI(`agy.exe`)의 비대화형 실행(`--output-format stream-json`)과 CLI 세션 로그(`~/.gemini/antigravity-cli/brain/`)를 2D 오피스 관제 화면과 인터랙티브 터미널 UI로 통합 제어하는 로컬 웹 애플리케이션입니다.

### 1.1 사전 환경
- Node.js `v16.20.2` 호환 (Vite `4.5.x`, Vue `3.4.x`, Pinia `2.1.x`)
- 패키지 매니저: `yarn` (`1.22.10`)
- Antigravity CLI(`agy.exe`): `AGY_BIN` 환경 변수 또는 `%LOCALAPPDATA%\agy\bin\agy.exe`

> PowerShell 실행 정책 제한으로 `yarn` 명령이 차단되는 환경에서는 `yarn.cmd`를 사용합니다.

### 1.2 실행 모드

1. **개발 모드 (`yarn.cmd dev`)**:
   - `scripts/dev.js`가 백엔드 브리지(`127.0.0.1:3110`)와 Vite 개발 서버(`127.0.0.1:5173`)를 동시에 실행합니다.
   - 별도로 브리지를 먼저 띄우지 않아도 자동으로 함께 기동되며, 브라우저에서 `http://127.0.0.1:5173`으로 접속합니다.
   - Vite가 `/api` 요청을 `127.0.0.1:3110` 브리지 서버로 프록시합니다.

2. **운영(정적 서빙) 모드 (`yarn.cmd build` -> `yarn.cmd bridge`)**:
   - `yarn.cmd build`로 `dist/` 번들을 생성한 뒤 `yarn.cmd bridge`를 실행합니다.
   - 브라우저에서 `http://127.0.0.1:3110`으로 접속하면 브리지 서버가 `dist/` 정적 파일과 API/SSE를 단일 포트로 서빙합니다.

### 1.3 주요 환경 변수

| 변수명 | 기본값 | 설명 |
| :--- | :--- | :--- |
| `OFFICE_PORT` | `3110` | 브리지 서버 포트 (기존 `3100` 포트 서버와 충돌 방지 목적) |
| `OFFICE_HOST` | `127.0.0.1` | 브리지 서버 바인딩 주소 |
| `TARGET_WORKSPACE` | `현재 실행 경로 (process.cwd())` | `agy.exe` 실행 작업 디렉터리 및 규칙 스캔 기준 경로 |
| `AGY_BIN` | `%LOCALAPPDATA%\agy\bin\agy.exe` | Antigravity CLI 실행 바이너리 경로 |
| `ANTIGRAVITY_CLI_BRAIN_DIR` | `~/.gemini/antigravity-cli/brain` | CLI 세션 로그 저장 디렉터리 |

---

## 2. 화면 구성 및 레이아웃 제어

화면은 상단 관제 헤더(HUD)와 3개 영역 분할 워크스페이스로 구성됩니다.

- **좌우 비율 조절**: 좌측 2D 오피스 캔버스와 우측 터미널 패널 사이의 수직 경계선을 드래그하여 너비를 조절합니다.
- **우측 상하 비율 조절**: 우측 상단 대화 뷰어와 우측 하단 프롬프트 콘솔 사이의 수평 경계선을 드래그하여 높이를 조절합니다.
- 조절한 분할 비율은 브라우저 `localStorage`에 저장되어 새로고침 후에도 유지됩니다.

---

## 3. 영역별 기능 및 동작 방식

### 3.1 상단 관제 헤더 (`OfficeHudHeader`)
- **대상 작업 경로 (`WORKSPACE`, 좌측)**:
  - 현재 `agy.exe`가 작업할 프로젝트 경로를 표시합니다.
  - 경로를 입력하고 `[경로 적용]`(또는 `Enter`)을 누르면 `POST /api/config`로 작업 경로가 변경되며, 해당 프로젝트의 `Rules` 디렉터리 스캔 결과와 저장된 팀원 구성이 자동으로 전환됩니다.
- **연결 상태 및 가동 진척률**:
  - `LIVE: ON`: 브리지 SSE(`/api/stream`)가 정상 연결된 상태입니다.
  - `연결 대기`: 브리지 서버가 꺼져 있거나 연결이 끊긴 상태입니다.
  - 가동 진척률: 활성 팀원 중 작업 수행(`WORKING`/`PLANNING`/`REVIEW`) 및 완료(`DONE`) 비율을 표시합니다.
- **`[팀 구성 (N/M)]`**: 현재 선택된 팀원 수(`N`)와 발견된 전체 에이전트 수(`M`)를 표시하며, 클릭 시 팀 구성 모달을 엽니다.
- **`[회의 소집]` / `[자리 복귀]`**: 활성 팀원 아바타를 2D 오피스 내 `MEETING ROOM` 좌석으로 이동시키거나 각자의 상태 위치로 복귀시킵니다.
- **`[오피스 접기]` / `[오피스 열기]`**: 좌측 2D 오피스 캔버스를 접어 우측 터미널 작업 영역을 전체 너비로 확장합니다.

---

### 3.2 좌측 — 2D 오피스 캔버스 (`OfficeCanvas`)

1. **3개 오피스 구역 (`1040x660` 논리 해상도)**:
   - `휴게실 (LOUNGE)`: 대기(`IDLE`) 및 완료(`DONE`) 상태 팀원이 머무는 공간 (커피 스테이션, 소파 배치)
   - `관리자 사무실 (ADMIN OFFICE)`: `CLI PIPELINE` 보드, 서버랙, 벽면 사훈 명판, `[회의 소집]` 시 사용하는 브리핑 테이블 배치 (현재 개별 에이전트 상주 구역으로는 미할당)
   - `사무실 (OFFICE)`: 작업 수행(`PLANNING`, `WORKING`, `REVIEW`, `BLOCKED`) 상태 팀원 데스크가 배치되는 작업 공간

2. **상태별 아바타 이동 및 애니메이션**:
   - 브리지가 1초 주기로 CLI 세션의 `transcript.jsonl` 끝부분(Tail 256KB)과 실행 중인 `agy.exe` 프로세스 상태를 판별해 SSE(`event: state`)로 송출합니다.
   - `IDLE`, `DONE` 상태는 `휴게실`로 이동하며, `PLANNING`, `WORKING`, `REVIEW`, `BLOCKED` 상태는 `사무실` 데스크로 이동합니다.
   - 상단 `[회의 소집]` 클릭 시 팀원들이 `관리자 사무실` 내 브리핑 테이블 앞으로 모입니다.
   - `Master`와 실무 에이전트 간 작업 시작(`TASK`) 및 완료(`DONE`) 전환 시 이동 패킷이 궤적을 따라 표시됩니다.

3. **세션 용량 건강도 배지**:
   - 연결된 CLI 세션의 `transcript.jsonl` 파일 크기 기준으로 3단계를 판정합니다.
     - `양호` (`< 5 MB`): 캔버스에 별도 경고 배지를 표시하지 않습니다.
     - `주의` (`>= 5 MB`): 이름표 하단에 `주의` 배지를 표시합니다.
     - `위험` (`>= 10 MB`): 이름표 하단에 `위험` 배지를 표시합니다.

4. **동적 워커 및 클릭 선택**:
   - 현재 팀 로스터에 매핑되지 않았지만 최근 활성 상태인 CLI 세션이 감지되면 보조 워커(`CLI-xxxx`)로 오피스에 자동 표시됩니다.
   - 캔버스에서 에이전트를 클릭하면 해당 에이전트가 우측 터미널 패널의 제어 대상으로 선택됩니다.

---

### 3.3 우측 상단 — 인터랙티브 CLI 터미널 & 대화 뷰어 (`AgentChatPanel`)

1. **상단 타이틀 바 및 에이전트 전환 스트립**:
   - 현재 선택된 에이전트 이름, 역할, 세션 용량 상태(`양호`/`주의`/`위험`/`미연결`), 현재 상태 태그를 표시합니다.
   - 에이전트 칩을 클릭해 대화 대상을 빠르게 전환할 수 있습니다.
   - 수동 세션 매핑 드롭다운에서 최근 감지된 CLI 세션 중 하나를 선택하고 `[연결]`을 누르면 해당 세션을 선택한 에이전트에 수동 고정(`office_mapping.json`)합니다.

2. **`[대화 및 답변]` 탭**:
   - **과거 대화 스레드 로드**: 세션 선택 시 `GET /api/sessions/:convId/messages`를 호출해 `USER_INPUT`과 `PLANNER_RESPONSE`를 시간순으로 렌더링합니다. (`transcript.jsonl`에서 본문이 잘린 스텝은 같은 폴더의 `transcript_full.jsonl`에서 원문을 복원합니다.)
   - **긴 요청 접기/펼치기**: 사용자 프롬프트가 길면 축약 표시하며 `[원문 펼치기]` / `[요약 보기]` 버튼으로 전체 내용을 확인합니다.
   - **도구 호출 요약 (`[TOOL]`)**: 중간 도구 호출 스텝은 기본 접힘 상태로 묶어 표시하고, 클릭하면 호출한 도구명과 대상 파일/명령을 펼쳐 볼 수 있습니다.
   - **마크다운 및 코드블록 복사**: 에이전트 답변은 XSS 필터링(`DOMPurify`)을 거쳐 마크다운으로 렌더링되며, 코드블록 우측 상단 `[복사]` 버튼으로 코드를 복사할 수 있습니다.
   - **실시간 `stream-json` 스트리밍**: `agy.exe` 실행 중에는 `❯ agy ...` 명령 에코가 출력되고, `[STREAM]` 상태 표시와 함께 수신되는 `text_delta`가 커서와 함께 실시간 누적 출력됩니다. 완료 시(`result`) 확정 스레드로 자동 동기화됩니다.
   - **스크롤 제어**: 스크롤이 맨 아래에 있을 때만 실시간 출력에 맞춰 자동 스크롤됩니다. 위쪽 과거 대화를 읽는 중일 때는 스크롤 위치를 고정하며, `[맨 아래]` 버튼으로 즉시 하단 이동할 수 있습니다.

3. **`[실행 로그 (Raw)]` 탭**:
   - `agy.exe --output-format stream-json`이 출력하는 원문 NDJSON 라인, `stderr` 메시지, 요약 상태 로그를 시간순으로 확인합니다.

---

### 3.4 우측 하단 — 원터치 커맨드 & 프롬프트 콘솔 (`PromptConsole`)

1. **원터치 커맨드 (`QUICK CMD`)**:
   - `[변경사항 분석]`: 현재 `WORKSPACE`의 `git status` 및 최근 변경 파일 구조 요약을 `plan` 모드(`--effort medium`)로 즉시 요청합니다.
   - `[세션 정리]`: 연결된 CLI 세션 로그(최근 최대 2MB)를 분석해 `SESSION_HANDOVER_TEMPLATE.md` 표준 6대 목차 양식의 인수인계서 초안을 파일로 생성하고 결과 모달(`HandoverModal`)을 엽니다. (생성 위치는 다중 에이전트 프로젝트 `<WORKSPACE>/<rulesDir>/<AgentId>/HANDOVER.md`, 단일 프로젝트 `<WORKSPACE>/HANDOVER.md`이며 기존 `HANDOVER.md` 존재 시 `HANDOVER.draft.md` 생성)
   - `[모델 갱신]`: `agy models`를 다시 실행해 사용 가능한 모델 목록을 갱신합니다.
   - `[새 세션으로 실행]`: 체크 시 기존 대화(`--conversation`)를 이어가지 않고 새 CLI 세션을 생성해 실행합니다.

2. **CLI 실행 옵션 제어**:
   - **AI 모델 (`--model`)**: `agy models`에서 파싱한 모델 목록 중 선택합니다. 우측 `?` 버튼으로 모델 계열별 특성 및 추론 강도 안내 모달(`ModelGuideModal`)을 열 수 있습니다.
   - **추론 강도 (`--effort`)**: `auto`, `low`, `medium`, `high`, `xhigh`, `max` 중 선택합니다.
     - `gemini-4-hydrogen-high`처럼 모델 ID 자체에 추론 강도 접미사가 내장된 모델에 다른 `--effort`를 함께 넘기면 CLI 충돌 오류가 발생하므로, 백엔드가 동일 계열의 해당 강도 모델(예: `gemini-3.8-flash-low`)로 자동 변환하거나 `--effort` 플래그를 생략해 안전하게 실행합니다.
   - **실행 모드 (`--mode`)**: `plan` (읽기/계획), `accept-edits` (편집 허용), `auto` (자동 실행) 중 선택합니다.
   - 선택한 모델, 추론 강도, 실행 모드는 브라우저 `localStorage`에 저장됩니다.

3. **프롬프트 입력 및 중단**:
   - `Enter`: 줄바꿈 / `Ctrl+Enter` (또는 `[프롬프트 전달]` 클릭): 실행 요청
   - 실행 중에는 중복 실행 방지를 위해 입력창과 옵션 선택기가 잠금(`disabled`) 처리되며, `[실행 중단]` 버튼으로 실행 중인 `agy.exe` 프로세스를 종료할 수 있습니다.

---

### 3.5 팀원 및 에이전트 구성 모달 (`TeamRosterModal`)

상단 헤더의 `[팀 구성]` 버튼으로 열며, 서로 다른 프로젝트마다 독립적인 팀을 구성해 운영할 수 있습니다.

1. **전체 에이전트 목록 수집 소스**:
   - `WORKSPACE`: `<WORKSPACE>/<rulesDir>/*/RULE.md` 디렉터리를 스캔해 에이전트 ID와 역할 설명을 추출합니다.
   - `CLI`: `agy agents` CLI 출력에서 전역 에이전트를 조회합니다.
   - `CUSTOM` / `PRESET`: 사용자가 UI에서 추가한 에이전트 및 템플릿 기본 프리셋을 표시합니다.

2. **함께 일할 팀원 선택 및 저장**:
   - 목록에서 체크박스로 현재 작업에 참여시킬 팀원만 선택한 뒤 `[선택 팀원 적용]`을 누릅니다.
   - 팀 구성과 `규칙 하위 경로(rulesDir)`는 `office_config.json`에 **`WORKSPACE` 경로별로 분리 저장**되므로, 여러 프로젝트의 팀 구성을 독립적으로 유지할 수 있습니다.

3. **새 에이전트 추가 및 `Rules/` 생성**:
   - 에이전트 ID, 역할 설명, 초기 업무 지침을 입력하고 `[추가 및 팀 편입]`을 누릅니다.
   - `[대상 프로젝트에 Rules 파일 생성]`이 체크되어 있으면 `<WORKSPACE>/<rulesDir>/<AgentId>/RULE.md` 경로와 파일을 생성하고 즉시 현재 팀에 편입시킵니다. (동일 경로에 이미 `RULE.md`가 존재하면 기존 파일을 덮어쓰지 않고 보존합니다.)

---

## 4. 백엔드 API 및 로컬 상태 파일 요약

### 4.1 주요 API 엔드포인트
- `GET /api/state`: 현재 작업 경로, 활성 팀원 상태, 감지된 CLI 세션 목록, 수동 매핑 스냅샷
- `GET /api/stream`: SSE 실시간 스트림 (`state`, `chat_delta`, `chat_result`)
- `GET /api/sessions/:convId/messages`: 특정 CLI 세션의 대화 스레드 조회
- `GET /api/config` / `POST /api/config`: `TARGET_WORKSPACE` 조회 및 변경
- `GET /api/agents` / `POST /api/agents/roster` / `POST /api/agents/create`: 전체 에이전트 목록 조회, 팀원 선택 저장, 에이전트 및 `RULE.md` 생성
- `GET /api/models`: 사용 가능한 모델 목록 조회 (`?refresh=1` 강제 갱신)
- `POST /api/prompt` / `POST /api/prompt/stop`: `agy.exe` 실행 및 중단
- `POST /api/mapping` / `POST /api/handover` / `POST /api/agent/state` / `POST /api/shutdown`

### 4.2 로컬 런타임 파일 (`.gitignore` 제외)
- `office_config.json`: 마지막 `targetWorkspace` 및 작업 경로별 `{ rulesDir, activeAgentIds, customAgents }` 저장
- `office_mapping.json`: `convId -> agentId` 수동/자동 매핑 저장
- `office_state.json`: 외부 스크립트/에이전트 명시 상태 기록용 파일

---

## 5. 문제 해결 (Troubleshooting)

1. **PowerShell에서 `yarn` 실행 시 스크립트 실행 오류 (`PSSecurityException`)가 발생하는 경우**:
   - `yarn` 대신 `yarn.cmd dev`, `yarn.cmd build`, `yarn.cmd bridge` 형태로 `.cmd` 확장자를 지정해 실행합니다.
2. **포트 충돌 (`EADDRINUSE`)이 발생하는 경우**:
   - 기본 포트는 `3110`입니다. 해당 포트가 이미 사용 중이면 실행 전 `set OFFICE_PORT=3120` 등으로 다른 포트를 지정합니다.
3. **데스크톱 Antigravity 앱에서 진행한 대화가 목록에 보이지 않는 경우**:
   - `agy --conversation <id>`는 CLI 저장소(`~/.gemini/antigravity-cli/brain/`)의 세션 ID만 지원합니다. 본 애플리케이션은 CLI 전용 저장소만 스캔하도록 설계되어 있습니다.
4. **코드 수정 후 새 기능이나 API가 바로 보이지 않는 경우**:
   - 백엔드(`server/`) 변경 시 실행 중이던 `yarn.cmd dev` 또는 `yarn.cmd bridge`를 `Ctrl+C`로 종료한 뒤 재실행해야 변경된 브리지 코드가 반영됩니다.
