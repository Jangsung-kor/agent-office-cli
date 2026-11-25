# agent-office-cli 프로젝트 개발 규칙

본 문서는 `agent-office-cli` 저장소의 필수 불변 원칙과 문서 관리 기준을 정의합니다.

---

## 1. 런타임 및 상태 제어 불변 원칙

### 1.1 세션 중단(`STOP_PROMPT`) 최우선 보장
어떤 상태·매핑·캐시 조건에서도 **세션 중단 기능은 가장 먼저 동작**해야 하며, 후속 기능 추가나 리팩터링 시 이 우선순위를 절대 낮추거나 우회할 수 없습니다.

- **즉시 프로세스 종료**: `POST /api/prompt/stop` (`server/bridge.js`) 및 `stopAgyJob` / `stopCodexJob` (`server/agyRunner.js`, `server/providers/codexProvider.js`)는 OS 프로세스 트리(`taskkill /PID ... /T /F` 또는 `SIGKILL`)를 즉시 종료하고 `runningJobs`에서 대상을 제거합니다.
- **잔여 스트림 차단**: 중단 플래그(`job.aborted = true`)가 설정된 이후 유입되는 `stdout`/`stderr` 청크는 즉시 무시해 `chat_delta`가 재발송되지 않도록 차단합니다.
- **RUNNING 잔재 덮어쓰기 보호**: 강제 종료로 `transcript.jsonl`에 `RUNNING` 스텝이 남아 있더라도 `abortedSessions` (`Map<convId, job>`) 및 `fin.aborted`가 해당 세션의 `RUNNING` 상태를 `BLOCKED`/`IDLE`로 덮어씁니다.
- **명시 상태 파일 동기화**: 중단 시 `office_state*.json`의 활성 상태도 즉시 `BLOCKED`로 전환하고, 스냅샷 병합(`buildSnapshot`)에서 `fin.aborted`가 `expFresh`보다 우선합니다.

### 1.2 수동 세션 매핑 및 캐시 일관성
- **수동 매핑 우선 선택**: `buildSnapshot()`은 `manualMapping`(`office_mapping*.json`)에 해당 `agentId`의 `convId`가 지정되어 있으면 최신 자동 매칭 세션(`s.role === id`)보다 수동 지정 세션을 직접 선택합니다.
- **종료 작업의 세션 귀속 분리**: 사용자가 다른 세션으로 매핑을 전환(`POST /api/mapping`)할 때 이전 세션의 `finishedJobs`가 새 매핑 세션을 가로채지 않도록 세션(`convId`) 일치 여부를 검증합니다. 단, 이전 세션의 중단 보호 기록은 `abortedSessions`에 보존해 원래 세션으로 되돌릴 때도 중단 상태가 유지되도록 합니다.
- **세션 캐시 무효화**: `scanCliSessions` (`server/transcript.js`)와 `scanSessions` (`server/providers/codexProvider.js`)는 파일 `mtimeMs`/`size`, `rosterSig`와 함께 `manualRole`을 캐시 키로 비교해 매핑 추가·변경·해제 시 해당 세션을 즉시 재분석합니다.

---

## 2. 코드 및 문서 작성 기준

- Node.js `v16.20.2` 호환 문법을 유지합니다.
- 확인되지 않은 동작·테스트 결과를 사실처럼 보고하지 않습니다([SPEC.md](./SPEC.md) 기준).
- `AGENTS.md`는 10KB 이하로 핵심 원칙만 유지하며, 상세 변경 이력과 작업 인수인계는 [HANDOVER.md](./HANDOVER.md)에 기록합니다.
- `HANDOVER.md`는 350줄을 넘기지 않도록 유지하고, 상세 로드맵은 [docs/roadmap/README.md](./docs/roadmap/README.md)를 따릅니다.
