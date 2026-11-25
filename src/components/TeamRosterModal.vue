<template>
  <div v-if="visible" class="modal-backdrop" @click.self="closeModal">
    <div class="modal-dialog">
      <header class="modal-header">
        <span class="modal-title">팀원 및 에이전트 구성</span>
        <div class="header-actions">
          <button
            type="button"
            class="btn btn-sm"
            :disabled="rosterData.loading"
            @click="emitAction('FETCH_AGENTS', { refresh: true })"
          >
            {{ rosterData.loading ? '스캔 중...' : '전체 목록 새로고침' }}
          </button>
          <button type="button" class="btn btn-sm" @click="closeModal">닫기</button>
        </div>
      </header>

      <div class="modal-body">
        <!-- 대상 프로젝트 및 규칙 경로 설정 -->
        <div class="workspace-meta-box">
          <div class="meta-row">
            <span class="meta-key">대상 프로젝트</span>
            <span class="meta-val mono">{{ rosterData.targetWorkspace || '-' }}</span>
          </div>
          <div class="meta-row">
            <label class="meta-key" for="rulesDirInput">규칙 하위 경로</label>
            <input
              id="rulesDirInput"
              v-model="draftRulesDir"
              type="text"
              class="text-input mono"
              placeholder="Rules/Personal"
            />
          </div>
        </div>

        <!-- 1. 현재 존재하는 모든 에이전트 목록 + 함께 일할 팀원 선택 -->
        <section class="section-block">
          <div class="section-head">
            <span class="section-title">
              존재하는 모든 에이전트 ({{ rosterData.allAgents.length }}종) — 선택 {{ draftSelectedIds.length }}명
            </span>
            <div class="head-btns">
              <button type="button" class="btn btn-xs" @click="selectAllWorkspace">프로젝트 규칙 전체 선택</button>
            </div>
          </div>

          <div class="agent-catalog-list">
            <label
              v-for="ag in rosterData.allAgents"
              :key="ag.id"
              :class="['catalog-row', { 'is-checked': isSelected(ag.id) }]"
            >
              <input
                type="checkbox"
                :checked="isSelected(ag.id)"
                @change="toggleAgent(ag.id)"
              />
              <span :class="['source-badge', `src-${ag.source}`]">{{ sourceLabel(ag.source) }}</span>
              <span class="ag-id mono">{{ ag.id }}</span>
              <span class="ag-role">{{ ag.role }}</span>
              <span class="ag-path mono">{{ ag.domainPath }}</span>
            </label>
          </div>
        </section>

        <!-- 2. 새 에이전트 추가 및 대상 프로젝트 Rules/ 생성 -->
        <section class="section-block">
          <div class="section-head">
            <span class="section-title">새 에이전트 추가 ({{ normalizedPreviewPath }})</span>
          </div>

          <div class="create-grid">
            <div class="form-field">
              <label class="field-label">에이전트 ID (영문/숫자/_/-)</label>
              <input
                v-model="newAgent.id"
                type="text"
                class="text-input mono"
                placeholder="예: Agent_API"
              />
            </div>
            <div class="form-field">
              <label class="field-label">역할 설명</label>
              <input
                v-model="newAgent.role"
                type="text"
                class="text-input"
                placeholder="예: API 서버 및 DB 담당"
              />
            </div>
          </div>

          <div class="form-field">
            <label class="field-label">초기 업무 지침 (RULE.md 내용)</label>
            <textarea
              v-model="newAgent.instructions"
              class="text-area"
              rows="2"
              placeholder="예: 담당 도메인의 백엔드 API 설계·구현 및 테스트 검증을 수행합니다."
            ></textarea>
          </div>

          <div class="create-footer-row">
            <label class="checkbox-label">
              <input v-model="newAgent.createRuleFile" type="checkbox" />
              <span>대상 프로젝트에 Rules 파일 생성 (기존 파일이 있으면 덮어쓰지 않음)</span>
            </label>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="!newAgent.id.trim() || rosterData.loading"
              @click="submitNewAgent"
            >
              추가 및 팀 편입
            </button>
          </div>
        </section>

        <div v-if="rosterData.error" class="error-box">{{ rosterData.error }}</div>
      </div>

      <footer class="modal-footer">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="draftSelectedIds.length === 0 || rosterData.loading"
          @click="saveRoster"
        >
          선택 팀원 적용 ({{ draftSelectedIds.length }}명)
        </button>
        <button type="button" class="btn" @click="closeModal">닫기</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  rosterData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const draftSelectedIds = ref([]);
const draftRulesDir = ref('Rules/Personal');
const newAgent = reactive({
  id: '',
  role: '',
  instructions: '',
  createRuleFile: true
});

watch(
  () => props.visible,
  (isVisible, wasVisible) => {
    // 모달이 닫혀 있다가 열리는 순간에만 서버 상태를 draft로 복사 (열린 상태의 SSE 갱신으로 사용자 편집이 덮어써지는 문제 방지)
    if (isVisible && !wasVisible) {
      draftSelectedIds.value = [...(props.rosterData.activeAgentIds || [])];
      draftRulesDir.value = props.rosterData.rulesDir || 'Rules/Personal';
    }
  },
  { immediate: true }
);

