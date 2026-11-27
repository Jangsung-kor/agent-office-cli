<template>
  <div class="chat-panel">
    <!-- 상단 탭 & 상태 컨트롤 바 -->
    <div class="panel-toolbar">
      <div class="tab-group">
        <button
          type="button"
          :class="['tab-btn', { 'is-active': activeTab === 'chat' }]"
          @click="activeTab = 'chat'"
        >
          대화 및 답변
        </button>
        <button
          type="button"
          :class="['tab-btn', { 'is-active': activeTab === 'raw' }]"
          @click="activeTab = 'raw'"
        >
          실행 로그 (Raw)
        </button>
      </div>

      <div class="toolbar-actions">
        <div class="font-ctrl" title="대화 및 로그 글자 크기 조절">
          <button
            type="button"
            class="tool-btn font-btn"
            :disabled="chatFontSize <= MIN_FONT_SIZE"
            @click="adjustFontSize(-1)"
          >
            A-
          </button>
          <span class="font-size-val">{{ chatFontSize }}px</span>
          <button
            type="button"
            class="tool-btn font-btn"
            :disabled="chatFontSize >= MAX_FONT_SIZE"
            @click="adjustFontSize(1)"
          >
            A+
          </button>
        </div>

        <span class="meta-count">
          {{ panelData.agent.convId ? `세션 ${panelData.agent.convId.slice(0, 8)}` : '세션 미연결' }}
          · 대화 {{ chatMessages.length }} · 도구 {{ totalToolCallCount }}
        </span>
        <button
          type="button"
          class="tool-btn"
          :disabled="panelData.messagesLoading || !panelData.agent.convId"
          @click="emitAction('REFRESH_MESSAGES', { convId: panelData.agent.convId })"
        >
          {{ panelData.messagesLoading ? '로딩...' : '새로고침' }}
        </button>
        <button type="button" class="tool-btn" @click="scrollToBottom(true)">맨 아래</button>
      </div>
    </div>

    <!-- 현재 세션 토큰 사용량 요약 바 -->
    <div v-if="panelData.agent.convId && sessionTokenStats" class="session-token-bar">
      <div class="token-stats-group mono">
        <span class="token-badge is-total">누적 {{ formatTokens(sessionTokenStats.totalTokens) }}</span>
        <span class="token-item">입력 {{ formatTokens(sessionTokenStats.inputTokens) }}</span>
        <span class="token-item c-green">
          캐시 {{ formatTokens(sessionTokenStats.cacheReadTokens) }} ({{ sessionCacheHitPct }}%)
        </span>
        <span class="token-item c-blue">출력 {{ formatTokens(sessionTokenStats.outputTokens) }}</span>
        <span v-if="sessionTokenStats.lastContextTokens > 0" class="token-item">
          컨텍스트 {{ formatTokens(sessionTokenStats.lastContextTokens) }}<template v-if="sessionTokenStats.contextWindow"> / {{ formatTokens(sessionTokenStats.contextWindow) }}</template>
        </span>
        <span v-if="sessionPeriodLabel" class="token-item">기간 {{ sessionPeriodLabel }}</span>
      </div>
      <button type="button" class="token-detail-btn" @click="emitAction('OPEN_TOKEN_MODAL')">
        전체 토큰 보기
      </button>
    </div>

    <!-- [탭 1] 대화 및 실시간 답변 스레드 (터미널 + 구조화 박스) -->
    <div
      v-show="activeTab === 'chat'"
      ref="chatScrollRef"
      class="terminal-scroll"
      :style="{ fontSize: `${chatFontSize}px` }"
      @scroll="onScrollContainer"
      @click="onMarkdownClick"
    >
      <div class="boot-line">
        <span class="prompt-prefix">❯</span>
        <span class="cmd-echo">{{ panelData.cliCommand || 'agy' }} attach --agent {{ panelData.agent.id }}</span>
      </div>
      <div class="boot-meta">
        [DIR] workspace={{ panelData.targetWorkspace || '-' }} | tool={{ panelData.agent.currentTool || '-' }}
      </div>

      <div v-if="!panelData.agent.convId && !panelData.activeStream" class="empty-guide">
        <div class="c-muted">[INFO] 현재 {{ panelData.agent.id }}에 연결된 CLI 세션이 없습니다.</div>
        <div class="c-muted">상단 매핑 드롭다운에서 기존 세션을 연결하거나 하단 콘솔에서 새 프롬프트를 실행하세요.</div>
      </div>

      <div v-else-if="panelData.messagesLoading && panelData.messages.length === 0" class="empty-guide">
        <span class="c-blue">[LOAD]</span> CLI 세션 대화 이력을 불러오는 중입니다...
      </div>

      <!-- 과거 대화 스레드 (순수 USER / RESPONSE / ERROR 중심 표시) -->
      <div v-for="msg in chatMessages" :key="msg.id" class="thread-item">
        <!-- 사용자 요청 -->
        <div v-if="msg.role === 'user'" class="user-turn">
          <div class="turn-head">
            <span class="prompt-prefix">❯</span>
            <span class="turn-role c-blue">USER</span>
            <span v-if="msg.timestamp" class="turn-time">{{ formatClock(msg.timestamp) }}</span>
            <button
              v-if="isLongUserText(msg.content)"
              type="button"
              class="inline-toggle-btn"
              @click="toggleUserExpand(msg.id)"
            >
              {{ expandedUserIds.has(msg.id) ? '요약 보기' : '원문 펼치기' }}
            </button>
          </div>
          <div class="user-prompt-box">
            {{ getUserDisplayText(msg) }}
          </div>
        </div>

        <!-- 에이전트 응답 -->
        <div v-else class="assistant-turn">
          <!-- 마크다운 본문 박스 -->
          <div v-if="msg.content" :class="['answer-box', { 'is-error': msg.isError }]">
            <div class="answer-meta">
              <span :class="msg.isError ? 'tag-error' : 'tag-done'">
                {{ msg.isError ? '[ERROR]' : '[RESPONSE]' }}
              </span>
              <span v-if="msg.timestamp" class="turn-time">{{ formatClock(msg.timestamp) }}</span>
              <template v-if="msg.isError">
                <button
                  type="button"
                  class="inline-toggle-btn"
                  @click="toggleErrorFriendly(msg.content)"
                >
                  {{ isErrorFriendlyVisible(msg.content) ? '원문만 보기' : '쉬운 해석 보기' }}
                </button>
                <button
                  type="button"
                  class="inline-toggle-btn"
                  :disabled="isAiExplainLoading(msg.content)"
                  title="기존 대화 세션을 오염시키지 않는 단발 실행으로 AI 원인 해석 요청"
                  @click="requestAiExplain(msg.content, '')"
                >
                  {{ isAiExplainLoading(msg.content) ? 'AI 해석 중...' : 'AI 원인 해석' }}
                </button>
              </template>
              <span v-if="msg.usage" class="msg-token-chip mono">
                <template v-if="msg.usage.model">{{ msg.usage.model }} · </template>
                입력 {{ formatTokens(msg.usage.inputTokens) }} · 캐시 {{ formatTokens(msg.usage.cacheReadTokens) }} · 출력 {{ formatTokens(msg.usage.outputTokens) }} (합 {{ formatTokens(msg.usage.totalTokens) }})
              </span>
            </div>

            <!-- 쉬운 해석(사람의 언어) 영역 -->
            <div v-if="msg.isError && isErrorFriendlyVisible(msg.content)" class="error-friendly-box">
              <div class="friendly-head">
                <span class="friendly-title">{{ getErrorInfo(msg.content).ruleHint.title || '오류 안내' }}</span>
                <span v-if="getErrorInfo(msg.content).aiEntry && getErrorInfo(msg.content).aiEntry.modelUsed" class="friendly-meta mono">
                  {{ getErrorInfo(msg.content).aiEntry.modelUsed }} · {{ formatTokens(getErrorInfo(msg.content).aiEntry.tokensUsed) }} tok (세션 분리)
                </span>
              </div>
              <div v-if="getErrorInfo(msg.content).ruleHint.summary" class="friendly-summary">
                {{ getErrorInfo(msg.content).ruleHint.summary }}
              </div>
              <div v-if="getErrorInfo(msg.content).ruleHint.action" class="friendly-action">
                조치: {{ getErrorInfo(msg.content).ruleHint.action }}
              </div>

              <div v-if="getErrorInfo(msg.content).aiEntry && getErrorInfo(msg.content).aiEntry.loading" class="friendly-loading">
                경량 모델로 오류 로그를 해석 중입니다 (기존 대화 세션과 분리 실행)...
              </div>
              <div v-else-if="getErrorInfo(msg.content).aiEntry && getErrorInfo(msg.content).aiEntry.error" class="friendly-err">
                해석 실패: {{ getErrorInfo(msg.content).aiEntry.error }}
              </div>
              <div v-else-if="getErrorInfo(msg.content).aiEntry && getErrorInfo(msg.content).aiEntry.skippedReason" class="friendly-note">
                {{ getErrorInfo(msg.content).aiEntry.skippedReason }}
              </div>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div
                v-else-if="getErrorInfo(msg.content).aiEntry && getErrorInfo(msg.content).aiEntry.aiExplanation"
                class="friendly-ai markdown-body"
                v-html="renderMarkdownCached(`${msg.id}_ai`, getErrorInfo(msg.content).aiEntry.aiExplanation)"
              ></div>
            </div>

            <!-- eslint-disable-next-line vue/no-v-html -->
            <div
              v-if="!msg.isError || !isErrorFriendlyVisible(msg.content) || isRawInsideFriendlyVisible(msg.content)"
              class="markdown-body"
              v-html="renderMarkdownCached(msg.id, msg.content)"
            ></div>
            <button
              v-if="msg.isError && isErrorFriendlyVisible(msg.content)"
              type="button"
              class="inline-toggle-btn raw-toggle-btn"
              @click="toggleRawInsideFriendly(msg.content)"
            >
              {{ isRawInsideFriendlyVisible(msg.content) ? '원문 로그 숨기기' : '원문 로그 함께 보기' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 실시간 stream-json 스트리밍 응답 블록 -->
      <div v-if="panelData.activeStream" class="stream-turn">
        <div class="user-turn">
          <div class="turn-head">
            <span class="prompt-prefix">❯</span>
            <span class="cmd-echo">{{ panelData.activeStream.commandLine || `${panelData.cliCommand || 'agy'} stream` }}</span>
          </div>
          <div v-if="panelData.activeStream.prompt" class="user-prompt-box">
            {{ panelData.activeStream.prompt }}
          </div>
        </div>

        <div class="answer-box is-streaming">
          <div class="answer-meta">
            <span class="tag-stream">[STREAM]</span>
            <span class="c-muted">
              {{ panelData.activeStream.stepType || 'running' }}
              <template v-if="panelData.activeStream.usage && panelData.activeStream.usage.total_tokens">
                · tokens={{ panelData.activeStream.usage.total_tokens.toLocaleString() }}
              </template>
            </span>
          </div>

          <div v-if="panelData.activeStream.error" class="stream-error-wrap">
            <div class="stream-error-head">
              <span class="tag-error">[ERROR]</span>
              <button
                type="button"
                class="inline-toggle-btn"
                @click="toggleErrorFriendly(panelData.activeStream.error)"
              >
                {{ isErrorFriendlyVisible(panelData.activeStream.error) ? '원문만 보기' : '쉬운 해석 보기' }}
              </button>
              <button
                type="button"
                class="inline-toggle-btn"
                :disabled="isAiExplainLoading(panelData.activeStream.error)"
                @click="requestAiExplain(panelData.activeStream.error, panelData.activeStream.commandLine)"
              >
                {{ isAiExplainLoading(panelData.activeStream.error) ? 'AI 해석 중...' : 'AI 원인 해석' }}
              </button>
            </div>
            <div v-if="isErrorFriendlyVisible(panelData.activeStream.error)" class="error-friendly-box">
              <div class="friendly-head">
                <span class="friendly-title">{{ getErrorInfo(panelData.activeStream.error).ruleHint.title || '오류 안내' }}</span>
              </div>
              <div v-if="getErrorInfo(panelData.activeStream.error).ruleHint.summary" class="friendly-summary">
                {{ getErrorInfo(panelData.activeStream.error).ruleHint.summary }}
              </div>
              <div v-if="getErrorInfo(panelData.activeStream.error).ruleHint.action" class="friendly-action">
                조치: {{ getErrorInfo(panelData.activeStream.error).ruleHint.action }}
              </div>
              <div v-if="getErrorInfo(panelData.activeStream.error).aiEntry && getErrorInfo(panelData.activeStream.error).aiEntry.loading" class="friendly-loading">
                경량 모델로 오류 로그를 해석 중입니다...
              </div>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div
                v-else-if="getErrorInfo(panelData.activeStream.error).aiEntry && getErrorInfo(panelData.activeStream.error).aiEntry.aiExplanation"
                class="friendly-ai markdown-body"
                v-html="renderStreamMarkdown(getErrorInfo(panelData.activeStream.error).aiEntry.aiExplanation)"
              ></div>
            </div>
            <div class="stream-error">
              {{ panelData.activeStream.error }}
            </div>
          </div>

          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-if="panelData.activeStream.text"
            class="markdown-body"
            v-html="renderStreamMarkdown(panelData.activeStream.text)"
          ></div>
          <span v-else class="c-muted">CLI 응답 스트림 수신 대기 중...</span>
          <span class="cursor"></span>
        </div>
      </div>
    </div>

    <!-- [탭 2] 도구 호출 이력 · Raw 스트림 · 요약 실행 로그 -->
    <div
      v-show="activeTab === 'raw'"
      ref="rawScrollRef"
      class="terminal-scroll raw-console"
      :style="{ fontSize: `${Math.max(11, chatFontSize - 1)}px` }"
    >
      <div class="log-section-head">도구 호출 이력 ({{ totalToolCallCount }})</div>
      <div v-if="toolHistoryEntries.length === 0" class="c-muted">
        기록된 도구 호출 이력이 없습니다.
      </div>
      <div v-else class="tool-history-list">
        <div v-for="entry in toolHistoryEntries" :key="entry.id" class="tool-history-step">
          <div v-for="(tc, idx) in entry.toolCalls" :key="`${entry.id}-${idx}`" class="tool-detail-row">
            <span v-if="entry.timestamp" class="c-muted">[{{ formatClock(entry.timestamp) }}]</span>
            <span class="tool-name">{{ tc.name }}</span>
            <span v-if="tc.target" class="tool-target">{{ tc.target }}</span>
          </div>
        </div>
      </div>

      <div class="log-section-head summary-head">실시간 stream-json / stderr 출력 ({{ panelData.rawStreamLogs.length }})</div>
      <div v-if="panelData.rawStreamLogs.length === 0" class="c-muted">
        실시간 CLI 실행 시 수신되는 NDJSON 및 stderr 원문이 여기에 표시됩니다.
      </div>
      <div v-for="(entry, idx) in panelData.rawStreamLogs" :key="`raw-${idx}`" class="raw-line">
        <span class="c-muted">[{{ entry.time }}]</span> {{ entry.line }}
      </div>

      <div class="log-section-head summary-head">요약 상태 로그 ({{ panelData.agent.logs.length }})</div>
      <div v-if="panelData.agent.logs.length === 0" class="c-muted">요약 로그 없음</div>
      <div
        v-for="(log, idx) in panelData.agent.logs"
        :key="`sum-${idx}`"
        :class="['raw-line', log.level === 'warn' ? 'c-yellow' : (log.level === 'done' ? 'c-green' : 'c-text')]"
      >
        <span class="c-muted">[{{ log.time }}]</span> {{ log.message }}
      </div>
    </div>

    <!-- 문서·아티팩트(.md 등) 미리보기 모달 -->
    <BaseModal
      :visible="filePreview.open"
      max-width="860px"
      max-height="86vh"
      body-gap="0px"
      @close="closeFilePreview"
    >
      <template #header>
        <div class="file-preview-meta">
          <span class="file-preview-name">{{ filePreview.name || '문서 미리보기' }}</span>
          <span v-if="filePreview.path" class="file-preview-path mono" :title="filePreview.path">{{ filePreview.path }}</span>
        </div>
      </template>
      <template #header-actions>
        <button v-if="filePreview.path" type="button" class="tool-btn" @click="copyPreviewPath">
          {{ previewCopied ? '복사됨' : '경로 복사' }}
        </button>
      </template>
      <div v-if="filePreview.loading" class="c-muted">문서를 불러오는 중입니다...</div>
      <div v-else-if="filePreview.error" class="friendly-err">{{ filePreview.error }}</div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div
        v-else-if="filePreview.isMarkdown"
        class="markdown-body"
        v-html="renderMarkdown(filePreview.content)"
      ></div>
      <pre v-else class="file-preview-pre">{{ filePreview.content }}</pre>
    </BaseModal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { renderMarkdown } from '@/utils/markdown';
import { formatTokens, toLocalDateKey, formatPeriodRange } from '@/utils/formatters';
import { makeErrorKey, translateErrorByRules } from '@/utils/errorHints';
import { readNumberStorage, writeStorage } from '@/utils/storage';

const props = defineProps({
  panelData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const STORAGE_FONT_SIZE_KEY = 'agent_office_cli_chat_font_size';
const MIN_FONT_SIZE = 11;
const MAX_FONT_SIZE = 20;

const activeTab = ref('chat');
const chatFontSize = ref(readNumberStorage(STORAGE_FONT_SIZE_KEY, 13, MIN_FONT_SIZE, MAX_FONT_SIZE));
const chatScrollRef = ref(null);
const rawScrollRef = ref(null);
const isPinnedToBottom = ref(true);

function adjustFontSize(delta) {
  const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, chatFontSize.value + delta));
  chatFontSize.value = next;
  writeStorage(STORAGE_FONT_SIZE_KEY, next);
}

const expandedUserIds = reactive(new Set());
const friendlyToggledErrorKeys = reactive(new Set());

// 대화 탭에는 본문이 존재하는 USER / RESPONSE / ERROR 항목만 남겨 도구-전용 빈 스텝 여백을 방지함
const chatMessages = computed(() => {
  const list = Array.isArray(props.panelData && props.panelData.messages)
    ? props.panelData.messages
    : [];
  return list.filter(msg => msg && (msg.role === 'user' || Boolean(msg.content)));
});

const toolHistoryEntries = computed(() => {
  const list = Array.isArray(props.panelData && props.panelData.messages)
    ? props.panelData.messages
    : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    if (!msg || !Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) continue;
    out.push({
      id: msg.id || `tool-${i}`,
      timestamp: msg.timestamp || null,
      toolCalls: msg.toolCalls
    });
  }
  return out;
});

const totalToolCallCount = computed(() =>
  toolHistoryEntries.value.reduce((acc, entry) => acc + entry.toolCalls.length, 0)
);
const rawVisibleInsideFriendlyKeys = reactive(new Set());
const markdownCache = new Map();

const errorExplainMode = computed(() => props.panelData.errorExplainMode === 'friendly' ? 'friendly' : 'raw');

function getErrorInfo(rawText) {
  const key = makeErrorKey(rawText);
  const map = props.panelData.errorExplanations || {};
  return {
    key,
    ruleHint: translateErrorByRules(rawText),
    aiEntry: map[key] || null
  };
}

function isErrorFriendlyVisible(rawText) {
  const { key, aiEntry } = getErrorInfo(rawText);
  const hasAiState = Boolean(aiEntry && (aiEntry.loading || aiEntry.aiExplanation || aiEntry.error || aiEntry.skippedReason));
  if (errorExplainMode.value === 'friendly') {
    return !friendlyToggledErrorKeys.has(key);
  }
  return friendlyToggledErrorKeys.has(key) || hasAiState;
}

function toggleErrorFriendly(rawText) {
  const key = makeErrorKey(rawText);
  if (friendlyToggledErrorKeys.has(key)) friendlyToggledErrorKeys.delete(key);
  else friendlyToggledErrorKeys.add(key);
}

function isRawInsideFriendlyVisible(rawText) {
  return rawVisibleInsideFriendlyKeys.has(makeErrorKey(rawText));
}

function toggleRawInsideFriendly(rawText) {
  const key = makeErrorKey(rawText);
  if (rawVisibleInsideFriendlyKeys.has(key)) rawVisibleInsideFriendlyKeys.delete(key);
  else rawVisibleInsideFriendlyKeys.add(key);
}

function isAiExplainLoading(rawText) {
  const { aiEntry } = getErrorInfo(rawText);
  return Boolean(aiEntry && aiEntry.loading);
}

function requestAiExplain(rawText, commandLine) {
  if (!rawText) return;
  emitAction('EXPLAIN_ERROR', {
    errorText: rawText,
    commandLine: commandLine || '',
    agentId: props.panelData.agent && props.panelData.agent.id
  });
}

/**
 * 상위 레이아웃으로 단일 액션 전달
 * @author Jangsung
 * @param {String} type
 * @param {Object} payload
 */
function emitAction(type, payload) {
  emit('action', { type, payload });
}

const sessionTokenStats = computed(() => {
  const u = props.panelData.sessionUsage || props.panelData.agent.tokenUsage || null;
  if (!u || !u.totalTokens) return null;
  return u;
});

const sessionCacheHitPct = computed(() => {
  const u = sessionTokenStats.value;
  if (!u) return 0;
  const denom = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0);
  if (denom <= 0) return 0;
  return Math.round(((Number(u.cacheReadTokens) || 0) / denom) * 100);
});

