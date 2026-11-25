# agent-office-cli 로드맵 v1 — CLI 중심 관제 및 데스크톱 기능 보완

- **상태**: `Active`
- **시리즈**: v1 (기준 커밋: `49518f6`, `2026-11-25`)
- **이전 문서**: 없음 (초기 시리즈)
- **상위 인덱스**: [docs/roadmap/README.md](./README.md)

---

## 1. 배경 및 목표

`agent-office-cli`는 Antigravity CLI(`agy.exe`)의 경량 프로세스 실행과 실시간 `stream-json` 스트리밍을 기반으로 다중 AI 에이전트를 동시에 지휘·관제하기 위해 구축한 웹 애플리케이션입니다.  
본 v1 문서는 **Antigravity CLI와 데스크톱 앱(Antigravity 2.0 / IDE)의 기능 비교 및 장·단점을 명확히 구분**하고, 그 근거 위에서 **CLI의 강점은 더 넓게 활용하고 CLI의 단점은 데스크톱 앱의 장점을 웹 UI로 이식해 보완**하는 개발 방향을 정의합니다.

---

## 2. Antigravity CLI vs 데스크톱 앱 비교 및 장·단점

확인 근거: `antigravity_guide` 내장 문서(`references/cli.md`, `references/app.md`, `references/ide.md`), 로컬 `agy.exe --help` 출력, [SPEC.md](../../SPEC.md).

### 2.1 핵심 구조 비교표

| 구분 | Antigravity CLI (`agy.exe`) | Antigravity 데스크톱 앱 (2.0 / IDE) |
| :--- | :--- | :--- |
| **구동 방식 / 자원** | 경량 단일 CLI 바이너리, 에이전트별 독립 프로세스 다중 실행 용이 | Electron 기반 앱(2.0) 또는 VS Code 기반 IDE |
| **외부 자동화·연동** | `-p` 비대화형 단발 실행, `stream-json`(NDJSON 입·출력), `--json-schema`, `acp` 서버 지원 | GUI 중심 조작 (외부 웹앱·스크립트에서 직접 제어 제한) |
| **실행 옵션 제어** | 호출 단위 플래그 조합 (`--model`, `--effort`, `--mode`, `--conversation`, `--agent`, `--add-dir`, `--sandbox`, `--settings`, `--print-timeout`) | 전역·프로젝트별 Settings UI로 권한 정책 관리 (`Command Allowlist/Denylist`, `Browser Allowlist`, 파일/네트워크 정책) |
| **작업 가시성 (UI)** | 기본 텍스트/TUI 출력 중심. 계획 문서, 변경 파일 Diff, 서브에이전트 목록을 보는 전용 보조 패널이 없음 | 보조 패널(Auxiliary Pane)에서 아티팩트(`Implementation Plan` 등) 열람·승인, 서브에이전트·백그라운드 태스크·변경 파일(Files Changed) 확인 |
| **입력 편의 기능** | 텍스트 프롬프트 중심 (`@` 자동완성, 이미지 첨부 UI 부재) | `@` 멘션(파일/폴더/이전 대화/터미널/규칙/MCP), 이미지·파일 드래그 앤 드롭, `/` 슬래시 메뉴, 예약 작업(Cron/Timer) 내장 |
| **코드 편집 밀착성** | 프로젝트·도메인 단위 병렬 작업 지시에 적합 | IDE 기준 Tab 자동완성, 인라인 편집(`Ctrl+I`), Code Lens, 에디터 내 시각적 Diff 오버레이 제공 |
| **세션 저장소** | `~/.gemini/antigravity-cli/brain/<convId>/` 전용 | `~/.gemini/antigravity/brain/<convId>/` 전용 (CLI `--conversation`과 ID 비호환) |

### 2.2 환경별 장점 및 단점 정리

