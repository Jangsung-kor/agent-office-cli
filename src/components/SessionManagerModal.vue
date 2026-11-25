<template>
  <div v-if="visible" class="modal-backdrop" @click.self="closeModal">
    <div class="modal-dialog">
      <header class="modal-header">
        <div class="header-left">
          <span class="modal-title">세션 통합 관리 & 작업 현황 ({{ sessionData.providerLabel || 'CLI' }})</span>
          <span class="status-summary mono">
            작업 중 {{ workingCount }} · 활성 {{ activeCount }} · 보관 {{ archivedCount }}
          </span>
        </div>
        <button type="button" class="btn btn-sm" @click="closeModal">닫기</button>
      </header>

      <div class="modal-body">
        <!-- 필터 탭 & 검색 -->
        <div class="toolbar-row">
          <div class="filter-tabs">
            <button
              v-for="tab in filterTabs"
              :key="tab.id"
              type="button"
              :class="['filter-tab', { 'is-active': activeFilter === tab.id }]"
              @click="activeFilter = tab.id"
            >
              {{ tab.label }} ({{ tab.count }})
            </button>
          </div>

          <input
            v-model="searchQuery"
            type="text"
            class="search-input"
            placeholder="세션 ID, 제목, 경로, 에이전트 검색..."
          />
        </div>

        <!-- 일괄 선택 & 정리 액션 바 -->
        <div class="bulk-bar">
          <div class="bulk-left">
            <label class="check-all">
              <input
                type="checkbox"
                :checked="allFilteredSelected"
                :disabled="filteredSessions.length === 0"
                @change="toggleSelectAll"
              />
              <span>현재 목록 전체 ({{ selectedIds.length }}개 선택)</span>
            </label>
            <button type="button" class="btn btn-xs" @click="selectSmallOrIdle">
              빈·초기 세션 선택 (≤0.05MB)
            </button>
          </div>

          <div class="bulk-right">
            <button
              type="button"
              class="btn btn-xs"
              :disabled="selectedIds.length === 0"
              @click="bulkArchive(true)"
            >
              선택 보관(숨김)
            </button>
            <button
              type="button"
              class="btn btn-xs"
              :disabled="selectedIds.length === 0"
              @click="bulkArchive(false)"
            >
              선택 복원
            </button>
            <button
              type="button"
              class="btn btn-xs btn-danger"
              :disabled="selectedIds.length === 0"
              @click="requestDelete(selectedIds)"
            >
              선택 영구 삭제
            </button>
          </div>
        </div>

        <!-- 영구 삭제 2단계 인라인 확인 바 -->
        <div v-if="pendingDeleteIds.length > 0" class="confirm-bar">
          <span>
            선택한 <strong>{{ pendingDeleteIds.length }}개</strong> 세션을 디스크에서 영구 삭제할까요? (복구 불가)
          </span>
          <div class="confirm-actions">
            <button type="button" class="btn btn-xs btn-danger" @click="confirmDelete">영구 삭제 확정</button>
            <button type="button" class="btn btn-xs" @click="pendingDeleteIds = []">취소</button>
          </div>
        </div>

        <!-- 세션 목록 -->
        <div class="session-list">
          <div
            v-for="s in filteredSessions"
            :key="s.convId"
            :class="['session-row', { 'is-working': s.isWorking, 'is-archived': s.archived }]"
          >
            <div class="row-check">
              <input
                type="checkbox"
                :checked="selectedSet.has(s.convId)"
                @change="toggleSelectOne(s.convId)"
              />
            </div>

            <div class="row-main">
              <div class="row-top">
                <span :class="['state-pill', `state-${(s.state || 'IDLE').toLowerCase()}`]">
                  {{ s.state }}
                </span>
                <span v-if="s.isWorking" :class="['origin-pill', s.isManagedRunning ? 'is-managed' : 'is-external']">
                  {{ s.isManagedRunning ? `웹 실행 (PID ${s.pid || '-'})` : '외부 활성' }}
                </span>
                <span v-if="s.archived" class="origin-pill is-archived-pill">정리됨(보관)</span>

                <template v-if="editingAliasId === s.convId">
                  <input
                    v-model="aliasDraft"
                    type="text"
                    class="alias-input"
                    placeholder="세션 별칭 입력..."
                    @keydown.enter="saveAlias(s)"
                    @keydown.escape="editingAliasId = ''"
                  />
                  <button type="button" class="btn btn-xs btn-primary" @click="saveAlias(s)">저장</button>
                  <button type="button" class="btn btn-xs" @click="editingAliasId = ''">취소</button>
                </template>
                <template v-else>
                  <span class="row-title" :title="s.titlePreview">
                    {{ s.alias || s.titlePreview || s.convId.slice(0, 8) }}
                  </span>
                  <button
                    type="button"
                    class="btn-link"
                    title="별칭 지정/수정"
                    @click="startEditAlias(s)"
                  >
                    이름 변경
                  </button>
                </template>
              </div>

              <div class="row-meta mono">
                <span>ID: {{ s.convId.slice(0, 8) }}</span>
                <span>· 경로: {{ s.workspacePath || '-' }}</span>
                <span>· 용량: {{ s.fileSizeMB }}MB</span>
                <span v-if="s.tokenUsage && s.tokenUsage.totalTokens > 0">
                  · 토큰: {{ formatTokens(s.tokenUsage.totalTokens) }}
                </span>
                <span>· 최근: {{ formatElapsed(s.lastActiveIso) }}</span>
              </div>
            </div>

            <div class="row-controls">
              <!-- 작업 중일 때 즉시 세션 종료 -->
              <button
                v-if="s.isWorking"
                type="button"
                class="btn btn-xs btn-danger"
                title="실행 중인 세션 프로세스 종료 또는 작업 상태 해제"
                @click="terminateSession(s)"
              >
                세션 종료
              </button>

              <!-- 에이전트 매핑 연결/해제 -->
              <div class="assign-wrap">
                <select
                  class="assign-select mono"
                  :value="assignDraftByConv[s.convId] !== undefined ? assignDraftByConv[s.convId] : (s.role || '')"
                  @change="assignDraftByConv[s.convId] = $event.target.value"
                >
                  <option value="">미할당</option>
                  <option v-for="ag in agentOptions" :key="ag.id" :value="ag.id">
                    {{ ag.id }}
                  </option>
                </select>
                <button type="button" class="btn btn-xs" @click="applyMapping(s)">
                  {{ getTargetAgent(s) ? '연결' : '해제' }}
                </button>
              </div>

              <button
                type="button"
                class="btn btn-xs"
                @click="toggleArchive(s)"
              >
                {{ s.archived ? '복원' : '보관' }}
              </button>

              <button
                type="button"
                class="btn btn-xs btn-danger-ghost"
                title="세션 파일 영구 삭제"
                @click="requestDelete([s.convId])"
              >
                삭제
              </button>
            </div>
          </div>

          <div v-if="filteredSessions.length === 0" class="empty-box">
            조건에 해당하는 세션이 없습니다.
          </div>
        </div>

        <div v-if="sessionData.error" class="error-box">{{ sessionData.error }}</div>
      </div>

      <footer class="modal-footer">
        <span class="footer-note">
          [보관] 처리한 세션은 디스크 파일을 유지한 채 매핑 드롭다운과 오피스 워커에서 숨겨집니다.
        </span>
        <button type="button" class="btn btn-primary" @click="closeModal">닫기</button>
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
  sessionData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const activeFilter = ref('active');