const sessionPeriodLabel = computed(() => {
  const u = sessionTokenStats.value;
  const startIso = (u && u.startedAtIso) || props.panelData.agent.startedAtIso || '';
  const endIso = (u && u.lastActiveIso) || props.panelData.agent.lastActiveIso || '';
  const durationMs = (u && u.durationMs) || props.panelData.agent.durationMs || 0;
  if (!startIso && !endIso) return '';
  return formatPeriodRange(startIso, endIso, durationMs);
});

function formatClock(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toTimeString().slice(0, 8);
    const todayKey = toLocalDateKey(Date.now());
    const dateKey = toLocalDateKey(d.getTime());
    if (dateKey && dateKey !== todayKey) {
      return `${dateKey.slice(5).replace('-', '/')} ${time}`;
    }
    return time;
  } catch (_) {
    return '';
  }
}

function isLongUserText(text) {
  return typeof text === 'string' && (text.length > 260 || text.split(/\r?\n/).length > 4);
}

function getUserDisplayText(msg) {
  if (!msg || !msg.content) return '-';
  if (expandedUserIds.has(msg.id) || !isLongUserText(msg.content)) {
    return msg.content;
  }
  return `${msg.content.slice(0, 240).trim()}...`;
}

function toggleUserExpand(id) {
  if (expandedUserIds.has(id)) expandedUserIds.delete(id);
  else expandedUserIds.add(id);
}