| 대상 | 장점 (Strengths) | 단점 (Weaknesses) |
| :--- | :--- | :--- |
| **Antigravity CLI (`agy.exe`)** | 1. **경량·병렬 실행**: 단일 바이너리라 여러 에이전트 프로세스를 동시에 띄워도 메모리·구동 부담이 작음<br>2. **프로그래매틱 제어**: `-p`, `stream-json`, `acp`로 외부 웹·백엔드에서 실행/중단/로그 수집을 직접 제어 가능<br>3. **실행 단위 옵션 유연성**: 호출마다 `--model`, `--effort`, `--mode`, `--sandbox`, `--add-dir` 등 조합 적용 가능<br>4. **파일 기반 투명성**: 세션별 `transcript.jsonl`과 `.md` 산출물이 표준 경로에 남아 외부 파싱·인수인계 자동화 용이 | 1. **시각적 산출물·승인 UI 부재**: 생성된 `.md` 계획서나 코드 변경 Diff를 보고 바로 승인하는 보조 패널이 없음<br>2. **컨텍스트 입력 불편**: `@` 파일/규칙 자동완성 멘션이나 이미지 첨부 UI가 없어 긴 경로를 직접 입력해야 함<br>3. **작업 알림·상태 추적 한계**: 터미널 포커스를 벗어나면 여러 병렬 세션의 완료·오류 시점을 놓치기 쉬움<br>4. **세션 비호환**: 데스크톱 앱 저장소(`antigravity/brain`)의 세션 ID를 CLI로 이어 실행할 수 없음 |
| **Antigravity 데스크톱 앱 (2.0 / IDE)** | 1. **보조 패널 시각화·승인**: 아티팩트(`Implementation Plan`), `Proceed/Approve` 버튼, 변경 파일, 태스크를 GUI로 즉시 확인<br>2. **리치 입력 및 자동화 UI**: `@` 멘션, `/` 슬래시 메뉴, 미디어 드래그 첨부, Cron/Timer 예약 실행 내장<br>3. **세밀한 권한·에디터 통합**: Command/Browser Allowlist UI 및 Tab/인라인 편집/시각적 Diff 제공 | 1. **무거운 런타임·폐쇄적 제어**: Electron/IDE GUI 중심이라 커스텀 오피스 UI에서 다수 에이전트를 묶어 동시 제어·모니터링하기 어려움<br>2. **파이프라인 조합 제약**: `stream-json` 기반 외부 스크립트/웹 브리지 연동 유연성이 CLI보다 낮음 |

---

## 3. 근거 기반 개선 논리 (강점 확장 + 단점 보완)

2장에서 도출된 장·단점을 바탕으로, `agent-office-cli`는 **CLI의 강점은 기능 확장으로 끌어올리고, CLI의 단점은 데스크톱 앱의 장점을 웹 UI로 구현해 상쇄**하는 구조를 취합니다.

### 3.1 CLI 장점 기반 확장 전략

1. **[경량 병렬 실행 + `stream-json` 제어] → 다중 에이전트 동시 관제·알림 강화 (`RM-05`)**
   - 근거: CLI는 에이전트마다 독립 `agy` 프로세스를 동시에 띄우고 `stream-json` 이벤트를 개별 수신할 수 있습니다.
   - 구현 논리: 이 병렬성을 제대로 활용하려면 사용자가 A 에이전트를 보는 중에도 B 에이전트의 진행 시간과 완료/오류를 즉시 인지해야 하므로, 비선택 에이전트 탭 진행 표시와 브라우저 완료 알림(`Notification API`)을 추가합니다.
2. **[실행 단위 플래그 조합 유연성] → 고급 CLI 플래그 UI 직결 (`RM-04`)**
   - 근거: 데스크톱 앱이 전역 Settings 메뉴에서 정책을 바꾸는 것과 달리, CLI는 프롬프트 실행 시점마다 `--sandbox`, `--add-dir` 등을 즉시 적용할 수 있습니다(`agy.exe --help` 확인).
   - 구현 논리: 현재 브리지([agyRunner.js](../../server/agyRunner.js))가 전달하는 `--model`, `--effort`, `--mode` 외에 `--sandbox`(제한 실행)와 `--add-dir`(참조 디렉터리 추가)를 콘솔 UI에 연결해 다중 저장소 작업 및 안전 제어 폭을 넓힙니다.
3. **[파일 기반 투명한 저장소] → 세션 파싱·건강도·인수인계 자동 검증 (`RM-06`)**
   - 근거: 모든 대화가 `transcript.jsonl`에 기록되므로 외부에서 스텝 병합, 토큰/오류 추출, 파일 용량(`5MB`/`10MB`) 기반 핸드오버를 자동화할 수 있습니다.
   - 구현 논리: 스캔·병합([transcript.js](../../server/transcript.js))과 마크다운 정규화([markdown.js](../../src/utils/markdown.js)), 반응형 좌석 배치([officeLayout.js](../../src/constants/officeLayout.js))의 순수 로직을 경량 회귀 테스트로 고정해 장시간 운영 신뢰성을 유지합니다.

### 3.2 CLI 단점 보완 전략 (데스크톱 앱 장점 이식)

1. **[시각적 아티팩트·승인 부재] → 세션 아티팩트(`.md`) 뷰어 및 원클릭 승인 (`RM-01`)**
   - 보완 논리: `agy` CLI 역시 `~/.gemini/antigravity-cli/brain/<convId>/*.md`에 계획서를 생성하지만, CLI에 뷰어가 없어 데스크톱 앱처럼 문서를 열어보고 `Approve`할 수 없는 것이 가장 큰 단점입니다. 따라서 브리지에서 세션 내 `.md` 목록/본문을 조회하고, 웹 UI에서 마크다운으로 열람한 뒤 클릭 한 번으로 `accept-edits` 실행으로 넘기는 승인 버튼을 구현합니다.
