const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  readJsonSafe,
  isValidConvId,
  createEmptyTokenUsage,
  localDateKey
} = require('./transcript');
const {
  PROVIDER_ORDER,
  isValidProviderId,
  getProvider,
  listProvidersSummary
} = require('./providers');
const {
  DEFAULT_RULES_DIR,
  isValidAgentId,
  resolveWorkspaceAgentsSync,
  resolveWorkspaceAgents,
  updateWorkspaceRulesDir,
  saveWorkspaceRoster,
  createWorkspaceAgent,
  removeWorkspaceAgent
} = require('./agentRegistry');

// 기본 포트 3110 사용 (포트 충돌 방지)
const PORT = Number(process.env.OFFICE_PORT || 3110);
const HOST = process.env.OFFICE_HOST || '127.0.0.1';
const BRIDGE_VERSION = '2026-11-25-cli-v4';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const STATE_FILE = path.join(PROJECT_ROOT, 'office_state.json');
const MAPPING_FILE = path.join(PROJECT_ROOT, 'office_mapping.json');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'office_config.json');

const POLL_INTERVAL_MS = 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const sseClients = new Set();
const runtimeByProvider = new Map();
for (const pid of PROVIDER_ORDER) {
  runtimeByProvider.set(pid, {
    sessionCache: new Map(),
    runningJobs: new Map(),
    finishedJobs: new Map(),
    abortedSessions: new Map()
  });
}

let activeProviderId = readInitialProviderId();
let cachedSnapshot = null;
let workspaceRoster = {
  targetWorkspace: '',
  workspaceMode: 'single-project',
  rulesDir: DEFAULT_RULES_DIR,
  candidateProjects: [],
  allAgents: [],
  activeAgentIds: ['Master'],
  activeAgents: [{ id: 'Master', name: 'Master', role: '팀 총괄 / PM', source: 'preset', isLead: true, domainPath: `${DEFAULT_RULES_DIR}/Master/RULE.md` }]
};

/**
 * 설정 파일에서 마지막 선택된 AI 프로바이더 ID 복원
 * @author Jangsung
 * @return {String}
 */
function readInitialProviderId() {
  const saved = readJsonSafe(CONFIG_FILE, {});
  if (saved && isValidProviderId(saved.activeProvider)) {
    return saved.activeProvider;
  }
  return 'antigravity';
}

/**
 * 프로바이더별 격리된 런타임 상태(세션 캐시, 실행 중/완료 작업) 조회
 * @author Jangsung
 * @param {String} providerId
 * @return {Object}
 */
function getRuntime(providerId = activeProviderId) {
  const pid = isValidProviderId(providerId) ? providerId : 'antigravity';
  return runtimeByProvider.get(pid);
}

/**
 * 현재 활성 프로바이더 어댑터 조회
 * @author Jangsung
 * @return {Object}
 */
function getActiveProvider() {
  return getProvider(activeProviderId);
}

/**
 * 프로바이더별 세션 매핑 파일 경로 조회 (antigravity는 기존 office_mapping.json 호환 유지)
 * @author Jangsung
 * @param {String} providerId
 * @return {String}
 */
function getMappingFile(providerId = activeProviderId) {
  return providerId === 'antigravity'
    ? MAPPING_FILE
    : path.join(PROJECT_ROOT, `office_mapping.${providerId}.json`);
}

/**
 * 프로바이더별 명시 상태 파일 경로 조회
 * @author Jangsung
 * @param {String} providerId
 * @return {String}
 */
function getStateFile(providerId = activeProviderId) {
  return providerId === 'antigravity'
    ? STATE_FILE
    : path.join(PROJECT_ROOT, `office_state.${providerId}.json`);
}

/**
 * 프로바이더별 세션 정리/보관/별칭 메타 파일 경로 조회
 * @author Jangsung
 * @param {String} providerId
 * @return {String}
 */
function getSessionMetaFile(providerId = activeProviderId) {
  return providerId === 'antigravity'
    ? path.join(PROJECT_ROOT, 'office_sessions_meta.json')
    : path.join(PROJECT_ROOT, `office_sessions_meta.${providerId}.json`);
}

/**
 * 프로바이더 전환 및 office_config.json 반영
 * @author Jangsung
 * @param {String} nextProviderId
 * @return {String}
 */
function setActiveProvider(nextProviderId) {
  if (!isValidProviderId(nextProviderId)) {
    throw new Error('지원하지 않는 AI 프로바이더입니다: ' + nextProviderId);
  }
  activeProviderId = nextProviderId;
  const saved = readJsonSafe(CONFIG_FILE, {});
  saved.activeProvider = nextProviderId;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2), 'utf8');
  return nextProviderId;
}

/**
 * 현재 활성 프로바이더 기준 로스터 탐색 옵션 생성
 * @author Jangsung
 * @param {Object} provider
 * @return {Object}
 */
function getRosterOpts(provider = getActiveProvider()) {
  const caps = provider.getCapabilities();
  return {
    includeCliAgents: caps.supportsCliAgents !== false,
    historyIndex: typeof provider.readHistoryIndex === 'function' ? provider.readHistoryIndex() : null
  };
}

/**
 * 현재 대상 작업 경로의 전체/활성 에이전트 로스터 갱신
 * @author Jangsung
 * @param {Boolean} forceCli
 * @return {Promise<Object>}
 */
async function refreshWorkspaceRoster(forceCli = false) {
  const ws = getTargetWorkspace();
  workspaceRoster = await resolveWorkspaceAgents(CONFIG_FILE, ws, forceCli, getRosterOpts());
  return workspaceRoster;
}

/**
 * 제어 대상 작업 경로(targetWorkspace) 조회
 * @author Jangsung
 * @return {String}
 */
function getTargetWorkspace() {
  const saved = readJsonSafe(CONFIG_FILE, {});
  if (saved && typeof saved.targetWorkspace === 'string' && saved.targetWorkspace.trim()) {
    return saved.targetWorkspace.trim();
  }
  return process.env.TARGET_WORKSPACE || process.cwd();
}

/**
 * 제어 대상 작업 경로(targetWorkspace) 검증 후 저장
 * @author Jangsung
 * @param {String} nextPath
 * @return {String}
 */
