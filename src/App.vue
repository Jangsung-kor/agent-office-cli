<template>
  <ProviderSelectScreen
    v-if="store.showProviderSelector"
    :providers="store.providers"
    :active-provider="store.activeProvider"
    :target-workspace="store.targetWorkspace"
    :loading="store.providersLoading"
    :switching-id="store.providerSwitchingId"
    :error="store.lastError"
    @action="handleAction"
  />

  <div v-else class="app-shell">
    <OfficeHudHeader :hud-info="hudInfo" @action="handleAction" />

    <div v-if="store.bridgeOutdated" class="bridge-outdated-banner">
      구버전 브리지 서버({{ store.bridgeVersion }})가 실행 중이어서 세션 보관·종료·토큰 API가 동작하지 않을 수 있습니다. 실행 중인
      <code>yarn.cmd dev</code> 또는 <code>yarn.cmd bridge</code>를 종료(Ctrl+C) 후 재시작하세요.
    </div>

    <main ref="workspaceRef" class="workspace-split">
      <!-- 좌측: 2D 오피스 캔버스 -->
      <div
        v-show="!canvasCollapsed"
        class="left-pane"
        :style="{ width: `${leftWidthPct}%` }"
      >
        <OfficeCanvas :canvas-state="canvasState" @action="handleAction" />
      </div>

      <!-- 좌우 수직 리사이즈 스플리터 -->
      <div
        v-show="!canvasCollapsed"
        :class="['v-resizer', { 'is-dragging': isDraggingV }]"
        title="좌우 패널 비율 조절"
        @mousedown="startVerticalResize"
      ></div>

      <!-- 우측: C안 인터랙티브 CLI 터미널 워크벤치 -->
      <section ref="rightPaneRef" class="right-pane">
        <!-- B안 스타일 터미널 상단 타이틀 바 -->
        <header class="terminal-header">
          <span class="window-title">
            {{ store.providerCapabilities.cliLabel || 'agy-cli' }} — {{ currentAgent.id }} ({{ currentAgent.role }})
          </span>
          <div class="window-meta">
            <div ref="healthGuideRef" class="health-guide-wrap">
              <span :class="['health-badge', healthMeta.cls]">
                {{ healthMeta.label }}
                <template v-if="currentAgent.convId"> {{ currentAgent.fileSizeMB }}MB</template>
              </span>
              <button
                type="button"
                :class="['health-guide-btn', { 'is-active': showHealthGuide }]"
                title="세션 상태 기준: 양호(<5MB) · 주의(5~10MB 미만) · 위험(≥10MB)"
                aria-label="세션 용량 상태 기준 안내"
                :aria-expanded="showHealthGuide"
                @click="toggleHealthGuide"
              >
                ?
              </button>

              <div v-if="showHealthGuide" class="health-guide-popover" role="dialog" aria-label="세션 용량 상태 기준">
                <div class="guide-popover-head">
                  <span class="guide-popover-title">
                    세션 용량 상태 기준 ({{ store.providerCapabilities.healthBasis || 'transcript.jsonl 파일 크기' }})
                  </span>
                  <button
                    type="button"
                    class="guide-popover-close"
                    aria-label="닫기"
                    @click="showHealthGuide = false"
                  >
                    ×
                  </button>
                </div>
                <ul class="guide-criteria-list">
                  <li v-for="item in HEALTH_CRITERIA" :key="item.level" class="guide-criteria-item">
                    <div class="guide-criteria-top">
                      <span :class="['health-badge', item.cls]">{{ item.label }}</span>
                      <span class="guide-threshold">{{ item.threshold }}</span>
                    </div>
                    <p class="guide-desc">{{ item.desc }}</p>
                  </li>
                </ul>
              </div>
            </div>
            <button
              v-if="currentAgent.convId && isCurrentAgentWorking"
              type="button"
              class="header-terminate-btn"
              title="현재 작업 중인 세션을 즉시 종료"
              @click="handleAction({ type: 'TERMINATE_SESSION', payload: { convId: currentAgent.convId, agentId: currentAgent.id } })"
            >
              세션 종료
            </button>
            <button
              v-if="currentAgent.convId"
              type="button"
              :class="['header-handover-btn', { 'is-warn': healthMeta.level === 'warn' || healthMeta.level === 'danger' }]"
              :disabled="store.handoverLoading"
              title="현재 세션을 HANDOVER.md 인수인계서로 정리"
              @click="handleAction({ type: 'GENERATE_HANDOVER', payload: { agentId: currentAgent.id, convId: currentAgent.convId } })"
            >
              {{ store.handoverLoading ? '정리 중...' : '세션 정리' }}
            </button>
            <span :class="['state-badge', `state-${(currentAgent.state || 'IDLE').toLowerCase()}`]">
              {{ currentAgent.state }}
            </span>
          </div>
        </header>

        <!-- 에이전트 빠른 전환 & CLI 세션 매핑 바 -->
        <div class="agent-strip">
          <div class="agent-tabs">
            <button
              v-for="agent in store.officeAgents"
              :key="agent.id"
              type="button"
              :class="['agent-chip', { 'is-selected': agent.id === store.selectedAgentId }]"
              @click="handleAction({ type: 'SELECT_AGENT', payload: { agentId: agent.id } })"
            >
              <span :class="['chip-dot', `state-${(agent.state || 'IDLE').toLowerCase()}`]"></span>
              <span>{{ agent.name }}</span>
            </button>
          </div>

          <div v-if="!currentAgent.isDynamicWorker" class="session-mapper">
            <select v-model="selectedMapConvId" class="map-select">
              <option value="">CLI 세션 매핑 선택...</option>
              <option v-for="s in selectableSessions" :key="s.convId" :value="s.convId">
                {{ s.isWorking ? '[작업중] ' : '' }}[{{ s.role || '미할당' }}] {{ s.convId.slice(0, 8) }} ({{ s.fileSizeMB }}MB) - {{ (s.alias || s.titlePreview || '').slice(0, 22) }}
              </option>
            </select>
            <button
              type="button"
              class="map-btn"
              @click="applyManualMapping"
            >
              연결
            </button>
          </div>
        </div>

        <!-- 우측 상단: 실시간 대화 스레드 & 터미널 뷰어 -->
        <div class="right-top-pane" :style="{ height: `${topHeightPct}%` }">
          <AgentChatPanel :panel-data="chatPanelData" @action="handleAction" />
        </div>

        <!-- 우측 상하 수평 리사이즈 스플리터 -->
        <div
          :class="['h-resizer', { 'is-dragging': isDraggingH }]"
          title="대화 뷰어 및 콘솔 높이 조절"
          @mousedown="startHorizontalResize"
        ></div>

        <!-- 우측 하단: 원터치 커맨드 + 프롬프트 실행 콘솔 -->
        <footer class="right-bottom-pane">
          <PromptConsole :console-data="consoleData" @action="handleAction" />
        </footer>
      </section>
    </main>

    <ModelGuideModal
      :visible="store.activeModal === 'modelGuide'"
      :provider-id="store.activeProvider"
      @action="handleAction"
    />
    <HandoverModal
      :visible="store.activeModal === 'handover'"
      :handover="store.handoverResult"
      @action="handleAction"
    />
    <TeamRosterModal
      :visible="store.activeModal === 'teamRoster'"
      :roster-data="rosterData"
      @action="handleAction"
    />
    <TokenUsageModal
      :visible="store.activeModal === 'tokenUsage'"
      :token-data="tokenModalData"
      @action="handleAction"
    />
    <SessionManagerModal
      :visible="store.activeModal === 'sessionManager'"
      :session-data="sessionModalData"
      @action="handleAction"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useOfficeStore } from '@/stores/officeStore';
