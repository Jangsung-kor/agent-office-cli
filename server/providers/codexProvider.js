const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const {
  readJsonSafe,
  normalizeFsPathKey,
  parseJsonLines,
  readHeadAndTail,
  createEmptyTokenUsage,
  localDateKey,
  accumulateDailyTokens,
  extractPromptSummaryAndRaw,
  matchRoleFromList,
  writeHandoverMarkdownFile,
  isValidConvId
} = require('../transcript');

const PROVIDER_ID = 'codex';
const HANDOVER_SCAN_BYTES = 2 * 1024 * 1024;
const TOKEN_FULL_SCAN_LIMIT_BYTES = 16 * 1024 * 1024;
const SANDBOX_MODES = ['read-only', 'workspace-write', 'full-auto'];
const EFFORT_LEVELS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const UUID_SUFFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const FALLBACK_CODEX_MODELS = [
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', defaultEffort: 'medium' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', defaultEffort: 'medium' },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', defaultEffort: 'medium' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', defaultEffort: 'low' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', defaultEffort: 'medium' }
];

const CAPABILITIES = {
  providerId: PROVIDER_ID,
  name: 'CODEX',
  label: 'Codex CLI',
  subtitle: 'OpenAI Codex CLI (codex exec --json) 기반 관제 및 세션 뷰어',
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
};

let modelCache = { fetchedAt: 0, list: [] };
let indexCache = { mtimeKey: '', data: null };
const codexFileByConvId = new Map();

/**
 * Codex 홈 디렉터리(~/.codex) 반환
 * @author Jangsung
 * @return {String}
 */
function getCodexHomeDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * Codex 세션 저장 디렉터리(~/.codex/sessions) 반환
 * @author Jangsung
 * @return {String}
 */
function getCodexSessionsDir() {
  return path.join(getCodexHomeDir(), 'sessions');
}

/**
 * 로컬 Codex CLI 실행 파일 경로 해석
 * @author Jangsung
 * @return {String}
 */
function resolveCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const openAiBinRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(openAiBinRoot)) {
    try {
      const subDirs = fs.readdirSync(openAiBinRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const exePath = path.join(openAiBinRoot, d.name, 'codex.exe');
          if (!fs.existsSync(exePath)) return null;
          const st = fs.statSync(exePath);
          return { exePath, mtimeMs: st.mtimeMs };
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (subDirs.length > 0) return subDirs[0].exePath;
    } catch (_) {}
  }

  const appServerCodex = path.join(getCodexHomeDir(), 'plugins', '.plugin-appserver', 'codex.exe');
  if (fs.existsSync(appServerCodex)) {
    return appServerCodex;
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const npmCodexCmd = path.join(appData, 'npm', 'codex.cmd');
  if (fs.existsSync(npmCodexCmd)) {
    return npmCodexCmd;
  }

  const pathEnv = String(process.env.PATH || '');
  const pathParts = pathEnv.split(path.delimiter).filter(Boolean);
  const exeNames = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  for (const dir of pathParts) {
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return 'codex';
}

/**
 * 로컬 Codex CLI 바이너리 감지 상태 조회
 * @author Jangsung
 * @return {Object}
 */
function detectCli() {
  const binPath = resolveCodexBin();
  const isAbs = path.isAbsolute(binPath);
  const available = isAbs ? fs.existsSync(binPath) : false;
  return {
    available,
    binPath,
    sessionStoreDir: getCodexSessionsDir()
  };
}

/**
 * ~/.codex/session_index.jsonl 에서 사용자 지정 스레드 제목 맵 조회
 * @author Jangsung
 * @return {Map<String, Object>}
 */
function readCodexThreadTitles() {
  const indexPath = path.join(getCodexHomeDir(), 'session_index.jsonl');
  const map = new Map();
  if (!fs.existsSync(indexPath)) return map;
  try {
    const items = parseJsonLines(fs.readFileSync(indexPath, 'utf8'));
    for (const item of items) {
      if (item && typeof item.id === 'string' && item.id.trim()) {
        map.set(item.id.trim(), {
          threadName: typeof item.thread_name === 'string' ? item.thread_name.trim() : '',
          updatedAt: item.updated_at || null
        });
      }
    }
  } catch (_) {}
  return map;
}

/**
 * ~/.codex/sessions 하위 YYYY/MM/DD/*.jsonl 파일 재귀 수집 (Node 16 호환)
 * @author Jangsung
 * @param {String} dir
 * @param {Number} depth
 * @param {Array<Object>} out
 */
function collectSessionFiles(dir, depth = 0, out = []) {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (let i = 0; i < entries.length; i++) {
    const ent = entries[i];
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      collectSessionFiles(full, depth + 1, out);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(full);
        out.push({ fullPath: full, name: ent.name, stat });
      } catch (_) {}
    }
  }
  return out;
}

/**
 * rollout 파일명 또는 첫 session_meta 줄에서 세션 ID(convId) 및 작업 경로(cwd) 추출
 * @author Jangsung
 * @param {String} filePath
 * @param {String} fileName
 * @return {Object}
 */
function readCodexSessionHeader(filePath, fileName) {
  let convId = '';
  const match = String(fileName || '').match(UUID_SUFFIX_RE);
  if (match) convId = match[1];

  let cwd = '';
  let cliVersion = '';
  let startedAtIso = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const readLen = Math.min(128 * 1024, fs.fstatSync(fd).size);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, buf.length, 0);
      const lines = parseJsonLines(buf.toString('utf8'));
      for (let i = 0; i < Math.min(lines.length, 8); i++) {
        const item = lines[i];
        if (!startedAtIso && item && item.timestamp) {
          startedAtIso = item.timestamp;
        }
        if (item.type === 'session_meta' && item.payload) {
          if (!convId && typeof item.payload.id === 'string') convId = item.payload.id.trim();
          if (typeof item.payload.cwd === 'string') cwd = item.payload.cwd.trim();
          if (typeof item.payload.cli_version === 'string') cliVersion = item.payload.cli_version.trim();
          if (typeof item.payload.timestamp === 'string') startedAtIso = item.payload.timestamp.trim();
          break;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}

  return { convId, cwd, cliVersion, startedAtIso };
}

