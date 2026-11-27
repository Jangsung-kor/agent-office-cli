<template>
  <div class="provider-screen">
    <div class="selector-shell">
      <header class="selector-header">
        <div class="title-block">
          <div class="eyebrow">MULTI-BACKEND AI ORCHESTRATION</div>
          <h1 class="main-title">AGENT OFFICE — AI 백엔드 선택</h1>
          <p class="sub-desc">
            동일한 2D 오피스 관제·대화·콘솔 화면을 유지한 채, 실행 엔진과 세션 저장소 어댑터만 선택하여 전환합니다.
          </p>
        </div>

        <div class="workspace-strip">
          <span class="ws-tag">WORKSPACE</span>
          <span class="ws-path">{{ screenData.targetWorkspace || '-' }}</span>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="screenData.loading || Boolean(screenData.switchingId)"
            @click="emitAction('FETCH_PROVIDERS')"
          >
            {{ screenData.loading ? '감지 중...' : 'CLI 상태 새로고침' }}
          </button>
        </div>
      </header>

      <div v-if="screenData.error" class="error-banner">{{ screenData.error }}</div>

      <section class="cards-grid" aria-label="AI 백엔드 선택 카드">
        <article
          v-for="p in displayProviders"
          :key="p.providerId"
          :class="[
            'provider-card',
            {
              'is-active': p.providerId === screenData.activeProvider,
              'is-switching': screenData.switchingId === p.providerId,
              'is-unavailable': !p.available
            }
          ]"
        >
          <div class="card-top">
            <div class="card-heading">
              <span class="card-code">{{ p.name }}</span>
              <span class="card-label">{{ p.label }}</span>
            </div>
            <div class="card-badges">
              <span v-if="p.runningCount > 0" class="badge badge-running">
                실행 중 {{ p.runningCount }}건
              </span>
              <span :class="['badge', p.available ? 'badge-ok' : 'badge-warn']">
                {{ p.available ? 'CLI 감지됨' : 'CLI 미감지' }}
              </span>
            </div>
          </div>

          <p class="card-desc">{{ p.subtitle }}</p>

          <dl class="spec-list">
            <div class="spec-row">
              <dt>실행 명령</dt>
              <dd class="mono">{{ p.cliCommand }}</dd>
            </div>
            <div class="spec-row">
              <dt>접속 계정</dt>
              <dd class="mono path-dd" :title="(p.accountInfo && p.accountInfo.note) || ''">
                {{ (p.accountInfo && p.accountInfo.displayLabel) || (p.available ? '계정 상태 확인 중' : 'CLI 미감지') }}
              </dd>
            </div>
            <div class="spec-row">
              <dt>감지 경로</dt>
              <dd class="mono path-dd" :title="p.binPath">{{ p.binPath || '-' }}</dd>
            </div>
            <div class="spec-row">
              <dt>세션 저장소</dt>
              <dd class="mono path-dd" :title="p.sessionStoreDir">{{ p.sessionStoreDir || '-' }}</dd>
            </div>
            <div class="spec-row">
              <dt>세션 / 모델</dt>
              <dd class="mono">세션 {{ p.sessionCount }}건 · 모델 {{ p.modelCount }}종</dd>
            </div>
            <div class="spec-row">
              <dt>지원 보안 등급</dt>
              <dd class="mono">{{ formatModes(p.modes) }}</dd>
            </div>
          </dl>

          <div v-if="p.sampleModels && p.sampleModels.length > 0" class="model-chips">
            <span v-for="m in p.sampleModels" :key="m" class="model-chip">{{ m }}</span>
          </div>

          <div class="card-footer">
            <button
              type="button"
              class="enter-btn"
              :disabled="Boolean(screenData.switchingId)"
              @click="selectProvider(p.providerId)"
            >
              {{ screenData.switchingId === p.providerId ? `${p.name} 백엔드 연결 중...` : `${p.name} 백엔드로 오피스 열기` }}
            </button>
          </div>
        </article>
      </section>

      <footer class="selector-footer">
        <span>오피스 진입 후에도 상단 헤더의 [AI 변경] 버튼으로 언제든 백엔드를 전환할 수 있습니다.</span>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  screenData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const FALLBACK_CARDS = [
  {
    providerId: 'antigravity',
    name: 'ANTIGRAVITY',
    label: 'Antigravity CLI',
    subtitle: 'Google Antigravity CLI (agy.exe) 기반 관제 및 stream-json 스트리밍',
    cliCommand: 'agy',
    binPath: '%LOCALAPPDATA%\\agy\\bin\\agy.exe',
    sessionStoreDir: '~/.gemini/antigravity-cli/brain',
    available: true,
    sessionCount: 0,
    runningCount: 0,
    modelCount: 0,
    sampleModels: [],
    modes: [{ id: 'plan' }, { id: 'accept-edits' }]
  },
  {
    providerId: 'codex',
    name: 'CODEX',
    label: 'Codex CLI',
    subtitle: 'OpenAI Codex CLI (codex exec --json) 기반 관제 및 세션 뷰어',
    cliCommand: 'codex exec',
    binPath: 'codex.exe',
    sessionStoreDir: '~/.codex/sessions',
    available: false,
    sessionCount: 0,
    runningCount: 0,
    modelCount: 0,
    sampleModels: [],
    modes: [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'full-auto' }]
  }
];