function setTargetWorkspace(nextPath) {
  const clean = typeof nextPath === 'string' ? nextPath.trim() : '';
  if (!clean) throw new Error('작업 경로가 비어 있습니다.');
  const resolved = path.resolve(clean);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    throw new Error('존재하지 않는 경로입니다: ' + resolved);
  }
  if (!stat.isDirectory()) {
    throw new Error('디렉터리가 아닙니다: ' + resolved);
  }
  const saved = readJsonSafe(CONFIG_FILE, {});
  saved.targetWorkspace = resolved;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2), 'utf8');
  return resolved;
}

/**
 * 특정 에이전트(하위 프로젝트 포함)의 실제 실행 작업 경로 해석
 * @author Jangsung
 * @param {String} agentId
 * @return {String}
 */
function resolveAgentWorkspace(agentId) {
  const list = (workspaceRoster.activeAgents || []).concat(workspaceRoster.allAgents || []);
  const def = list.find(a => a && a.id === agentId);
  if (def && def.workspacePath && fs.existsSync(def.workspacePath)) {
    return def.workspacePath;
  }
  return getTargetWorkspace();
}

/**
 * 세션 중단 시 명시적 상태 파일(office_state*.json)의 RUNNING/WORKING 잔재를 즉시 중단 상태로 전환
 * @author Jangsung
 * @param {String} providerId
 * @param {String} agentId
 */
