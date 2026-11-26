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

      <div ref="accountWrapRef" class="account-wrap">
        <button
          type="button"
          :class="['account-pill', { 'is-active': showAccountPopover }]"
          :title="accountTooltip"
          @click="toggleAccountPopover"
        >
          <span class="account-tag">계정</span>
          <span class="account-val">{{ accountShortLabel }}</span>
        </button>

        <div v-if="showAccountPopover" class="account-popover">
          <div class="pop-head">
            <span>접속 계정 상태 ({{ hudInfo.providerName || 'ANTIGRAVITY' }})</span>
            <button type="button" class="pop-close" @click="showAccountPopover = false">닫기</button>
          </div>
          <div class="pop-meta-row">
            <span class="pop-key">인증 방식</span>
            <span class="pop-val mono">{{ (hudInfo.accountInfo && hudInfo.accountInfo.authMethod) || '-' }}</span>
          </div>
          <div v-if="hudInfo.accountInfo && hudInfo.accountInfo.detectedEmail" class="pop-meta-row">
            <span class="pop-key">감지 이메일</span>
            <span class="pop-val mono">{{ hudInfo.accountInfo.detectedEmail }}</span>
          </div>
          <div v-if="hudInfo.accountInfo && hudInfo.accountInfo.plan" class="pop-meta-row">
            <span class="pop-key">플랜</span>
            <span class="pop-val mono">{{ hudInfo.accountInfo.plan }}</span>
          </div>
          <div v-if="hudInfo.accountInfo && hudInfo.accountInfo.note" class="pop-note">
            {{ hudInfo.accountInfo.note }}
          </div>
          <div class="pop-label-form">
            <label class="pop-form-label" for="accountLabelInput">표시용 계정 메모 (구분용 · 인증 키 입력 아님)</label>
            <div class="pop-form-row">
              <input
                id="accountLabelInput"
                v-model="accountLabelDraft"
                type="text"
                class="pop-input"
                maxlength="60"
                placeholder="예: 회사 Google (name@company.com)"
                @keydown.enter="saveAccountLabel"
                @keydown.escape="showAccountPopover = false"
              />
              <button type="button" class="btn btn-sm btn-primary" @click="saveAccountLabel">저장</button>
              <button
                v-if="hudInfo.accountInfo && hudInfo.accountInfo.customLabel"
                type="button"
                class="btn btn-sm"
                @click="clearAccountLabel"
              >
                초기화
              </button>
            </div>
          </div>
        </div>
      </div>

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
        :class="['btn', 'btn-sm', { 'btn-active': !hudInfo.canvasCollapsed }]"
        @click="emitAction('TOGGLE_CANVAS')"
      >
        {{ hudInfo.canvasCollapsed ? '오피스 열기' : '오피스 접기' }}
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { formatTokens, formatPeriodRange } from '@/utils/formatters';

const props = defineProps({
  hudInfo: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const workspaceDraft = ref(props.hudInfo.targetWorkspace || '');
const accountWrapRef = ref(null);
const showAccountPopover = ref(false);
const accountLabelDraft = ref('');

const accountShortLabel = computed(() => {
  const info = props.hudInfo.accountInfo;
  if (!info) return '확인 중';
  const raw = info.displayLabel || '확인 필요';
  return raw.length > 22 ? `${raw.slice(0, 21)}..` : raw;
});

const accountTooltip = computed(() => {
  const info = props.hudInfo.accountInfo;
  if (!info) return '현재 접속 계정 상태 확인 및 라벨 지정';
  return `${info.authMethod || ''} · ${info.displayLabel || ''} (클릭하여 상세 보기/라벨 설정)`;
});

watch(
  () => props.hudInfo.accountInfo && props.hudInfo.accountInfo.customLabel,
  nextLabel => {
    accountLabelDraft.value = nextLabel || '';
  },
  { immediate: true }
);

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

function toggleAccountPopover() {
  if (!showAccountPopover.value) {
    accountLabelDraft.value = (props.hudInfo.accountInfo && props.hudInfo.accountInfo.customLabel) || '';
  }
  showAccountPopover.value = !showAccountPopover.value;
}

function saveAccountLabel() {
  emitAction('UPDATE_ACCOUNT_LABEL', {
    providerId: props.hudInfo.providerId,
    label: (accountLabelDraft.value || '').trim()
  });
  showAccountPopover.value = false;
}

function clearAccountLabel() {
  accountLabelDraft.value = '';
  emitAction('UPDATE_ACCOUNT_LABEL', {
    providerId: props.hudInfo.providerId,
    label: ''
  });
  showAccountPopover.value = false;
}

function onDocMouseDown(ev) {
  if (!showAccountPopover.value || !accountWrapRef.value) return;
  if (!accountWrapRef.value.contains(ev.target)) {
    showAccountPopover.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMouseDown);
});
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

.account-wrap {
  position: relative;
}

.account-pill {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-secondary;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;

  &:hover,
  &.is-active {
    background-color: $bg-hover;
    border-color: $state-working;
    color: $text-primary;
  }
}

.account-tag {
  color: $text-muted;
  font-weight: 600;
}

.account-val {
  font-family: $font-mono;
  color: $text-primary;
}

.account-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 340px;
  padding: 11px 12px;
  background-color: $bg-surface;
  border: 1px solid $border-strong;
  border-radius: 6px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  color: $text-primary;
  padding-bottom: 6px;
  border-bottom: 1px solid $border-subtle;
}

.pop-close {
  background: transparent;
  border: 1px solid $border-subtle;
  border-radius: 3px;
  color: $text-secondary;
  font-size: 10.5px;
  padding: 2px 6px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
  }
}

.pop-meta-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
}

.pop-key {
  color: $text-muted;
  flex-shrink: 0;
}

.pop-val {
  color: $text-primary;
  text-align: right;
  word-break: break-all;
}

.pop-note {
  padding: 6px 8px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.45;
  color: $text-secondary;
}

.pop-label-form {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 4px;
  border-top: 1px solid $border-subtle;
}

.pop-form-label {
  font-size: 10.5px;
  color: $text-muted;
}

.pop-form-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.pop-input {
  flex: 1;
  min-width: 0;
  background-color: $bg-input;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-primary;
  padding: 4px 7px;
  font-size: 11.5px;
  outline: none;

  &:focus {
    border-color: $state-working;
  }
}

.mono {
  font-family: $font-mono;
}
</style>