/**
 * agentRegistry 호환용 워크스페이스-세션 인덱스 생성
 * @author Jangsung
 * @return {Object}
 */
function readCodexHistoryIndex() {
  const sessionsDir = getCodexSessionsDir();
  const empty = { byConvId: new Map(), byWorkspace: new Map() };
  if (!fs.existsSync(sessionsDir)) return empty;

  const files = collectSessionFiles(sessionsDir).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 80);
  const mtimeKey = files.map(f => `${f.name}:${f.stat.mtimeMs}:${f.stat.size}`).join('|');
  if (indexCache.data && indexCache.mtimeKey === mtimeKey) {
    return indexCache.data;
  }

  const titles = readCodexThreadTitles();
  const byConvId = new Map();
  const byWorkspace = new Map();

  for (const f of files) {
    const { convId, cwd } = readCodexSessionHeader(f.fullPath, f.name);
    if (!convId || !isValidConvId(convId)) continue;
    codexFileByConvId.set(convId, f.fullPath);

    if (!cwd) continue;
    const wsResolved = path.resolve(cwd);
    const wsKey = normalizeFsPathKey(wsResolved);
    const titleMeta = titles.get(convId);
    const display = titleMeta && titleMeta.threadName ? titleMeta.threadName : '';

    byConvId.set(convId, {
      convId,
      workspacePath: wsResolved,
      workspaceKey: wsKey,
      timestamp: f.stat.mtimeMs,
      display
    });

    let wsEntry = byWorkspace.get(wsKey);
    if (!wsEntry) {
      wsEntry = {
        workspacePath: wsResolved,
        workspaceKey: wsKey,
        convIds: [],
        lastTimestamp: 0,
        lastPrompt: ''
      };
      byWorkspace.set(wsKey, wsEntry);
    }
    wsEntry.convIds.push(convId);
    if (f.stat.mtimeMs >= wsEntry.lastTimestamp) {
      wsEntry.lastTimestamp = f.stat.mtimeMs;
      if (display) wsEntry.lastPrompt = display;
    }
  }

  const data = { byConvId, byWorkspace };
  indexCache = { mtimeKey, data };
  return data;
}

/**
 * convId에 해당하는 Codex rollout 파일 경로 조회
 * @author Jangsung
 * @param {String} convId
 * @return {String|null}
 */
function findCodexSessionPath(convId) {
  if (!isValidConvId(convId)) return null;
  const cached = codexFileByConvId.get(convId);
  if (cached && fs.existsSync(cached)) return cached;

  const files = collectSessionFiles(getCodexSessionsDir());
  for (const f of files) {
    if (f.name.includes(convId)) {
      codexFileByConvId.set(convId, f.fullPath);
      return f.fullPath;
    }
  }
  return null;
}

/**
 * ~/.codex/models_cache.json 또는 codex debug models 를 통해 모델 목록 조회
 * @author Jangsung
 * @param {Boolean} forceRefresh
 * @return {Promise<Array<Object>>}
 */
function getAvailableModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && modelCache.list.length > 0 && now - modelCache.fetchedAt < 5 * 60 * 1000) {
    return Promise.resolve(modelCache.list);
  }

  const parseModelsPayload = payload => {
    const rawList = Array.isArray(payload && payload.models)
      ? payload.models
      : (Array.isArray(payload) ? payload : []);
    return rawList
      .filter(m => m && m.slug && m.visibility !== 'hide')
      .map(m => ({
        id: m.slug,
        label: m.display_name || m.slug,
        defaultEffort: m.default_reasoning_level || 'medium'
      }));
  };

  const cacheFile = path.join(getCodexHomeDir(), 'models_cache.json');
  if (!forceRefresh && fs.existsSync(cacheFile)) {
    const cachedJson = readJsonSafe(cacheFile, null);
    const parsed = parseModelsPayload(cachedJson);
    if (parsed.length > 0) {
      modelCache = { fetchedAt: now, list: parsed };
      return Promise.resolve(parsed);
    }
  }

  const codexBin = resolveCodexBin();
  return new Promise(resolve => {
    execFile(codexBin, ['debug', 'models'], { timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (!err && stdout) {
        try {
          const parsed = parseModelsPayload(JSON.parse(stdout));
          if (parsed.length > 0) {
            modelCache = { fetchedAt: Date.now(), list: parsed };
            resolve(parsed);
            return;
          }
        } catch (_) {}
      }
      if (fs.existsSync(cacheFile)) {
        const parsed = parseModelsPayload(readJsonSafe(cacheFile, null));
        if (parsed.length > 0) {
          modelCache = { fetchedAt: Date.now(), list: parsed };
          resolve(parsed);
          return;
        }
      }
      resolve(modelCache.list.length > 0 ? modelCache.list : FALLBACK_CODEX_MODELS);
    });
  });
}

/**
 * Codex UserMessage 본문에서 UI 컨텍스트 태그 정리
 * @author Jangsung
 * @param {String} raw
 * @return {String}
 */