import { getHealthMeta, HEALTH_CRITERIA } from '@/constants/officeLayout';
import OfficeHudHeader from '@/components/OfficeHudHeader.vue';
import OfficeCanvas from '@/components/OfficeCanvas.vue';
import AgentChatPanel from '@/components/AgentChatPanel.vue';
import PromptConsole from '@/components/PromptConsole.vue';
import ProviderSelectScreen from '@/components/ProviderSelectScreen.vue';
import ModelGuideModal from '@/components/ModelGuideModal.vue';
import HandoverModal from '@/components/HandoverModal.vue';
import TeamRosterModal from '@/components/TeamRosterModal.vue';
import TokenUsageModal from '@/components/TokenUsageModal.vue';
import SessionManagerModal from '@/components/SessionManagerModal.vue';

const STORAGE_LEFT_W = 'agent_office_cli_left_w';
const STORAGE_TOP_H = 'agent_office_cli_top_h';

const store = useOfficeStore();

const workspaceRef = ref(null);
const rightPaneRef = ref(null);
const healthGuideRef = ref(null);
const showHealthGuide = ref(false);
const canvasCollapsed = ref(false);
const isDraggingV = ref(false);
const isDraggingH = ref(false);

const leftWidthPct = ref(readSavedNumber(STORAGE_LEFT_W, 50, 28, 72));
const topHeightPct = ref(readSavedNumber(STORAGE_TOP_H, 60, 35, 80));
const selectedMapConvId = ref('');