function renderMarkdownCached(id, text) {
  const key = `${id}:${text.length}`;
  if (markdownCache.has(key)) return markdownCache.get(key);
  const html = renderMarkdown(text);
  if (markdownCache.size > 250) markdownCache.clear();
  markdownCache.set(key, html);
  return html;
}

function renderStreamMarkdown(text) {
  return renderMarkdown(text);
}

const filePreview = computed(() => (props.panelData && props.panelData.filePreview) || { open: false });
const previewCopied = ref(false);

function closeFilePreview() {
  previewCopied.value = false;
  emitAction('CLOSE_FILE_PREVIEW');
}

async function copyPreviewPath() {
  if (!filePreview.value.path) return;
  try {
    await navigator.clipboard.writeText(filePreview.value.path);
    previewCopied.value = true;
    setTimeout(() => {
      previewCopied.value = false;
    }, 1200);
  } catch (_) {}
}

/**
 * 코드블록 복사 버튼 및 로컬 문서(file://, .md) 링크 클릭 이벤트 위임
 * @author Jangsung
 * @param {MouseEvent} ev
 */
async function onMarkdownClick(ev) {
  const btn = ev.target && ev.target.closest ? ev.target.closest('.md-code-copy') : null;
  if (btn) {
    const wrap = btn.closest('.md-code-wrap');
    const codeEl = wrap ? wrap.querySelector('pre code') : null;
    if (!codeEl) return;
    try {
      await navigator.clipboard.writeText(codeEl.textContent || '');
      btn.textContent = '복사됨';
      setTimeout(() => {
        btn.textContent = '복사';
      }, 1200);
    } catch (_) {}
    return;
  }

  const link = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
  if (!link) return;
  const href = (link.getAttribute('href') || '').trim();
  if (!href || href.startsWith('#') || /^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    return;
  }
  ev.preventDefault();
  const convId = (props.panelData && props.panelData.agent && props.panelData.agent.convId) || '';
  emitAction('OPEN_FILE_PREVIEW', { path: href, convId });
}

