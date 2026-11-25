const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  getCliBrainDir,
  readJsonSafe,
  isValidConvId,
  findCliTranscriptPath,
  scanCliSessions,
  readSessionMessages,
  generateHandoverDocument
} = require('./transcript');
const {
  ALLOWED_MODES,
  ALLOWED_EFFORTS,
  getAvailableModels,
  startAgyPromptJob,
  stopAgyJob
} = require('./agyRunner');
const {
  isValidAgentId,
  resolveWorkspaceAgentsSync,
  resolveWorkspaceAgents,
  saveWorkspaceRoster,
  createWorkspaceAgent
} = require('./agentRegistry');

// 기존 dcim 가상 오피스 브리지(3100)와 동시 실행 시 충돌을 피하기 위해 기본 포트 3110 사용
const PORT = Number(process.env.OFFICE_PORT || 3110);
const HOST = process.env.OFFICE_HOST || '127.0.0.1';
const BRIDGE_VERSION = '2026-11-25-cli-v2';
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
const sessionCache = new Map();
const runningJobs = new Map();
const finishedJobs = new Map();
let cachedSnapshot = null;
let workspaceRoster = {
  targetWorkspace: '',
  rulesDir: 'Rules/Personal',
  allAgents: [],
  activeAgentIds: ['Master'],
  activeAgents: [{ id: 'Master', name: 'Master', role: '팀 총괄 / PM', source: 'preset', isLead: true, domainPath: 'Rules/Personal/Master/RULE.md' }]
};

/**
 * 현재 대상 작업 경로의 전체/활성 에이전트 로스터 갱신
 * @author Jangsung
 * @param {Boolean} forceCli
 * @return {Promise<Object>}
 */
