# agent-office-cli 작업 인수인계서 (HANDOVER)

- **최종 갱신일**: 2026-11-25
- **프로젝트**: `agent-office-cli` (Vue 3 + Vite 4 + Node.js HTTP/SSE Bridge)
- **관련 문서**: [AGENTS.md](./AGENTS.md) · [SPEC.md](./SPEC.md) · [GUIDE.md](./GUIDE.md) · [docs/roadmap/README.md](./docs/roadmap/README.md)

---

## 1. 확정된 설계 원칙 및 제약 조건

1. **세션 중단(`STOP_PROMPT`) 최우선 원칙** ([AGENTS.md](./AGENTS.md#L7-L14))
   - 어떠한 매핑·캐시·외부 상태(`office_state*.json`)가 존재하더라도 중단 요청은 즉시 OS 프로세스를 강제 종료하고, 중단된 세션의 `RUNNING` 잔재를 `abortedSessions` + `fin.aborted`로 덮어써야 합니다.
   - 매핑 변경 버그를 해결할 때 `finishedJobs` / `fin.aborted`의 중단 보호 우선순위를 약화하거나 삭제하는 방식은 **폐기**하고, 중단 보호를 **세션(`convId`) 단위 `abortedSessions` 맵으로 보존**하는 구조를 채택했습니다.
2. **실행 환경 제약**: 로컬 Node.js `v16.20.2` 호환 유지 (`vite@^4.5`, `@vitejs/plugin-vue@^4.6`).

---

## 2. 최근 해결한 이슈 및 변경 내역 (2026-11-25)

### 이슈: 에이전트(`telepathy` 등)의 세션을 수동으로 다르게 매핑해도 변경되지 않는 문제
- **확인된 원인**:
  1. 직전에 중단/종료된 작업이 `runtime.finishedJobs`에 `agentId` 단위로 30분간 남아, 더 오래된 다른 세션을 매핑해도 `finNewerThanSession` 분기가 `fin.convId`를 덮어씀.
  2. `buildSnapshot()`이 `detectedSessions.find(s => s.role === id)`만 사용해, 동일 역할로 자동 감지된 최신 세션이 있으면 수동 매핑된 과거 세션보다 먼저 선택됨.
  3. `scanCliSessions` / `scanSessions`의 `sessionCache`가 `manualMapping`에서 키가 삭제(매핑 변경/해제)된 경우 캐시된 `role`을 갱신하지 않음.
- **적용한 수정**:
  - [server/bridge.js](file:///C:/vue3/agent-office-cli/server/bridge.js):
    - `runtimeByProvider`에 세션 단위 중단 보호 맵 `abortedSessions` 추가.
    - `buildSnapshot()`에서 `manualMapping`에 지정된 `convId`가 있으면 `detectedSessions`에서 `convId`로 직접 우선 매칭하고, `rawFin`이 현재 매핑 세션과 다를 때는 덮어쓰지 않도록 분리하되 `abortedSessions`로 세션별 중단 보호(`RUNNING` 잔재 차단) 및 `expFresh` 우선 해제를 유지.
    - `POST /api/mapping`에서 타 세션으로 매핑 전환 시 이전 `fin.aborted`를 `abortedSessions`에 보존한 뒤 `finishedJobs` 슬롯만 정리.
    - `POST /api/prompt/stop`에서 요청 `convId` 또는 스냅샷 `convId`를 `stopJob`에 전달하고 `syncAbortedExplicitState()`로 `office_state*.json` 활성 상태도 즉시 중단 전환.
    - `POST /api/prompt` 시작 시 해당 `agentId`의 `finishedJobs` 및 `targetConvId`의 `abortedSessions` 해제.
  - [server/agyRunner.js](file:///C:/vue3/agent-office-cli/server/agyRunner.js) & [server/providers/codexProvider.js](file:///C:/vue3/agent-office-cli/server/providers/codexProvider.js):
    - `stopAgyJob` / `stopCodexJob`에 `opts.convId`, `opts.abortedSessions` 지원 및 `taskkill` 실패 시 `child.kill('SIGKILL')` 폴백 추가.
    - `stdout`/`stderr` 수신 핸들러 첫머리에 `if (job.aborted) return;` 가드 추가.
    - `codexProvider.js` `scanSessions`의 `sessionCache` 히트 조건에 `manualRole` 비교 추가.
  - [server/transcript.js](file:///C:/vue3/agent-office-cli/server/transcript.js):
    - `scanCliSessions`의 `sessionCache` 히트 조건에 `manualRole` 비교를 추가해 매핑 추가·변경·해제 시 즉시 `detectAgentRole` 재계산.
  - [src/components/PromptConsole.vue](file:///C:/vue3/agent-office-cli/src/components/PromptConsole.vue) & [src/stores/officeStore.js](file:///C:/vue3/agent-office-cli/src/stores/officeStore.js):
    - `STOP_PROMPT` 액션에 `convId`를 함께 전달하고 중단 성공 시 `submittingByAgent` 잠금도 즉시 해제.

---

## 3. 다음 할 일 / 운영 유의사항

- 백엔드(`server/`) 코드가 수정되었으므로, 실행 중인 `yarn.cmd dev` 또는 `yarn.cmd bridge` 프로세스가 있다면 재시작해야 수정된 브리지 로직이 실제 포트(`3110`)에 반영됩니다.
- `dist/` 정적 서빙 모드(`yarn.cmd bridge`)를 사용할 경우 `yarn.cmd build`로 프론트엔드 번들을 최신화해야 합니다.