function onScrollContainer() {
  const el = chatScrollRef.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  isPinnedToBottom.value = distanceFromBottom <= 36;
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = activeTab.value === 'chat' ? chatScrollRef.value : rawScrollRef.value;
    if (!el) return;
    if (force || isPinnedToBottom.value) {
      el.scrollTop = el.scrollHeight;
    }
  });
}

watch(
  () => [
    props.panelData.agent.id,
    props.panelData.messages.length,
    props.panelData.activeStream && props.panelData.activeStream.text,
    props.panelData.rawStreamLogs.length
  ],
  () => {
    scrollToBottom(false);
  }
);

watch(
  () => props.panelData.agent.id,
  () => {
    isPinnedToBottom.value = true;
    scrollToBottom(true);
  }
);
</script>

<style lang="scss" scoped>
.chat-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background-color: $term-bg;
}

.panel-toolbar {
  height: 36px;
  min-height: 36px;
  padding: 0 12px;
  background-color: $bg-header;
  border-bottom: 1px solid $border-strong;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tab-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tab-btn {
  padding: 5px 10px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: $text-muted;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;

  &:hover {
    color: $text-secondary;
  }

  &.is-active {
    color: $text-primary;
    border-bottom-color: $state-working;
  }
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.error-mode-ctrl {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: 4px;
}

.error-mode-label {
  font-size: 10.5px;
  color: $text-muted;
  margin-right: 2px;
}

.mode-btn {
  padding: 2px 6px;
  font-size: 10.5px;

  &.is-selected {
    background-color: $navy-accent;
    border-color: $navy-border;
    color: $text-primary;
  }
}

.font-ctrl {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-right: 4px;
}

.font-btn {
  padding: 2px 6px;
  font-family: $font-mono;
  font-size: 10.5px;
}

.font-size-val {
  min-width: 32px;
  text-align: center;
  font-family: $font-mono;
  font-size: 10.5px;
  color: $text-secondary;
}

.meta-count {
  font-family: $font-mono;
  font-size: 11px;
  color: $text-muted;
}

.tool-btn {
  padding: 3px 8px;
  background-color: $bg-elevated;
  border: 1px solid $border-strong;
  border-radius: 3px;
  color: $text-secondary;
  font-size: 11px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background-color: $bg-hover;
    color: $text-primary;
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

.terminal-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 20px;
  font-family: $font-mono;
  font-size: 13px;
  line-height: 1.65;
  background-color: $term-bg;
}

.boot-line {
  margin-bottom: 2px;
}

.boot-meta {
  font-size: 0.88em;
  color: $text-muted;
  margin-bottom: 12px;
}

.empty-guide {
  padding: 10px 12px;
  background-color: $bg-elevated;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  font-family: $font-sans;
  font-size: 0.95em;
  line-height: 1.6;
}

.thread-item,
.stream-turn {
  margin-bottom: 14px;
}

.user-turn {
  margin-bottom: 8px;
}

.turn-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}

.prompt-prefix {
  color: $term-blue;
  font-weight: 700;
}

.cmd-echo {
  color: $text-primary;
  font-weight: 600;
}

.turn-role {
  font-size: 11px;
  font-weight: 700;
}

.turn-time {
  font-size: 10.5px;
  color: $text-muted;
}

.inline-toggle-btn {
  padding: 1px 6px;
  background-color: $bg-elevated;
  border: 1px solid $border-subtle;
  border-radius: 3px;
  color: $text-secondary;
  font-size: 10.5px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
  }
}

