<template>
  <BaseModal
    :visible="visible"
    title="팀원 및 에이전트 구성"
    max-width="860px"
    max-height="90vh"
    body-gap="14px"
    @close="closeModal"
  >
    <template #header-actions>
      <button
        type="button"
        class="btn btn-sm"
        :disabled="rosterData.loading"
        @click="emitAction('FETCH_AGENTS', { refresh: true })"
      >
        {{ rosterData.loading ? '스캔 중...' : '전체 목록 새로고침' }}
      </button>
    </template>
        <!-- 대상 프로젝트 및 규칙 경로 설정 -->
        <div class="workspace-meta-box">
          <div class="meta-row">
            <span class="meta-key">대상 경로</span>
            <span class="meta-val mono">{{ rosterData.targetWorkspace || '-' }}</span>
            <span :class="['mode-pill', isMultiProject ? 'mode-multi' : 'mode-single']">
              {{ isMultiProject ? '다중 프로젝트 폴더' : '단일 프로젝트' }}
            </span>
          </div>

          <div v-if="isMultiProject" class="meta-row">
            <span class="meta-key">탐색 방식</span>
            <span class="meta-desc">하위 프로젝트별 규칙(.gemini/rules, AGENTS.md 등) 및 CLI 이력을 자동 감지합니다.</span>
          </div>

          <template v-else>
            <div class="meta-row">
              <label class="meta-key" for="rulesDirInput">규칙 하위 경로</label>
              <input
                id="rulesDirInput"
                v-model="draftRulesDir"
                type="text"
                class="text-input mono"
                placeholder=".agents/rules (비우면 자동 감지)"
                @keydown.enter="scanRulesDir(draftRulesDir)"
              />
              <button
                type="button"
                class="btn btn-xs"
                :disabled="rosterData.loading"
                @click="scanRulesDir(draftRulesDir)"
              >
                경로 적용 · 재스캔
              </button>
            </div>
            <div class="meta-row preset-row">
              <span class="meta-key">빠른 선택</span>
              <div class="preset-chips">
                <button
                  v-for="preset in RULES_PRESETS"
                  :key="preset.value"
                  type="button"
                  :class="['btn btn-xs', { 'is-active-preset': draftRulesDir === preset.value }]"
                  :disabled="rosterData.loading"
                  @click="scanRulesDir(preset.value)"
                >
                  {{ preset.label }}
                </button>
              </div>
            </div>
          </template>
        </div>

        <!-- 1. 현재 존재하는 모든 에이전트 목록 + 함께 일할 팀원 선택 -->
        <section class="section-block">
          <div class="section-head">
            <span class="section-title">
              존재하는 모든 에이전트 ({{ rosterData.allAgents.length }}종) — 선택 {{ draftSelectedIds.length }}명
            </span>
            <div class="head-btns">
              <button type="button" class="btn btn-xs" @click="selectAllWorkspace">프로젝트/CLI 전체 선택</button>
            </div>
          </div>

          <div class="agent-catalog-list">
            <div
              v-for="ag in rosterData.allAgents"
              :key="ag.id"
              :class="['catalog-row', { 'is-checked': isSelected(ag.id) }]"
              :title="ag.workspacePath || ag.domainPath"
              @click="toggleAgent(ag.id)"
            >
              <input
                type="checkbox"
                :checked="isSelected(ag.id)"
                @click.stop
                @change="toggleAgent(ag.id)"
              />
              <span :class="['source-badge', `src-${ag.source}`]">{{ sourceLabel(ag.source) }}</span>
              <span class="ag-id mono">{{ ag.id }}</span>
              <span class="ag-role">{{ ag.role }}</span>
              <span class="ag-path mono">{{ ag.domainPath }}</span>
              <button
                v-if="ag.source === 'custom'"
                type="button"
                class="btn btn-xs btn-remove"
                title="오피스 목록에서 제거 (디스크 파일은 유지)"
                :disabled="rosterData.loading"
                @click.stop="removeCustomAgent(ag.id)"
              >
                제거
              </button>
              <span v-else class="row-action-placeholder"></span>
            </div>
          </div>
        </section>

        <!-- 2. 새 에이전트 추가 (다중 프로젝트: 폴더 연결 / 단일 프로젝트: 규칙 파일 생성) -->
        <section class="section-block">
          <div class="section-head">
            <span class="section-title">
              {{ isMultiProject ? '새 프로젝트 에이전트 연결' : '새 에이전트 추가' }} ({{ normalizedPreviewPath }})
            </span>
          </div>

          <template v-if="isMultiProject">
            <div class="create-grid">
              <div class="form-field">
                <label class="field-label">미연결 하위 폴더 빠른 선택</label>
                <select
                  v-model="selectedCandidatePath"
                  class="text-input mono"
                  @change="onSelectCandidateProject"
                >
                  <option value="">직접 경로 입력...</option>
                  <option
                    v-for="proj in (rosterData.candidateProjects || [])"
                    :key="proj.path"
                    :value="proj.path"
                  >
                    {{ proj.name }}
                  </option>
                </select>
              </div>
              <div class="form-field">
                <label class="field-label">프로젝트 폴더 경로 (필수)</label>
                <input
                  v-model="newAgent.projectPath"
                  type="text"
                  class="text-input mono"
                  placeholder="예: C:\vue3\riding-project"
                />
              </div>
            </div>

            <div class="create-grid-3">
              <div class="form-field">
                <label class="field-label">에이전트 ID (영문/숫자/_/-)</label>
                <input
                  v-model="newAgent.id"
                  type="text"
                  class="text-input mono"
                  placeholder="예: riding-project"
                />
              </div>
              <div class="form-field">
                <label class="field-label">역할 설명</label>
                <input
                  v-model="newAgent.role"
                  type="text"
                  class="text-input"
                  placeholder="비우면 README/AGENTS.md에서 자동 추출"
                />
              </div>
              <div class="form-field">
                <label class="field-label">지침 파일 생성</label>
                <select v-model="newAgent.multiRuleFormat" class="text-input">
                  <option value="none">생성 안 함 (오피스 연결만)</option>
                  <option value="agents-md">AGENTS.md 생성</option>
                  <option value="gemini-rule">.gemini/rules/&lt;id&gt;.md 생성</option>
                  <option value="agents-rule">.agents/rules/&lt;id&gt;.md 생성</option>
                </select>
              </div>
            </div>

            <div v-if="newAgent.multiRuleFormat !== 'none'" class="form-field">
              <label class="field-label">초기 지침 내용 (기존 파일이 있으면 덮어쓰지 않음)</label>
              <textarea
                v-model="newAgent.instructions"
                class="text-area"
                rows="2"
                placeholder="예: 이 프로젝트의 설계·구현·테스트 검증을 수행합니다."
              ></textarea>
            </div>
          </template>

          <template v-else>
            <div class="create-grid-3">
              <div class="form-field">
                <label class="field-label">에이전트 ID (영문/숫자/_/-)</label>
                <input
                  v-model="newAgent.id"
                  type="text"
                  class="text-input mono"
                  placeholder="예: reviewer"
                />
              </div>
              <div class="form-field">
                <label class="field-label">역할 설명</label>
                <input
                  v-model="newAgent.role"
                  type="text"
                  class="text-input"
                  placeholder="예: 코드 리뷰 및 테스트 담당"
                />
              </div>
              <div class="form-field">
                <label class="field-label">규칙 파일 형식</label>
                <select v-model="newAgent.singleRuleFormat" class="text-input">
                  <option value="md">단일 파일 (&lt;id&gt;.md · CLI 표준)</option>
                  <option value="folder">폴더형 (&lt;id&gt;/RULE.md · 기존 호환)</option>
                  <option value="none">생성 안 함 (오피스 등록만)</option>
                </select>
              </div>
            </div>

            <div v-if="newAgent.singleRuleFormat !== 'none'" class="form-field">
              <label class="field-label">초기 업무 지침 (기존 파일이 있으면 덮어쓰지 않음)</label>
              <textarea
                v-model="newAgent.instructions"
                class="text-area"
                rows="2"
                placeholder="예: 담당 영역의 설계·구현·검증을 수행합니다."
              ></textarea>
            </div>
          </template>

          <div class="create-footer-row">
            <span class="preview-note mono">{{ normalizedPreviewPath }}</span>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="!canSubmitNewAgent || rosterData.loading"
              @click="submitNewAgent"
            >
              추가 및 팀 편입
            </button>
          </div>
        </section>

        <div v-if="rosterData.error" class="error-box">{{ rosterData.error }}</div>

    <template #footer>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="draftSelectedIds.length === 0 || rosterData.loading"
        @click="saveRoster"
      >
        선택 팀원 적용 ({{ draftSelectedIds.length }}명)
      </button>
      <button type="button" class="btn" @click="closeModal">닫기</button>
    </template>
  </BaseModal>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';
