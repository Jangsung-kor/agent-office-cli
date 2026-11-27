<template>
  <section class="prompt-console">
    <!-- 1줄 슬림 CLI 옵션 바 (--model, --effort, --mode) -->
    <div :class="['options-row', { 'two-cols': selectedModelHasBuiltInEffort }]">
      <div class="option-item field-model">
        <span class="field-label">모델</span>
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
        <button
          type="button"
          class="guide-btn"
          title="AI 모델 안내 및 목록 새로고침"
          @click="emitAction('OPEN_MODEL_GUIDE')"
        >
          ?
        </button>
      </div>

      <div v-if="!selectedModelHasBuiltInEffort" class="option-item">
        <span class="field-label">강도</span>
        <select
          class="option-select"
          :value="selectedEffortId"
          :disabled="isBusy"
          @change="onPrefChange('effort', $event.target.value)"
        >
          <option v-for="eff in effortOptions" :key="eff.id" :value="eff.id">
            {{ eff.label }}
          </option>
        </select>
      </div>

      <div class="option-item">
        <span class="field-label">보안 등급</span>
        <select
          class="option-select"
          :value="selectedModeId"
          :disabled="isBusy"
          @change="onPrefChange('mode', $event.target.value)"
        >
          <option v-for="md in modeOptions" :key="md.id" :value="md.id">
            {{ md.label }}
          </option>
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
          <div v-if="consoleData.lastError" class="error-status-row">
            <span class="error-text" :title="consoleData.lastError">
              {{ displayLastErrorText }}
            </span>
            <button
              type="button"
              class="error-explain-btn"
              :disabled="lastErrorExplainLoading"
              title="기존 대화 세션과 분리해 원인 해석"
              @click="requestLastErrorExplain"
            >
              {{ lastErrorExplainLoading ? '해석 중...' : '원인 해석' }}
            </button>
          </div>
          <span v-else class="hint-text">
            대상: {{ consoleData.agent.id }}
            <template v-if="consoleData.agent.convId && !consoleData.promptPrefs.createNewSession">
              ({{ consoleData.agent.convId.slice(0, 8) }})
            </template>
            <template v-else> (새 CLI 세션)</template>
            · Ctrl+Enter 전달
          </span>
        </div>

        <div class="action-buttons">
          <label v-if="consoleData.agent.convId" class="new-session-toggle">
            <input
              type="checkbox"
              :checked="consoleData.promptPrefs.createNewSession"
              :disabled="isBusy"
              @change="onPrefChange('createNewSession', $event.target.checked)"
            />
            <span>새 세션</span>
          </label>
          <button
            v-if="isBusy"
            type="button"
            class="btn btn-danger"
            @click="emitAction('STOP_PROMPT', { agentId: consoleData.agent.id, convId: consoleData.agent.convId || null })"
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
import { makeErrorKey, translateErrorByRules } from '@/utils/errorHints';

