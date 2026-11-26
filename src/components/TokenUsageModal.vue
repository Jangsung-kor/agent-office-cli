<template>
  <BaseModal
    :visible="visible"
    max-width="1060px"
    max-height="90vh"
    body-gap="12px"
    @close="closeModal"
  >
    <template #header>
      <span class="modal-title">토큰 사용량 현황 ({{ tokenData.providerLabel || 'CLI' }})</span>
      <span class="header-sub mono">
        {{ activePeriodSummaryText }}
      </span>
    </template>
        <!-- 기간 비교 & 선택 바 -->
        <div class="period-tabs-row">
          <div class="period-tabs">
            <button
              v-for="tab in periodTabs"
              :key="tab.id"
              type="button"
              :class="['period-tab', { 'is-active': selectedPeriod === tab.id }]"
              @click="selectedPeriod = tab.id"
            >
              <span>{{ tab.label }}</span>
              <strong class="mono">{{ formatTokens(tab.tokens) }}</strong>
            </button>
          </div>

          <label class="toggle-check">
            <input v-model="includeArchived" type="checkbox" />
            <span>정리됨(보관) 세션 포함</span>
          </label>
        </div>

        <!-- 전체 요약 카드 -->
        <section class="summary-grid">
          <div class="stat-card is-primary">
            <span class="stat-label">{{ selectedPeriodLabel }} 합계</span>
            <strong class="stat-value mono">{{ formatTokens(totals.totalTokens) }}</strong>
            <span class="stat-hint mono">{{ totals.totalTokens.toLocaleString() }} tok</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">신규 입력 (Uncached)</span>
            <strong class="stat-value mono">{{ formatTokens(totals.inputTokens) }}</strong>
            <span class="stat-hint mono">{{ totals.inputTokens.toLocaleString() }} tok</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">캐시 읽기 (적중률 {{ cacheHitRate }}%)</span>
            <strong class="stat-value mono c-green">{{ formatTokens(totals.cacheReadTokens) }}</strong>
            <span class="stat-hint mono">{{ totals.cacheReadTokens.toLocaleString() }} tok</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">출력 토큰</span>
            <strong class="stat-value mono c-blue">{{ formatTokens(totals.outputTokens) }}</strong>
            <span class="stat-hint mono">
              {{ totals.outputTokens.toLocaleString() }} tok
              <template v-if="totals.reasoningTokens > 0"> (추론 {{ formatTokens(totals.reasoningTokens) }})</template>
            </span>
          </div>
        </section>

        <!-- 세션별 토큰 테이블 -->
        <div class="filter-bar">
          <span class="section-title">세션별 사용 내역 ({{ rows.length }}건)</span>
          <span class="range-caption mono">{{ activePeriodDetailCaption }}</span>
        </div>

        <div class="table-wrap">
          <table class="token-table">
            <thead>
              <tr>
                <th>세션 / 별칭</th>
                <th>사용 기간</th>
                <th>에이전트</th>
                <th>모델</th>
                <th>상태</th>
                <th class="num-col">신규 입력</th>
                <th class="num-col">캐시 읽기</th>
                <th class="num-col">출력</th>
                <th class="num-col">합계</th>
                <th>비중</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.session.convId"
                :class="{ 'is-archived': row.session.archived }"
                @click="focusSessionAgent(row.session)"
              >
                <td class="session-col">
                  <div class="session-title" :title="row.session.titlePreview">
                    {{ row.session.alias || row.session.titlePreview || row.session.convId.slice(0, 8) }}
                  </div>
                  <div class="session-sub mono">
                    {{ row.session.convId.slice(0, 8) }} · {{ row.session.fileSizeMB }}MB
                    <span v-if="row.session.archived" class="tag-archived">보관됨</span>
                    <span v-if="row.session.tokenUsage && row.session.tokenUsage.partial" class="tag-partial">부분집계</span>
                  </div>
                </td>
                <td class="period-col mono">
                  <div>{{ formatRangeShort(row.session) }}</div>
                  <div class="dur-sub">{{ formatDuration(row.session.durationMs) }}</div>
                </td>
                <td class="mono">{{ row.session.role || '-' }}</td>
                <td class="mono model-col">{{ (row.session.tokenUsage && row.session.tokenUsage.model) || '-' }}</td>
                <td>
                  <span :class="['state-pill', `state-${(row.session.state || 'IDLE').toLowerCase()}`]">
                    {{ row.session.state }}
                  </span>
                </td>
                <td class="num-col mono">{{ formatTokens(row.usage.inputTokens) }}</td>
                <td class="num-col mono c-green">{{ formatTokens(row.usage.cacheReadTokens) }}</td>
                <td class="num-col mono c-blue">{{ formatTokens(row.usage.outputTokens) }}</td>
                <td class="num-col mono strong-num">{{ formatTokens(row.usage.totalTokens) }}</td>
                <td class="bar-col">
                  <div class="ratio-track">
                    <div
                      class="ratio-fill"
                      :style="{ width: `${getRatioPct(row.usage.totalTokens)}%` }"
                    ></div>
                  </div>
                </td>
              </tr>
              <tr v-if="rows.length === 0">
                <td colspan="10" class="empty-row">선택한 기간에 사용된 토큰 내역이 없습니다.</td>
              </tr>
            </tbody>
          </table>
        </div>
    <template #footer>
      <span class="footer-note">
        각 턴의 기록 시각 기준으로 일자별(오늘/7일/30일) 토큰을 분리 집계하며, 최근 80개 스캔 세션 기준입니다.
      </span>
      <button type="button" class="btn btn-primary" @click="closeModal">닫기</button>
    </template>
  </BaseModal>
