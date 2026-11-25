<template>
  <header class="hud-header">
    <div class="workspace-bar">
      <span class="workspace-prefix">WORKSPACE</span>
      <input
        v-model="workspaceDraft"
        class="workspace-input"
        type="text"
        placeholder="대상 작업 경로 (예: C:\projects\my-app)"
        @keydown.enter="submitWorkspace"
      />
      <button type="button" class="btn btn-primary btn-sm" @click="submitWorkspace">경로 적용</button>
    </div>

    <div class="hud-controls">
      <button
        type="button"
        class="provider-pill"
        title="AI 백엔드 선택 화면으로 이동"
        @click="emitAction('OPEN_PROVIDER_SELECTOR')"
      >
        <span class="provider-tag">AI</span>
        <span class="provider-name">{{ hudInfo.providerName || 'ANTIGRAVITY' }}</span>
        <span class="provider-change">변경</span>
      </button>

      <span :class="['live-pill', hudInfo.bridgeConnected ? 'is-online' : 'is-offline']">
        <span class="live-dot"></span>
        <span>{{ hudInfo.bridgeConnected ? 'LIVE: ON' : '연결 대기' }}</span>
      </span>

      <div class="progress-pill">
        <span>가동</span>
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: `${hudInfo.pipelineStats.progressPct}%` }"></div>
        </div>
        <span>{{ hudInfo.pipelineStats.activeCount }}/{{ hudInfo.pipelineStats.total }}</span>
      </div>

      <button
        type="button"
        class="btn btn-sm token-hud-btn"
        :title="tokenTooltip"
        @click="emitAction('OPEN_TOKEN_MODAL')"
      >
        토큰 오늘 {{ formattedTodayTokens }} / 누적 {{ formattedTotalTokens }}
      </button>

      <button
        type="button"
        :class="['btn', 'btn-sm', { 'btn-working-alert': workingSessionCount > 0 }]"
        title="세션 작업 현황 확인, 정리(보관/삭제), 작업 중 세션 종료"
        @click="emitAction('OPEN_SESSION_MODAL')"
      >
        세션 ({{ workingSessionCount > 0 ? `작업 ${workingSessionCount} / ` : '' }}{{ activeSessionCount }})
      </button>

      <button
        type="button"
        class="btn btn-sm btn-primary"
        @click="emitAction('OPEN_TEAM_MODAL')"
      >
        팀 구성 ({{ hudInfo.activeTeamCount }}/{{ hudInfo.allAgentsCount }})
      </button>

      <button
        type="button"
        :class="['btn', 'btn-sm', { 'btn-active': hudInfo.meetingActive }]"
        @click="emitAction('CALL_ALL_MEETING')"
      >
        {{ hudInfo.meetingActive ? '자리 복귀' : '회의 소집' }}
      </button>

      <button
        type="button"
        :class="['btn', 'btn-sm', { 'btn-active': !hudInfo.canvasCollapsed }]"
        @click="emitAction('TOGGLE_CANVAS')"
      >
        {{ hudInfo.canvasCollapsed ? '오피스 열기' : '오피스 접기' }}
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { formatTokens, formatPeriodRange } from '@/utils/formatters';

const props = defineProps({
  hudInfo: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const workspaceDraft = ref(props.hudInfo.targetWorkspace || '');

const formattedTotalTokens = computed(() =>
  formatTokens(props.hudInfo.tokenSummary && props.hudInfo.tokenSummary.totalTokens)
);

const formattedTodayTokens = computed(() =>
  formatTokens(props.hudInfo.tokenSummary && props.hudInfo.tokenSummary.todayTokens)
);

const tokenTooltip = computed(() => {
  const ts = props.hudInfo.tokenSummary;
  if (!ts || !ts.periodStartIso) return '세션별 토큰 사용량 상세 보기';
  const range = formatPeriodRange(ts.periodStartIso, ts.periodEndIso, ts.durationMs, true);
  return `집계 기간: ${range} · 클릭하여 기간별/세션별 토큰 상세 보기`;
});

const workingSessionCount = computed(() =>
  Number(props.hudInfo.tokenSummary && props.hudInfo.tokenSummary.workingSessionCount) || 0
);

const activeSessionCount = computed(() =>
  Number(props.hudInfo.tokenSummary && props.hudInfo.tokenSummary.activeSessionCount) || 0
);

watch(
  () => props.hudInfo.targetWorkspace,
  nextVal => {
    if (nextVal && nextVal !== workspaceDraft.value) {
      workspaceDraft.value = nextVal;
    }
  }
);

/**
 * 상위 레이아웃으로 단일 액션 전달
 * @author Jangsung
 * @param {String} type
 * @param {Object} payload
 */
function emitAction(type, payload) {
  emit('action', { type, payload });
}

/**
 * 작업 대상 경로 변경 요청
 * @author Jangsung
 */
function submitWorkspace() {
  const clean = (workspaceDraft.value || '').trim();
  if (!clean) return;
  emitAction('UPDATE_WORKSPACE', { targetWorkspace: clean });
}
</script>

<style lang="scss" scoped>
.hud-header {
  height: 54px;
  min-height: 54px;
  background-color: $bg-surface;
  border-bottom: 1px solid $border-subtle;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  gap: 12px;
}

.workspace-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  max-width: 560px;
  min-width: 240px;
}

.workspace-prefix {
  padding: 5px 8px;
  background-color: $bg-elevated;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-secondary;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.workspace-input {
  flex: 1;
  min-width: 0;
  background-color: $bg-input;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-primary;
  padding: 5px 9px;
  font-family: $font-mono;
  font-size: 11.5px;
  outline: none;

  &:focus {
    border-color: $state-working;
  }
}

.hud-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.provider-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  background-color: $bg-input;
  border: 1px solid $navy-border;
  border-radius: 4px;
  color: $text-primary;
  font-family: $font-mono;
  font-size: 11px;
  cursor: pointer;

  &:hover {
    background-color: $bg-hover;
    border-color: $state-working;
  }
}

.provider-tag {
  color: $text-muted;
  font-weight: 700;
}

.provider-name {
  color: $term-blue;
  font-weight: 700;
}

.provider-change {
  padding-left: 5px;
  border-left: 1px solid $border-subtle;
  font-family: $font-sans;
  font-size: 10.5px;
  color: $text-secondary;
}

.live-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  font-size: 11px;
  font-family: $font-mono;
  color: $text-muted;

  &.is-online {
    border-color: $state-done;
    color: $term-green;

    .live-dot {
      background-color: $state-done;
    }
  }

  &.is-offline {
    border-color: $border-strong;
    color: $text-muted;
  }
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: $state-idle;
}

.progress-pill {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 9px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  font-size: 11px;
  color: $text-secondary;
}

.progress-track {
  width: 56px;
  height: 6px;
  background-color: $bg-elevated;
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background-color: $state-working;
  transition: width 0.25s ease;
}

.btn {
  padding: 5px 10px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background-color: $bg-hover;
  }
}

.btn-sm {
  padding: 4px 9px;
  font-size: 11.5px;
}

.btn-primary {
  background-color: $navy-accent;
  border-color: $navy-border;
  color: $text-primary;

  &:hover {
    background-color: $navy-accent-hover;
  }
}

.btn-active {
  background-color: $navy-accent;
  border-color: $state-working;
  color: $text-primary;
}

.token-hud-btn {
  font-family: $font-mono;
  color: $term-blue;
}

.btn-working-alert {
  border-color: $state-working;
  color: $term-blue;
  background-color: rgba(59, 130, 246, 0.14);
}
</style>