function cleanCodexUserText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw
    .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, '')
    .replace(/<environment_context[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<external_codex_apps_open_page[\s\S]*?<\/external_codex_apps_open_page>/gi, '')
    .replace(/^\s*##\s*My request:\s*/i, '')
    .trim();
  const hbMatch = cleaned.match(/<heartbeat>[\s\S]*?<instructions>([\s\S]*?)<\/instructions>[\s\S]*?<\/heartbeat>/i);
  if (hbMatch && hbMatch[1]) {
    cleaned = `[자동 예약 실행] ${hbMatch[1].trim()}`;
  }
  return cleaned;
}

/**
 * Codex function_call / custom_tool_call 요약
 * @author Jangsung
 * @param {Object} payload
 * @return {Object}
 */
function summarizeCodexToolCall(payload) {
  const name = (payload && payload.name) || 'tool';
  let target = '';
  if (payload && typeof payload.input === 'string' && payload.input.trim()) {
    target = payload.input.replace(/\s+/g, ' ').trim().slice(0, 80);
  } else if (payload && payload.arguments) {
    try {
      const args = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments;
      if (args.cmd) target = String(args.cmd).replace(/\s+/g, ' ').trim().slice(0, 80);
      else if (args.path) target = path.basename(String(args.path));
      else if (args.query) target = String(args.query).slice(0, 80);
    } catch (_) {
      target = String(payload.arguments).slice(0, 80);
    }
  }
  return { name, target };
}

/**
 * response_item.message.content 배열에서 텍스트 추출
 * @author Jangsung
 * @param {Array|String} content
 * @return {String}
 */
function extractCodexContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      return part.text || '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Codex rollout JSONL 이벤트 목록에서 누적 토큰, 일자별 버킷, 사용 기간 집계
 * @author Jangsung
 * @param {Array<Object>} items
 * @param {Boolean} partial
 * @param {String|null} headerStartedIso
 * @param {Number|null} fallbackLastMs
 * @return {Object}
 */
function summarizeCodexTokens(items, partial = false, headerStartedIso = null, fallbackLastMs = null) {
  const usage = createEmptyTokenUsage();
  usage.partial = Boolean(partial);
  if (!Array.isArray(items) || items.length === 0) return usage;

  let minMs = headerStartedIso ? new Date(headerStartedIso).getTime() : Infinity;
  if (!Number.isFinite(minMs)) minMs = Infinity;
  let maxMs = 0;
  let prevTotal = {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.timestamp) {
      const ms = new Date(item.timestamp).getTime();
      if (Number.isFinite(ms)) {
        if (ms < minMs) minMs = ms;
        if (ms > maxMs) maxMs = ms;
      }
    }
    if (item.type === 'turn_context' && item.payload && typeof item.payload.model === 'string') {
      usage.model = item.payload.model.trim();
    } else if (item.type === 'event_msg' && item.payload && item.payload.type === 'token_count' && item.payload.info) {
      const info = item.payload.info;
      const tu = info.total_token_usage;
      const lu = info.last_token_usage;
      if (tu) {
        const rawIn = Number(tu.input_tokens) || 0;
        const cacheRead = Number(tu.cached_input_tokens) || 0;
        const uncachedIn = Math.max(0, rawIn - cacheRead);
        const out = Number(tu.output_tokens) || 0;
        const reas = Number(tu.reasoning_output_tokens) || 0;
        const tot = Number(tu.total_tokens) || (rawIn + out);

        const dIn = Math.max(0, uncachedIn - prevTotal.inputTokens);
        const dCache = Math.max(0, cacheRead - prevTotal.cacheReadTokens);
        const dOut = Math.max(0, out - prevTotal.outputTokens);
        const dReas = Math.max(0, reas - prevTotal.reasoningTokens);
        const dTot = Math.max(0, tot - prevTotal.totalTokens);
        if (dTot > 0 || dIn > 0 || dCache > 0 || dOut > 0) {
          const dateKey = localDateKey(item.timestamp || fallbackLastMs);
          accumulateDailyTokens(usage.byDate, dateKey, {
            inputTokens: dIn,
            cacheReadTokens: dCache,
            outputTokens: dOut,
            reasoningTokens: dReas,
            totalTokens: dTot
          });
        }

        prevTotal = {
          inputTokens: uncachedIn,
          cacheReadTokens: cacheRead,
          outputTokens: out,
          reasoningTokens: reas,
          totalTokens: tot
        };
        usage.inputTokens = uncachedIn;
        usage.cacheReadTokens = cacheRead;
        usage.outputTokens = out;
        usage.reasoningTokens = reas;
        usage.totalTokens = tot;
      }
      if (lu) {
        usage.lastContextTokens = Number(lu.input_tokens) || 0;
      }
      if (typeof info.model_context_window === 'number') {
        usage.contextWindow = info.model_context_window;
      }
    }
  }

  if (Number.isFinite(fallbackLastMs) && fallbackLastMs > maxMs) {
    maxMs = fallbackLastMs;
  }
  if (Number.isFinite(minMs) && maxMs > 0) {
    usage.startedAtIso = new Date(minMs).toISOString();
    usage.lastActiveIso = new Date(maxMs).toISOString();
    usage.durationMs = Math.max(0, maxMs - minMs);
  }
  return usage;
}

/**
 * Codex rollout 파일 전체(16MB 초과 시 꼬리 2MB)에서 일자별/누적 토큰 집계
 * @author Jangsung
 * @param {String} filePath
 * @param {Number} fileSize
 * @param {String|null} headerStartedIso
 * @param {Number|null} mtimeMs
 * @return {Object}
 */
function readCodexTokenSummary(filePath, fileSize, headerStartedIso = null, mtimeMs = null) {
  try {
    if (fileSize <= TOKEN_FULL_SCAN_LIMIT_BYTES) {
      const items = parseJsonLines(fs.readFileSync(filePath, 'utf8'));
      return summarizeCodexTokens(items, false, headerStartedIso, mtimeMs);
    }
    const scanBytes = HANDOVER_SCAN_BYTES;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(scanBytes);
      fs.readSync(fd, buf, 0, scanBytes, fileSize - scanBytes);
      let str = buf.toString('utf8');
      const nl = str.indexOf('\n');
      if (nl !== -1) str = str.slice(nl + 1);
      return summarizeCodexTokens(parseJsonLines(str), true, headerStartedIso, mtimeMs);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return createEmptyTokenUsage();
  }
}

/**
 * Codex rollout JSONL 파일의 앞뒤 청크를 분석해 세션 상태 요약 생성
 * @author Jangsung
 * @param {String} convId
 * @param {fs.Stats} stat
 * @param {String} headText
 * @param {String} tailText
 * @param {Object} manualMapping
 * @param {Array<Object>} activeAgents
 * @param {Object} historyIndex
 * @param {Map} titles
 * @param {String|null} filePath
 * @param {String|null} headerStartedIso
 * @return {Object}
 */