2. **[변경 파일 Diff 확인 불가] → 워크스페이스 Git Diff 패널 (`RM-02`)**
   - 보완 논리: 데스크톱/IDE의 `Files Changed` 패널에 해당하는 기능이 CLI 웹 UI에 없어 수정 내역 검수를 위해 에디터를 별도로 열어야 합니다. 대상 `targetWorkspace`의 `git status`와 파일별 `git diff`를 우측 상단 `변경 파일` 탭으로 제공해 코드 검수 공백을 메웁니다.
3. **[`@` 컨텍스트 입력 불편] → 파일 및 `Rules/` 경로 피커 (`RM-03`)**
   - 보완 논리: 데스크톱 앱의 `@` 멘션 메뉴가 없어 긴 `Rules/Personal/.../RULE.md`나 소스 경로를 직접 입력하다 오타가 나기 쉽습니다. 프롬프트 입력창에 워크스페이스 파일·규칙 문서 검색 피커를 붙여 클릭으로 정확한 경로를 삽입하도록 보완합니다.

---

## 4. v1 개선 백로그

| ID | 상태 | 우선순위 | 과제명 | 연계 근거 (강화/보완) | 구현 개요 및 대상 파일 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **RM-01** | `[ ]` | `P0` | **세션 아티팩트(`*.md`) 뷰어 및 계획 승인** | **단점 보완**: 아티팩트 열람·승인 UI 부재 해소 | `~/.gemini/antigravity-cli/brain/<convId>/` 내 `.md` 목록·본문 조회 및 `accept-edits` 승인 실행 ([transcript.js](../../server/transcript.js), [bridge.js](../../server/bridge.js), [AgentChatPanel.vue](../../src/components/AgentChatPanel.vue)) |
| **RM-02** | `[ ]` | `P1` | **변경 파일(Files Changed / Git Diff) 패널** | **단점 보완**: 수정 코드 시각화 패널 부재 해소 | `targetWorkspace` 기준 `git status`/`git diff` 조회 API 및 우측 상단 `변경 파일` 탭 ([bridge.js](../../server/bridge.js), [AgentChatPanel.vue](../../src/components/AgentChatPanel.vue)) |
| **RM-03** | `[ ]` | `P1` | **`@` 파일 및 `Rules/` 경로 피커** | **단점 보완**: `@` 멘션 자동완성 부재 해소 | 워크스페이스 파일·규칙 문서 검색 및 프롬프트 삽입 피커 ([bridge.js](../../server/bridge.js), [PromptConsole.vue](../../src/components/PromptConsole.vue)) |
| **RM-04** | `[ ]` | `P2` | **CLI 고급 플래그 연동 (`--sandbox`, `--add-dir`)** | **강점 확장**: 실행 단위 플래그 유연성 활용 | 샌드박스 실행 토글 및 다중 참조 디렉터리 지정 옵션 연동 ([agyRunner.js](../../server/agyRunner.js), [PromptConsole.vue](../../src/components/PromptConsole.vue)) |
| **RM-05** | `[ ]` | `P2` | **병렬 실행 알림 및 에이전트 탭 진행 표시** | **강점 확장 + 단점 보완**: 경량 다중 실행 추적·알림 | 비선택 에이전트 탭 경과 시간 표기 및 완료·오류 `Notification API` 알림 ([App.vue](../../src/App.vue), [officeStore.js](../../src/stores/officeStore.js)) |
| **RM-06** | `[ ]` | `P2` | **핵심 로직 경량 회귀 검증 스크립트** | **강점 확장**: 파일 기반 파싱·관제 안정성 보증 | 마크다운 정규화([markdown.js](../../src/utils/markdown.js)), 스텝 병합([transcript.js](../../server/transcript.js)), 좌석 계산([officeLayout.js](../../src/constants/officeLayout.js)) 단위 검증 ([package.json](../../package.json)) |

---

## 5. 마일스톤 진행 및 다음 시리즈 전환 기준

- **단기 목표 (v1.1)**: `RM-01` ~ `RM-02` 완료로 계획 수립 → 아티팩트 열람·승인 → 코드 수정 → Diff 확인 사이클을 웹 UI 단일 화면 안에서 완결
- **중기 목표 (v1.2)**: `RM-03` ~ `RM-06` 완료로 병렬 작업 안정성 및 입력 편의성 보강
- **v2 전환 조건**: 본 문서가 350줄을 넘기거나 v1 백로그(`RM-01`~`RM-06`)가 모두 `[x]`로 완료된 시점에 `ROADMAP_v2.md`를 생성하고 본 문서를 `Archived`로 전환합니다.

---

## 6. 변경 이력

| 일자 | 버전 | 작성/수정 내용 |
| :--- | :--- | :--- |
| 2026-11-25 | v1.0 | 초안 작성 — CLI vs 데스크톱 앱 비교표 및 v1 개선 백로그(`RM-01`~`RM-06`) 정의 |
| 2026-11-25 | v1.1 | CLI·데스크톱 앱별 장·단점 요약표(2.2) 추가 및 장·단점 근거와 백로그 간 인과 매핑(3장, 4장) 보강 |