.user-prompt-box {
  padding: 9px 12px;
  background-color: #0e141f;
  border: 1px solid #2e405e;
  border-left: 3px solid $term-blue;
  border-radius: 0 4px 4px 0;
  font-family: $font-sans;
  font-size: 1em;
  color: $text-primary;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}

.tool-history-step {
  display: flex;
  flex-direction: column;
}

.tool-detail-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  padding: 2px 0;
}

.tool-name {
  color: $term-blue;
  font-weight: 600;
  flex-shrink: 0;
}

.tool-target {
  color: $text-secondary;
  word-break: break-all;
}

.answer-box {
  padding: 11px 13px;
  background-color: #0e1520;
  border: 1px solid #2b3c56;
  border-left: 3px solid $term-green;
  border-radius: 0 4px 4px 0;
  font-family: $font-sans;

  &.is-streaming {
    border-color: #2f5249;
    border-left-color: $term-green;
    background-color: #0d181c;
  }

  &.is-error {
    border-color: #5a2c38;
    border-left-color: $term-danger;
    background-color: #170f14;
  }
}

.answer-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  font-family: $font-mono;
  font-size: 11px;
}

.session-token-bar {
  padding: 5px 12px;
  background-color: $bg-surface;
  border-bottom: 1px solid $border-subtle;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.token-stats-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: $text-secondary;
}