const searchQuery = ref('');
const selectedIds = ref([]);
const pendingDeleteIds = ref([]);
const editingAliasId = ref('');
const aliasDraft = ref('');
const assignDraftByConv = reactive({});

watch(
  () => props.visible,
  isVis => {
    if (isVis) {
      pendingDeleteIds.value = [];
      editingAliasId.value = '';
    }
  }
);

const allSessions = computed(() =>
  Array.isArray(props.sessionData.sessions) ? props.sessionData.sessions : []
);

const agentOptions = computed(() =>
  Array.isArray(props.sessionData.activeAgents) ? props.sessionData.activeAgents : []
);

const workingCount = computed(() => allSessions.value.filter(s => s.isWorking).length);
const activeCount = computed(() => allSessions.value.filter(s => !s.archived).length);
const archivedCount = computed(() => allSessions.value.filter(s => s.archived).length);
const unassignedCount = computed(() => allSessions.value.filter(s => !s.archived && !s.role).length);

const filterTabs = computed(() => [
  { id: 'active', label: '활성 세션', count: activeCount.value },
  { id: 'working', label: '작업 중', count: workingCount.value },
  { id: 'unassigned', label: '미할당', count: unassignedCount.value },
  { id: 'archived', label: '정리됨(보관)', count: archivedCount.value },
  { id: 'all', label: '전체', count: allSessions.value.length }
]);

