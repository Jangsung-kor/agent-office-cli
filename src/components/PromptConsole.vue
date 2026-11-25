<template>
  <section class="prompt-console">
    <!-- B안 계승 원터치 CLI 커맨드 컨트롤러 바 -->
    <div class="quick-cmd-bar">
      <div class="quick-cmd-left">
        <span class="bar-label">QUICK CMD</span>
        <button
          type="button"
          class="quick-btn"
          :disabled="isBusy"
          title="대상 작업 경로의 git 상태 및 최근 변경 파일 분석 요청 (plan 모드)"
          @click="runQuickAnalyze"
        >
          변경사항 분석
        </button>
        <button
          type="button"
          :class="['quick-btn', { 'is-warn': needsHandoverWarn }]"
          :disabled="!consoleData.agent.convId || consoleData.handoverLoading"
          title="표준 양식(SESSION_HANDOVER_TEMPLATE) 인수인계서 생성"
          @click="emitAction('GENERATE_HANDOVER', { agentId: consoleData.agent.id, convId: consoleData.agent.convId })"
        >
          {{ consoleData.handoverLoading ? '정리 중...' : '세션 정리' }}
        </button>
        <button
          type="button"
          class="quick-btn"
          :disabled="isBusy"
          title="agy models 목록 새로고침"
          @click="emitAction('REFRESH_MODELS')"
        >
          모델 갱신
        </button>
      </div>

      <label v-if="consoleData.agent.convId" class="new-session-toggle">
        <input
          type="checkbox"
          :checked="consoleData.promptPrefs.createNewSession"
          :disabled="isBusy"
          @change="onPrefChange('createNewSession', $event.target.checked)"
        />
        <span>새 세션으로 실행</span>
      </label>
    </div>

    <!-- CLI 플래그 제어 (--model, --effort, --mode) -->
    <div :class="['options-row', { 'two-cols': selectedModelHasBuiltInEffort }]">
      <div class="option-field field-model">
        <div class="field-label-row">
          <span class="field-label">AI 모델 (--model)</span>
          <button
            type="button"
            class="guide-btn"
            title="AI 모델별 성능 및 토큰 사용량 안내"
            @click="emitAction('OPEN_MODEL_GUIDE')"
          >
            ?
          </button>
        </div>
        <select
          class="option-select"
          :value="selectedModelId"
          :disabled="isBusy"
          @change="onPrefChange('modelId', $event.target.value)"
        >
          <option v-for="m in modelOptions" :key="m.id" :value="m.id">
            {{ m.label }}
          </option>
        </select>
      </div>

      <div v-if="!selectedModelHasBuiltInEffort" class="option-field">
        <span class="field-label">추론 강도 (--effort)</span>
        <select
          class="option-select"
          :value="consoleData.promptPrefs.effort"
          :disabled="isBusy"
          @change="onPrefChange('effort', $event.target.value)"
        >
          <option value="auto">auto (모델 기본)</option>
          <option value="low">low (최소)</option>
          <option value="medium">medium (보통)</option>
          <option value="high">high (권장)</option>
          <option value="xhigh">xhigh (최대)</option>
          <option value="max">max (최상한)</option>
        </select>
      </div>

      <div class="option-field">
        <span class="field-label">실행 모드 (--mode)</span>
        <select
          class="option-select"
          :value="consoleData.promptPrefs.mode"
          :disabled="isBusy"
          @change="onPrefChange('mode', $event.target.value)"
        >
          <option value="plan">plan (읽기/계획)</option>
          <option value="accept-edits">accept-edits (편집 허용)</option>
          <option value="auto">auto (자동 실행)</option>
        </select>
      </div>
    </div>

    <!-- 프롬프트 입력창 & 실행 버튼 -->
    <div class="input-wrap">
      <textarea
        v-model="promptDraft"
        class="prompt-textarea"
        :disabled="isBusy"
        :placeholder="textareaPlaceholder"
        @keydown="onTextareaKeydown"
      ></textarea>

      <div class="action-bar">
        <div class="action-status">
          <span v-if="consoleData.lastError" class="error-text">{{ consoleData.lastError }}</span>
          <span v-else class="hint-text">
            대상: {{ consoleData.agent.id }}
            <template v-if="consoleData.agent.convId && !consoleData.promptPrefs.createNewSession">
              (이어하기 {{ consoleData.agent.convId.slice(0, 8) }})
            </template>
            <template v-else> (새 CLI 세션)</template>
            · Enter: 줄바꿈 / Ctrl+Enter: 전달
          </span>
        </div>

        <div class="action-buttons">
          <button
            v-if="isBusy"
            type="button"
            class="btn btn-danger"
            @click="emitAction('STOP_PROMPT', { agentId: consoleData.agent.id })"
          >
            실행 중단
          </button>
          <button
            type="button"
            class="btn btn-primary"
            :disabled="isBusy || !promptDraft.trim()"
            @click="submitPrompt"
          >
            <span v-if="isBusy" class="btn-spinner"></span>
            <span>{{ isBusy ? '실행 중...' : '프롬프트 전달' }}</span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue';
import { getHealthMeta } from '@/constants/officeLayout';

