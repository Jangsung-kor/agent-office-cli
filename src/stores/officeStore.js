import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { assignAgentSeats, resolveDynamicWorkers, isLoungeState } from '@/constants/officeLayout';
import { makeErrorKey, translateErrorByRules } from '@/utils/errorHints';
import { readJsonResponse } from '@/utils/http';
import { readStorage, writeStorage } from '@/utils/storage';

const EXPECTED_BRIDGE_VERSION = '2026-11-25-cli-v4';
const STORAGE_PROVIDER_SESSION_KEY = 'agent_office_selected_provider';
const STORAGE_ERROR_MODE_KEY = 'agent_office_cli_error_explain_mode';

const DEFAULT_CAPABILITIES_MAP = {
  antigravity: {
    providerId: 'antigravity',
    name: 'ANTIGRAVITY',
    label: 'Antigravity CLI',
    cliCommand: 'agy',
    cliLabel: 'agy-cli',
    supportsCliAgents: true,
    supportsHandover: true,
    defaultModelId: 'gemini-4-hydrogen-high',
    defaultEffort: 'auto',
    defaultMode: 'plan',
    builtInEffortRegex: '-(low|medium|high|xhigh|max)$',
    healthBasis: 'transcript.jsonl 파일 크기',
    modes: [
      { id: 'plan', label: 'plan (읽기/계획)' },
      { id: 'accept-edits', label: 'accept-edits (편집 허용)' },
      { id: 'auto', label: 'auto (자동 실행)' }
    ],
    efforts: [
      { id: 'auto', label: 'auto (기본)' },
      { id: 'low', label: 'low (최소)' },
      { id: 'medium', label: 'medium (보통)' },
      { id: 'high', label: 'high (권장)' },
      { id: 'xhigh', label: 'xhigh (최대)' },
      { id: 'max', label: 'max (최상한)' }
    ]
  },
  codex: {
    providerId: 'codex',
    name: 'CODEX',
    label: 'Codex CLI',
    cliCommand: 'codex exec',
    cliLabel: 'codex-cli',
    supportsCliAgents: false,
    supportsHandover: true,
    defaultModelId: 'gpt-6-luna',
    defaultEffort: 'medium',
    defaultMode: 'read-only',
    builtInEffortRegex: null,
    healthBasis: 'Codex 세션 JSONL 파일 크기',
    modes: [
      { id: 'read-only', label: 'read-only (읽기/계획)' },
      { id: 'workspace-write', label: 'workspace-write (편집 허용)' },
      { id: 'full-auto', label: 'full-auto (전체 허용)' }
    ],
    efforts: [
      { id: 'auto', label: 'auto (기본)' },
      { id: 'low', label: 'low (최소)' },
      { id: 'medium', label: 'medium (보통)' },
      { id: 'high', label: 'high (권장)' },
      { id: 'xhigh', label: 'xhigh (최대)' },
      { id: 'max', label: 'max (최상한)' },
      { id: 'ultra', label: 'ultra (초고성능)' }
    ]
  }
};

function readSessionSelectedProvider() {
  try {
    const val = sessionStorage.getItem(STORAGE_PROVIDER_SESSION_KEY);
    return val === 'antigravity' || val === 'codex' ? val : '';
  } catch (_) {
    return '';
  }
}

function writeSessionSelectedProvider(providerId) {
  try {
    if (providerId) {
      sessionStorage.setItem(STORAGE_PROVIDER_SESSION_KEY, providerId);
    } else {
      sessionStorage.removeItem(STORAGE_PROVIDER_SESSION_KEY);
    }
  } catch (_) {}
}

function readProviderPref(providerId, key, fallback) {
  const scopedKey = `agent_office_${providerId}_${key}`;
  const legacyKey = `agent_office_cli_${key}`;
  try {
    const scoped = localStorage.getItem(scopedKey);
    if (scoped) return scoped;
    if (providerId === 'antigravity') {
      return localStorage.getItem(legacyKey) || fallback;
    }
    return fallback;
  } catch (_) {
    return fallback;
  }
}

function saveProviderPref(providerId, key, value) {
  writeStorage(`agent_office_${providerId}_${key}`, value);
}

function createEmptyFilePreview() {
  return {
    open: false,
    loading: false,
    name: '',
    path: '',
    content: '',
    isMarkdown: false,
    error: ''
  };
}

function buildPrefsForProvider(providerId, capabilities) {
  const caps = capabilities || DEFAULT_CAPABILITIES_MAP[providerId] || DEFAULT_CAPABILITIES_MAP.antigravity;
  return {
    modelId: readProviderPref(providerId, 'model', caps.defaultModelId),
    effort: readProviderPref(providerId, 'effort', caps.defaultEffort),
    mode: readProviderPref(providerId, 'mode', caps.defaultMode),
    createNewSession: false
  };
}

/**
 * 다중 AI CLI 가상 오피스 중앙 상태 및 단방향 액션 스토어
 * 모든 하위 UI 컴포넌트는 dispatchAction({ type, payload }) 단일 진입점으로만 상태를 변경함
 * @author Jangsung
 */