const displayProviders = computed(() =>
  Array.isArray(props.screenData.providers) && props.screenData.providers.length > 0
    ? props.screenData.providers
    : FALLBACK_CARDS
);

function formatModes(modes) {
  if (!Array.isArray(modes) || modes.length === 0) return '-';
  return modes.map(m => m.id).join(' | ');
}

function emitAction(type, payload) {
  emit('action', { type, payload });
}

function selectProvider(providerId) {
  if (props.screenData.switchingId) return;
  emitAction('SELECT_PROVIDER', { providerId });
}
</script>

<style lang="scss" scoped>
.provider-screen {
  width: 100vw;
  height: 100vh;
  background-color: $bg-base;
  color: $text-primary;
  overflow-y: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px 20px;
}

.selector-shell {
  width: min(960px, 100%);
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.selector-header {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
  background-color: $bg-surface;
  border: 1px solid $border-subtle;
  border-radius: 6px;
}

.title-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.eyebrow {
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: $term-blue;
}

.main-title {
  font-size: 20px;
  font-weight: 700;
  color: $text-primary;
}

.sub-desc {
  font-size: 12.5px;
  color: $text-secondary;
  line-height: 1.5;
}

.workspace-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  flex-wrap: wrap;
}

.ws-tag {
  padding: 2px 7px;
  background-color: $bg-elevated;
  border: 1px solid $border-subtle;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 600;
  color: $text-secondary;
}

.ws-path {
  flex: 1;
  min-width: 180px;
  font-family: $font-mono;
  font-size: 11.5px;
  color: $text-primary;
  word-break: break-all;
}

.error-banner {
  padding: 9px 12px;
  background-color: rgba(225, 29, 72, 0.14);
  border: 1px solid $state-danger;
  border-radius: 4px;
  color: $term-danger;
  font-size: 12px;
}

.cards-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: 780px) {
  .cards-grid {
    grid-template-columns: 1fr;
  }
}

.provider-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  background-color: $bg-surface;
  border: 1px solid $border-strong;
  border-radius: 6px;
  transition: border-color 0.15s ease, background-color 0.15s ease;

  &:hover {
    border-color: $state-working;
    background-color: $bg-elevated;
  }

  &.is-active {
    border-color: $navy-border;
  }

  &.is-switching {
    border-color: $term-blue;
  }
}

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.card-heading {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.card-code {
  font-family: $font-mono;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: $text-primary;
}

.card-label {
  font-size: 12px;
  color: $term-blue;
  font-weight: 600;
}

.card-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.badge {
  padding: 2px 8px;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10.5px;
  font-weight: 600;
  border: 1px solid $border-subtle;
}

.badge-ok {
  color: $term-green;
  background-color: rgba(16, 185, 129, 0.14);
  border-color: rgba(16, 185, 129, 0.35);
}

.badge-warn {
  color: $term-yellow;
  background-color: rgba(217, 119, 6, 0.14);
  border-color: rgba(217, 119, 6, 0.35);
}

.badge-running {
  color: $term-blue;
  background-color: rgba(56, 189, 248, 0.14);
  border-color: rgba(56, 189, 248, 0.35);
}

.card-desc {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.5;
}

.spec-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
}

.spec-row {
  display: grid;
  grid-template-columns: 78px 1fr;
  gap: 8px;
  font-size: 11.5px;
  align-items: center;

  dt {
    color: $text-muted;
  }

  dd {
    color: $text-primary;
    min-width: 0;
  }
}

.path-dd {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.model-chip {
  padding: 2px 7px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10.5px;
  color: $text-secondary;
}

.card-footer {
  margin-top: auto;
  padding-top: 4px;
}

.enter-btn {
  width: 100%;
  padding: 10px 14px;
  border-radius: 4px;
  border: 1px solid $navy-border;
  background-color: $navy-accent;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;

  &:hover:not(:disabled) {
    background-color: $navy-accent-hover;
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
}

.btn {
  padding: 5px 10px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 11.5px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background-color: $bg-hover;
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
}

.mono {
  font-family: $font-mono;
}

.selector-footer {
  text-align: center;
  font-size: 11.5px;
  color: $text-muted;
}
</style>