const props = defineProps({
  consoleData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const promptDraft = ref('');

const lastErrorAiEntry = computed(() => {
  const raw = props.consoleData.lastError;
  if (!raw) return null;
  const map = props.consoleData.errorExplanations || {};
  return map[makeErrorKey(raw)] || null;
});

const lastErrorExplainLoading = computed(() => Boolean(lastErrorAiEntry.value && lastErrorAiEntry.value.loading));

const displayLastErrorText = computed(() => {
  const raw = props.consoleData.lastError;
  if (!raw) return '';
  const entry = lastErrorAiEntry.value;
  if (entry && entry.aiExplanation) {
    return entry.aiExplanation.replace(/\s+/g, ' ').trim();
  }
  if (props.consoleData.errorExplainMode === 'friendly') {
    const hint = translateErrorByRules(raw);
    if (hint && hint.matched) return `${hint.title}: ${hint.summary}`;
  }
  return raw;
});

function requestLastErrorExplain() {
  const raw = props.consoleData.lastError;
  if (!raw) return;
  emitAction('EXPLAIN_ERROR', {
    errorText: raw,
    commandLine: '',
    agentId: props.consoleData.agent && props.consoleData.agent.id
  });
}

const DEFAULT_EFFORTS = [
  { id: 'auto', label: 'auto (기본)' },
  { id: 'low', label: 'low (최소)' },
  { id: 'medium', label: 'medium (보통)' },
  { id: 'high', label: 'high (권장)' },
  { id: 'xhigh', label: 'xhigh (최대)' },
  { id: 'max', label: 'max (최상한)' }
];

const DEFAULT_MODES = [
  { id: 'plan', label: 'plan (읽기/계획)' },
  { id: 'accept-edits', label: 'accept-edits (편집 허용)' },
  { id: 'auto', label: 'auto (자동 실행)' }
];

const FALLBACK_MODELS = [
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' }
];

const capabilities = computed(() => props.consoleData.capabilities || {});

const effortOptions = computed(() =>
  Array.isArray(capabilities.value.efforts) && capabilities.value.efforts.length > 0
    ? capabilities.value.efforts
    : DEFAULT_EFFORTS
);

const modeOptions = computed(() =>
  Array.isArray(capabilities.value.modes) && capabilities.value.modes.length > 0
    ? capabilities.value.modes
    : DEFAULT_MODES
);

const modelOptions = computed(() =>
  Array.isArray(props.consoleData.models) && props.consoleData.models.length > 0
    ? props.consoleData.models
    : FALLBACK_MODELS
);

const selectedModelId = computed(() => {
  const pref = props.consoleData.promptPrefs.modelId;
  if (modelOptions.value.some(m => m.id === pref)) return pref;
  const def = capabilities.value.defaultModelId;
  if (def && modelOptions.value.some(m => m.id === def)) return def;
  return modelOptions.value[0] ? modelOptions.value[0].id : 'gemini-4-hydrogen-high';
});

const selectedEffortId = computed(() => {
  const pref = props.consoleData.promptPrefs.effort;
  if (effortOptions.value.some(e => e.id === pref)) return pref;
  const def = capabilities.value.defaultEffort;
  if (def && effortOptions.value.some(e => e.id === def)) return def;
  return effortOptions.value[0] ? effortOptions.value[0].id : 'auto';
});

const selectedModeId = computed(() => {
  const pref = props.consoleData.promptPrefs.mode;
  if (modeOptions.value.some(m => m.id === pref)) return pref;
  const def = capabilities.value.defaultMode;
  if (def && modeOptions.value.some(m => m.id === def)) return def;
  return modeOptions.value[0] ? modeOptions.value[0].id : 'plan';
});

const selectedModelHasBuiltInEffort = computed(() => {
  const pattern = capabilities.value.builtInEffortRegex;
  if (!pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(selectedModelId.value || '');
  } catch (_) {
    return false;
  }
});

const isBusy = computed(() => {
  const a = props.consoleData.agent;
  return Boolean(
    props.consoleData.isSubmitting
    || a.cliRunning
    || a.state === 'WORKING'
  );
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
    effort: selectedModelHasBuiltInEffort.value ? 'auto' : selectedEffortId.value,
    mode: selectedModeId.value,
    skipPermissions: true,
    prompt: clean,
    createNew: Boolean(prefs.createNewSession)
  });
  promptDraft.value = '';
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
  gap: 8px;
  padding: 10px 12px;
  background-color: $bg-surface;
  overflow: auto;
}

.options-row {
  display: grid;
  grid-template-columns: 1.6fr 1fr 1fr;
  gap: 8px;
  align-items: center;

  &.two-cols {
    grid-template-columns: 1.6fr 1fr;
  }
}

.option-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.field-label {
  font-size: 11px;
  color: $text-secondary;
  flex-shrink: 0;
}

.guide-btn {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1px solid $border-strong;
  background-color: $bg-input;
  color: $text-secondary;
  font-family: $font-mono;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    border-color: $state-working;
    color: $text-primary;
  }
}

.option-select {
  flex: 1;
  min-width: 0;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-primary;
  padding: 4px 8px;
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
  min-height: 92px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.prompt-textarea {
  flex: 1;
  min-height: 64px;
  width: 100%;
  resize: none;
  background-color: $bg-input;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-primary;
  padding: 8px 10px;
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

.error-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.error-text {
  font-size: 11.5px;
  color: $term-danger;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.error-explain-btn {
  flex-shrink: 0;
  padding: 1px 6px;
  background-color: $bg-elevated;
  border: 1px solid $border-strong;
  border-radius: 3px;
  color: $text-secondary;
  font-size: 10.5px;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: $state-working;
    color: $text-primary;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.new-session-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: $text-secondary;
  cursor: pointer;
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