export const useOfficeStore = defineStore('office', () => {
  const initialSessionProvider = readSessionSelectedProvider();

  const bridgeConnected = ref(false);
  const bridgeVersion = ref('-');
  const bridgeOutdated = computed(
    () => bridgeConnected.value && bridgeVersion.value !== EXPECTED_BRIDGE_VERSION
  );
  const activeProvider = ref(initialSessionProvider || 'antigravity');
  const providers = ref([]);
  const providersLoading = ref(false);
  const providerSwitchingId = ref('');
  const showProviderSelector = ref(!initialSessionProvider);
  const providerCapabilities = ref({
    ...(DEFAULT_CAPABILITIES_MAP[activeProvider.value] || DEFAULT_CAPABILITIES_MAP.antigravity)
  });
  const accountInfo = ref(null);

  const targetWorkspace = ref('');
  const workspaceMode = ref('single-project');
  const rulesDir = ref('.agents/rules');
  const candidateProjects = ref([]);
  const cliBrainDir = ref('');
  const agents = ref({});
  const allAgents = ref([]);
  const activeAgentIds = ref(['Master']);
  const sessions = ref([]);
  const manualMapping = ref({});
  const tokenSummary = ref({
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    activeSessionCount: 0,
    archivedSessionCount: 0,
    workingSessionCount: 0,
    totalSessionCount: 0
  });
  const models = ref([]);
  const rosterLoading = ref(false);

  const selectedAgentId = ref('Master');
  const hoveredAgentId = ref(null);
  const packets = ref([]);

  const activeSessionMessages = ref([]);
  const activeSessionUsage = ref(null);
  const messagesLoading = ref(false);
  const streamingResponseByAgent = ref({});
  const rawStreamLogsByAgent = ref({});
  const submittingByAgent = ref({});
  const promptPrefs = ref(buildPrefsForProvider(activeProvider.value, providerCapabilities.value));
  const activeModal = ref(null);
  const handoverResult = ref(null);
  const handoverLoading = ref(false);
  const lastError = ref('');
  const errorExplainMode = ref(readStorage(STORAGE_ERROR_MODE_KEY, 'raw') === 'friendly' ? 'friendly' : 'raw');
  const errorExplanations = ref({});
  const filePreview = ref(createEmptyFilePreview());

  let eventSource = null;

  /**
   * 캔버스 및 목록 렌더링용 에이전트 통합 배열 (선택된 팀원 동적 좌석 배정 + 미할당 CLI 워커)
   * @author Jangsung
   */
  const officeAgents = computed(() => {
    const baseMap = agents.value || {};
    const assignedConvIds = new Set();
    for (const ag of Object.values(baseMap)) {
      if (ag && ag.convId) assignedConvIds.add(ag.convId);
    }

    const baseList = assignAgentSeats(baseMap);

    const dynamicWorkers = resolveDynamicWorkers(sessions.value, assignedConvIds).map(w => {
      const pos = isLoungeState(w.state) ? w.lounge : w.desk;
      return {
        ...w,
        targetX: pos.x,
        targetY: pos.y
      };
    });

    return baseList.concat(dynamicWorkers);
  });

  const selectedAgent = computed(
    () => officeAgents.value.find(a => a.id === selectedAgentId.value) || officeAgents.value[0] || null
  );

  const activeStream = computed(() => streamingResponseByAgent.value[selectedAgentId.value] || null);
  const activeRawStreamLogs = computed(() => rawStreamLogsByAgent.value[selectedAgentId.value] || []);

  const pipelineStats = computed(() => {
    const base = officeAgents.value.filter(a => !a.isDynamicWorker);
    const activeCount = base.filter(a => a.state === 'WORKING').length;
    const doneCount = base.filter(a => a.state === 'DONE').length;
    return {
      total: base.length,
      activeCount,
      doneCount,
      progressPct: base.length > 0 ? Math.round(((activeCount * 0.5 + doneCount) / base.length) * 100) : 0
    };
  });

  /**
   * 활성 프로바이더 CLI 실행 명령어 미리보기 문자열 조합
   * @author Jangsung
   * @param {Object} params
   * @return {String}
   */
  function buildCliCommandEcho({ modelId, effort, mode, convId, prompt }) {
    const caps = providerCapabilities.value || DEFAULT_CAPABILITIES_MAP.antigravity;
    const singleLine = String(prompt || '').replace(/\s+/g, ' ').trim();
    const shortPrompt = singleLine.length > 48 ? `${singleLine.slice(0, 48)}...` : singleLine;

    if (caps.providerId === 'codex') {
      const parts = ['codex exec'];
      if (convId) parts.push('resume');
      parts.push('--json');
      if (modelId) parts.push(`-m ${modelId}`);
      if (mode) parts.push(`-s ${mode}`);
      if (effort && effort !== 'auto') parts.push(`-c model_reasoning_effort="${effort}"`);
      if (convId) parts.push(convId.slice(0, 8));
      parts.push(`"${shortPrompt}"`);
      return parts.join(' ');
    }

    const parts = [caps.cliCommand || 'agy'];
    if (modelId) parts.push(`--model ${modelId}`);
    if (effort) parts.push(`--effort ${effort}`);
    if (mode) parts.push(`--mode ${mode}`);
    parts.push('--output-format stream-json');
    if (convId) parts.push(`--conversation ${convId.slice(0, 8)}`);
    parts.push(`-p="${shortPrompt}"`);
    return parts.join(' ');
  }

  /**
   * Raw 스트림 로그 버퍼에 1줄 추가
   * @author Jangsung
   * @param {String} agentId
   * @param {String} line
   */
  function appendRawStreamLog(agentId, line) {
    if (!agentId || !line) return;
    const prev = rawStreamLogsByAgent.value[agentId] || [];
    const time = new Date().toTimeString().slice(0, 8);
    const nextList = prev.concat({ time, line }).slice(-150);
    rawStreamLogsByAgent.value = {
      ...rawStreamLogsByAgent.value,
      [agentId]: nextList
    };
  }

  /**
   * Master와 에이전트 간 시각적 전달 패킷 생성
   * @author Jangsung
   * @param {String} fromId
   * @param {String} toId
   * @param {String} label
   * @param {String} color
   */
  function spawnPacket(fromId, toId, label, color) {
    const fromAgent = officeAgents.value.find(a => a.id === fromId);
    const toAgent = officeAgents.value.find(a => a.id === toId);
    if (!fromAgent || !toAgent || fromId === toId) return;
    packets.value = packets.value.concat({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fromId,
      toId,
      fromX: fromAgent.targetX,
      fromY: fromAgent.targetY - 16,
      toX: toAgent.targetX,
      toY: toAgent.targetY - 16,
      label: label || 'CLI',
      color: color || '#38bdf8',
      createdAt: Date.now()
    }).slice(-12);
  }

  /**
   * 서버 로스터 응답 메타데이터를 스토어 상태에 일괄 반영
   * @author Jangsung
   * @param {Object} data
   */
  function applyRosterPayload(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.allAgents)) allAgents.value = data.allAgents;
    if (Array.isArray(data.activeAgentIds)) activeAgentIds.value = data.activeAgentIds;
    if (data.workspaceMode) workspaceMode.value = data.workspaceMode;
    if (data.rulesDir) rulesDir.value = data.rulesDir;
    if (Array.isArray(data.candidateProjects)) candidateProjects.value = data.candidateProjects;
  }

  /**
   * 프로바이더 카탈로그 및 CLI 감지 상태 조회
   * @author Jangsung
   */
  async function fetchProviders() {
    providersLoading.value = true;
    try {
      const res = await fetch('/api/providers');
      const data = await readJsonResponse(res, '프로바이더 목록 조회');
      if (res.ok && data.ok) {
        providers.value = Array.isArray(data.providers) ? data.providers : [];
        if (data.targetWorkspace && !targetWorkspace.value) {
          targetWorkspace.value = data.targetWorkspace;
        }
      } else {
        lastError.value = data.error || '프로바이더 목록 조회 실패';
      }
    } catch (e) {
      lastError.value = e.message || '프로바이더 목록 조회 실패';
    } finally {
      providersLoading.value = false;
    }
  }

  /**
   * 초기 스냅샷 및 모델 목록 로드 (같은 탭에서 새로고침 시 기존 선택 프로바이더 동기화)
   * @author Jangsung
   */
  async function fetchInitialData() {
    try {
      await fetchProviders();
      const sessionChosen = readSessionSelectedProvider();

      if (sessionChosen) {
        const switchRes = await fetch('/api/provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: sessionChosen })
        });
        if (switchRes.ok) {
          const swData = await readJsonResponse(switchRes, 'AI 백엔드 동기화');
          if (swData.ok) {
            if (Array.isArray(swData.models)) models.value = swData.models;
            if (swData.capabilities) providerCapabilities.value = swData.capabilities;
            if (swData.state) applySnapshot(swData.state);
          }
        }
      }

      const [stateRes, modelsRes, agentsRes] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/models'),
        fetch('/api/agents')
      ]);
      if (stateRes.ok) {
        const snap = await readJsonResponse(stateRes, '상태 스냅샷 조회');
        applySnapshot(snap);
      }
      if (modelsRes.ok) {
        const data = await readJsonResponse(modelsRes, '모델 목록 조회');
        if (data.ok && Array.isArray(data.models)) {
          models.value = data.models;
        }
      }
      if (agentsRes.ok) {
        const agData = await readJsonResponse(agentsRes, '에이전트 목록 조회');
        if (agData.ok) {
          applyRosterPayload(agData);
        }
      }
    } catch (e) {
      lastError.value = e.message || '브리지 초기 데이터 조회 실패';
    }
  }

  /**
   * 서버 스냅샷 반영, 프로바이더 변경 동기화, 상태 전이 패킷 및 진행 중 스트림 복구
   * @author Jangsung
   * @param {Object} snap
   */
  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    const prevProviderId = activeProvider.value;
    const nextProviderId = snap.providerId || activeProvider.value;
    const providerChanged = Boolean(snap.providerId && snap.providerId !== prevProviderId);

    if (snap.providerId) {
      activeProvider.value = snap.providerId;
    }
    if (snap.capabilities) {
      providerCapabilities.value = snap.capabilities;
    } else if (DEFAULT_CAPABILITIES_MAP[nextProviderId]) {
      providerCapabilities.value = { ...DEFAULT_CAPABILITIES_MAP[nextProviderId] };
    }
    if (snap.accountInfo !== undefined) {
      accountInfo.value = snap.accountInfo;
    }

    if (providerChanged) {
      promptPrefs.value = buildPrefsForProvider(nextProviderId, providerCapabilities.value);
      streamingResponseByAgent.value = {};
      rawStreamLogsByAgent.value = {};
    }

    const prevAgents = providerChanged ? {} : (agents.value || {});
    const nextAgents = snap.agents || {};
    const nextStreamMap = { ...streamingResponseByAgent.value };
    const nextRawMap = { ...rawStreamLogsByAgent.value };
    let shouldReloadSelectedConvId = null;

    for (const id of Object.keys(nextAgents)) {
      const prevSnap = prevAgents[id];
      const prevState = prevSnap && prevSnap.state;
      const prevCliRunning = Boolean(prevSnap && prevSnap.cliRunning);
      const agentSnap = nextAgents[id];
      const nextState = agentSnap && agentSnap.state;
      if (prevState && prevState !== nextState) {
        if (nextState === 'WORKING' && id !== 'Master') {
          spawnPacket('Master', id, 'TASK', '#3b82f6');
        } else if (nextState === 'DONE' && id !== 'Master') {
          spawnPacket(id, 'Master', 'DONE', '#10b981');
        }
      }

      // 새로고침 또는 프로바이더 재진입 시 서버 실행 중 버퍼 복구
      if (agentSnap && agentSnap.cliRunning && agentSnap.activeStream) {
        const cur = nextStreamMap[id];
        const srvStream = agentSnap.activeStream;
        if (!cur || (srvStream.text && srvStream.text.length > (cur.text || '').length)) {
          nextStreamMap[id] = {
            convId: srvStream.convId || null,
            prompt: srvStream.prompt || '',
            commandLine: buildCliCommandEcho(srvStream),
            text: srvStream.text || '',
            stepType: srvStream.stepType || '',
            state: 'RUNNING',
            usage: srvStream.usage || null,
            startedAt: srvStream.startedAt || null,
            error: null
          };
        }
        if (Array.isArray(srvStream.rawLogs) && srvStream.rawLogs.length > 0 && !(nextRawMap[id] && nextRawMap[id].length > 0)) {
          nextRawMap[id] = srvStream.rawLogs;
        }
      } else if (agentSnap && !agentSnap.cliRunning && !submittingByAgent.value[id]) {
        if (nextStreamMap[id]) {
          delete nextStreamMap[id];
          if (id === selectedAgentId.value && agentSnap.convId) {
            shouldReloadSelectedConvId = agentSnap.convId;
          }
        } else if ((prevCliRunning || (prevState && prevState !== nextState && (nextState === 'DONE' || nextState === 'IDLE'))) && id === selectedAgentId.value && agentSnap.convId) {
          shouldReloadSelectedConvId = agentSnap.convId;
        }
      }
    }

    bridgeConnected.value = Boolean(snap.bridgeConnected);
    bridgeVersion.value = snap.bridgeVersion || '-';
    targetWorkspace.value = snap.targetWorkspace || '';
    if (snap.workspaceMode) workspaceMode.value = snap.workspaceMode;
    if (snap.rulesDir) rulesDir.value = snap.rulesDir;
    if (Array.isArray(snap.activeAgentIds)) {
      const prevJoined = activeAgentIds.value.join(',');
      const nextJoined = snap.activeAgentIds.join(',');
      if (prevJoined !== nextJoined) {
        activeAgentIds.value = snap.activeAgentIds;
      }
      if (snap.activeAgentIds.length > 0 && !snap.activeAgentIds.includes(selectedAgentId.value)) {
        selectedAgentId.value = snap.activeAgentIds[0];
      }
    }
    cliBrainDir.value = snap.sessionStoreDir || snap.cliBrainDir || '';
    agents.value = nextAgents;
    sessions.value = Array.isArray(snap.sessions) ? snap.sessions : [];
    manualMapping.value = snap.manualMapping || {};
    if (snap.tokenSummary) {
      tokenSummary.value = snap.tokenSummary;
    }
    streamingResponseByAgent.value = nextStreamMap;
    rawStreamLogsByAgent.value = nextRawMap;

    if (providerChanged) {
      const curAgent = nextAgents[selectedAgentId.value];
      shouldReloadSelectedConvId = curAgent && curAgent.convId ? curAgent.convId : null;
      if (!shouldReloadSelectedConvId) {
        activeSessionMessages.value = [];
        activeSessionUsage.value = null;
      }
    }

    if (shouldReloadSelectedConvId) {
      loadSessionMessages(shouldReloadSelectedConvId);
    }
  }

  /**
   * SSE 실시간 스트림 연결
   * @author Jangsung
   */
  function connectStream() {
    disconnectStream();
    eventSource = new EventSource('/api/stream');

    eventSource.addEventListener('state', ev => {
      try {
        applySnapshot(JSON.parse(ev.data));
      } catch (_) {}
    });

    eventSource.addEventListener('chat_delta', ev => {
      try {
        const data = JSON.parse(ev.data);
        if (!data || !data.agentId) return;
        if (data.providerId && data.providerId !== activeProvider.value) return;
        if (data.rawLine) {
          appendRawStreamLog(data.agentId, data.rawLine);
        }
        const prev = streamingResponseByAgent.value[data.agentId] || {};
        streamingResponseByAgent.value = {
          ...streamingResponseByAgent.value,
          [data.agentId]: {
            ...prev,
            convId: data.convId || prev.convId || null,
            text: typeof data.accumulatedText === 'string' ? data.accumulatedText : (prev.text || ''),
            stepType: data.stepType || prev.stepType || '',
            state: data.state || 'RUNNING',
            usage: data.usage || prev.usage || null,
            error: data.error || prev.error || null
          }
        };
      } catch (_) {}
    });

    eventSource.addEventListener('chat_result', ev => {
      try {
        const data = JSON.parse(ev.data);
        if (!data || !data.agentId) return;
        if (data.providerId && data.providerId !== activeProvider.value) return;
        if (data.rawLine) {
          appendRawStreamLog(data.agentId, data.rawLine);
        }
        if (data.error) {
          lastError.value = data.error;
          if (errorExplainMode.value === 'friendly' && translateErrorByRules(data.error).aiExplainable) {
            dispatchAction({
              type: 'EXPLAIN_ERROR',
              payload: {
                errorText: data.error,
                commandLine: data.commandLine || '',
                agentId: data.agentId
              }
            });
          }
        }
        const targetConvId = data.convId || (agents.value[data.agentId] && agents.value[data.agentId].convId);
        const finalizeClear = () => {
          const next = { ...streamingResponseByAgent.value };
          delete next[data.agentId];
          streamingResponseByAgent.value = next;
        };

        if (data.agentId === selectedAgentId.value && targetConvId) {
          loadSessionMessages(targetConvId).finally(finalizeClear);
        } else {
          finalizeClear();
        }
      } catch (_) {}
    });

    eventSource.onerror = () => {
      bridgeConnected.value = false;
    };
  }

  /**
   * SSE 스트림 해제
   * @author Jangsung
   */
  function disconnectStream() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  /**
   * 선택된 세션의 대화 스레드 조회
   * @author Jangsung
   * @param {String} convId
   */
  async function loadSessionMessages(convId) {
    if (!convId) {
      activeSessionMessages.value = [];
      activeSessionUsage.value = null;
      return;
    }
    messagesLoading.value = true;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(convId)}/messages`);
      const data = await readJsonResponse(res, '세션 메시지 조회');
      if (res.ok && data.ok) {
        activeSessionMessages.value = data.messages || [];
        activeSessionUsage.value = data.sessionUsage || null;
      } else {
        activeSessionMessages.value = [];
        activeSessionUsage.value = null;
      }
    } catch (e) {
      lastError.value = e.message || '세션 메시지 조회 실패';
    } finally {
      messagesLoading.value = false;
    }
  }

  /**
   * 단일 액션 진입점 (Flux / Command Pattern)
   * @author Jangsung
   * @param {Object} action
   */
  async function dispatchAction(action) {
    if (!action || !action.type) return;
    const { type, payload } = action;
    lastError.value = '';

    try {
      switch (type) {
      case 'FETCH_PROVIDERS': {
        await fetchProviders();
        break;
      }
      case 'OPEN_PROVIDER_SELECTOR': {
        writeSessionSelectedProvider('');
        showProviderSelector.value = true;
        await fetchProviders();
        break;
      }
      case 'SELECT_PROVIDER': {
        const nextId = payload && payload.providerId;
        if (!nextId) break;
        providerSwitchingId.value = nextId;
        try {
          const res = await fetch('/api/provider', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ providerId: nextId })
          });
          const data = await readJsonResponse(res, 'AI 백엔드 전환');
          if (!res.ok || !data.ok) {
            lastError.value = data.error || 'AI 백엔드 전환 실패';
            break;
          }
          writeSessionSelectedProvider(nextId);
          if (Array.isArray(data.models)) models.value = data.models;
          if (data.capabilities) providerCapabilities.value = data.capabilities;
          promptPrefs.value = buildPrefsForProvider(nextId, data.capabilities);
          if (data.state) applySnapshot(data.state);

          const agentsRes = await fetch('/api/agents');
          if (agentsRes.ok) {
            const agData = await readJsonResponse(agentsRes, '에이전트 목록 조회');
            if (agData.ok) applyRosterPayload(agData);
          }
          showProviderSelector.value = false;
          if (selectedAgent.value && selectedAgent.value.convId) {
            await loadSessionMessages(selectedAgent.value.convId);
          } else {
            activeSessionMessages.value = [];
          }
        } catch (e) {
          lastError.value = e.message || 'AI 백엔드 전환 중 오류 발생';
        } finally {
          providerSwitchingId.value = '';
        }
        break;
      }
      case 'SELECT_AGENT': {
        const nextId = (payload && payload.agentId) || 'Master';
        selectedAgentId.value = nextId;
        const target = officeAgents.value.find(a => a.id === nextId);
        await loadSessionMessages(target && target.convId);
        break;
      }
      case 'HOVER_AGENT': {
        hoveredAgentId.value = (payload && payload.agentId) || null;
        break;
      }
      case 'UPDATE_ACCOUNT_LABEL': {
        const pid = (payload && payload.providerId) || activeProvider.value;
        const res = await fetch('/api/account-label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: pid,
            label: (payload && payload.label) || ''
          })
        });
        const data = await readJsonResponse(res, '접속 계정 라벨 저장');
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '접속 계정 라벨 저장 실패';
        } else if (data.accountInfo && pid === activeProvider.value) {
          accountInfo.value = data.accountInfo;
        }
        break;
      }
      case 'CONSUME_PACKETS': {
        const ids = new Set((payload && payload.expiredIds) || []);
        if (ids.size > 0) {
          packets.value = packets.value.filter(p => !ids.has(p.id));
        }
        break;
      }
      case 'UPDATE_MAPPING': {
        const res = await fetch('/api/mapping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: payload && payload.agentId,
            convId: payload && payload.convId
          })
        });
        const data = await readJsonResponse(res, '세션 매핑 변경');
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '세션 매핑 변경 실패';
        } else if (payload && payload.convId) {
          await loadSessionMessages(payload.convId);
        }
        break;
      }
      case 'REFRESH_MESSAGES': {
        const convId = (payload && payload.convId)
          || (selectedAgent.value && selectedAgent.value.convId);
        await loadSessionMessages(convId);
        break;
      }
      case 'REFRESH_MODELS': {
        const res = await fetch('/api/models?refresh=1');
        const data = await readJsonResponse(res, '모델 목록 갱신');
        if (data.ok && Array.isArray(data.models)) {
          models.value = data.models;
        }
        break;
      }
      case 'SET_PROMPT_PREF': {
        const next = { ...promptPrefs.value, ...(payload || {}) };
        promptPrefs.value = next;
        const pid = activeProvider.value || 'antigravity';
        if (payload && payload.modelId !== undefined) saveProviderPref(pid, 'model', next.modelId);
        if (payload && payload.effort !== undefined) saveProviderPref(pid, 'effort', next.effort);
        if (payload && payload.mode !== undefined) saveProviderPref(pid, 'mode', next.mode);
        break;
      }
      case 'OPEN_MODEL_GUIDE': {
        activeModal.value = 'modelGuide';
        break;
      }
      case 'OPEN_TOKEN_MODAL': {
        activeModal.value = 'tokenUsage';
        break;
      }
      case 'OPEN_SESSION_MODAL': {
        activeModal.value = 'sessionManager';
        break;
      }
      case 'SET_ERROR_EXPLAIN_MODE': {
        const nextMode = payload && payload.mode === 'friendly' ? 'friendly' : 'raw';
        errorExplainMode.value = nextMode;
        try {
          localStorage.setItem(STORAGE_ERROR_MODE_KEY, nextMode);
        } catch (_) {}
        break;
      }
      case 'EXPLAIN_ERROR': {
        const errorText = typeof (payload && payload.errorText) === 'string' ? payload.errorText.trim() : '';
        if (!errorText) break;
        const key = makeErrorKey(errorText);
        const existing = errorExplanations.value[key];
        if (existing && (existing.loading || existing.aiExplanation || existing.mode === 'rule_fallback')) {
          break;
        }
        const ruleHint = translateErrorByRules(errorText);
        errorExplanations.value = {
          ...errorExplanations.value,
          [key]: { loading: true, ruleHint, aiExplanation: '', modelUsed: '', tokensUsed: 0, error: '' }
        };
        try {
          const res = await fetch('/api/error/explain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              errorText,
              commandLine: (payload && payload.commandLine) || '',
              agentId: (payload && payload.agentId) || selectedAgentId.value,
              mode: 'ai'
            })
          });
          const data = await readJsonResponse(res, '오류 원인 해석');
          if (!res.ok || !data.ok) {
            errorExplanations.value = {
              ...errorExplanations.value,
              [key]: {
                loading: false,
                ruleHint,
                aiExplanation: '',
                error: data.error || '오류 해석 요청 실패'
              }
            };
          } else {
            errorExplanations.value = {
              ...errorExplanations.value,
              [key]: {
                loading: false,
                mode: data.mode || 'ai',
                ruleHint: data.ruleHint || ruleHint,
                modelUsed: data.modelUsed || '',
                tokensUsed: Number(data.tokensUsed || 0),
                aiExplanation: data.aiExplanation || '',
                skippedReason: data.skippedReason || '',
                error: ''
              }
            };
          }
        } catch (err) {
          errorExplanations.value = {
            ...errorExplanations.value,
            [key]: {
              loading: false,
              ruleHint,
              aiExplanation: '',
              error: err.message || '오류 해석 중 네트워크 오류'
            }
          };
        }
        break;
      }
      case 'UPDATE_SESSION_META': {
        const res = await fetch('/api/sessions/meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {})
        });
        const data = await readJsonResponse(res, '세션 상태/별칭 변경');
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '세션 상태 변경 실패';
        }
        break;
      }
      case 'TERMINATE_SESSION': {
        const targetConvId = payload && payload.convId;
        const targetAgentId = (payload && payload.agentId) || null;
        const res = await fetch('/api/sessions/terminate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ convId: targetConvId, agentId: targetAgentId })
        });
        const data = await readJsonResponse(res, '세션 종료');
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '세션 종료 실패';
        } else {
          const stoppedAgent = data.agentId || targetAgentId;
          if (stoppedAgent) {
            appendRawStreamLog(stoppedAgent, '[세션 종료] 사용자 요청으로 작업을 종료했습니다.');
            const next = { ...streamingResponseByAgent.value };
            delete next[stoppedAgent];
            streamingResponseByAgent.value = next;
            submittingByAgent.value = { ...submittingByAgent.value, [stoppedAgent]: false };
          }
        }
        break;
      }
      case 'DELETE_SESSIONS': {
        const res = await fetch('/api/sessions/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {})
        });
        const data = await readJsonResponse(res, '세션 삭제');
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '세션 삭제 실패';
        } else {
          const deletedSet = new Set(data.deletedIds || []);
          const curConv = selectedAgent.value && selectedAgent.value.convId;
          if (curConv && deletedSet.has(curConv)) {
            activeSessionMessages.value = [];
            activeSessionUsage.value = null;
          }
        }
        break;
      }
      case 'OPEN_TEAM_MODAL': {
        activeModal.value = 'teamRoster';
        await dispatchAction({ type: 'FETCH_AGENTS', payload: { refresh: false } });
        break;
      }
      case 'FETCH_AGENTS': {
        rosterLoading.value = true;
        try {
          const refreshFlag = payload && payload.refresh ? '?refresh=1' : '';
          const res = await fetch(`/api/agents${refreshFlag}`);
          const data = await readJsonResponse(res, '에이전트 목록 조회');
          if (res.ok && data.ok) {
            applyRosterPayload(data);
          } else {
            lastError.value = data.error || '에이전트 목록 조회 실패';
          }
        } finally {
          rosterLoading.value = false;
        }
        break;
      }
      case 'SCAN_RULES_DIR': {
        rosterLoading.value = true;
        try {
          const res = await fetch('/api/agents/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rulesDir: payload && payload.rulesDir !== undefined ? payload.rulesDir : ''
            })
          });
          const data = await readJsonResponse(res, '규칙 경로 재스캔');
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '규칙 경로 재스캔 실패';
          } else {
            applyRosterPayload(data);
          }
        } finally {
          rosterLoading.value = false;
        }
        break;
      }
      case 'SAVE_ROSTER': {
        rosterLoading.value = true;
        try {
          const res = await fetch('/api/agents/roster', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              activeAgentIds: payload && payload.activeAgentIds,
              rulesDir: payload && payload.rulesDir
            })
          });
          const data = await readJsonResponse(res, '팀원 저장');
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '팀원 저장 실패';
          } else {
            applyRosterPayload(data);
            activeModal.value = null;
          }
        } finally {
          rosterLoading.value = false;
        }
        break;
      }
      case 'CREATE_AGENT': {
        rosterLoading.value = true;
        try {
          const res = await fetch('/api/agents/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {})
          });
          const data = await readJsonResponse(res, '에이전트 생성');
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '에이전트 생성 실패';
          } else {
            lastError.value = '';
            applyRosterPayload(data);
          }
        } finally {
          rosterLoading.value = false;
        }
        break;
      }
      case 'REMOVE_AGENT': {
        rosterLoading.value = true;
        try {
          const res = await fetch('/api/agents/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: payload && payload.agentId })
          });
          const data = await readJsonResponse(res, '에이전트 제거');
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '에이전트 제거 실패';
          } else {
            lastError.value = '';
            applyRosterPayload(data);
          }
        } finally {
          rosterLoading.value = false;
        }
        break;
      }
      case 'CLOSE_MODAL': {
        activeModal.value = null;
        break;
      }
      case 'GENERATE_HANDOVER': {
        const targetAgent = (payload && payload.agentId) || selectedAgentId.value;
        const convId = (payload && payload.convId) || (selectedAgent.value && selectedAgent.value.convId);
        if (!convId) {
          lastError.value = `${targetAgent}에 연결된 CLI 세션이 없습니다.`;
          break;
        }
        handoverLoading.value = true;
        try {
          const res = await fetch('/api/handover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: targetAgent, convId })
          });
          const data = await readJsonResponse(res, '인수인계서 생성');
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '인수인계서 생성 실패';
          } else {
            handoverResult.value = data;
            activeModal.value = 'handover';
          }
        } finally {
          handoverLoading.value = false;
        }
        break;
      }
      case 'UPDATE_WORKSPACE': {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetWorkspace: payload && payload.targetWorkspace })
        });
        const data = await readJsonResponse(res, '작업 경로 변경');
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '작업 경로 변경 실패';
        } else {
          applyRosterPayload(data);
        }
        break;
      }
      case 'SEND_PROMPT': {
        const reqBody = payload || {};
        const targetAgentId = reqBody.agentId || selectedAgentId.value;
        const cmdEcho = buildCliCommandEcho(reqBody);
        appendRawStreamLog(targetAgentId, `❯ ${cmdEcho}`);
        submittingByAgent.value = { ...submittingByAgent.value, [targetAgentId]: true };
        streamingResponseByAgent.value = {
          ...streamingResponseByAgent.value,
          [targetAgentId]: {
            convId: reqBody.createNew ? null : (reqBody.convId || null),
            prompt: reqBody.prompt || '',
            commandLine: cmdEcho,
            text: '',
            stepType: 'init',
            state: 'RUNNING',
            usage: null,
            error: null
          }
        };

        try {
          const res = await fetch('/api/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody)
          });
          const data = await readJsonResponse(res, '프롬프트 실행');
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '프롬프트 실행 실패';
            const next = { ...streamingResponseByAgent.value };
            delete next[targetAgentId];
            streamingResponseByAgent.value = next;
          }
        } catch (e) {
          lastError.value = e.message || '프롬프트 실행 중 오류 발생';
          const next = { ...streamingResponseByAgent.value };
          delete next[targetAgentId];
          streamingResponseByAgent.value = next;
        } finally {
          submittingByAgent.value = { ...submittingByAgent.value, [targetAgentId]: false };
        }
        break;
      }
      case 'STOP_PROMPT': {
        const targetAgentId = (payload && payload.agentId) || selectedAgentId.value;
        const targetConvId = (payload && payload.convId) || (agents.value[targetAgentId] && agents.value[targetAgentId].convId) || null;
        const res = await fetch('/api/prompt/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: targetAgentId, convId: targetConvId })
        });
        const data = await readJsonResponse(res, '작업 중단');
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '작업 중단 실패';
        } else {
          appendRawStreamLog(targetAgentId, '[CLI 중단] 사용자 요청으로 프로세스를 종료했습니다.');
          const next = { ...streamingResponseByAgent.value };
          delete next[targetAgentId];
          streamingResponseByAgent.value = next;
          submittingByAgent.value = { ...submittingByAgent.value, [targetAgentId]: false };
        }
        break;
      }
      case 'OPEN_FILE_PREVIEW': {
        const cleanHref = String((payload && payload.path) || '').trim();
        if (!cleanHref) break;
        const convId = String((payload && payload.convId) || (selectedAgent.value && selectedAgent.value.convId) || '').trim();
        const fallbackName = cleanHref.split(/[\\/]/).pop().split('#')[0] || '문서 미리보기';
        filePreview.value = {
          open: true,
          loading: true,
          name: fallbackName,
          path: '',
          content: '',
          isMarkdown: /\.(md|markdown)(#.*)?$/i.test(cleanHref),
          error: ''
        };
        try {
          const res = await fetch(
            `/api/file?path=${encodeURIComponent(cleanHref)}&convId=${encodeURIComponent(convId)}`
          );
          const data = await readJsonResponse(res, '문서 미리보기');
          if (!res.ok || !data.ok) {
            filePreview.value = {
              ...filePreview.value,
              loading: false,
              error: (data && data.error) || `문서를 불러오지 못했습니다 (HTTP ${res.status}).`
            };
          } else {
            const resolvedName = data.name || fallbackName;
            filePreview.value = {
              open: true,
              loading: false,
              name: resolvedName,
              path: data.path || cleanHref,
              content: data.content || '',
              isMarkdown: /\.(md|markdown)$/i.test(resolvedName),
              error: ''
            };
          }
        } catch (err) {
          filePreview.value = {
            ...filePreview.value,
            loading: false,
            error: (err && err.message) || '문서 조회 중 네트워크 오류가 발생했습니다.'
          };
        }
        break;
      }
      case 'CLOSE_FILE_PREVIEW': {
        filePreview.value = createEmptyFilePreview();
        break;
      }
      default:
        break;
      }
    } catch (e) {
      lastError.value = e.message || '요청 처리 중 오류 발생';
    }
  }

  return {
    bridgeConnected,
    bridgeVersion,
    bridgeOutdated,
    activeProvider,
    providers,
    providersLoading,
    providerSwitchingId,
    showProviderSelector,
    providerCapabilities,
    accountInfo,
    targetWorkspace,
    workspaceMode,
    rulesDir,
    candidateProjects,
    cliBrainDir,
    agents,
    allAgents,
    activeAgentIds,
    rosterLoading,
    officeAgents,
    sessions,
    manualMapping,
    tokenSummary,
    models,
    selectedAgentId,
    selectedAgent,
    hoveredAgentId,
    packets,
    pipelineStats,
    activeSessionMessages,
    activeSessionUsage,
    messagesLoading,
    activeStream,
    activeRawStreamLogs,
    submittingByAgent,
    promptPrefs,
    activeModal,
    handoverResult,
    handoverLoading,
    lastError,
    errorExplainMode,
    errorExplanations,
    filePreview,
    fetchInitialData,
    connectStream,
    disconnectStream,
    dispatchAction
  };
});