import BaseModal from '@/components/BaseModal.vue';

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

const RULES_PRESETS = [
  { label: '.agents/rules', value: '.agents/rules' },
  { label: '.gemini/rules', value: '.gemini/rules' },
  { label: 'Rules/Personal', value: 'Rules/Personal' },
  { label: 'rules', value: 'rules' },
  { label: '자동 감지', value: '' }
];

const isMultiProject = computed(() => props.rosterData.workspaceMode === 'multi-project');

const draftSelectedIds = ref([]);
const draftRulesDir = ref('.agents/rules');
const selectedCandidatePath = ref('');
const newAgent = reactive({
  id: '',
  role: '',
  instructions: '',
  projectPath: '',
  multiRuleFormat: 'none',
  singleRuleFormat: 'md'
});

watch(
  () => props.visible,
  (isVisible, wasVisible) => {
    // 모달이 닫혀 있다가 열리는 순간에만 서버 상태를 draft로 복사 (열린 상태의 SSE 갱신으로 사용자 편집이 덮어써지는 문제 방지)
    if (isVisible && !wasVisible) {
      draftSelectedIds.value = [...(props.rosterData.activeAgentIds || [])];
      draftRulesDir.value = props.rosterData.rulesDir || '.agents/rules';
      newAgent.singleRuleFormat = /^Rules\//i.test(draftRulesDir.value) ? 'folder' : 'md';
      selectedCandidatePath.value = '';
      newAgent.projectPath = '';
    }
  },
  { immediate: true }
);