const filteredSessions = computed(() => {
  const q = (searchQuery.value || '').trim().toLowerCase();
  return allSessions.value.filter(s => {
    if (activeFilter.value === 'active' && s.archived) return false;
    if (activeFilter.value === 'working' && !s.isWorking) return false;
    if (activeFilter.value === 'unassigned' && (s.archived || s.role)) return false;
    if (activeFilter.value === 'archived' && !s.archived) return false;
    if (!q) return true;
    const hay = [
      s.convId,
      s.alias,
      s.titlePreview,
      s.workspacePath,
      s.role
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
});

const selectedSet = computed(() => new Set(selectedIds.value));

const allFilteredSelected = computed(() => {
  if (filteredSessions.value.length === 0) return false;
  return filteredSessions.value.every(s => selectedSet.value.has(s.convId));
});

function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}

function formatElapsed(isoStr) {
  if (!isoStr) return '-';
  const ms = new Date(isoStr).getTime();
  if (!Number.isFinite(ms)) return '-';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

function toggleSelectOne(convId) {
  if (selectedSet.value.has(convId)) {
    selectedIds.value = selectedIds.value.filter(id => id !== convId);
  } else {
    selectedIds.value = selectedIds.value.concat(convId);
  }
}

function toggleSelectAll() {
  if (allFilteredSelected.value) {
    const visibleSet = new Set(filteredSessions.value.map(s => s.convId));
    selectedIds.value = selectedIds.value.filter(id => !visibleSet.has(id));
  } else {
    const next = new Set(selectedIds.value);
    for (const s of filteredSessions.value) next.add(s.convId);
    selectedIds.value = Array.from(next);
  }
}

function selectSmallOrIdle() {
  selectedIds.value = filteredSessions.value
    .filter(s => !s.isWorking && Number(s.fileSizeMB || 0) <= 0.05)
    .map(s => s.convId);
}

function startEditAlias(s) {
  editingAliasId.value = s.convId;
  aliasDraft.value = s.alias || '';
}

function saveAlias(s) {
  emit('action', {
    type: 'UPDATE_SESSION_META',
    payload: { convId: s.convId, alias: aliasDraft.value.trim() }
  });
  editingAliasId.value = '';
}

function toggleArchive(s) {
  emit('action', {
    type: 'UPDATE_SESSION_META',
    payload: { convId: s.convId, archived: !s.archived }
  });
}

function bulkArchive(archived) {
  if (selectedIds.value.length === 0) return;
  emit('action', {
    type: 'UPDATE_SESSION_META',
    payload: { convIds: [...selectedIds.value], archived }
  });
  selectedIds.value = [];
}

function terminateSession(s) {
  emit('action', {
    type: 'TERMINATE_SESSION',
    payload: { convId: s.convId, agentId: s.runningAgentId || s.role || null }
  });
}

function getTargetAgent(s) {
  return assignDraftByConv[s.convId] !== undefined ? assignDraftByConv[s.convId] : (s.role || '');
}

function applyMapping(s) {
  const targetAgent = getTargetAgent(s);
  if (targetAgent) {
    emit('action', {
      type: 'UPDATE_MAPPING',
      payload: { agentId: targetAgent, convId: s.convId }
    });
  } else if (s.role) {
    emit('action', {
      type: 'UPDATE_MAPPING',
      payload: { agentId: s.role, convId: null }
    });
  }
}

function requestDelete(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  pendingDeleteIds.value = [...ids];
}

function confirmDelete() {
  if (pendingDeleteIds.value.length === 0) return;
  const targets = [...pendingDeleteIds.value];
  pendingDeleteIds.value = [];
  selectedIds.value = selectedIds.value.filter(id => !targets.includes(id));
  emit('action', {
    type: 'DELETE_SESSIONS',
    payload: { convIds: targets }
  });
}

function closeModal() {
  emit('action', { type: 'CLOSE_MODAL' });
}
</script>

<style lang="scss" scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(8, 11, 16, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-dialog {
  width: min(1040px, 95vw);
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
  gap: 10px;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.modal-title {
  font-size: 14px;
  font-weight: 700;
  color: $text-primary;
}

.status-summary {
  font-size: 11px;
  color: $term-blue;
}

.modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.filter-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.filter-tab {
  padding: 4px 10px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-secondary;
  font-size: 11.5px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
  }

  &.is-active {
    background-color: $navy-accent;
    border-color: $navy-border;
    color: $text-primary;
    font-weight: 600;
  }
}

.search-input {
  width: 240px;
  max-width: 100%;
  padding: 5px 9px;
  background-color: $bg-input;
  border: 1px solid $border-strong;
  border-radius: 4px;
  color: $text-primary;
  font-size: 11.5px;
  outline: none;

  &:focus {
    border-color: $state-working;
  }
}

.bulk-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  flex-wrap: wrap;
}

.bulk-left,
.bulk-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.check-all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: $text-secondary;
  cursor: pointer;
}

.confirm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background-color: rgba(225, 29, 72, 0.14);
  border: 1px solid $state-danger;
  border-radius: 4px;
  color: $term-danger;
  font-size: 12px;
}

.confirm-actions {
  display: flex;
  gap: 6px;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 440px;
  overflow-y: auto;
}

.session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background-color: $bg-elevated;
  border: 1px solid $border-subtle;
  border-radius: 4px;

  &.is-working {
    border-color: $state-working;
    background-color: rgba(59, 130, 246, 0.08);
  }

  &.is-archived {
    opacity: 0.72;
  }
}