function analyzeCodexSessionActivity(convId, stat, headText, tailText, manualMapping, activeAgents, historyIndex, titles, filePath = null, headerStartedIso = null) {
  const headItems = parseJsonLines(headText);
  const tailItems = parseJsonLines(tailText);

  const syntheticHead = [];
  const syntheticTail = [];
  const collectSynthetic = (items, out) => {
    for (const item of items) {
      if (item.type === 'event_msg' && item.payload && item.payload.type === 'item_completed' && item.payload.item && item.payload.item.type === 'UserMessage') {
        const txt = cleanCodexUserText(extractCodexContentText(item.payload.item.content));
        if (txt) out.push({ type: 'USER_INPUT', content: txt });
      }
    }
  };
  collectSynthetic(headItems, syntheticHead);
  collectSynthetic(tailItems, syntheticTail);

  let role = null;
  if (manualMapping && manualMapping[convId]) {
    role = manualMapping[convId] === 'NONE' ? null : manualMapping[convId];
  } else {
    const activeList = Array.isArray(activeAgents) ? activeAgents : [];
    const convMeta = historyIndex && historyIndex.byConvId ? historyIndex.byConvId.get(convId) : null;
    if (convMeta && convMeta.workspaceKey) {
      const wsMatches = activeList.filter(a => a && a.workspaceKey && a.workspaceKey === convMeta.workspaceKey);
      if (wsMatches.length === 1) {
        role = wsMatches[0].id;
      } else if (wsMatches.length > 1) {
        role = matchRoleFromList(syntheticHead, syntheticTail, wsMatches) || wsMatches[0].id;
      }
    }
    if (!role) {
      role = matchRoleFromList(syntheticHead, syntheticTail, activeList);
    }
  }

  const now = Date.now();
  const ageSec = Math.max(0, (now - stat.mtimeMs) / 1000);
  const fileSizeMB = Number((stat.size / (1024 * 1024)).toFixed(2));
  const convMeta = historyIndex && historyIndex.byConvId ? historyIndex.byConvId.get(convId) : null;
  const titleMeta = titles ? titles.get(convId) : null;

  let lastUserText = '';
  let latestToolName = '';
  let latestToolTarget = '';
  let lastResponsePreview = '';
  let lastErrorMsg = '';
  let activeTurnOpen = false;
  let lastTaskDone = false;
  let stepCounter = 0;
  const logs = [];

  for (const item of tailItems) {
    if (typeof item.ordinal === 'number') {
      stepCounter = Math.max(stepCounter, item.ordinal);
    }
    const timeStr = item.timestamp
      ? new Date(item.timestamp).toTimeString().slice(0, 8)
      : new Date(stat.mtimeMs).toTimeString().slice(0, 8);

    if (item.type === 'event_msg' && item.payload) {
      const p = item.payload;
      if (p.type === 'task_started') {
        activeTurnOpen = true;
        lastTaskDone = false;
      } else if (p.type === 'task_complete') {
        activeTurnOpen = false;
        lastTaskDone = true;
        if (p.error && p.error.message) {
          lastErrorMsg = String(p.error.message).slice(0, 100);
          logs.push({ time: timeStr, message: `[Codex 오류] ${lastErrorMsg}`, level: 'warn' });
        } else if (p.last_agent_message) {
          lastResponsePreview = String(p.last_agent_message).replace(/\s+/g, ' ').trim().slice(0, 75);
          logs.push({ time: timeStr, message: `[응답 완료] ${lastResponsePreview}`, level: 'done' });
        }
      } else if (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage') {
        const cleaned = cleanCodexUserText(extractCodexContentText(p.item.content));
        if (cleaned) {
          lastUserText = cleaned;
          const parsed = extractPromptSummaryAndRaw(cleaned);
          if (parsed.preview !== '-') {
            logs.push({ time: timeStr, message: `[사용자 요청] ${parsed.preview}`, level: 'warn' });
          }
        }
      }
    } else if (item.type === 'response_item' && item.payload) {
      const p = item.payload;
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const sum = summarizeCodexToolCall(p);
        latestToolName = sum.name;
        latestToolTarget = sum.target;
        logs.push({ time: timeStr, message: `도구 실행: ${sum.name}${sum.target ? ` (${sum.target.slice(0, 40)})` : ''}`, level: 'info' });
      } else if (p.type === 'message' && p.role === 'assistant') {
        const txt = extractCodexContentText(p.content).replace(/\s+/g, ' ').trim();
        if (txt) lastResponsePreview = txt.slice(0, 75);
      }
    }
  }

  let state = 'IDLE';
  if (activeTurnOpen && ageSec <= 120) {
    state = 'WORKING';
  } else if (ageSec <= 180) {
    state = lastErrorMsg ? 'BLOCKED' : (lastTaskDone ? 'DONE' : 'WORKING');
  }

  const parsedPrompt = lastUserText ? extractPromptSummaryAndRaw(lastUserText) : null;
  const threadTitle = titleMeta && titleMeta.threadName ? titleMeta.threadName : '';
  const taskSummary = (parsedPrompt && parsedPrompt.summary !== '-') ? parsedPrompt.summary : (threadTitle || lastResponsePreview || '-');
  const taskRaw = (parsedPrompt && parsedPrompt.raw !== '-') ? parsedPrompt.raw : (threadTitle || lastResponsePreview || '-');
  const taskPreview = (parsedPrompt && parsedPrompt.preview !== '-') ? parsedPrompt.preview : (threadTitle || lastResponsePreview || '-');

  let bubbleText = '대기 중';
  if (state === 'WORKING') {
    bubbleText = latestToolTarget ? `${latestToolName}: ${latestToolTarget.slice(0, 22)}` : 'Codex 작업 수행 중...';
  } else if (state === 'BLOCKED') {
    bubbleText = `오류: ${lastErrorMsg.slice(0, 24)}`;
  } else if (state === 'DONE') {
    bubbleText = lastResponsePreview ? `완료: ${lastResponsePreview.slice(0, 20)}` : '최근 요청 응답 완료';
  } else if (taskPreview !== '-') {
    bubbleText = `대기 (최근: ${taskPreview.slice(0, 18)})`;
  }

  const tokenUsage = filePath
    ? readCodexTokenSummary(filePath, stat.size, headerStartedIso, stat.mtimeMs)
    : summarizeCodexTokens(tailItems, false, headerStartedIso, stat.mtimeMs);

  let startedMs = headerStartedIso ? new Date(headerStartedIso).getTime() : Infinity;
  if (!Number.isFinite(startedMs)) {
    for (const item of headItems) {
      if (item && item.timestamp) {
        const ms = new Date(item.timestamp).getTime();
        if (Number.isFinite(ms)) {
          startedMs = ms;
          break;
        }
      }
    }
  }
  if (!Number.isFinite(startedMs)) {
    startedMs = (stat.birthtimeMs && stat.birthtimeMs > 0) ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
  }
  const startedAtIso = new Date(startedMs).toISOString();
  const lastActiveIso = new Date(stat.mtimeMs).toISOString();
  const durationMs = Math.max(0, stat.mtimeMs - startedMs);
  tokenUsage.startedAtIso = startedAtIso;
  tokenUsage.lastActiveIso = lastActiveIso;
  tokenUsage.durationMs = durationMs;

  return {
    convId,
    origin: 'codex',
    role,
    workspacePath: convMeta ? convMeta.workspacePath : null,
    mtimeMs: stat.mtimeMs,
    startedAtIso,
    lastActiveIso,
    durationMs,
    ageSec: Math.round(ageSec),
    fileSizeBytes: stat.size,
    fileSizeMB,
    lastStepIndex: stepCounter,
    state,
    bubbleText,
    currentTask: taskPreview,
    currentTaskSummary: taskSummary,
    currentTaskRaw: taskRaw,
    currentTool: latestToolName ? `${latestToolName}${latestToolTarget ? ` (${latestToolTarget.slice(0, 40)})` : ''}` : '-',
    tokenUsage,
    logs: logs.slice(-25),
    titlePreview: threadTitle || (taskPreview !== '-' ? taskPreview : convId.slice(0, 8))
  };
}