.token-badge {
  padding: 1px 6px;
  border-radius: 3px;
  background-color: rgba(56, 189, 248, 0.14);
  border: 1px solid rgba(56, 189, 248, 0.35);
  color: $term-blue;
  font-weight: 700;
}

.token-detail-btn {
  padding: 2px 7px;
  background-color: $bg-elevated;
  border: 1px solid $border-strong;
  border-radius: 3px;
  color: $text-secondary;
  font-size: 10.5px;
  cursor: pointer;

  &:hover {
    color: $text-primary;
    background-color: $bg-hover;
  }
}

.msg-token-chip {
  margin-left: auto;
  padding: 1px 6px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-radius: 3px;
  font-size: 10px;
  color: $text-muted;
}

.tag-done {
  color: $term-green;
  font-weight: 700;
}

.tag-error {
  color: $term-danger;
  font-weight: 700;
}

.tag-stream {
  color: $term-green;
  font-weight: 700;
}

.stream-error-wrap {
  margin-bottom: 8px;
}

.stream-error-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  font-family: $font-mono;
  font-size: 11px;
}

.stream-error {
  color: $term-danger;
  font-family: $font-mono;
  font-size: 12px;
  margin-bottom: 6px;
}

.error-friendly-box {
  margin: 4px 0 8px;
  padding: 8px 10px;
  background-color: $bg-surface;
  border: 1px solid $border-strong;
  border-radius: 4px;
  font-family: $font-sans;
  font-size: 12px;
  line-height: 1.5;
}