/**
 * localStorage 저장 비율 안전 조회
 * @author Jangsung
 */
function readSavedNumber(key, fallback, min, max) {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw >= min && raw <= max) return raw;
  } catch (_) {}
  return fallback;
}

const currentAgent = computed(() => store.selectedAgent || {
  id: 'Master',
  name: 'Master',
  role: 'Team Lead / PM',
  state: 'IDLE',
  convId: null,
  fileSizeMB: 0,
  currentTool: '-',
  currentTask: '-',
  currentTaskSummary: '-',
  logs: [],
  isDynamicWorker: false
});

const healthMeta = computed(() =>
  getHealthMeta(currentAgent.value.fileSizeMB, Boolean(currentAgent.value.convId))
);

watch(
  () => currentAgent.value.convId,
  nextConvId => {
    selectedMapConvId.value = nextConvId || '';
  },
  { immediate: true }
);

const isCurrentAgentWorking = computed(() =>
  Boolean(
    currentAgent.value.cliRunning
    || currentAgent.value.state === 'WORKING'
    || currentAgent.value.state === 'PLANNING'
  )
);

const selectableSessions = computed(() =>
  (store.sessions || []).filter(s => !s.archived || s.convId === selectedMapConvId.value)
);

const hudInfo = computed(() => ({
  bridgeConnected: store.bridgeConnected,
  bridgeVersion: store.bridgeVersion,
  providerId: store.activeProvider,
  providerName: (store.providerCapabilities && store.providerCapabilities.name) || 'ANTIGRAVITY',
  targetWorkspace: store.targetWorkspace,
  pipelineStats: store.pipelineStats,
  tokenSummary: store.tokenSummary,
  meetingActive: store.meetingActive,
  canvasCollapsed: canvasCollapsed.value,
  activeTeamCount: store.activeAgentIds.length,
  allAgentsCount: store.allAgents.length
}));

const canvasState = computed(() => ({
  agents: store.officeAgents,
  selectedAgentId: store.selectedAgentId,
  hoveredAgentId: store.hoveredAgentId,
  meetingActive: store.meetingActive,
  packets: store.packets,
  pipelineStats: store.pipelineStats
}));

const chatPanelData = computed(() => ({
  agent: currentAgent.value,
  messages: store.activeSessionMessages,
  sessionUsage: store.activeSessionUsage,
  messagesLoading: store.messagesLoading,
  activeStream: store.activeStream,
  rawStreamLogs: store.activeRawStreamLogs,
  targetWorkspace: store.targetWorkspace,
  cliCommand: (store.providerCapabilities && store.providerCapabilities.cliCommand) || 'agy'
}));

const consoleData = computed(() => ({
  agent: currentAgent.value,
  models: store.models,
  capabilities: store.providerCapabilities,
  promptPrefs: store.promptPrefs,
  isSubmitting: Boolean(store.submittingByAgent[currentAgent.value.id]),
  handoverLoading: store.handoverLoading,
  lastError: store.lastError
}));

const rosterData = computed(() => ({
  targetWorkspace: store.targetWorkspace,
  workspaceMode: store.workspaceMode,
  rulesDir: store.rulesDir,
  candidateProjects: store.candidateProjects,
  allAgents: store.allAgents,
  activeAgentIds: store.activeAgentIds,
  loading: store.rosterLoading,
  error: store.lastError
}));

const tokenModalData = computed(() => ({
  providerId: store.activeProvider,
  providerLabel: (store.providerCapabilities && store.providerCapabilities.label) || 'CLI',
  tokenSummary: store.tokenSummary,
  sessions: store.sessions,
  agents: store.agents
}));

const sessionModalData = computed(() => ({
  providerId: store.activeProvider,
  providerLabel: (store.providerCapabilities && store.providerCapabilities.label) || 'CLI',
  sessions: store.sessions,
  activeAgents: Object.values(store.agents || {}),
  manualMapping: store.manualMapping,
  error: store.lastError
}));

/**
 * 중앙 단방향 액션 핸들러
 * @author Jangsung
 * @param {Object} action
 */