/**
 * Codex 세션 목록 스캔 (최근 80개)
 * @author Jangsung
 * @param {Map} sessionCache
 * @param {Object} manualMapping
 * @param {Array<Object>} activeAgents
 * @return {Array<Object>}
 */
function scanSessions(sessionCache, manualMapping, activeAgents) {
  const sessionsDir = getCodexSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];

  const historyIndex = readCodexHistoryIndex();
  const titles = readCodexThreadTitles();
  const files = collectSessionFiles(sessionsDir)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, 80);

  const rosterSig = Array.isArray(activeAgents)
    ? activeAgents.map(a => `${a.id}:${a.source || ''}:${a.workspaceKey || ''}`).join(',')
    : '';

  const detected = [];
  for (const f of files) {
    const { convId, startedAtIso } = readCodexSessionHeader(f.fullPath, f.name);
    if (!convId || !isValidConvId(convId)) continue;
    codexFileByConvId.set(convId, f.fullPath);

    const cached = sessionCache.get(convId);
    const manualRole = (manualMapping && manualMapping[convId]) ? String(manualMapping[convId]) : '';
    let analyzed;
    if (
      cached
      && cached.mtimeMs === f.stat.mtimeMs
      && cached.size === f.stat.size
      && cached.rosterSig === rosterSig
      && cached.manualRole === manualRole
    ) {
      const reAge = Math.max(0, (Date.now() - f.stat.mtimeMs) / 1000);
      analyzed = { ...cached.analyzed, origin: 'codex', ageSec: Math.round(reAge) };
      if (analyzed.state !== 'IDLE' && reAge > 180) {
        analyzed.state = 'IDLE';
        analyzed.bubbleText = analyzed.currentTask !== '-'
          ? `대기 (최근: ${analyzed.currentTask.slice(0, 18)})`
          : '대기 중';
      }
    } else {
      try {
        const { headText, tailText } = readHeadAndTail(f.fullPath, f.stat.size);
        analyzed = analyzeCodexSessionActivity(
          convId,
          f.stat,
          headText,
          tailText,
          manualMapping,
          activeAgents,
          historyIndex,
          titles,
          f.fullPath,
          startedAtIso
        );
        sessionCache.set(convId, { mtimeMs: f.stat.mtimeMs, size: f.stat.size, rosterSig, manualRole, analyzed });
      } catch (_) {
        continue;
      }
    }
    detected.push(analyzed);
  }

  detected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return detected;
}

/**
 * Codex 세션 JSONL에서 대화 스레드(USER / ASSISTANT / TOOL / ERROR) 로드
 * @author Jangsung
 * @param {String} convId
 * @param {Number} limit
 * @return {Object}
 */
function readSessionMessages(convId, limit = 150) {
  const filePath = findCodexSessionPath(convId);
  if (!filePath) {
    throw new Error('Codex 세션을 찾을 수 없습니다: ' + convId);
  }

  const stat = fs.statSync(filePath);
  const items = parseJsonLines(fs.readFileSync(filePath, 'utf8'));
  const sessionUsage = summarizeCodexTokens(items, false, null, stat.mtimeMs);
  const messages = [];
  let pendingTools = [];
  let lastAssistantMsg = null;
  let currentModel = sessionUsage.model || null;
  let seq = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ts = item.timestamp || null;
    const stepIdx = typeof item.ordinal === 'number' ? item.ordinal : i;

    if (item.type === 'turn_context' && item.payload && typeof item.payload.model === 'string') {
      currentModel = item.payload.model.trim();
    } else if (item.type === 'event_msg' && item.payload) {
      const p = item.payload;
      if (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage') {
        const cleaned = cleanCodexUserText(extractCodexContentText(p.item.content));
        if (!cleaned) continue;
        const parsed = extractPromptSummaryAndRaw(cleaned);
        if (parsed.raw === '-') continue;
        pendingTools = [];
        lastAssistantMsg = null;
        messages.push({
          id: `cu-${stepIdx}-${seq++}`,
          stepIndex: stepIdx,
          role: 'user',
          content: parsed.raw,
          preview: parsed.preview,
          toolCalls: [],
          status: 'DONE',
          timestamp: ts
        });
      } else if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        const lu = p.info.last_token_usage;
        const lRawIn = Number(lu.input_tokens) || 0;
        const lCache = Number(lu.cached_input_tokens) || 0;
        const lUncached = Math.max(0, lRawIn - lCache);
        const lOut = Number(lu.output_tokens) || 0;
        if (lastAssistantMsg && !lastAssistantMsg.usage) {
          lastAssistantMsg.usage = {
            inputTokens: lUncached,
            cacheReadTokens: lCache,
            outputTokens: lOut,
            reasoningTokens: Number(lu.reasoning_output_tokens) || 0,
            totalTokens: Number(lu.total_tokens) || (lRawIn + lOut),
            model: currentModel
          };
        }
      } else if (p.type === 'task_complete' && p.error && p.error.message) {
        lastAssistantMsg = {
          id: `ce-${stepIdx}-${seq++}`,
          stepIndex: stepIdx,
          role: 'assistant',
          content: String(p.error.message),
          toolCalls: pendingTools,
          isIntermediate: false,
          isError: true,
          status: 'ERROR',
          timestamp: ts,
          usage: null
        };
        messages.push(lastAssistantMsg);
        pendingTools = [];
      }
    } else if (item.type === 'response_item' && item.payload) {
      const p = item.payload;
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        pendingTools.push(summarizeCodexToolCall(p));
      } else if (p.type === 'message' && p.role === 'assistant') {
        const text = extractCodexContentText(p.content).trim();
        if (!text && pendingTools.length === 0) continue;
        lastAssistantMsg = {
          id: `ca-${stepIdx}-${seq++}`,
          stepIndex: stepIdx,
          role: 'assistant',
          content: text,
          toolCalls: pendingTools,
          isIntermediate: p.phase === 'commentary',
          isError: false,
          status: p.status || 'DONE',
          timestamp: ts,
          usage: null
        };
        messages.push(lastAssistantMsg);
        pendingTools = [];
      }
    }
  }

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 150));
  const sliced = messages.length > safeLimit ? messages.slice(messages.length - safeLimit) : messages;
  return {
    convId,
    totalSteps: messages.length,
    returnedCount: sliced.length,
    sessionUsage,
    messages: sliced
  };
}