.row-check {
  flex-shrink: 0;
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.state-pill {
  padding: 1px 6px;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10px;
  font-weight: 700;
  border: 1px solid $border-subtle;
  color: $text-muted;

  &.state-working { color: $term-blue; border-color: $state-working; }
  &.state-planning { color: $state-planning; border-color: $state-planning; }
  &.state-done { color: $term-green; border-color: $state-done; }
  &.state-blocked { color: $term-yellow; border-color: $state-blocked; }
}

.origin-pill {
  padding: 1px 6px;
  border-radius: 3px;
  font-family: $font-mono;
  font-size: 10px;
  font-weight: 600;

  &.is-managed {
    color: $term-blue;
    background-color: rgba(56, 189, 248, 0.14);
  }
  &.is-external {
    color: $term-yellow;
    background-color: rgba(217, 119, 6, 0.14);
  }
  &.is-archived-pill {
    color: $text-secondary;
    background-color: rgba(100, 116, 139, 0.18);
  }
}

.row-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-primary;
  max-width: 360px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-link {
  border: none;
  background: transparent;
  color: $text-muted;
  font-size: 10.5px;
  cursor: pointer;
  text-decoration: underline;

  &:hover {
    color: $term-blue;
  }
}

.alias-input {
  padding: 2px 6px;
  background-color: $bg-input;
  border: 1px solid $state-working;
  border-radius: 3px;
  color: $text-primary;
  font-size: 11.5px;
  width: 180px;
  outline: none;
}

.row-meta {
  font-size: 10.5px;
  color: $text-muted;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.row-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.assign-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
}

.assign-select {
  height: 24px;
  max-width: 124px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 3px;
  color: $text-secondary;
  font-size: 11px;
  padding: 0 5px;
}

.empty-box {
  text-align: center;
  padding: 24px;
  color: $text-muted;
  font-size: 12px;
}

.error-box {
  padding: 8px 10px;
  background-color: rgba(225, 29, 72, 0.14);
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
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.footer-note {
  font-size: 11px;
  color: $text-muted;
}

.mono { font-family: $font-mono; }

.btn {
  padding: 6px 13px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.btn-sm { padding: 4px 9px; font-size: 11px; }
.btn-xs { padding: 3px 8px; font-size: 11px; }
.btn-primary { background-color: $navy-accent; border-color: $navy-border; }
.btn-danger {
  background-color: rgba(225, 29, 72, 0.22);
  border-color: $state-danger;
  color: $term-danger;
}
.btn-danger-ghost {
  color: $term-danger;
  border-color: rgba(225, 29, 72, 0.38);
}
</style>