</template>

<script setup>
import { ref, computed } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import {
  formatTokens,
  toLocalDateKey,
  formatDuration,
  formatPeriodRange
} from '@/utils/formatters';

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  tokenData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);
const includeArchived = ref(true);
const selectedPeriod = ref('all');

const PERIOD_DEFS = [
  { id: 'all', label: '전체 스캔', days: 0 },
  { id: 'today', label: '오늘', days: 1 },
  { id: '7d', label: '최근 7일', days: 7 },
  { id: '30d', label: '최근 30일', days: 30 }
];

function getCutoffDateKey(days) {
  if (!days || days <= 0) return '';
  const now = Date.now();
  return toLocalDateKey(now - (days - 1) * 24 * 60 * 60 * 1000);
}

/**
 * 선택된 기간(all / today / 7d / 30d)에 해당하는 세션별 토큰 사용량 추출
 * @author Jangsung
 */
function getUsageForPeriod(session, periodId) {
  const u = session && session.tokenUsage ? session.tokenUsage : null;
  if (!u) {
    return { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  }
  if (periodId === 'all') {
    return {
      inputTokens: Number(u.inputTokens) || 0,
      cacheReadTokens: Number(u.cacheReadTokens) || 0,
      outputTokens: Number(u.outputTokens) || 0,
      reasoningTokens: Number(u.reasoningTokens) || 0,
      totalTokens: Number(u.totalTokens) || 0
    };
  }

  const def = PERIOD_DEFS.find(p => p.id === periodId);
  const cutoffKey = getCutoffDateKey(def ? def.days : 1);
  const todayKey = toLocalDateKey(Date.now());
  const byDate = u.byDate && typeof u.byDate === 'object' ? u.byDate : null;

  if (byDate && Object.keys(byDate).length > 0) {
    const acc = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    for (const [dKey, bucket] of Object.entries(byDate)) {
      const match = periodId === 'today' ? dKey === todayKey : dKey >= cutoffKey;
      if (match && bucket) {
        acc.inputTokens += Number(bucket.inputTokens) || 0;
        acc.cacheReadTokens += Number(bucket.cacheReadTokens) || 0;
        acc.outputTokens += Number(bucket.outputTokens) || 0;
        acc.reasoningTokens += Number(bucket.reasoningTokens) || 0;
        acc.totalTokens += Number(bucket.totalTokens) || 0;
      }
    }
    return acc;
  }

  // byDate가 비어 있는 16MB 초과/레거시 세션은 최근 활동일 기준 폴백
  const lastKey = toLocalDateKey(session.lastActiveIso);
  const match = periodId === 'today' ? lastKey === todayKey : (lastKey && lastKey >= cutoffKey);
  return match
    ? {
        inputTokens: Number(u.inputTokens) || 0,
        cacheReadTokens: Number(u.cacheReadTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        reasoningTokens: Number(u.reasoningTokens) || 0,
        totalTokens: Number(u.totalTokens) || 0
      }
    : { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

const baseSessions = computed(() => {
  const list = Array.isArray(props.tokenData.sessions) ? props.tokenData.sessions : [];
  return includeArchived.value ? list : list.filter(s => !s.archived);
});

const periodTabs = computed(() =>
  PERIOD_DEFS.map(def => {
    let sum = 0;
    for (const s of baseSessions.value) {
      sum += getUsageForPeriod(s, def.id).totalTokens;
    }
    return { ...def, tokens: sum };
  })
);

const selectedPeriodLabel = computed(() => {
  const found = PERIOD_DEFS.find(d => d.id === selectedPeriod.value);
  return found ? found.label : '전체 스캔';
});

const rows = computed(() => {
  const list = baseSessions.value
    .map(session => ({
      session,
      usage: getUsageForPeriod(session, selectedPeriod.value)
    }))
    .filter(r => selectedPeriod.value === 'all' || r.usage.totalTokens > 0);

  return list.sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
});

const totals = computed(() => {
  const acc = {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  for (const r of rows.value) {
    acc.inputTokens += r.usage.inputTokens;
    acc.cacheReadTokens += r.usage.cacheReadTokens;
    acc.outputTokens += r.usage.outputTokens;
    acc.reasoningTokens += r.usage.reasoningTokens;
    acc.totalTokens += r.usage.totalTokens;
  }
  return acc;
});

const cacheHitRate = computed(() => {
  const denom = totals.value.inputTokens + totals.value.cacheReadTokens;
  if (denom <= 0) return 0;
  return Math.round((totals.value.cacheReadTokens / denom) * 100);
});

const computedRange = computed(() => {
  let minMs = Infinity;
  let maxMs = 0;
  for (const r of rows.value) {
    if (r.usage.totalTokens <= 0) continue;
    const s = r.session;
    const sMs = s.startedAtIso ? new Date(s.startedAtIso).getTime() : NaN;
    const eMs = s.lastActiveIso ? new Date(s.lastActiveIso).getTime() : NaN;
    if (Number.isFinite(sMs) && sMs < minMs) minMs = sMs;
    if (Number.isFinite(eMs) && eMs > maxMs) maxMs = eMs;
  }
  if (!Number.isFinite(minMs) || maxMs <= 0) return null;
  return {
    startIso: new Date(minMs).toISOString(),
    endIso: new Date(maxMs).toISOString(),
    durationMs: Math.max(0, maxMs - minMs)
  };
});

const activePeriodSummaryText = computed(() => {
  if (selectedPeriod.value === 'today') {
    return `집계 일자: ${toLocalDateKey(Date.now())} (오늘 00:00 ~ 현재)`;
  }
  if (selectedPeriod.value === '7d') {
    return `집계 구간: ${getCutoffDateKey(7)} ~ ${toLocalDateKey(Date.now())} (최근 7일)`;
  }
  if (selectedPeriod.value === '30d') {
    return `집계 구간: ${getCutoffDateKey(30)} ~ ${toLocalDateKey(Date.now())} (최근 30일)`;
  }
  if (!computedRange.value) return '기록된 사용 기간 없음';
  const r = computedRange.value;
  return `집계 기간: ${formatPeriodRange(r.startIso, r.endIso, r.durationMs, true)}`;
});

const activePeriodDetailCaption = computed(() => {
  if (!computedRange.value) return '';
  const r = computedRange.value;
  return `세션 활동 범위: ${formatPeriodRange(r.startIso, r.endIso, r.durationMs, true)}`;
});

const maxSessionTokens = computed(() => {
  let max = 0;
  for (const r of rows.value) {
    if (r.usage.totalTokens > max) max = r.usage.totalTokens;
  }
  return max || 1;
});

function getRatioPct(tokens) {
  return Math.max(tokens > 0 ? 4 : 0, Math.round((tokens / maxSessionTokens.value) * 100));
}

function formatRangeShort(s) {
  return formatPeriodRange(s.startedAtIso, s.lastActiveIso, s.durationMs, false).replace(/\s*\([^)]+\)$/, '');
}

function focusSessionAgent(s) {
  if (s && s.role) {
    emit('action', { type: 'SELECT_AGENT', payload: { agentId: s.role } });
    emit('action', { type: 'CLOSE_MODAL' });
  }
}

function closeModal() {
  emit('action', { type: 'CLOSE_MODAL' });
}
</script>

<style lang="scss" scoped>
.modal-title {
  font-size: 14px;
  font-weight: 700;
  color: $text-primary;
}

.header-sub {
  font-size: 11px;
  color: $term-blue;
}

.period-tabs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.period-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.period-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  color: $text-secondary;
  font-size: 11.5px;
  cursor: pointer;

  strong {
    color: $text-primary;
  }

  &:hover {
    border-color: $border-strong;
    color: $text-primary;
  }

  &.is-active {
    background-color: $navy-accent;
    border-color: $navy-border;
    color: $text-primary;
  }
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 720px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.stat-card {
  padding: 10px 12px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 5px;
  display: flex;
  flex-direction: column;
  gap: 3px;

  &.is-primary {
    border-color: $navy-border;
    background-color: rgba(30, 39, 97, 0.25);
  }
}

.stat-label {
  font-size: 11px;
  color: $text-secondary;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: $text-primary;
}

.stat-hint {
  font-size: 10.5px;
  color: $text-muted;
}

.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.section-title {
  font-size: 12px;
  font-weight: 700;
  color: $term-blue;
}

.range-caption {
  font-size: 11px;
  color: $text-muted;
}

.toggle-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: $text-secondary;
  cursor: pointer;
}

.table-wrap {
  border: 1px solid $border-subtle;
  border-radius: 4px;
  overflow: auto;
  max-height: 410px;
}

.token-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;

  th,
  td {
    padding: 7px 9px;
    border-bottom: 1px solid $border-subtle;
    text-align: left;
    vertical-align: middle;
  }

  th {
    position: sticky;
    top: 0;
    background-color: $bg-elevated;
    color: $text-secondary;
    font-weight: 600;
    z-index: 1;
    white-space: nowrap;
  }

  tbody tr {
    cursor: pointer;

    &:hover {
      background-color: $bg-hover;
    }

    &.is-archived {
      opacity: 0.72;
    }
  }
}

.num-col {
  text-align: right !important;
  white-space: nowrap;
}

.strong-num {
  font-weight: 700;
  color: $text-primary;
}

.session-col {
  max-width: 240px;
}

.session-title {
  color: $text-primary;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-sub {
  font-size: 10.5px;
  color: $text-muted;
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.period-col {
  white-space: nowrap;
  font-size: 10.5px;
  color: $text-secondary;
}

.dur-sub {
  font-size: 10px;
  color: $text-muted;
  margin-top: 1px;
}

.tag-archived,
.tag-partial {
  padding: 0 4px;
  border-radius: 2px;
  font-size: 9.5px;
  border: 1px solid $border-strong;
  color: $text-secondary;
}

.model-col {
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: $text-secondary;
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
  &.state-done { color: $term-green; border-color: $state-done; }
  &.state-blocked { color: $term-yellow; border-color: $state-blocked; }
}

.bar-col {
  width: 78px;
}

.ratio-track {
  width: 68px;
  height: 7px;
  background-color: $bg-input;
  border-radius: 3px;
  overflow: hidden;
}

.ratio-fill {
  height: 100%;
  background-color: $state-working;
}

.empty-row {
  text-align: center !important;
  color: $text-muted;
  padding: 20px !important;
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
.c-green { color: $term-green; }
.c-blue { color: $term-blue; }

.btn {
  padding: 6px 13px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 12px;
  cursor: pointer;
}

.btn-sm {
  padding: 4px 9px;
  font-size: 11px;
}

.btn-primary {
  background-color: $navy-accent;
  border-color: $navy-border;
}
</style>