const props = defineProps({
  consoleData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const promptDraft = ref('');

const FALLBACK_MODELS = [
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' }
];

const modelOptions = computed(() =>
  Array.isArray(props.consoleData.models) && props.consoleData.models.length > 0
    ? props.consoleData.models
    : FALLBACK_MODELS
);

const selectedModelId = computed(() => {
  const pref = props.consoleData.promptPrefs.modelId;
  if (modelOptions.value.some(m => m.id === pref)) return pref;
  return modelOptions.value[0] ? modelOptions.value[0].id : 'gemini-4-hydrogen-high';
});

const selectedModelHasBuiltInEffort = computed(() =>
  /-(low|medium|high|xhigh|max)$/i.test(selectedModelId.value || '')
);

const isBusy = computed(() => {
  const a = props.consoleData.agent;
  return Boolean(
    props.consoleData.isSubmitting
    || a.cliRunning
    || a.state === 'WORKING'
    || a.state === 'PLANNING'
  );
});

const needsHandoverWarn = computed(() => {
  const hm = getHealthMeta(props.consoleData.agent.fileSizeMB, Boolean(props.consoleData.agent.convId));
  return hm.level === 'warn' || hm.level === 'danger';
});

const textareaPlaceholder = computed(() => {
  if (isBusy.value) {
    return '현재 CLI 작업이 진행 중입니다. 완료 또는 중단 후 다음 프롬프트를 입력할 수 있습니다.';
  }
  return `${props.consoleData.agent.id}에게 전달할 지시사항을 입력하세요 (Enter: 줄바꿈, Ctrl+Enter: 전달)`;
});

/**
 * 상위 레이아웃으로 단일 액션 전달
 * @author Jangsung
 * @param {String} type
 * @param {Object} payload
 */
function emitAction(type, payload) {
  emit('action', { type, payload });
}

function onPrefChange(key, value) {
  emitAction('SET_PROMPT_PREF', { [key]: value });
}

function submitPrompt() {
  const clean = (promptDraft.value || '').trim();
  if (!clean || isBusy.value) return;
  const prefs = props.consoleData.promptPrefs;
  emitAction('SEND_PROMPT', {
    agentId: props.consoleData.agent.id,
    convId: prefs.createNewSession ? '' : (props.consoleData.agent.convId || ''),
    modelId: selectedModelId.value,
    effort: selectedModelHasBuiltInEffort.value ? 'auto' : (prefs.effort || 'auto'),
    mode: prefs.mode || 'plan',
    prompt: clean,
    createNew: Boolean(prefs.createNewSession)
  });
  promptDraft.value = '';
}

function runQuickAnalyze() {
  if (isBusy.value) return;
  const prefs = props.consoleData.promptPrefs;
  emitAction('SEND_PROMPT', {
    agentId: props.consoleData.agent.id,
    convId: prefs.createNewSession ? '' : (props.consoleData.agent.convId || ''),
    modelId: selectedModelId.value,
    effort: 'medium',
    mode: 'plan',
    prompt: '현재 작업 디렉터리의 git status와 최근 변경된 핵심 파일 구조를 간결하게 요약해줘.',
    createNew: Boolean(prefs.createNewSession)
  });
}

function onTextareaKeydown(ev) {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    submitPrompt();
  }
}
</script>

<style lang="scss" scoped>
.prompt-console {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  background-color: $bg-surface;
  overflow: auto;
}

.quick-cmd-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.quick-cmd-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.bar-label {
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 700;
  color: $term-blue;
  margin-right: 2px;
}

.quick-btn {
  padding: 4px 9px;
  background-color: $bg-elevated;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-secondary;
  font-family: $font-mono;
  font-size: 11px;
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
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.new-session-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: $text-secondary;
  cursor: pointer;
}

.options-row {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr;
  gap: 8px;

  &.two-cols {
    grid-template-columns: 1.5fr 1fr;
  }
}

.option-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-label {
  font-size: 11px;
  color: $text-secondary;
}

.guide-btn {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 1px solid $border-strong;
  background-color: $bg-input;
  color: $text-secondary;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    border-color: $state-working;
    color: $text-primary;
  }
}

.option-select {
  width: 100%;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-primary;
  padding: 5px 8px;
  font-family: $font-mono;
  font-size: 11.5px;
  outline: none;

  &:focus {
    border-color: $state-working;
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
}

.input-wrap {
  flex: 1;
  min-height: 68px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.prompt-textarea {
  flex: 1;
  min-height: 50px;
  width: 100%;
  resize: none;
  background-color: $bg-input;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-primary;
  padding: 7px 10px;
  font-family: $font-sans;
  font-size: 12.5px;
  line-height: 1.5;
  outline: none;

  &:focus {
    border-color: $state-working;
  }

  &::placeholder {
    color: $text-muted;
  }

  &:disabled {
    background-color: $term-bg;
    color: $text-muted;
    opacity: 0.7;
    cursor: not-allowed;
  }
}

.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.action-status {
  min-width: 0;
  flex: 1;
}

.hint-text {
  font-size: 11px;
  color: $text-muted;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}

.error-text {
  font-size: 11.5px;
  color: $term-danger;
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn {
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.btn-primary {
  background-color: $navy-accent;
  border-color: $navy-border;

  &:hover:not(:disabled) {
    background-color: $navy-accent-hover;
  }
}

.btn-danger {
  background-color: rgba(168, 86, 86, 0.25);
  border-color: $state-danger;
  color: $term-danger;

  &:hover {
    background-color: rgba(168, 86, 86, 0.4);
  }
}

.btn-spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: $text-primary;
  border-radius: 50%;
  animation: cli-spin 0.75s linear infinite;
  vertical-align: -1px;
  margin-right: 6px;
}

@keyframes cli-spin {
  to { transform: rotate(360deg); }
}
</style>