/**
 * 실행 옵션 유효성 정규화
 * @author Jangsung
 * @param {Object} raw
 * @return {Object}
 */
function normalizePromptOptions({ modelId, effort, mode }) {
  const safeMode = SANDBOX_MODES.includes(mode) ? mode : CAPABILITIES.defaultMode;
  const safeEffort = EFFORT_LEVELS.includes(effort) ? effort : CAPABILITIES.defaultEffort;
  const safeModel = typeof modelId === 'string' && modelId.trim()
    ? modelId.trim()
    : CAPABILITIES.defaultModelId;
  if (!/^[a-zA-Z0-9._-]+$/.test(safeModel)) {
    throw new Error('유효하지 않은 modelId 형식입니다.');
  }
  return { modelId: safeModel, effort: safeEffort, mode: safeMode };
}

/**
 * Codex CLI (codex exec --json) 비동기 실행 및 SSE 실시간 스트리밍
 * @author Jangsung
 * @param {Object} params
 * @return {Object}
 */
function startCodexPromptJob({
  agentId,
  convId,
  modelId,
  effort,
  mode,
  prompt,
  cwd,
  mappingFile,
  runningJobs,
  finishedJobs,
  onStateChange,
  onStreamEvent
}) {
  const safeMode = SANDBOX_MODES.includes(mode) ? mode : CAPABILITIES.defaultMode;
  const safeEffort = EFFORT_LEVELS.includes(effort) ? effort : CAPABILITIES.defaultEffort;
  const sandboxValue = safeMode === 'full-auto' ? 'danger-full-access' : safeMode;
  const safePrompt = prompt.startsWith('-') ? ' ' + prompt : prompt;

  const args = ['exec'];
  if (convId) {
    args.push('resume');
  }
  args.push('--json', '--skip-git-repo-check', '-m', modelId);
  if (!convId) {
    args.push('-C', cwd, '-s', sandboxValue);
  } else {
    args.push('-c', `sandbox_mode="${sandboxValue}"`);
  }
  args.push('-c', 'approval_policy="never"');
  if (safeEffort && safeEffort !== 'auto') {
    args.push('-c', `model_reasoning_effort="${safeEffort}"`);
  }
  if (convId) {
    args.push(convId);
  }
  args.push(safePrompt);

  const codexBin = resolveCodexBin();
  const child = spawn(codexBin, args, {
    cwd,
    shell: process.platform === 'win32' && codexBin.toLowerCase().endsWith('.cmd'),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const job = {
    pid: child.pid,
    child,
    agentId,
    convId: convId || null,
    modelId,
    effort: safeEffort,
    mode: safeMode,
    prompt,
    cwd,
    startedAt: new Date().toISOString(),
    streamText: '',
    finalResponse: '',
    responsePreview: '',
    error: null,
    resultEmitted: false,
    usage: null,
    activeTool: '',
    rawStreamLogs: [],
    logs: [
      {
        time: new Date().toTimeString().slice(0, 8),
        message: `[Codex 시작] 모델=${modelId}, 강도=${safeEffort}, 모드=${safeMode}${convId ? `, 세션=${convId.slice(0, 8)}` : ' (새 세션)'}`,
        level: 'warn'
      }
    ]
  };
  runningJobs.set(agentId, job);

  const itemTextMap = new Map();
  const rebuildStreamText = () => Array.from(itemTextMap.values()).filter(Boolean).join('\n\n');

  const appendRawLine = rawLine => {
    const lineStr = String(rawLine || '').trim();
    if (!lineStr) return;
    job.rawStreamLogs.push({
      time: new Date().toTimeString().slice(0, 8),
      line: lineStr.length > 2000 ? lineStr.slice(0, 2000) + ' ...' : lineStr
    });
    if (job.rawStreamLogs.length > 120) job.rawStreamLogs.shift();
  };

  const appendLog = (msg, level = 'info') => {
    const clean = String(msg || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    job.logs.push({ time: new Date().toTimeString().slice(0, 8), message: clean.slice(0, 140), level });
    if (job.logs.length > 40) job.logs.shift();
  };

  let outBuf = '';
  child.stdout.on('data', chunk => {
    if (job.aborted) return;
    outBuf += chunk.toString('utf8');
    const lines = outBuf.split(/\r?\n/);
    outBuf = lines.pop() || '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      appendRawLine(line);
      if (line[0] !== '{') {
        appendLog(line);
        continue;
      }

      try {
        const obj = JSON.parse(line);
        if (obj.type === 'thread.started' && obj.thread_id) {
          job.convId = obj.thread_id;
          appendLog(`[세션 연결] ID=${obj.thread_id.slice(0, 8)}`, 'info');
          if (!convId && mappingFile) {
            const mapping = readJsonSafe(mappingFile, {});
            for (const k of Object.keys(mapping)) {
              if (mapping[k] === agentId) delete mapping[k];
            }
            mapping[obj.thread_id] = agentId;
            try {
              fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2), 'utf8');
            } catch (_) {}
          }
          if (onStreamEvent) {
            onStreamEvent('chat_delta', {
              agentId,
              convId: job.convId,
              eventType: 'init',
              textDelta: '',
              accumulatedText: job.streamText,
              rawLine: line,
              startedAt: job.startedAt
            });
          }
        } else if ((obj.type === 'item.started' || obj.type === 'item.updated' || obj.type === 'item.completed') && obj.item) {
          const item = obj.item;
          const itemKey = item.id || item.type || 'item';
          if (item.type === 'agent_message') {
            if (typeof item.text === 'string' && item.text.length > 0) {
              itemTextMap.set(itemKey, item.text);
              job.streamText = rebuildStreamText();
            }
            job.activeTool = 'agent_response';
          } else {
            job.activeTool = item.type || 'tool';
            if (obj.type === 'item.started') {
              const label = item.command || item.tool || item.query || item.type;
              appendLog(`[도구 실행] ${String(label).slice(0, 90)}`, 'info');
            }
          }
          if (onStreamEvent) {
            onStreamEvent('chat_delta', {
              agentId,
              convId: job.convId,
              eventType: obj.type,
              stepType: job.activeTool,
              state: obj.type === 'item.completed' ? 'DONE' : 'RUNNING',
              textDelta: '',
              accumulatedText: job.streamText,
              usage: job.usage,
              rawLine: line
            });
          }
        } else if (obj.type === 'turn.completed') {
          const u = obj.usage || null;
          if (u) {
            const total = u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0));
            job.usage = { ...u, total_tokens: total };
          }
          const fullResp = job.streamText;
          const preview = fullResp.replace(/\s+/g, ' ').trim().slice(0, 100);
          job.finalResponse = fullResp;
          job.responsePreview = preview;
          job.resultEmitted = true;
          const tok = job.usage && job.usage.total_tokens ? `, tokens=${job.usage.total_tokens}` : '';
          appendLog(`[Codex 응답 완료${tok}] ${preview}`, 'done');
          if (onStreamEvent) {
            onStreamEvent('chat_result', {
              agentId,
              convId: job.convId,
              status: 'SUCCESS',
              response: fullResp,
              error: null,
              usage: job.usage,
              rawLine: line,
              endedAt: new Date().toISOString()
            });
          }
        } else if (obj.type === 'turn.failed' || obj.type === 'error') {
          const errText = (obj.error && obj.error.message) || obj.message || 'Codex 실행 오류';
          job.error = String(errText);
          job.resultEmitted = true;
          appendLog(`[Codex 오류] ${job.error}`, 'warn');
          if (onStreamEvent) {
            onStreamEvent('chat_result', {
              agentId,
              convId: job.convId,
              status: 'ERROR',
              response: job.streamText,
              error: job.error,
              usage: job.usage,
              rawLine: line,
              endedAt: new Date().toISOString()
            });
          }
        }
      } catch (_) {
        appendLog(line);
      }
    }

    if (onStateChange) onStateChange();
  });

  child.stderr.on('data', chunk => {
    if (job.aborted) return;
    const errText = chunk.toString('utf8').trim();
    if (errText) {
      const tagged = `[stderr] ${errText}`;
      appendRawLine(tagged);
      appendLog(tagged, 'warn');
      if (onStreamEvent) {
        onStreamEvent('chat_delta', {
          agentId,
          convId: job.convId,
          eventType: 'stderr',
          textDelta: '',
          accumulatedText: job.streamText,
          rawLine: tagged
        });
      }
      if (onStateChange) onStateChange();
    }
  });

  const finalizeJob = (code, errMsg) => {
    if (job.aborted) {
      runningJobs.delete(agentId);
      return;
    }
    if (errMsg) {
      appendLog(`[실행 실패] ${errMsg}`, 'warn');
    } else {
      appendLog(`[Codex 종료] exit=${code}`, code === 0 ? 'done' : 'warn');
    }
    job.exitCode = code;
    job.endedAtMs = Date.now();
    job.endedAt = new Date().toISOString();
    finishedJobs.set(agentId, job);
    runningJobs.delete(agentId);

    if (onStreamEvent && !job.resultEmitted) {
      onStreamEvent('chat_result', {
        agentId,
        convId: job.convId,
        status: code === 0 ? 'DONE' : 'ERROR',
        exitCode: code,
        response: job.finalResponse || job.streamText || '',
        error: errMsg || job.error || (code !== 0 ? `Codex 종료 코드 ${code}` : null),
        usage: job.usage || null,
        endedAt: job.endedAt
      });
    }
    if (onStateChange) onStateChange();
  };

  child.on('error', err => finalizeJob(-1, err.message));
  child.on('close', code => {
    if (!runningJobs.has(agentId)) return;
    finalizeJob(code, null);
  });

  return job;
}