watch(
  () => props.rosterData.rulesDir,
  nextDir => {
    if (props.visible && nextDir) {
      draftRulesDir.value = nextDir;
      newAgent.singleRuleFormat = /^Rules\//i.test(nextDir) ? 'folder' : 'md';
    }
  }
);

const canSubmitNewAgent = computed(() => {
  if (!newAgent.id.trim()) return false;
  if (isMultiProject.value && !newAgent.projectPath.trim()) return false;
  return true;
});

const normalizedPreviewPath = computed(() => {
  const id = (newAgent.id || '<AgentId>').trim();
  if (isMultiProject.value) {
    const p = (newAgent.projectPath || '<프로젝트 경로>').trim().replace(/[\\/]+$/, '');
    if (newAgent.multiRuleFormat === 'agents-md') return `${p}/AGENTS.md`;
    if (newAgent.multiRuleFormat === 'gemini-rule') return `${p}/.gemini/rules/${id}.md`;
    if (newAgent.multiRuleFormat === 'agents-rule') return `${p}/.agents/rules/${id}.md`;
    return `${p} (파일 생성 없이 연결)`;
  }
  const dir = (draftRulesDir.value || '.agents/rules').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (newAgent.singleRuleFormat === 'folder') return `${dir}/${id}/RULE.md`;
  if (newAgent.singleRuleFormat === 'md') return `${dir}/${id}.md`;
  return `${id} (파일 생성 없이 등록)`;
});

function onSelectCandidateProject() {
  const found = (props.rosterData.candidateProjects || []).find(p => p.path === selectedCandidatePath.value);
  if (!found) return;
  newAgent.projectPath = found.path;
  if (!newAgent.id.trim()) {
    newAgent.id = found.idSuggestion || '';
  }
}

function emitAction(type, payload) {
  emit('action', { type, payload });
}

function scanRulesDir(nextDir) {
  const clean = typeof nextDir === 'string' ? nextDir.trim() : '';
  draftRulesDir.value = clean;
  emitAction('SCAN_RULES_DIR', { rulesDir: clean });
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
    .filter(a => a.source === 'workspace' || a.source === 'cli')
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
  if (isMultiProject.value && !newAgent.projectPath.trim()) return;
  if (!draftSelectedIds.value.includes(cleanId)) {
    draftSelectedIds.value = draftSelectedIds.value.concat(cleanId);
  }
  const ruleFormat = isMultiProject.value ? newAgent.multiRuleFormat : newAgent.singleRuleFormat;
  emitAction('CREATE_AGENT', {
    id: cleanId,
    role: newAgent.role,
    instructions: newAgent.instructions,
    projectPath: isMultiProject.value ? newAgent.projectPath.trim() : '',
    ruleFormat,
    createRuleFile: ruleFormat !== 'none',
    rulesDir: draftRulesDir.value
  });
  newAgent.id = '';
  newAgent.role = '';
  newAgent.instructions = '';
  newAgent.projectPath = '';
  selectedCandidatePath.value = '';
}

function removeCustomAgent(id) {
  draftSelectedIds.value = draftSelectedIds.value.filter(x => x !== id);
  emitAction('REMOVE_AGENT', { agentId: id });
}
</script>

<style lang="scss" scoped>

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
  display: flex;
  align-items: center;
  gap: 10px;

  .text-input {
    width: auto;
    flex: 1;
    min-width: 0;
  }
}

.meta-key {
  width: 96px;
  flex-shrink: 0;
  font-size: 11.5px;
  color: $text-secondary;
}

.meta-val {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: $text-primary;
  word-break: break-all;
}

.meta-desc {
  flex: 1;
  font-size: 11.5px;
  color: $text-secondary;
}

.mode-pill {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 3px;
  font-size: 10.5px;
  font-weight: 700;

  &.mode-multi {
    background-color: rgba(56, 189, 248, 0.14);
    color: $term-blue;
    border: 1px solid rgba(56, 189, 248, 0.3);
  }

  &.mode-single {
    background-color: rgba(16, 185, 129, 0.14);
    color: $term-green;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }
}

.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.is-active-preset {
  border-color: $term-blue;
  color: $term-blue;
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
  grid-template-columns: 18px 82px 122px 1.3fr 1fr 48px;
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

.btn-remove {
  color: $term-danger;
  border-color: rgba(225, 29, 72, 0.4);
  padding: 2px 6px;
}

.row-action-placeholder {
  width: 48px;
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

.create-grid-3 {
  display: grid;
  grid-template-columns: 1fr 1.2fr 1.2fr;
  gap: 10px;
}

.preview-note {
  font-size: 11px;
  color: $text-muted;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