function syncAbortedExplicitState(providerId, agentId) {
  const stateFile = getStateFile(providerId);
  if (!fs.existsSync(stateFile)) return;
  const data = readJsonSafe(stateFile, null);
  if (!data || !data.agents || !data.agents[agentId]) return;
  const prev = data.agents[agentId];
  const logs = Array.isArray(prev.logs) ? prev.logs.slice(-29) : [];
  logs.push({
    time: new Date().toTimeString().slice(0, 8),
    message: '[상태 해제] 사용자 요청으로 실행 대기 상태를 해제했습니다.',
    level: 'warn'
  });
  data.agents[agentId] = {
    ...prev,
    state: 'BLOCKED',
    bubbleText: '사용자 요청으로 실행 중단됨',
    updatedAt: new Date().toISOString(),
    logs
  };
  try {
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * 활성 AI 프로바이더 기준 세션 스캔 결과와 실행 중/완료 작업, 수동 상태를 병합한 스냅샷 생성
 * @author Jangsung
 * @param {String} providerId
 * @return {Object}
 */
function buildSnapshot(providerId = activeProviderId) {
  const provider = getProvider(providerId);
  const caps = provider.getCapabilities();
  const runtime = getRuntime(provider.id);
  const manualMapping = readJsonSafe(getMappingFile(provider.id), {});
  const sessionMetaMap = readJsonSafe(getSessionMetaFile(provider.id), {});
  const explicitStateFile = readJsonSafe(getStateFile(provider.id), {});
  const explicitAgents = explicitStateFile.agents || {};
  const activeAgents = Array.isArray(workspaceRoster.activeAgents) && workspaceRoster.activeAgents.length > 0
    ? workspaceRoster.activeAgents
    : [{ id: 'Master', name: 'Master', role: '팀 총괄 / PM', source: 'preset', isLead: true, domainPath: `${DEFAULT_RULES_DIR}/Master/RULE.md` }];
  const detectedSessions = provider.scanSessions(runtime.sessionCache, manualMapping, activeAgents);

  const runningByConvId = new Map();
  for (const rJob of runtime.runningJobs.values()) {
    if (rJob && rJob.convId) {
      runningByConvId.set(rJob.convId, rJob);
    }
  }

  const nowMs = Date.now();
  // 세션별 중단 이력이 유효한 경우 동적 워커를 포함한 모든 감지 세션의 RUNNING 잔재를 최우선 차단
  for (const s of detectedSessions) {
    const abFin = runtime.abortedSessions.get(s.convId);
    if (abFin && (nowMs - abFin.endedAtMs < 30 * 60 * 1000)) {
      const abAnchor = abFin.endedAtMs + 5000;
      if (abAnchor >= s.mtimeMs && (s.state === 'WORKING' || s.state === 'PLANNING')) {
        const abAgeSec = (nowMs - abFin.endedAtMs) / 1000;
        s.state = abAgeSec <= 45 ? 'BLOCKED' : 'IDLE';
        s.bubbleText = abAgeSec <= 45 ? '사용자 요청으로 실행 중단됨' : '대기 중 (이전 실행 중단됨)';
      }
    }
    const rJob = runningByConvId.get(s.convId);
    if (rJob) {
      s.state = 'WORKING';
      s.bubbleText = `[${rJob.modelId}] 실행 중...`;
    }
  }

  const manualConvByAgent = new Map();
  for (const [cId, aId] of Object.entries(manualMapping || {})) {
    if (aId && aId !== 'NONE' && isValidConvId(cId)) {
      manualConvByAgent.set(aId, cId);
    }
  }

  const agentMap = {};
  for (const agentDef of activeAgents) {
    const id = agentDef.id;
    const exp = explicitAgents[id];
    const expUpdatedMs = exp && exp.updatedAt ? new Date(exp.updatedAt).getTime() : 0;
    const expFresh = Boolean(expUpdatedMs && (nowMs - expUpdatedMs < 10 * 60 * 1000));
    const manualConvId = manualConvByAgent.get(id) || null;
    const isArchivedSession = convId => Boolean(convId && sessionMetaMap[convId] && sessionMetaMap[convId].archived);
    const matchedSession = manualConvId
      ? (detectedSessions.find(s => s.convId === manualConvId) || null)
      : (detectedSessions.find(s => s.role === id && !isArchivedSession(s.convId)) || null);
    const cliJob = runtime.runningJobs.get(id) || null;
    const targetConvId = (matchedSession && matchedSession.convId) || manualConvId || null;

    const rawFin = runtime.finishedJobs.get(id) || null;
    const rawFinFresh = Boolean(rawFin && (nowMs - rawFin.endedAtMs < 30 * 60 * 1000));
    // 수동 매핑으로 다른 세션을 지정한 경우 이전 세션의 finishedJobs가 새 매핑 세션을 가로채지 않도록 세션 일치 여부 확인
    const rawFinMatchesTarget = !manualConvId || (rawFin && rawFin.convId === manualConvId);
    const abortedSessionFin = targetConvId ? (runtime.abortedSessions.get(targetConvId) || null) : null;
    const abortedSessionFresh = Boolean(abortedSessionFin && (nowMs - abortedSessionFin.endedAtMs < 30 * 60 * 1000));

    const fin = (rawFinFresh && rawFinMatchesTarget)
      ? rawFin
      : (abortedSessionFresh ? abortedSessionFin : null);
    const finFresh = Boolean(fin);
    // 사용자가 명시적으로 중단(fin.aborted)한 경우, 강제 종료 직전 기록된 세션 로그의 RUNNING 잔재를 덮어씀
    const finTimestampAnchor = fin && fin.aborted ? fin.endedAtMs + 5000 : (fin ? fin.endedAtMs : 0);
    const finNewerThanSession = finFresh && (!matchedSession || finTimestampAnchor >= matchedSession.mtimeMs);
    const finAgeSec = finFresh ? (nowMs - fin.endedAtMs) / 1000 : Infinity;
    const expOverriddenByAbort = Boolean(finNewerThanSession && fin && fin.aborted && fin.endedAtMs >= expUpdatedMs);
    const resolvedCliConvId = (cliJob && cliJob.convId)
      || (matchedSession && matchedSession.convId)
      || (finFresh && fin.convId)
      || manualConvId
      || null;

    const buildActiveStreamMeta = job => {
      if (!job) return null;
      return {
        convId: job.convId || null,
        prompt: job.prompt,
        modelId: job.modelId,
        effort: job.effort,
        mode: job.mode,
        startedAt: job.startedAt,
        text: job.streamText || '',
        stepType: job.activeTool || '',
        usage: job.usage || null,
        rawLogs: Array.isArray(job.rawStreamLogs) ? job.rawStreamLogs.slice(-120) : []
      };
    };

    const baseMeta = {
      name: agentDef.name || id,
      role: agentDef.role || '실무 에이전트',
      agentSource: agentDef.source || 'preset',
      isLead: Boolean(agentDef.isLead),
      domainPath: agentDef.domainPath || `${workspaceRoster.rulesDir}/${id}/RULE.md`,
      workspacePath: agentDef.workspacePath || getTargetWorkspace()
    };

    if (expFresh && !expOverriddenByAbort) {
      agentMap[id] = {
        id,
        ...baseMeta,
        source: path.basename(getStateFile(provider.id)),
        convId: (cliJob && cliJob.convId) || (matchedSession ? matchedSession.convId : null),
        convOrigin: provider.id,
        cliConvId: resolvedCliConvId,
        state: cliJob ? 'WORKING' : (exp.state || 'WORKING'),
        bubbleText: cliJob ? `[${cliJob.modelId}] 실행 중...` : (exp.bubbleText || '작업 중'),
        currentTask: exp.currentTask || '-',
        currentTaskSummary: exp.currentTaskSummary || exp.currentTask || '-',
        currentTaskRaw: exp.currentTaskRaw || exp.currentTask || '-',
        currentTool: cliJob ? `${caps.cliCommand} (${cliJob.mode})` : (exp.currentTool || '-'),
        fileSizeMB: matchedSession ? matchedSession.fileSizeMB : 0,
        lastStepIndex: matchedSession ? matchedSession.lastStepIndex : 0,
        tokenUsage: matchedSession && matchedSession.tokenUsage ? matchedSession.tokenUsage : null,
        lastActiveIso: exp.updatedAt,
        cliRunning: Boolean(cliJob),
        cliModel: cliJob ? cliJob.modelId : null,
        cliEffort: cliJob ? cliJob.effort : null,
        cliMode: cliJob ? cliJob.mode : null,
        activeStream: buildActiveStreamMeta(cliJob),
        logs: Array.isArray(exp.logs) ? exp.logs : (matchedSession ? matchedSession.logs : [])
      };
    } else if (cliJob) {
      const baseLogs = matchedSession ? matchedSession.logs : [];
      agentMap[id] = {
        id,
        ...baseMeta,
        source: matchedSession ? `session+${provider.id}` : `${provider.id}-cli`,
        convId: cliJob.convId || (matchedSession ? matchedSession.convId : null),
        convOrigin: provider.id,
        cliConvId: resolvedCliConvId,
        state: 'WORKING',
        bubbleText: `[${cliJob.modelId}] ${cliJob.prompt.slice(0, 18)}`,
        currentTask: cliJob.prompt.slice(0, 72),
        currentTaskSummary: cliJob.prompt,
        currentTaskRaw: cliJob.prompt,
        currentTool: `${caps.cliCommand} (${cliJob.modelId}, ${cliJob.mode})`,
        fileSizeMB: matchedSession ? matchedSession.fileSizeMB : 0,
        lastStepIndex: matchedSession ? matchedSession.lastStepIndex : 0,
        tokenUsage: matchedSession && matchedSession.tokenUsage ? matchedSession.tokenUsage : null,
        lastActiveIso: cliJob.startedAt,
        cliRunning: true,
        cliModel: cliJob.modelId,
        cliEffort: cliJob.effort,
        cliMode: cliJob.mode,
        activeStream: buildActiveStreamMeta(cliJob),
        logs: baseLogs.concat(cliJob.logs).slice(-35)
      };
    } else if (finNewerThanSession) {
      const cliDoneState = fin.aborted
        ? (finAgeSec <= 45 ? 'BLOCKED' : 'IDLE')
        : (finAgeSec <= 180 ? (fin.exitCode === 0 ? 'DONE' : 'IDLE') : 'IDLE');
      const cliBubble = fin.aborted
        ? (finAgeSec <= 45 ? '사용자 요청으로 실행 중단됨' : '대기 중 (이전 실행 중단됨)')
        : (finAgeSec <= 180
            ? (fin.exitCode === 0 ? `완료: ${fin.responsePreview || 'CLI 응답 완료'}` : `CLI 오류 (exit=${fin.exitCode})`)
            : `대기 (최근 CLI: ${fin.prompt.slice(0, 16)})`);
      const baseLogs = matchedSession ? matchedSession.logs : [];
      agentMap[id] = {
        id,
        ...baseMeta,
        source: `${provider.id}-cli`,
        convId: fin.convId || (matchedSession ? matchedSession.convId : null),
        convOrigin: provider.id,
        cliConvId: resolvedCliConvId,
        state: cliDoneState,
        bubbleText: cliBubble,
        currentTask: fin.prompt.slice(0, 72),
        currentTaskSummary: fin.prompt,
        currentTaskRaw: fin.prompt,
        currentTool: `${caps.cliCommand} (${fin.modelId}, ${fin.mode})`,
        fileSizeMB: matchedSession ? matchedSession.fileSizeMB : 0,
        lastStepIndex: matchedSession ? matchedSession.lastStepIndex : 0,
        tokenUsage: matchedSession && matchedSession.tokenUsage ? matchedSession.tokenUsage : null,
        lastActiveIso: fin.endedAt,
        cliRunning: false,
        cliModel: fin.modelId,
        cliEffort: fin.effort,
        cliMode: fin.mode,
        activeStream: null,
        logs: baseLogs.concat(fin.logs).slice(-35)
      };
    } else if (matchedSession) {
      agentMap[id] = {
        id,
        ...baseMeta,
        source: matchedSession.origin === 'codex' ? 'codex-session' : 'transcript.jsonl',
        convId: matchedSession.convId,
        convOrigin: matchedSession.origin || provider.id,
        cliConvId: resolvedCliConvId,
        state: matchedSession.state,
        bubbleText: matchedSession.bubbleText,
        currentTask: matchedSession.currentTask,
        currentTaskSummary: matchedSession.currentTaskSummary,
        currentTaskRaw: matchedSession.currentTaskRaw,
        currentTool: matchedSession.currentTool,
        fileSizeMB: matchedSession.fileSizeMB,
        lastStepIndex: matchedSession.lastStepIndex,
        tokenUsage: matchedSession.tokenUsage || null,
        lastActiveIso: matchedSession.lastActiveIso,
        cliRunning: false,
        cliModel: null,
        cliEffort: null,
        cliMode: null,
        activeStream: null,
        logs: matchedSession.logs
      };
    } else {
      agentMap[id] = {
        id,
        ...baseMeta,
        source: 'none',
        convId: null,
        convOrigin: null,
        cliConvId: resolvedCliConvId,
        state: 'IDLE',
        bubbleText: `대기 중 (연결된 ${caps.name} 세션 없음)`,
        currentTask: '-',
        currentTaskSummary: '-',
        currentTaskRaw: '-',
        currentTool: '-',
        fileSizeMB: 0,
        lastStepIndex: 0,
        tokenUsage: null,
        lastActiveIso: null,
        cliRunning: false,
        cliModel: null,
        cliEffort: null,
        cliMode: null,
        activeStream: null,
        logs: []
      };
    }
  }

  const sessionList = detectedSessions.slice(0, 80).map(s => {
    const meta = sessionMetaMap[s.convId] || {};
    const rJob = runningByConvId.get(s.convId) || null;
    const isWorking = s.state === 'WORKING' || s.state === 'PLANNING' || Boolean(rJob);
    const u = s.tokenUsage || createEmptyTokenUsage();
    const startedAtIso = s.startedAtIso || u.startedAtIso || s.lastActiveIso || null;
    const durationMs = Number(s.durationMs || u.durationMs || 0);
    return {
      convId: s.convId,
      origin: s.origin || provider.id,
      role: s.role,
      workspacePath: s.workspacePath || null,
      state: s.state,
      isWorking,
      isManagedRunning: Boolean(rJob),
      runningAgentId: rJob ? rJob.agentId : null,
      pid: rJob ? rJob.pid : null,
      archived: Boolean(meta.archived),
      alias: typeof meta.alias === 'string' ? meta.alias : '',
      archivedAt: meta.archivedAt || null,
      ageSec: s.ageSec,
      fileSizeMB: s.fileSizeMB,
      lastStepIndex: s.lastStepIndex,
      startedAtIso,
      lastActiveIso: s.lastActiveIso,
      durationMs,
      titlePreview: s.titlePreview,
      currentTool: s.currentTool,
      tokenUsage: {
        ...u,
        startedAtIso,
        lastActiveIso: s.lastActiveIso,
        durationMs
      }
    };
  });

  const todayKey = localDateKey(nowMs);
  const cutoff7dKey = localDateKey(nowMs - 6 * 24 * 60 * 60 * 1000);
  const cutoff30dKey = localDateKey(nowMs - 29 * 24 * 60 * 60 * 1000);
  let minPeriodMs = Infinity;
  let maxPeriodMs = 0;

  const tokenSummary = {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    todayDateKey: todayKey,
    todayTokens: 0,
    last7dTokens: 0,
    last30dTokens: 0,
    periodStartIso: null,
    periodEndIso: null,
    durationMs: 0,
    activeSessionCount: 0,
    archivedSessionCount: 0,
    workingSessionCount: 0,
    totalSessionCount: sessionList.length
  };
  for (const s of sessionList) {
    if (s.archived) {
      tokenSummary.archivedSessionCount += 1;
    } else {
      tokenSummary.activeSessionCount += 1;
    }
    if (s.isWorking) {
      tokenSummary.workingSessionCount += 1;
    }
    const u = s.tokenUsage;
    if (u) {
      tokenSummary.inputTokens += Number(u.inputTokens) || 0;
      tokenSummary.cacheReadTokens += Number(u.cacheReadTokens) || 0;
      tokenSummary.outputTokens += Number(u.outputTokens) || 0;
      tokenSummary.reasoningTokens += Number(u.reasoningTokens) || 0;
      tokenSummary.totalTokens += Number(u.totalTokens) || 0;

      if (u.totalTokens > 0) {
        const sMs = s.startedAtIso ? new Date(s.startedAtIso).getTime() : NaN;
        const eMs = s.lastActiveIso ? new Date(s.lastActiveIso).getTime() : NaN;
        if (Number.isFinite(sMs) && sMs < minPeriodMs) minPeriodMs = sMs;
        if (Number.isFinite(eMs) && eMs > maxPeriodMs) maxPeriodMs = eMs;
      }

      if (u.byDate && typeof u.byDate === 'object') {
        for (const [dKey, dBucket] of Object.entries(u.byDate)) {
          const dt = Number(dBucket && dBucket.totalTokens) || 0;
          if (dKey === todayKey) tokenSummary.todayTokens += dt;
          if (cutoff7dKey && dKey >= cutoff7dKey) tokenSummary.last7dTokens += dt;
          if (cutoff30dKey && dKey >= cutoff30dKey) tokenSummary.last30dTokens += dt;
        }
      }
    }
  }
  if (Number.isFinite(minPeriodMs) && maxPeriodMs > 0) {
    tokenSummary.periodStartIso = new Date(minPeriodMs).toISOString();
    tokenSummary.periodEndIso = new Date(maxPeriodMs).toISOString();
    tokenSummary.durationMs = Math.max(0, maxPeriodMs - minPeriodMs);
  }

  return {
    timestamp: new Date().toISOString(),
    bridgeConnected: true,
    bridgeVersion: BRIDGE_VERSION,
    providerId: provider.id,
    providerLabel: caps.label,
    cliCommand: caps.cliCommand,
    cliLabel: caps.cliLabel,
    capabilities: caps,
    targetWorkspace: getTargetWorkspace(),
    workspaceMode: workspaceRoster.workspaceMode || 'single-project',
    rulesDir: workspaceRoster.rulesDir,
    allAgentsCount: workspaceRoster.allAgents.length,
    activeAgentIds: activeAgents.map(a => a.id),
    cliBrainDir: caps.sessionStoreDir,
    sessionStoreDir: caps.sessionStoreDir,
    tokenSummary,
    agents: agentMap,
    sessions: sessionList,
    manualMapping
  };
}

/**
 * SSE 이벤트 브로드캐스트
 * @author Jangsung
 * @param {String} eventName
 * @param {Object} data
 */
function broadcastSseEvent(eventName, data) {
  if (sseClients.size === 0) return;
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

/**
 * 상태 스냅샷 변동 시 전체 SSE 클라이언트에 송출
 * @author Jangsung
 */
function broadcastSnapshot() {
  const next = buildSnapshot();
  const prevStr = cachedSnapshot ? JSON.stringify({ ...cachedSnapshot, timestamp: '' }) : '';
  const currCmpStr = JSON.stringify({ ...next, timestamp: '' });

  cachedSnapshot = next;
  if (prevStr === currCmpStr) return;

  broadcastSseEvent('state', next);
}

/**
 * JSON 요청 바디 파싱 (최대 1MB)
 * @author Jangsung
 * @param {http.IncomingMessage} req
 * @return {Promise<Object>}
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * JSON 응답 헬퍼
 * @author Jangsung
 * @param {http.ServerResponse} res
 * @param {Number} statusCode
 * @param {Object} payload
 */
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * 프로덕션 빌드 결과(dist/) 정적 파일 서빙
 * @author Jangsung
 * @param {String} urlPath
 * @param {http.ServerResponse} res
 * @return {Boolean}
 */
function tryServeDist(urlPath, res) {
  if (!fs.existsSync(DIST_DIR)) return false;
  const cleanRel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(DIST_DIR, cleanRel);
  if (!resolved.startsWith(DIST_DIR)) return false;

  let targetFile = resolved;
  if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
    targetFile = path.join(DIST_DIR, 'index.html');
  }
  if (!fs.existsSync(targetFile)) return false;

  const ext = path.extname(targetFile).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(targetFile).pipe(res);
  return true;
}

/**
 * convId 기준으로 실행 중 프로세스 종료 및 세션 중단 마커 기록 (관리 프로세스/외부 세션 공용)
 * @author Jangsung
 * @param {Object} provider
 * @param {Object} runtime
 * @param {String} convId
 * @param {String|null} fallbackAgentId
 * @return {Object}
 */
function terminateSessionByConvId(provider, runtime, convId, fallbackAgentId = null) {
  let matchedJob = null;
  for (const job of runtime.runningJobs.values()) {
    if (job && (job.convId === convId || (fallbackAgentId && job.agentId === fallbackAgentId))) {
      matchedJob = job;
      break;
    }
  }

  const manualMapping = readJsonSafe(getMappingFile(provider.id), {});
  const mappedAgentId = (matchedJob && matchedJob.agentId)
    || (convId && manualMapping[convId] && manualMapping[convId] !== 'NONE' ? manualMapping[convId] : null)
    || fallbackAgentId
    || null;

  if (matchedJob) {
    provider.stopJob(
      matchedJob.agentId,
      runtime.runningJobs,
      runtime.finishedJobs,
      (eventName, payload) => {
        broadcastSseEvent(eventName, { ...payload, providerId: provider.id });
      },
      { convId: convId || matchedJob.convId || null, abortedSessions: runtime.abortedSessions }
    );
    syncAbortedExplicitState(provider.id, matchedJob.agentId);
    return { killedManagedProcess: true, agentId: matchedJob.agentId, pid: matchedJob.pid || null };
  }

  const nowMs = Date.now();
  const markerJob = {
    agentId: mappedAgentId || convId,
    convId,
    modelId: '-',
    mode: '-',
    prompt: '사용자 요청으로 세션 종료됨',
    aborted: true,
    exitCode: -1,
    endedAtMs: nowMs,
    endedAt: new Date(nowMs).toISOString(),
    logs: [{ time: new Date(nowMs).toTimeString().slice(0, 8), message: '[세션 종료] 사용자 요청으로 작업 상태를 종료했습니다.', level: 'warn' }]
  };
  if (convId) {
    runtime.abortedSessions.set(convId, markerJob);
  }
  if (mappedAgentId) {
    runtime.finishedJobs.set(mappedAgentId, markerJob);
    syncAbortedExplicitState(provider.id, mappedAgentId);
  }
  return { killedManagedProcess: false, agentId: mappedAgentId, pid: null };
}

/**
 * 지정된 convId 목록의 세션을 안전하게 영구 삭제하고 매핑·메타·캐시 정리
 * @author Jangsung
 * @param {Object} provider
 * @param {Object} runtime
 * @param {Array<String>} convIds
 * @return {Array<String>}
 */
function deleteSessionsByIds(provider, runtime, convIds) {
  const mappingFile = getMappingFile(provider.id);
  const metaFile = getSessionMetaFile(provider.id);
  const mapping = readJsonSafe(mappingFile, {});
  const metaMap = readJsonSafe(metaFile, {});
  const deletedIds = [];

  for (const rawId of convIds) {
    const convId = typeof rawId === 'string' ? rawId.trim() : '';
    if (!isValidConvId(convId)) {
      throw new Error('유효하지 않은 convId 형식입니다: ' + convId);
    }
    terminateSessionByConvId(provider, runtime, convId, mapping[convId] || null);
    if (typeof provider.deleteSession === 'function') {
      provider.deleteSession(convId);
    }
    delete mapping[convId];
    delete metaMap[convId];
    runtime.sessionCache.delete(convId);
    runtime.abortedSessions.delete(convId);
    deletedIds.push(convId);
  }

  fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');
  fs.writeFileSync(metaFile, JSON.stringify(metaMap, null, 2), 'utf8');
  return deletedIds;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const urlPath = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 0. AI 프로바이더 카탈로그 및 활성 백엔드 전환
  if (req.method === 'GET' && urlPath === '/api/providers') {
    try {
      const providers = await listProvidersSummary(id => getRuntime(id));
      sendJson(res, 200, {
        ok: true,
        activeProvider: activeProviderId,
        targetWorkspace: getTargetWorkspace(),
        providers
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/provider') {
    try {
      const body = await readRequestBody(req);
      const nextId = setActiveProvider(body.providerId);
      const provider = getActiveProvider();
      await refreshWorkspaceRoster(false);
      const models = await provider.getModels(false);
      const snap = buildSnapshot(nextId);
      cachedSnapshot = snap;
      broadcastSseEvent('state', snap);
      sendJson(res, 200, {
        ok: true,
        activeProvider: nextId,
        capabilities: provider.getCapabilities(),
        models,
        state: snap
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 1. 현재 상태 스냅샷 조회
  if (req.method === 'GET' && urlPath === '/api/state') {
    const snap = buildSnapshot();
    cachedSnapshot = snap;
    sendJson(res, 200, snap);
    return;
  }

  // 2. SSE 실시간 스트림 (state + chat_delta + chat_result)
  if (req.method === 'GET' && urlPath === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    sseClients.add(res);
    const initial = buildSnapshot();
    cachedSnapshot = initial;
    res.write(`event: state\ndata: ${JSON.stringify(initial)}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 3. 특정 세션의 대화 스레드 조회 (활성 프로바이더 기준)
  const msgMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'GET' && msgMatch) {
    try {
      const convId = decodeURIComponent(msgMatch[1]);
      if (!isValidConvId(convId)) {
        sendJson(res, 400, { ok: false, error: '유효하지 않은 convId 형식입니다.' });
        return;
      }
      const limit = Number(parsedUrl.searchParams.get('limit') || 150);
      const provider = getActiveProvider();
      const result = provider.readSessionMessages(convId, limit);
      sendJson(res, 200, { ok: true, providerId: provider.id, ...result });
    } catch (e) {
      sendJson(res, 404, { ok: false, error: e.message });
    }
    return;
  }

  // 3-1. 세션 메타데이터(보관/정리, 별칭) 단건 또는 일괄 수정
  if (req.method === 'POST' && urlPath === '/api/sessions/meta') {
    try {
      const body = await readRequestBody(req);
      const provider = getActiveProvider();
      const metaFile = getSessionMetaFile(provider.id);
      const mappingFile = getMappingFile(provider.id);
      const metaMap = readJsonSafe(metaFile, {});
      const mapping = readJsonSafe(mappingFile, {});
      let mappingChanged = false;

      const targetIds = Array.isArray(body.convIds)
        ? body.convIds
        : (body.convId ? [body.convId] : []);
      if (targetIds.length === 0) {
        throw new Error('대상 convId가 지정되지 않았습니다.');
      }

      const nowIso = new Date().toISOString();
      for (const rawId of targetIds) {
        const cid = typeof rawId === 'string' ? rawId.trim() : '';
        if (!isValidConvId(cid)) {
          throw new Error('유효하지 않은 convId 형식입니다: ' + cid);
        }
        const prev = metaMap[cid] || {};
        const next = {
          alias: body.alias !== undefined ? String(body.alias || '').trim().slice(0, 60) : (prev.alias || ''),
          archived: body.archived !== undefined ? Boolean(body.archived) : Boolean(prev.archived),
          archivedAt: body.archived !== undefined
            ? (body.archived ? nowIso : null)
            : (prev.archivedAt || null),
          updatedAt: nowIso
        };
        metaMap[cid] = next;

        if (next.archived && mapping[cid]) {
          delete mapping[cid];
          mappingChanged = true;
        }
      }

      fs.writeFileSync(metaFile, JSON.stringify(metaMap, null, 2), 'utf8');
      if (mappingChanged) {
        fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');
      }
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, providerId: provider.id, meta: metaMap });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 3-2. 작업 중인 세션 즉시 종료 (관리 프로세스 kill 및 RUNNING 잔재 해제)
  if (req.method === 'POST' && urlPath === '/api/sessions/terminate') {
    try {
      const body = await readRequestBody(req);
      const convId = typeof body.convId === 'string' ? body.convId.trim() : '';
      if (!isValidConvId(convId)) {
        throw new Error('유효하지 않은 convId 형식입니다.');
      }
      const provider = getActiveProvider();
      const runtime = getRuntime(provider.id);
      const fallbackAgentId = typeof body.agentId === 'string' && isValidAgentId(body.agentId) ? body.agentId : null;
      const result = terminateSessionByConvId(provider, runtime, convId, fallbackAgentId);
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, providerId: provider.id, convId, ...result });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 3-3. 세션 영구 삭제 (단건 DELETE /api/sessions/:convId 및 일괄 POST /api/sessions/delete)
  const delMatch = urlPath.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'DELETE' && delMatch) {
    try {
      const convId = decodeURIComponent(delMatch[1]);
      if (!isValidConvId(convId)) {
        sendJson(res, 400, { ok: false, error: '유효하지 않은 convId 형식입니다.' });
        return;
      }
      const provider = getActiveProvider();
      const runtime = getRuntime(provider.id);
      const deletedIds = deleteSessionsByIds(provider, runtime, [convId]);
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, providerId: provider.id, deletedIds });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/sessions/delete') {
    try {
      const body = await readRequestBody(req);
      const rawIds = Array.isArray(body.convIds) ? body.convIds : (body.convId ? [body.convId] : []);
      if (rawIds.length === 0) {
        throw new Error('삭제할 convId가 지정되지 않았습니다.');
      }
      const provider = getActiveProvider();
      const runtime = getRuntime(provider.id);
      const deletedIds = deleteSessionsByIds(provider, runtime, rawIds);
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, providerId: provider.id, deletedIds });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 4. 작업 대상 경로(TARGET_WORKSPACE) 및 활성 프로바이더 설정 조회/변경
  if (req.method === 'GET' && urlPath === '/api/config') {
    const provider = getActiveProvider();
    const caps = provider.getCapabilities();
    sendJson(res, 200, {
      ok: true,
      providerId: provider.id,
      capabilities: caps,
      targetWorkspace: getTargetWorkspace(),
      cliBrainDir: caps.sessionStoreDir,
      sessionStoreDir: caps.sessionStoreDir,
      allowedModes: caps.modes.map(m => m.id),
      allowedEfforts: caps.efforts.map(e => e.id)
    });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/config') {
    try {
      const body = await readRequestBody(req);
      const updated = setTargetWorkspace(body.targetWorkspace);
      await refreshWorkspaceRoster(false);
      broadcastSnapshot();
      sendJson(res, 200, {
        ok: true,
        targetWorkspace: updated,
        workspaceMode: workspaceRoster.workspaceMode || 'single-project',
        rulesDir: workspaceRoster.rulesDir,
        candidateProjects: workspaceRoster.candidateProjects || [],
        allAgents: workspaceRoster.allAgents,
        activeAgentIds: workspaceRoster.activeAgentIds
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 4-1. 전체 에이전트 카탈로그 및 활성 팀원 조회
  if (req.method === 'GET' && urlPath === '/api/agents') {
    try {
      const refresh = parsedUrl.searchParams.get('refresh') === '1';
      const data = await refreshWorkspaceRoster(refresh);
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 4-1b. 단일 프로젝트 규칙 하위 경로 변경 및 즉시 재스캔
  if (req.method === 'POST' && urlPath === '/api/agents/scan') {
    try {
      const body = await readRequestBody(req);
      const ws = getTargetWorkspace();
      workspaceRoster = await updateWorkspaceRulesDir(CONFIG_FILE, ws, body.rulesDir, getRosterOpts());
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, ...workspaceRoster });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 4-2. 현재 프로젝트에서 함께 일할 팀원(로스터) 저장
  if (req.method === 'POST' && urlPath === '/api/agents/roster') {
    try {
      const body = await readRequestBody(req);
      const ws = getTargetWorkspace();
      workspaceRoster = await saveWorkspaceRoster(CONFIG_FILE, ws, {
        activeAgentIds: body.activeAgentIds,
        rulesDir: body.rulesDir
      }, getRosterOpts());
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, ...workspaceRoster });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 4-3. 새 에이전트 생성 또는 프로젝트 연결
  if (req.method === 'POST' && urlPath === '/api/agents/create') {
    try {
      const body = await readRequestBody(req);
      const ws = getTargetWorkspace();
      workspaceRoster = await createWorkspaceAgent(CONFIG_FILE, ws, body, getRosterOpts());
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, ...workspaceRoster });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 4-4. CUSTOM 에이전트 등록 해제 (실제 파일/폴더는 삭제하지 않음)
  if (req.method === 'POST' && urlPath === '/api/agents/remove') {
    try {
      const body = await readRequestBody(req);
      const ws = getTargetWorkspace();
      workspaceRoster = await removeWorkspaceAgent(CONFIG_FILE, ws, body.agentId || body.id, getRosterOpts());
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, ...workspaceRoster });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 5. 사용 가능한 모델 목록 조회
  if (req.method === 'GET' && urlPath === '/api/models') {
    const refresh = parsedUrl.searchParams.get('refresh') === '1';
    const provider = getActiveProvider();
    const models = await provider.getModels(refresh);
    sendJson(res, 200, { ok: true, providerId: provider.id, models });
    return;
  }

  // 6. 수동 세션 <-> 에이전트 매핑 저장 (프로바이더별 파일 격리)
  if (req.method === 'POST' && urlPath === '/api/mapping') {
    try {
      const body = await readRequestBody(req);
      const { agentId, convId } = body;
      const runtime = getRuntime();
      const mappingFile = getMappingFile();
      const mapping = readJsonSafe(mappingFile, {});

      for (const k of Object.keys(mapping)) {
        if (mapping[k] === agentId) delete mapping[k];
      }
      if (convId && agentId) {
        if (!isValidConvId(convId)) throw new Error('유효하지 않은 convId 형식입니다.');
        mapping[convId] = agentId;
      }

      // 다른 세션으로 매핑 전환 시 이전 세션의 finishedJobs가 새 세션을 덮어쓰지 않도록 분리 (중단된 원 세션 보호는 abortedSessions에 유지)
      const prevFin = agentId ? runtime.finishedJobs.get(agentId) : null;
      if (prevFin && (!prevFin.convId || prevFin.convId !== (convId || null))) {
        if (prevFin.aborted && prevFin.convId) {
          runtime.abortedSessions.set(prevFin.convId, prevFin);
        }
        runtime.finishedJobs.delete(agentId);
      }

      fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, providerId: activeProviderId, mapping });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 7. 명시적 에이전트 상태 업데이트 (프로바이더별 상태 파일 격리)
  if (req.method === 'POST' && urlPath === '/api/agent/state') {
    try {
      const body = await readRequestBody(req);
      const { agentId, state, bubbleText, currentTask, currentTool, logMessage } = body;
      if (!isValidAgentId(agentId)) {
        throw new Error('유효하지 않은 agentId: ' + agentId);
      }

      const stateFile = getStateFile();
      const data = readJsonSafe(stateFile, { agents: {} });
      if (!data.agents) data.agents = {};
      const prev = data.agents[agentId] || { logs: [] };
      const logs = Array.isArray(prev.logs) ? prev.logs : [];
      if (logMessage) {
        logs.push({ time: new Date().toTimeString().slice(0, 8), message: logMessage, level: 'info' });
        if (logs.length > 30) logs.shift();
      }

      data.agents[agentId] = {
        state: state || prev.state || 'WORKING',
        bubbleText: bubbleText || prev.bubbleText || '작업 중',
        currentTask: currentTask || prev.currentTask || '-',
        currentTool: currentTool || prev.currentTool || '-',
        updatedAt: new Date().toISOString(),
        logs
      };

      fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');
      broadcastSnapshot();
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 8. 세션 표준 인수인계서 생성 (활성 프로바이더 기준)
  if (req.method === 'POST' && urlPath === '/api/handover') {
    try {
      const body = await readRequestBody(req);
      const { agentId, convId } = body;
      if (!isValidAgentId(agentId)) {
        throw new Error('유효하지 않은 agentId: ' + agentId);
      }
      const provider = getActiveProvider();
      const snap = cachedSnapshot || buildSnapshot(provider.id);
      const agentSnap = snap.agents[agentId];
      const targetConvId = convId || (agentSnap && agentSnap.convId);
      if (!targetConvId) {
        throw new Error(`${agentId}에 연결된 CLI 세션이 없습니다.`);
      }
      const result = provider.generateHandover({
        agentId,
        convId: targetConvId,
        targetWorkspace: resolveAgentWorkspace(agentId),
        rulesDir: workspaceRoster.rulesDir,
        domainPath: (agentSnap && agentSnap.domainPath) || '',
        fallbackBaseDir: PROJECT_ROOT
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 9. CLI 프롬프트 실행 (활성 프로바이더 어댑터로 위임)
  if (req.method === 'POST' && urlPath === '/api/prompt') {
    try {
      const body = await readRequestBody(req);
      const { agentId, convId, modelId, effort, mode, prompt, createNew } = body;

      if (!isValidAgentId(agentId)) {
        sendJson(res, 400, { ok: false, error: '유효하지 않은 agentId: ' + agentId });
        return;
      }

      const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
      if (!cleanPrompt) {
        sendJson(res, 400, { ok: false, error: '프롬프트 내용이 비어 있습니다.' });
        return;
      }

      const provider = getActiveProvider();
      const jobProviderId = provider.id;
      const runtime = getRuntime(jobProviderId);
      const mappingFile = getMappingFile(jobProviderId);
      const normalized = provider.normalizePromptOptions({ modelId, effort, mode });

      // 모델 variant 매칭을 위해 캐시가 비어 있으면 사전에 모델 목록 1회 로드
      await provider.getModels(false);

      const snap = (cachedSnapshot && cachedSnapshot.providerId === jobProviderId)
        ? cachedSnapshot
        : buildSnapshot(jobProviderId);
      const agentSnap = snap.agents[agentId];
      if (runtime.runningJobs.has(agentId)) {
        sendJson(res, 409, { ok: false, error: `${agentId}에서 이미 프롬프트 작업이 실행 중입니다.` });
        return;
      }
      if (!createNew && agentSnap && (agentSnap.state === 'WORKING' || agentSnap.state === 'PLANNING')) {
        sendJson(res, 409, { ok: false, error: `${agentId} 세션이 현재 작업 중(${agentSnap.state})입니다. 완료 후 전달하세요.` });
        return;
      }

      const requestedConvId = !createNew ? (convId || (agentSnap && agentSnap.convId) || '') : '';
      let targetConvId = '';
      if (requestedConvId) {
        if (!isValidConvId(requestedConvId)) {
          sendJson(res, 400, { ok: false, error: '유효하지 않은 convId 형식입니다.' });
          return;
        }
        if (provider.findSessionExists(requestedConvId)) {
          targetConvId = requestedConvId;
        }
      }

      runtime.finishedJobs.delete(agentId);
      if (targetConvId) {
        runtime.abortedSessions.delete(targetConvId);
      }

      const job = provider.startPromptJob({
        agentId,
        convId: targetConvId,
        modelId: normalized.modelId,
        effort: normalized.effort,
        mode: normalized.mode,
        prompt: cleanPrompt,
        cwd: resolveAgentWorkspace(agentId),
        mappingFile,
        runningJobs: runtime.runningJobs,
        finishedJobs: runtime.finishedJobs,
        onStateChange: () => {
          if (activeProviderId === jobProviderId) {
            broadcastSnapshot();
          }
        },
        onStreamEvent: (eventName, payload) => {
          broadcastSseEvent(eventName, { ...payload, providerId: jobProviderId });
        }
      });

      broadcastSnapshot();
      sendJson(res, 200, {
        ok: true,
        providerId: jobProviderId,
        agentId,
        pid: job.pid,
        modelId: job.modelId,
        effort: job.effort,
        mode: job.mode,
        convId: targetConvId || null,
        cwd: job.cwd
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 10. 실행 중인 CLI 프롬프트 작업 중단 (어떤 상태·매핑에서도 최우선 즉시 중단 보장)
  if (req.method === 'POST' && urlPath === '/api/prompt/stop') {
    try {
      const body = await readRequestBody(req);
      const { agentId, convId } = body;
      if (!isValidAgentId(agentId)) {
        sendJson(res, 400, { ok: false, error: '유효하지 않은 agentId: ' + agentId });
        return;
      }
      const provider = getActiveProvider();
      const runtime = getRuntime(provider.id);
      const reqConvId = typeof convId === 'string' && isValidConvId(convId) ? convId : null;
      const curSnap = (cachedSnapshot && cachedSnapshot.providerId === provider.id)
        ? cachedSnapshot
        : buildSnapshot(provider.id);
      const activeConvId = reqConvId
        || (curSnap.agents[agentId] && curSnap.agents[agentId].convId)
        || null;

      provider.stopJob(
        agentId,
        runtime.runningJobs,
        runtime.finishedJobs,
        (eventName, payload) => {
          broadcastSseEvent(eventName, { ...payload, providerId: provider.id });
        },
        { convId: activeConvId, abortedSessions: runtime.abortedSessions }
      );
      syncAbortedExplicitState(provider.id, agentId);
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, providerId: provider.id, agentId, convId: activeConvId });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 11. 안전 종료
  if (req.method === 'POST' && urlPath === '/api/shutdown') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // 12. 알 수 없는 /api/* 요청은 HTML 폴백 대신 JSON 404 반환
  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    sendJson(res, 404, { ok: false, error: `지원하지 않는 API 경로입니다: ${req.method} ${urlPath}` });
    return;
  }

  // 13. 프로덕션 빌드(dist/) 정적 서빙
  if (req.method === 'GET' && tryServeDist(urlPath, res)) {
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const pollTimer = setInterval(broadcastSnapshot, POLL_INTERVAL_MS);
const rosterTimer = setInterval(() => {
  refreshWorkspaceRoster(false).catch(() => {});
}, 30000);

server.on('error', err => {
  clearInterval(pollTimer);
  clearInterval(rosterTimer);
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[agent-office-cli bridge] 포트 ${HOST}:${PORT}가 이미 사용 중입니다. OFFICE_PORT 환경 변수로 다른 포트를 지정하세요.`);
  } else {
    console.error(`[agent-office-cli bridge] 서버 오류: ${err && err.message ? err.message : err}`);
  }
  process.exit(1);
});

// 서버 포트를 즉시 개방하기 위해 초기 로스터는 동기 스캔으로 채우고 CLI 전역 에이전트는 백그라운드에서 보강함
try {
  workspaceRoster = resolveWorkspaceAgentsSync(CONFIG_FILE, getTargetWorkspace(), getRosterOpts());
} catch (_) {}

server.listen(PORT, HOST, () => {
  const initProvider = getActiveProvider();
  const initCaps = initProvider.getCapabilities();
  console.log(`[agent-office-cli bridge] 실행: http://${HOST}:${PORT}`);
  console.log(`[활성 프로바이더] ${initProvider.id} (${initCaps.label})`);
  console.log(`[세션 저장소] ${initCaps.sessionStoreDir}`);
  console.log(`[작업 대상 경로] ${getTargetWorkspace()} (팀원 ${workspaceRoster.activeAgents.length}명)`);
  refreshWorkspaceRoster(false)
    .then(() => broadcastSnapshot())
    .catch(() => {});
});