/**
 * 실행 중인 Codex CLI 자식 프로세스 중단
 * @author Jangsung
 * @param {String} agentId
 * @param {Map} runningJobs
 * @param {Map} finishedJobs
 * @param {Function} onStreamEvent
 * @return {Boolean}
 */
function stopCodexJob(agentId, runningJobs, finishedJobs, onStreamEvent, opts = {}) {
  if (!agentId) return false;
  const job = runningJobs.get(agentId);
  const fallbackConvId = opts && typeof opts.convId === 'string' && opts.convId.trim() ? opts.convId.trim() : null;
  const abortedSessions = opts && opts.abortedSessions instanceof Map ? opts.abortedSessions : null;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const timeStr = new Date(nowMs).toTimeString().slice(0, 8);

  if (job) {
    job.aborted = true;
    job.resultEmitted = true;
    job.exitCode = -1;
    job.endedAtMs = nowMs;
    job.endedAt = nowIso;
    if (!job.convId && fallbackConvId) {
      job.convId = fallbackConvId;
    }
    job.error = '사용자 요청으로 실행이 중단되었습니다.';
    job.logs.push({ time: timeStr, message: '[Codex 중단] 사용자 요청으로 실행을 중단했습니다.', level: 'warn' });
    if (job.logs.length > 40) job.logs.shift();

    try {
      if (process.platform === 'win32' && job.pid) {
        execFile('taskkill', ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true }, err => {
          if (err && job.child && !job.child.killed) {
            try { job.child.kill('SIGKILL'); } catch (_) {}
          }
        });
      } else if (job.child) {
        job.child.kill('SIGKILL');
      }
    } catch (_) {}

    runningJobs.delete(agentId);
    if (finishedJobs) finishedJobs.set(agentId, job);
    if (abortedSessions && job.convId) {
      abortedSessions.set(job.convId, job);
    }
    if (onStreamEvent) {
      onStreamEvent('chat_result', {
        agentId,
        convId: job.convId,
        status: 'ABORTED',
        exitCode: -1,
        response: job.streamText || '',
        error: job.error,
        usage: job.usage || null,
        endedAt: nowIso
      });
    }
    return true;
  }

  const markerJob = {
    agentId,
    convId: fallbackConvId,
    modelId: '-',
    mode: '-',
    prompt: '사용자 요청으로 실행 중단됨',
    aborted: true,
    exitCode: -1,
    endedAtMs: nowMs,
    endedAt: nowIso,
    logs: [{ time: timeStr, message: '[상태 해제] 사용자 요청으로 실행 대기 상태를 해제했습니다.', level: 'warn' }]
  };
  if (finishedJobs) {
    finishedJobs.set(agentId, markerJob);
  }
  if (abortedSessions && fallbackConvId) {
    abortedSessions.set(fallbackConvId, markerJob);
  }
  return true;
}