const normalizedPreviewPath = computed(() => {
  const dir = (draftRulesDir.value || 'Rules/Personal').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const id = (newAgent.id || '<AgentId>').trim();
  return `${dir}/${id}/RULE.md`;
});

function emitAction(type, payload) {
  emit('action', { type, payload });
}

function closeModal() {
  emitAction('CLOSE_MODAL');
}

function isSelected(id) {
  return draftSelectedIds.value.includes(id);
}

function toggleAgent(id) {
  if (isSelected(id)) {
    draftSelectedIds.value = draftSelectedIds.value.filter(x => x !== id);
  } else {
    draftSelectedIds.value = draftSelectedIds.value.concat(id);
  }
}

function selectAllWorkspace() {
  const wsIds = (props.rosterData.allAgents || [])
    .filter(a => a.source === 'workspace')
    .map(a => a.id);
  if (wsIds.length > 0) {
    draftSelectedIds.value = wsIds;
  }
}

function sourceLabel(src) {
  if (src === 'workspace') return 'WORKSPACE';
  if (src === 'cli') return 'CLI';
  if (src === 'custom') return 'CUSTOM';
  return 'PRESET';
}

function saveRoster() {
  if (draftSelectedIds.value.length === 0) return;
  emitAction('SAVE_ROSTER', {
    activeAgentIds: [...draftSelectedIds.value],
    rulesDir: draftRulesDir.value
  });
}

function submitNewAgent() {
  const cleanId = (newAgent.id || '').trim();
  if (!cleanId) return;
  if (!draftSelectedIds.value.includes(cleanId)) {
    draftSelectedIds.value = draftSelectedIds.value.concat(cleanId);
  }
  emitAction('CREATE_AGENT', {
    id: cleanId,
    role: newAgent.role,
    instructions: newAgent.instructions,
    createRuleFile: newAgent.createRuleFile,
    rulesDir: draftRulesDir.value
  });
  newAgent.id = '';
  newAgent.role = '';
  newAgent.instructions = '';
}
</script>

<style lang="scss" scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(8, 11, 16, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-dialog {
  width: min(860px, 94vw);
  max-height: 90vh;
  background-color: $bg-surface;
  border: 1px solid $border-strong;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 12px 16px;
  background-color: $bg-header;
  border-bottom: 1px solid $border-subtle;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.workspace-meta-box {
  padding: 10px 12px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.meta-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  align-items: center;
  gap: 10px;
}

.meta-key {
  font-size: 11.5px;
  color: $text-secondary;
}

.meta-val {
  font-size: 12px;
  color: $text-primary;
  word-break: break-all;
}

.section-block {
  background-color: $bg-elevated;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-title {
  font-size: 12px;
  font-weight: 700;
  color: $term-blue;
}

.agent-catalog-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 240px;
  overflow-y: auto;
}

.catalog-row {
  display: grid;
  grid-template-columns: 18px 82px 122px 1.4fr 1fr;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background-color: $bg-hover;
  }

  &.is-checked {
    border-color: $navy-border;
    background-color: rgba(30, 39, 97, 0.35);
  }
}

.source-badge {
  padding: 2px 6px;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  border: 1px solid $border-subtle;
  color: $text-secondary;

  &.src-workspace {
    color: $term-green;
    border-color: $state-done;
  }

  &.src-cli {
    color: $term-blue;
    border-color: $state-working;
  }

  &.src-custom {
    color: $term-yellow;
    border-color: $term-warn;
  }
}

.ag-id {
  font-size: 12px;
  font-weight: 700;
  color: $text-primary;
}

.ag-role {
  font-size: 12px;
  color: $text-secondary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ag-path {
  font-size: 11px;
  color: $text-muted;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.create-grid {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 11px;
  color: $text-secondary;
}

.text-input,
.text-area {
  width: 100%;
  background-color: $bg-input;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-primary;
  padding: 6px 9px;
  font-size: 12px;
  outline: none;

  &:focus {
    border-color: $state-working;
  }
}

.text-area {
  resize: vertical;
  font-family: $font-sans;
}

.create-footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: $text-secondary;
  cursor: pointer;
}

.error-box {
  padding: 8px 10px;
  background-color: rgba(168, 86, 86, 0.2);
  border: 1px solid $state-danger;
  border-radius: 4px;
  color: $term-danger;
  font-size: 12px;
}

.modal-footer {
  padding: 10px 16px;
  background-color: $bg-header;
  border-top: 1px solid $border-subtle;
  display: flex;
  justify-content: center;
  gap: 8px;
}

.mono {
  font-family: $font-mono;
}

.btn {
  padding: 6px 13px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.btn-sm {
  padding: 4px 9px;
  font-size: 11.5px;
}

.btn-xs {
  padding: 3px 8px;
  font-size: 11px;
}

.btn-primary {
  background-color: $navy-accent;
  border-color: $navy-border;
}
</style>
