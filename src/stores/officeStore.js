import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { assignAgentSeats, resolveDynamicWorkers, isLoungeState } from '@/constants/officeLayout';

const STORAGE_MODEL_KEY = 'agent_office_cli_model';
const STORAGE_EFFORT_KEY = 'agent_office_cli_effort';
const STORAGE_MODE_KEY = 'agent_office_cli_mode';

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Antigravity CLI 가상 오피스 중앙 상태 및 단방향 액션 스토어
 * 모든 하위 UI 컴포넌트는 dispatchAction({ type, payload }) 단일 진입점으로만 상태를 변경함
 * @author Jangsung
 */
export const useOfficeStore = defineStore('office', () => {
  const bridgeConnected = ref(false);
  const bridgeVersion = ref('-');
  const targetWorkspace = ref('');
  const rulesDir = ref('Rules/Personal');
  const cliBrainDir = ref('');
  const agents = ref({});
  const allAgents = ref([]);
  const activeAgentIds = ref(['Master']);
  const sessions = ref([]);
  const manualMapping = ref({});
  const models = ref([]);
  const rosterLoading = ref(false);

  const selectedAgentId = ref('Master');
  const hoveredAgentId = ref(null);
  const meetingActive = ref(false);
  const packets = ref([]);

  const activeSessionMessages = ref([]);
  const messagesLoading = ref(false);
  const streamingResponseByAgent = ref({});
  const rawStreamLogsByAgent = ref({});
  const submittingByAgent = ref({});
  const promptPrefs = ref({
    modelId: readPref(STORAGE_MODEL_KEY, 'gemini-4-hydrogen-high'),
    effort: readPref(STORAGE_EFFORT_KEY, 'auto'),
    mode: readPref(STORAGE_MODE_KEY, 'plan'),
    createNewSession: false
  });
  const activeModal = ref(null);
  const handoverResult = ref(null);
  const handoverLoading = ref(false);
  const lastError = ref('');

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

    const baseList = assignAgentSeats(baseMap, meetingActive.value);

    const dynamicWorkers = resolveDynamicWorkers(sessions.value, assignedConvIds).map(w => {
      const pos = meetingActive.value
        ? w.meetingSeat
        : (isLoungeState(w.state) ? w.lounge : w.desk);
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
    const activeCount = base.filter(a => a.state === 'WORKING' || a.state === 'PLANNING' || a.state === 'REVIEW').length;
    const doneCount = base.filter(a => a.state === 'DONE').length;
    return {
      total: base.length,
      activeCount,
      doneCount,
      progressPct: base.length > 0 ? Math.round(((activeCount * 0.5 + doneCount) / base.length) * 100) : 0
    };
  });

  /**
   * CLI 실행 명령어 미리보기 문자열 조합 (터미널 에코 표출용)
   * @author Jangsung
   * @param {Object} params
   * @return {String}
   */
  function buildCliCommandEcho({ modelId, effort, mode, convId, prompt }) {
    const parts = ['agy'];
    if (modelId) parts.push(`--model ${modelId}`);
    if (effort) parts.push(`--effort ${effort}`);
    if (mode) parts.push(`--mode ${mode}`);
    parts.push('--output-format stream-json');
    if (convId) parts.push(`--conversation ${convId.slice(0, 8)}`);
    const singleLine = String(prompt || '').replace(/\s+/g, ' ').trim();
    const shortPrompt = singleLine.length > 48 ? `${singleLine.slice(0, 48)}...` : singleLine;
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
   * 초기 스냅샷 및 모델 목록 로드
   * @author Jangsung
   */
  async function fetchInitialData() {
    try {
      const [stateRes, modelsRes, agentsRes] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/models'),
        fetch('/api/agents')
      ]);
      if (stateRes.ok) {
        const snap = await stateRes.json();
        applySnapshot(snap);
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        if (data.ok && Array.isArray(data.models)) {
          models.value = data.models;
        }
      }
      if (agentsRes.ok) {
        const agData = await agentsRes.json();
        if (agData.ok) {
          allAgents.value = Array.isArray(agData.allAgents) ? agData.allAgents : [];
          activeAgentIds.value = Array.isArray(agData.activeAgentIds) ? agData.activeAgentIds : ['Master'];
          if (agData.rulesDir) rulesDir.value = agData.rulesDir;
        }
      }
    } catch (e) {
      lastError.value = e.message || '브리지 초기 데이터 조회 실패';
    }
  }

  /**
   * 서버 스냅샷 반영, 상태 전이 패킷 및 진행 중 스트림 복구
   * @author Jangsung
   * @param {Object} snap
   */
  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    const prevAgents = agents.value || {};
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

      // 새로고침 등으로 클라이언트에 스트림 상태가 비어 있을 때 서버 실행 중 버퍼 복구
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
        // 서버에서 CLI 실행이 종료(cliRunning === false)되었는데 클라이언트에 잔여 스트림이 남지 않도록 즉시 해제
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
    cliBrainDir.value = snap.cliBrainDir || '';
    agents.value = nextAgents;
    sessions.value = Array.isArray(snap.sessions) ? snap.sessions : [];
    manualMapping.value = snap.manualMapping || {};
    streamingResponseByAgent.value = nextStreamMap;
    rawStreamLogsByAgent.value = nextRawMap;

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
        if (data.rawLine) {
          appendRawStreamLog(data.agentId, data.rawLine);
        }
        if (data.error) {
          lastError.value = data.error;
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
   * 선택된 CLI 세션의 대화 스레드 조회
   * @author Jangsung
   * @param {String} convId
   */
  async function loadSessionMessages(convId) {
    if (!convId) {
      activeSessionMessages.value = [];
      return;
    }
    messagesLoading.value = true;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(convId)}/messages`);
      const data = await res.json();
      if (res.ok && data.ok) {
        activeSessionMessages.value = data.messages || [];
      } else {
        activeSessionMessages.value = [];
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

    switch (type) {
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
      case 'CALL_ALL_MEETING': {
        meetingActive.value = !meetingActive.value;
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
        const data = await res.json();
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
        const data = await res.json();
        if (data.ok && Array.isArray(data.models)) {
          models.value = data.models;
        }
        break;
      }
      case 'SET_PROMPT_PREF': {
        const next = { ...promptPrefs.value, ...(payload || {}) };
        promptPrefs.value = next;
        try {
          if (payload && payload.modelId !== undefined) localStorage.setItem(STORAGE_MODEL_KEY, next.modelId);
          if (payload && payload.effort !== undefined) localStorage.setItem(STORAGE_EFFORT_KEY, next.effort);
          if (payload && payload.mode !== undefined) localStorage.setItem(STORAGE_MODE_KEY, next.mode);
        } catch (_) {}
        break;
      }
      case 'OPEN_MODEL_GUIDE': {
        activeModal.value = 'modelGuide';
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
          const data = await res.json();
          if (res.ok && data.ok) {
            allAgents.value = Array.isArray(data.allAgents) ? data.allAgents : [];
            activeAgentIds.value = Array.isArray(data.activeAgentIds) ? data.activeAgentIds : [];
            if (data.rulesDir) rulesDir.value = data.rulesDir;
          } else {
            lastError.value = data.error || '에이전트 목록 조회 실패';
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
          const data = await res.json();
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '팀원 저장 실패';
          } else {
            allAgents.value = data.allAgents || [];
            activeAgentIds.value = data.activeAgentIds || [];
            if (data.rulesDir) rulesDir.value = data.rulesDir;
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
          const data = await res.json();
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '에이전트 생성 실패';
          } else {
            allAgents.value = data.allAgents || [];
            activeAgentIds.value = data.activeAgentIds || [];
            if (data.rulesDir) rulesDir.value = data.rulesDir;
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
          const data = await res.json();
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
        const data = await res.json();
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '작업 경로 변경 실패';
        } else {
          if (Array.isArray(data.allAgents)) allAgents.value = data.allAgents;
          if (Array.isArray(data.activeAgentIds)) activeAgentIds.value = data.activeAgentIds;
          if (data.rulesDir) rulesDir.value = data.rulesDir;
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
          const data = await res.json();
          if (!res.ok || !data.ok) {
            lastError.value = data.error || '프롬프트 실행 실패';
            const next = { ...streamingResponseByAgent.value };
            delete next[targetAgentId];
            streamingResponseByAgent.value = next;
          }
        } finally {
          submittingByAgent.value = { ...submittingByAgent.value, [targetAgentId]: false };
        }
        break;
      }
      case 'STOP_PROMPT': {
        const targetAgentId = (payload && payload.agentId) || selectedAgentId.value;
        const res = await fetch('/api/prompt/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: targetAgentId })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          lastError.value = data.error || '작업 중단 실패';
        } else {
          appendRawStreamLog(targetAgentId, '[CLI 중단] 사용자 요청으로 프로세스를 종료했습니다.');
          const next = { ...streamingResponseByAgent.value };
          delete next[targetAgentId];
          streamingResponseByAgent.value = next;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    bridgeConnected,
    bridgeVersion,
    targetWorkspace,
    rulesDir,
    cliBrainDir,
    agents,
    allAgents,
    activeAgentIds,
    rosterLoading,
    officeAgents,
    sessions,
    manualMapping,
    models,
    selectedAgentId,
    selectedAgent,
    hoveredAgentId,
    meetingActive,
    packets,
    pipelineStats,
    activeSessionMessages,
    messagesLoading,
    activeStream,
    activeRawStreamLogs,
    submittingByAgent,
    promptPrefs,
    activeModal,
    handoverResult,
    handoverLoading,
    lastError,
    fetchInitialData,
    connectStream,
    disconnectStream,
    dispatchAction
  };
});