function handleAction(action) {
  if (!action || !action.type) return;
  if (action.type === 'TOGGLE_CANVAS') {
    canvasCollapsed.value = !canvasCollapsed.value;
    return;
  }
  store.dispatchAction(action);
}

/**
 * 선택된 에이전트에 CLI 세션 수동 매핑 적용
 * @author Jangsung
 */
function applyManualMapping() {
  handleAction({
    type: 'UPDATE_MAPPING',
    payload: {
      agentId: currentAgent.value.id,
      convId: selectedMapConvId.value || null
    }
  });
}

function startVerticalResize(e) {
  e.preventDefault();
  isDraggingV.value = true;
}

function startHorizontalResize(e) {
  e.preventDefault();
  isDraggingH.value = true;
}

function onWindowMouseMove(e) {
  if (isDraggingV.value && workspaceRef.value) {
    const rect = workspaceRef.value.getBoundingClientRect();
    if (rect.width > 0) {
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      leftWidthPct.value = Math.min(72, Math.max(28, Math.round(pct * 10) / 10));
    }
  }
  if (isDraggingH.value && rightPaneRef.value) {
    const rect = rightPaneRef.value.getBoundingClientRect();
    // 상단 타이틀 바(42px)와 에이전트 스트립(38px)을 제외한 본문 영역 기준 비율 계산
    const contentTop = rect.top + 80;
    const contentHeight = rect.height - 80;
    if (contentHeight > 120) {
      const pct = ((e.clientY - contentTop) / contentHeight) * 100;
      topHeightPct.value = Math.min(82, Math.max(35, Math.round(pct * 10) / 10));
    }
  }
}

function onWindowMouseUp() {
  if (isDraggingV.value) {
    isDraggingV.value = false;
    try { localStorage.setItem(STORAGE_LEFT_W, String(leftWidthPct.value)); } catch (_) {}
  }
  if (isDraggingH.value) {
    isDraggingH.value = false;
    try { localStorage.setItem(STORAGE_TOP_H, String(topHeightPct.value)); } catch (_) {}
  }
}

function toggleHealthGuide() {
  showHealthGuide.value = !showHealthGuide.value;
}

function onDocumentPointerDown(e) {
  if (!showHealthGuide.value || !healthGuideRef.value) return;
  if (!healthGuideRef.value.contains(e.target)) {
    showHealthGuide.value = false;
  }
}

function onDocumentKeydown(e) {
  if (e.key === 'Escape' && showHealthGuide.value) {
    showHealthGuide.value = false;
  }
}

onMounted(async () => {
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
  document.addEventListener('mousedown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
  await store.fetchInitialData();
  store.connectStream();
  if (currentAgent.value.convId) {
    await store.dispatchAction({
      type: 'REFRESH_MESSAGES',
      payload: { convId: currentAgent.value.convId }
    });
  }
});

onUnmounted(() => {
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
  document.removeEventListener('mousedown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
  store.disconnectStream();
});
</script>

<style lang="scss">
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  background-color: $bg-base;
  color: $text-primary;
  font-family: $font-sans;
  font-size: 13px;
  overflow: hidden;
}

* {
  scrollbar-width: thin;
  scrollbar-color: $border-strong $bg-base;
}

::-webkit-scrollbar {
  width: 7px;
  height: 7px;
}

::-webkit-scrollbar-track {
  background: $bg-base;
}

::-webkit-scrollbar-thumb {
  background: $border-strong;
  border-radius: 4px;

  &:hover {
    background: $navy-border;
  }
}
</style>

<style lang="scss" scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  background-color: $bg-base;
}

.bridge-outdated-banner {
  padding: 6px 14px;
  background-color: rgba(217, 119, 6, 0.16);
  border-bottom: 1px solid $term-warn;
  color: $term-yellow;
  font-size: 11.5px;
  line-height: 1.4;

  code {
    font-family: $font-mono;
    padding: 1px 4px;
    background-color: $bg-input;
    border-radius: 3px;
    color: $text-primary;
  }
}