.friendly-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.friendly-title {
  font-weight: 700;
  color: $term-yellow;
}

.friendly-meta {
  font-size: 10px;
  color: $text-muted;
}

.friendly-summary {
  color: $text-primary;
  margin-bottom: 3px;
}

.friendly-action {
  color: $term-green;
  font-size: 11.5px;
}

.friendly-loading {
  margin-top: 6px;
  font-size: 11px;
  color: $term-blue;
}

.friendly-err {
  margin-top: 6px;
  font-size: 11px;
  color: $term-danger;
}

.friendly-note {
  margin-top: 6px;
  font-size: 11px;
  color: $text-secondary;
}

.friendly-ai {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid $border-subtle;
}

.raw-toggle-btn {
  margin-top: 4px;
}

.cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  vertical-align: -2px;
  background-color: $term-green;
  margin-left: 4px;
  animation: term-blink 0.9s infinite;
}

@keyframes term-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.markdown-body {
  color: $text-primary;
  font-size: 1em;
  line-height: 1.65;
  word-break: break-word;

  :deep(p) {
    margin-bottom: 8px;

    &:last-child {
      margin-bottom: 0;
    }
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    margin: 12px 0 6px;
    font-weight: 700;
    color: $text-primary;
  }

  :deep(ul),
  :deep(ol) {
    padding-left: 18px;
    margin-bottom: 8px;
  }

  :deep(li) {
    margin-bottom: 3px;
  }

  :deep(code) {
    font-family: $font-mono;
    font-size: 0.9em;
    padding: 1px 4px;
    background-color: $bg-elevated;
    border-radius: 3px;
    color: $term-blue;
  }

  :deep(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 0.92em;
  }

  :deep(th),
  :deep(td) {
    border: 1px solid $border-subtle;
    padding: 5px 8px;
    text-align: left;
  }

  :deep(th) {
    background-color: $bg-surface;
    color: $text-secondary;
  }

  :deep(.md-code-wrap) {
    margin: 8px 0;
    border: 1px solid $border-subtle;
    border-radius: 4px;
    overflow: hidden;
    background-color: $bg-input;
  }

  :deep(.md-code-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 9px;
    background-color: $bg-surface;
    border-bottom: 1px solid $border-subtle;
    font-family: $font-mono;
    font-size: 10.5px;
    color: $text-muted;
  }

  :deep(.md-code-copy) {
    padding: 1px 6px;
    background-color: $bg-elevated;
    border: 1px solid $border-strong;
    border-radius: 3px;
    color: $text-secondary;
    font-size: 10.5px;
    cursor: pointer;

    &:hover {
      color: $text-primary;
    }
  }

  :deep(.md-pre) {
    padding: 9px 11px;
    overflow-x: auto;
    margin: 0;

    code {
      background: transparent;
      padding: 0;
      color: $text-primary;
    }
  }
}

.raw-console {
  line-height: 1.55;
}

.log-section-head {
  font-size: 11px;
  font-weight: 700;
  color: $term-blue;
  margin-bottom: 6px;

  &.summary-head {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid $border-subtle;
  }
}

.raw-line {
  margin-bottom: 3px;
  word-break: break-all;
  color: $text-secondary;
}

.c-muted { color: $text-muted; }
.c-text { color: $text-secondary; }
.c-green { color: $term-green; }
.c-yellow { color: $term-yellow; }
.c-blue { color: $term-blue; }

:deep(.markdown-body a.local-file-link) {
  color: $term-blue;
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;

  &:hover {
    text-decoration-style: solid;
  }
}

.file-preview-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.file-preview-name {
  font-size: 13px;
  font-weight: 700;
  color: $text-primary;
}

.file-preview-path {
  font-size: 11px;
  color: $text-muted;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-preview-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: $font-mono;
  font-size: 12px;
  color: $text-secondary;
}
</style>