/**
 * Codex 세션 로그에서 표준 인수인계서 생성
 * @author Jangsung
 * @param {Object} params
 * @return {Object}
 */
function generateHandoverDocument({ agentId, convId, targetWorkspace, rulesDir, domainPath, fallbackBaseDir }) {
  const filePath = findCodexSessionPath(convId);
  if (!filePath) {
    throw new Error('Codex 세션 로그 파일을 찾을 수 없습니다: ' + convId);
  }
  const stat = fs.statSync(filePath);
  const fileSizeMB = Number((stat.size / (1024 * 1024)).toFixed(2));

  const scanSize = Math.min(stat.size, HANDOVER_SCAN_BYTES);
  const fd = fs.openSync(filePath, 'r');
  let rawChunk = '';
  try {
    const buf = Buffer.alloc(scanSize);
    fs.readSync(fd, buf, 0, scanSize, stat.size - scanSize);
    rawChunk = buf.toString('utf8');
    if (stat.size > scanSize) {
      const nl = rawChunk.indexOf('\n');
      if (nl !== -1) rawChunk = rawChunk.slice(nl + 1);
    }
  } finally {
    fs.closeSync(fd);
  }

  const items = parseJsonLines(rawChunk);
  const userPrompts = [];
  const modifiedFiles = new Map();
  const commandList = [];
  let lastStepIndex = 0;
  let latestSummaryResponse = '';

  for (const item of items) {
    if (typeof item.ordinal === 'number') {
      lastStepIndex = Math.max(lastStepIndex, item.ordinal);
    }
    if (item.type === 'event_msg' && item.payload && item.payload.type === 'item_completed' && item.payload.item && item.payload.item.type === 'UserMessage') {
      const cleaned = cleanCodexUserText(extractCodexContentText(item.payload.item.content));
      if (cleaned) {
        const parsed = extractPromptSummaryAndRaw(cleaned);
        if (parsed.raw !== '-') userPrompts.push(parsed.summary);
      }
    } else if (item.type === 'response_item' && item.payload) {
      const p = item.payload;
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const sum = summarizeCodexToolCall(p);
        if (sum.target && !commandList.includes(`${sum.name}: ${sum.target}`)) {
          commandList.push(`${sum.name}: ${sum.target}`);
        }
      } else if (p.type === 'message' && p.role === 'assistant') {
        const txt = extractCodexContentText(p.content).replace(/\s+/g, ' ').trim();
        if (txt) latestSummaryResponse = txt.slice(0, 420);
      }
    }
  }

  return writeHandoverMarkdownFile({
    agentId,
    convId,
    fileSizeMB,
    lastStepIndex,
    userPrompts,
    modifiedFiles,
    commandList,
    latestSummaryResponse,
    latestFocus: '',
    targetWorkspace,
    rulesDir,
    domainPath,
    fallbackBaseDir
  });
}

/**
 * Codex 세션 JSONL 파일 영구 삭제 (경로 이탈 차단 검증 포함)
 * @author Jangsung
 * @param {String} convId
 * @return {Boolean}
 */
function deleteCodexSession(convId) {
  if (!isValidConvId(convId)) {
    throw new Error('유효하지 않은 convId 형식입니다.');
  }
  const filePath = findCodexSessionPath(convId);
  if (!filePath) return false;
  const sessionsRoot = path.resolve(getCodexSessionsDir());
  const resolved = path.resolve(filePath);
  const rel = path.relative(sessionsRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('허용되지 않은 세션 경로입니다.');
  }
  fs.unlinkSync(resolved);
  codexFileByConvId.delete(convId);
  return true;
}

module.exports = {
  id: PROVIDER_ID,
  getCapabilities: () => ({ ...CAPABILITIES, sessionStoreDir: getCodexSessionsDir() }),
  detectCli,
  getSessionStoreDir: getCodexSessionsDir,
  readHistoryIndex: readCodexHistoryIndex,
  getModels: getAvailableModels,
  findSessionExists: convId => Boolean(findCodexSessionPath(convId)),
  scanSessions,
  readSessionMessages,
  normalizePromptOptions,
  startPromptJob: startCodexPromptJob,
  stopJob: stopCodexJob,
  generateHandover: generateHandoverDocument,
  deleteSession: deleteCodexSession
};