.workspace-split {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.left-pane {
  min-width: 320px;
  height: 100%;
  display: flex;
  flex-shrink: 0;
}

.v-resizer {
  width: 6px;
  background-color: $bg-base;
  border-left: 1px solid $border-subtle;
  border-right: 1px solid $border-subtle;
  cursor: col-resize;
  flex-shrink: 0;

  &:hover,
  &.is-dragging {
    background-color: $state-working;
  }
}

.right-pane {
  flex: 1;
  min-width: 360px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: $term-bg;
  overflow: hidden;
}

.terminal-header {
  height: 40px;
  min-height: 40px;
  background-color: $term-bar;
  border-bottom: 1px solid $border-subtle;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.window-title {
  font-family: $font-mono;
  font-size: 12px;
  font-weight: 600;
  color: $text-secondary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.window-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.health-guide-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.health-badge {
  padding: 2px 7px;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 600;

  &.health-ok {
    color: $term-green;
    background-color: rgba(16, 185, 129, 0.14);
  }
  &.health-warn {
    color: $term-yellow;
    background-color: rgba(217, 119, 6, 0.16);
  }
  &.health-danger {
    color: $term-danger;
    background-color: rgba(225, 29, 72, 0.18);
  }
  &.health-none {
    color: $text-muted;
    background-color: rgba(100, 116, 139, 0.14);
  }
}

.health-guide-btn {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid $border-strong;
  background-color: $bg-input;
  color: $text-secondary;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;

  &:hover,
  &.is-active {
    border-color: $state-working;
    color: $text-primary;
    background-color: $bg-elevated;
  }
}

.health-guide-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 300px;
  max-width: calc(100vw - 32px);
  background-color: $bg-surface;
  border: 1px solid $border-strong;
  border-radius: 6px;
  padding: 10px 12px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.guide-popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid $border-subtle;
}

.guide-popover-title {
  font-size: 11.5px;
  font-weight: 700;
  color: $text-primary;
}

.guide-popover-close {
  border: none;
  background: transparent;
  color: $text-secondary;
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
  }
}

.guide-criteria-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.guide-criteria-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.guide-criteria-top {
  display: flex;
  align-items: center;
  gap: 7px;
}

.guide-threshold {
  font-family: $font-mono;
  font-size: 11px;
  font-weight: 600;
  color: $text-primary;
}

.guide-desc {
  font-size: 11px;
  line-height: 1.4;
  color: $text-secondary;
}

.header-terminate-btn {
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid $state-danger;
  background-color: rgba(225, 29, 72, 0.2);
  color: $term-danger;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    background-color: rgba(225, 29, 72, 0.35);
  }
}

.header-handover-btn {
  padding: 2px 8px;
  border-radius: 3px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-secondary;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;

  &:hover:not(:disabled) {
    background-color: $bg-hover;
    color: $text-primary;
  }

  &.is-warn:not(:disabled) {
    border-color: $term-warn;
    color: $term-yellow;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.state-badge {
  padding: 2px 7px;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 700;
  border: 1px solid $border-subtle;
  color: $text-secondary;

  &.state-working {
    color: $term-blue;
    border-color: $state-working;
  }
  &.state-planning {
    color: $state-planning;
    border-color: $state-planning;
  }
  &.state-done {
    color: $term-green;
    border-color: $state-done;
  }
  &.state-blocked {
    color: $term-yellow;
    border-color: $state-blocked;
  }
}

.agent-strip {
  min-height: 40px;
  padding: 6px 12px;
  background-color: $bg-surface;
  border-bottom: 1px solid $border-subtle;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.agent-tabs {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.agent-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-secondary;
  font-family: $font-mono;
  font-size: 11px;
  cursor: pointer;

  &:hover {
    background-color: $bg-hover;
    color: $text-primary;
  }

  &.is-selected {
    background-color: $navy-accent;
    border-color: $navy-border;
    color: $text-primary;
  }
}

.chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: $state-idle;

  &.state-working { background-color: $state-working; }
  &.state-planning { background-color: $state-planning; }
  &.state-done { background-color: $state-done; }
  &.state-blocked { background-color: $state-blocked; }
}

.session-mapper {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  max-width: 440px;
}

.map-select {
  width: 100%;
  max-width: 360px;
  height: 28px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-secondary;
  padding: 3px 7px;
  font-family: $font-mono;
  font-size: 11px;
  outline: none;
}

.map-btn {
  padding: 4px 9px;
  background-color: $bg-elevated;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-primary;
  font-size: 11px;
  cursor: pointer;

  &:hover {
    background-color: $bg-hover;
  }
}

.right-top-pane {
  min-height: 160px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.h-resizer {
  height: 6px;
  background-color: $bg-base;
  border-top: 1px solid $border-subtle;
  border-bottom: 1px solid $border-subtle;
  cursor: row-resize;
  flex-shrink: 0;

  &:hover,
  &.is-dragging {
    background-color: $state-working;
  }
}

.right-bottom-pane {
  flex: 1;
  min-height: 215px;
  background-color: $bg-surface;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