async function refreshWorkspaceRoster(forceCli = false) {
  const ws = getTargetWorkspace();
  workspaceRoster = await resolveWorkspaceAgents(CONFIG_FILE, ws, forceCli);
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
  return process.env.TARGET_WORKSPACE || 'e:\\github\\dcim';
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
 * CLI brain 스캔 결과와 실행 중/완료 작업, 수동 상태를 병합한 스냅샷 생성
 * @author Jangsung
 * @return {Object}
 */
function buildSnapshot() {
  const manualMapping = readJsonSafe(MAPPING_FILE, {});
  const explicitStateFile = readJsonSafe(STATE_FILE, {});
  const explicitAgents = explicitStateFile.agents || {};
  const activeAgents = Array.isArray(workspaceRoster.activeAgents) && workspaceRoster.activeAgents.length > 0
    ? workspaceRoster.activeAgents
    : [{ id: 'Master', name: 'Master', role: '팀 총괄 / PM', source: 'preset', isLead: true, domainPath: 'Rules/Personal/Master/RULE.md' }];
  const detectedSessions = scanCliSessions(sessionCache, manualMapping, activeAgents);

  const agentMap = {};
  for (const agentDef of activeAgents) {
    const id = agentDef.id;
    const exp = explicitAgents[id];
    const expFresh = exp && exp.updatedAt && (Date.now() - new Date(exp.updatedAt).getTime() < 10 * 60 * 1000);
    const matchedSession = detectedSessions.find(s => s.role === id);
    const cliJob = runningJobs.get(id) || null;
    const fin = finishedJobs.get(id) || null;
    const finFresh = fin && (Date.now() - fin.endedAtMs < 30 * 60 * 1000);
    // 사용자가 명시적으로 중단(fin.aborted)한 경우, 강제 종료 직전 기록된 transcript의 RUNNING 잔재를 덮어씀
    const finTimestampAnchor = fin && fin.aborted ? fin.endedAtMs + 5000 : (fin ? fin.endedAtMs : 0);
    const finNewerThanSession = finFresh && (!matchedSession || finTimestampAnchor >= matchedSession.mtimeMs);
    const finAgeSec = finFresh ? (Date.now() - fin.endedAtMs) / 1000 : Infinity;
    const resolvedCliConvId = (cliJob && cliJob.convId)
      || (matchedSession && matchedSession.convId)
      || (finFresh && fin.convId)
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
      domainPath: agentDef.domainPath || `${workspaceRoster.rulesDir}/${id}/RULE.md`
    };

    if (expFresh) {
      agentMap[id] = {
        id,
        ...baseMeta,
        source: 'office_state.json',
        convId: (cliJob && cliJob.convId) || (matchedSession ? matchedSession.convId : null),
        convOrigin: 'cli',
        cliConvId: resolvedCliConvId,
        state: cliJob ? 'WORKING' : (exp.state || 'WORKING'),
        bubbleText: cliJob ? `[${cliJob.modelId}] 실행 중...` : (exp.bubbleText || '작업 중'),
        currentTask: exp.currentTask || '-',
        currentTaskSummary: exp.currentTaskSummary || exp.currentTask || '-',
        currentTaskRaw: exp.currentTaskRaw || exp.currentTask || '-',
        currentTool: cliJob ? `agy (${cliJob.mode})` : (exp.currentTool || '-'),
        fileSizeMB: matchedSession ? matchedSession.fileSizeMB : 0,
        lastStepIndex: matchedSession ? matchedSession.lastStepIndex : 0,
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
        source: matchedSession ? 'transcript.jsonl+cli' : 'agy-cli',
        convId: cliJob.convId || (matchedSession ? matchedSession.convId : null),
        convOrigin: 'cli',
        cliConvId: resolvedCliConvId,
        state: 'WORKING',
        bubbleText: `[${cliJob.modelId}] ${cliJob.prompt.slice(0, 18)}`,
        currentTask: cliJob.prompt.slice(0, 72),
        currentTaskSummary: cliJob.prompt,
        currentTaskRaw: cliJob.prompt,
        currentTool: `agy (${cliJob.modelId}, ${cliJob.mode})`,
        fileSizeMB: matchedSession ? matchedSession.fileSizeMB : 0,
        lastStepIndex: matchedSession ? matchedSession.lastStepIndex : 0,
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
        source: 'agy-cli',
        convId: fin.convId || (matchedSession ? matchedSession.convId : null),
        convOrigin: 'cli',
        cliConvId: resolvedCliConvId,
        state: cliDoneState,
        bubbleText: cliBubble,
        currentTask: fin.prompt.slice(0, 72),
        currentTaskSummary: fin.prompt,
        currentTaskRaw: fin.prompt,
        currentTool: `agy (${fin.modelId}, ${fin.mode})`,
        fileSizeMB: matchedSession ? matchedSession.fileSizeMB : 0,
        lastStepIndex: matchedSession ? matchedSession.lastStepIndex : 0,
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
        source: 'transcript.jsonl',
        convId: matchedSession.convId,
        convOrigin: 'cli',
        cliConvId: resolvedCliConvId,
        state: matchedSession.state,
        bubbleText: matchedSession.bubbleText,
        currentTask: matchedSession.currentTask,
        currentTaskSummary: matchedSession.currentTaskSummary,
        currentTaskRaw: matchedSession.currentTaskRaw,
        currentTool: matchedSession.currentTool,
        fileSizeMB: matchedSession.fileSizeMB,
        lastStepIndex: matchedSession.lastStepIndex,
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
        bubbleText: '대기 중 (연결된 CLI 세션 없음)',
        currentTask: '-',
        currentTaskSummary: '-',
        currentTaskRaw: '-',
        currentTool: '-',
        fileSizeMB: 0,
        lastStepIndex: 0,
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

  return {
    timestamp: new Date().toISOString(),
    bridgeConnected: true,
    bridgeVersion: BRIDGE_VERSION,
    targetWorkspace: getTargetWorkspace(),
    rulesDir: workspaceRoster.rulesDir,
    allAgentsCount: workspaceRoster.allAgents.length,
    activeAgentIds: activeAgents.map(a => a.id),
    cliBrainDir: getCliBrainDir(),
    agents: agentMap,
    sessions: detectedSessions.slice(0, 20).map(s => ({
      convId: s.convId,
      origin: 'cli',
      role: s.role,
      state: s.state,
      ageSec: s.ageSec,
      fileSizeMB: s.fileSizeMB,
      lastStepIndex: s.lastStepIndex,
      lastActiveIso: s.lastActiveIso,
      titlePreview: s.titlePreview,
      currentTool: s.currentTool
    })),
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

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const urlPath = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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

  // 3. 특정 CLI 세션의 대화 스레드 조회
  const msgMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'GET' && msgMatch) {
    try {
      const convId = decodeURIComponent(msgMatch[1]);
      if (!isValidConvId(convId)) {
        sendJson(res, 400, { ok: false, error: '유효하지 않은 convId 형식입니다.' });
        return;
      }
      const limit = Number(parsedUrl.searchParams.get('limit') || 150);
      const result = readSessionMessages(convId, limit);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 404, { ok: false, error: e.message });
    }
    return;
  }

  // 4. 작업 대상 경로(TARGET_WORKSPACE) 설정 조회/변경
  if (req.method === 'GET' && urlPath === '/api/config') {
    sendJson(res, 200, {
      ok: true,
      targetWorkspace: getTargetWorkspace(),
      cliBrainDir: getCliBrainDir(),
      allowedModes: ALLOWED_MODES,
      allowedEfforts: ALLOWED_EFFORTS
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
        rulesDir: workspaceRoster.rulesDir,
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

  // 4-2. 현재 프로젝트에서 함께 일할 팀원(로스터) 저장
  if (req.method === 'POST' && urlPath === '/api/agents/roster') {
    try {
      const body = await readRequestBody(req);
      const ws = getTargetWorkspace();
      workspaceRoster = await saveWorkspaceRoster(CONFIG_FILE, ws, {
        activeAgentIds: body.activeAgentIds,
        rulesDir: body.rulesDir
      });
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, ...workspaceRoster });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 4-3. 새 에이전트 생성 (필요 시 대상 프로젝트 Rules/<rulesDir>/<id>/RULE.md 생성)
  if (req.method === 'POST' && urlPath === '/api/agents/create') {
    try {
      const body = await readRequestBody(req);
      const ws = getTargetWorkspace();
      workspaceRoster = await createWorkspaceAgent(CONFIG_FILE, ws, body);
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
    const models = await getAvailableModels(refresh);
    sendJson(res, 200, { ok: true, models });
    return;
  }

  // 6. 수동 세션 <-> 에이전트 매핑 저장
  if (req.method === 'POST' && urlPath === '/api/mapping') {
    try {
      const body = await readRequestBody(req);
      const { agentId, convId } = body;
      const mapping = readJsonSafe(MAPPING_FILE, {});

      for (const k of Object.keys(mapping)) {
        if (mapping[k] === agentId) delete mapping[k];
      }
      if (convId && agentId) {
        if (!isValidConvId(convId)) throw new Error('유효하지 않은 convId 형식입니다.');
        mapping[convId] = agentId;
      }

      fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8');
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, mapping });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 7. 명시적 에이전트 상태 업데이트
  if (req.method === 'POST' && urlPath === '/api/agent/state') {
    try {
      const body = await readRequestBody(req);
      const { agentId, state, bubbleText, currentTask, currentTool, logMessage } = body;
      if (!isValidAgentId(agentId)) {
        throw new Error('유효하지 않은 agentId: ' + agentId);
      }

      const data = readJsonSafe(STATE_FILE, { agents: {} });
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

      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
      broadcastSnapshot();
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 8. 세션 표준 인수인계서 생성
  if (req.method === 'POST' && urlPath === '/api/handover') {
    try {
      const body = await readRequestBody(req);
      const { agentId, convId } = body;
      if (!isValidAgentId(agentId)) {
        throw new Error('유효하지 않은 agentId: ' + agentId);
      }
      const snap = cachedSnapshot || buildSnapshot();
      const agentSnap = snap.agents[agentId];
      const targetConvId = convId || (agentSnap && agentSnap.convId);
      if (!targetConvId) {
        throw new Error(`${agentId}에 연결된 CLI 세션이 없습니다.`);
      }
      const result = generateHandoverDocument({
        agentId,
        convId: targetConvId,
        targetWorkspace: getTargetWorkspace(),
        rulesDir: workspaceRoster.rulesDir,
        fallbackBaseDir: PROJECT_ROOT
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // 9. CLI 프롬프트 실행 (stream-json 실시간 스트리밍 포함)
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

      const safeMode = ALLOWED_MODES.includes(mode) ? mode : 'plan';
      const safeEffort = ALLOWED_EFFORTS.includes(effort) ? effort : 'auto';
      const safeModel = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : 'gemini-4-hydrogen-high';
      if (!/^[a-zA-Z0-9._-]+$/.test(safeModel)) {
        sendJson(res, 400, { ok: false, error: '유효하지 않은 modelId 형식입니다.' });
        return;
      }

      // 모델 variant 매칭을 위해 캐시가 비어 있으면 사전에 모델 목록 1회 로드
      await getAvailableModels(false);

      const snap = cachedSnapshot || buildSnapshot();
      const agentSnap = snap.agents[agentId];
      if (runningJobs.has(agentId)) {
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
        if (findCliTranscriptPath(requestedConvId)) {
          targetConvId = requestedConvId;
        }
      }

      const job = startAgyPromptJob({
        agentId,
        convId: targetConvId,
        modelId: safeModel,
        effort: safeEffort,
        mode: safeMode,
        prompt: cleanPrompt,
        cwd: getTargetWorkspace(),
        mappingFile: MAPPING_FILE,
        runningJobs,
        finishedJobs,
        onStateChange: broadcastSnapshot,
        onStreamEvent: broadcastSseEvent
      });

      broadcastSnapshot();
      sendJson(res, 200, {
        ok: true,
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

  // 10. 실행 중인 CLI 프롬프트 작업 중단
  if (req.method === 'POST' && urlPath === '/api/prompt/stop') {
    try {
      const body = await readRequestBody(req);
      const { agentId } = body;
      if (!isValidAgentId(agentId)) {
        sendJson(res, 400, { ok: false, error: '유효하지 않은 agentId: ' + agentId });
        return;
      }
      stopAgyJob(agentId, runningJobs, finishedJobs, broadcastSseEvent);
      broadcastSnapshot();
      sendJson(res, 200, { ok: true, agentId });
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

  // 12. 프로덕션 빌드(dist/) 정적 서빙
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
  workspaceRoster = resolveWorkspaceAgentsSync(CONFIG_FILE, getTargetWorkspace());
} catch (_) {}

server.listen(PORT, HOST, () => {
  console.log(`[agent-office-cli bridge] 실행: http://${HOST}:${PORT}`);
  console.log(`[CLI 저장소] ${getCliBrainDir()}`);
  console.log(`[작업 대상 경로] ${getTargetWorkspace()} (팀원 ${workspaceRoster.activeAgents.length}명)`);
  refreshWorkspaceRoster(false)
    .then(() => broadcastSnapshot())
    .catch(() => {});
});
