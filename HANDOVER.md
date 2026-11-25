# agent-office-cli 작업 인수인계서 (HANDOVER)

- **최종 갱신일**: 2026-11-26
- **기준 커밋**: `45d14ff` (`origin/main`)
- **프로젝트**: `agent-office-cli` (Vue 3 + Vite 4 + Node.js HTTP/SSE Bridge)
- **관련 문서**: [AGENTS.md](./AGENTS.md) · [SPEC.md](./SPEC.md) · [GUIDE.md](./GUIDE.md) · [docs/roadmap/README.md](./docs/roadmap/README.md)

---

## 1. 확정된 설계 원칙 및 제약 조건

1. **세션 중단(`STOP_PROMPT`) 최우선 원칙** ([AGENTS.md](./AGENTS.md#L7-L14))
   - 어떠한 매핑·캐시·외부 상태(`office_state*.json`)가 존재하더라도 중단 요청은 즉시 OS 프로세스를 강제 종료하고, 중단된 세션의 `RUNNING` 잔재를 `abortedSessions` + `fin.aborted`로 덮어써야 합니다.
   - 매핑 변경 버그 해결 시 `finishedJobs` / `fin.aborted`의 중단 보호 우선순위를 약화하거나 삭제하는 방식은 **폐기**하고, 중단 보호를 **세션(`convId`) 단위 `abortedSessions` 맵으로 보존**하는 구조를 유지합니다.
2. **실행 환경 제약**: 로컬 Node.js `v16.20.2` 호환 문법 유지 (`vite@^4.5`, `@vitejs/plugin-vue@^4.6`).
3. **Codex 토큰 일자별(`byDate`) 증분 합산 원칙**
   - Codex `token_count` 이벤트의 `total_token_usage`는 세션 누적값이므로, 일자별 버킷(`byDate`) 집계 시 반드시 직전 이벤트 대비 증가분(delta)만 누적해 중복 합산을 방지합니다([server/providers/codexProvider.js](./server/providers/codexProvider.js)).
4. **로컬 런타임 산출물 Git 제외**
   - `office_config.json`, `office_state*.json`, `office_mapping*.json`, `office_sessions_meta*.json`, `HANDOVER.draft.md`, `handovers/`는 로컬 전용 산출물로 [.gitignore](./.gitignore)에서 제외합니다.

---

## 2. 최근 구현 및 해결 이력

### 2026-11-26: 멀티 프로바이더 · 토큰 기간 집계 · 세션 관리 (`45d14ff`)
- **멀티 프로바이더(`Antigravity` / `Codex`) 어댑터**
  - [server/providers/index.js](./server/providers/index.js), [antigravityProvider.js](./server/providers/antigravityProvider.js), [codexProvider.js](./server/providers/codexProvider.js), [ProviderSelectScreen.vue](./src/components/ProviderSelectScreen.vue)로 첫 화면 프로바이더 선택 및 프로바이더별 세션·매핑·실행 상태 격리.
- **토큰 사용량 · 기간 · 일자별(`byDate`) 집계**
  - [server/transcript.js](./server/transcript.js), [codexProvider.js](./server/providers/codexProvider.js), [bridge.js](./server/bridge.js)에서 세션 시작/종료(`startedAtIso`, `lastActiveIso`, `durationMs`)와 일자별 `byDate`, 전체 `tokenSummary` (`todayTokens`, `last7dTokens`, `last30dTokens`, `periodStartIso`, `periodEndIso`) 집계.
  - [src/utils/formatters.js](./src/utils/formatters.js), [OfficeHudHeader.vue](./src/components/OfficeHudHeader.vue), [AgentChatPanel.vue](./src/components/AgentChatPanel.vue), [TokenUsageModal.vue](./src/components/TokenUsageModal.vue)에 `전체 스캔 / 오늘 / 최근 7일 / 최근 30일` 기간 탭 및 사용 기간 표시 구현.
- **세션 관리 · 작업 종료 · 보관/삭제**
  - [SessionManagerModal.vue](./src/components/SessionManagerModal.vue) 및 `POST /api/sessions/meta`(별칭·보관), `POST /api/sessions/terminate`(강제 중단 및 `BLOCKED` 전환), `DELETE /api/sessions/:convId`(경로 검증 포함 삭제) 추가.

### 2026-11-25: 수동 세션 매핑 전환 시 이전 중단 상태 간섭 수정
- **원인**: `runtime.finishedJobs`의 `agentId` 단위 잔존, `buildSnapshot()`의 자동 매칭 우선순위, `sessionCache`의 `manualRole` 미비교로 수동 매핑 변경이 덮어써지던 문제.
- **해결**: [server/bridge.js](./server/bridge.js), [server/agyRunner.js](./server/agyRunner.js), [server/providers/codexProvider.js](./server/providers/codexProvider.js), [server/transcript.js](./server/transcript.js), [src/components/PromptConsole.vue](./src/components/PromptConsole.vue), [src/stores/officeStore.js](./src/stores/officeStore.js)에서 `abortedSessions` 세션 격리, 수동 매핑 `convId` 우선 선택, `sessionCache` `manualRole` 캐시 키 비교, `STOP_PROMPT` 시 `convId` 동반 전달 적용.

---

## 3. 다음 할 일 / 운영 유의사항

- 백엔드(`server/`) 변경 사항을 실제 서비스 포트(`3110`)에 반영하려면 기존 `yarn.cmd dev` 또는 `yarn.cmd bridge` 프로세스를 재시작해야 합니다.
- 정적 서빙 모드(`yarn.cmd bridge`) 사용 시 최신 프론트엔드 번들(`dist/`) 생성을 위해 `npm.cmd run build` 또는 `yarn.cmd build`를 실행하세요.
