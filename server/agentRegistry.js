const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readJsonSafe, normalizeFsPathKey, readCliHistoryIndex } = require('./transcript');
const { resolveAgyBin } = require('./agyRunner');

const DEFAULT_RULES_DIR = '.agents/rules';

const CANDIDATE_RULES_DIRS = [
  '.agents/rules',
  '.agent/rules',
  '.gemini/rules',
  'Rules/Personal',
  'rules',
  'Rules'
];

const ROOT_INSTRUCTION_FILES = ['AGENTS.md', 'GEMINI.md', 'HANDOVER.md'];

const IGNORED_SUBDIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-ssr',
  '.vite',
  '.vscode',
  '.idea',
  'handovers',
  'tmp',
  'temp'
]);

const IGNORED_AGENT_IDS = new Set([
  'skills',
  'skill',
  'rules',
  'rule',
  'plugins',
  'plugin',
  'workflows',
  'workflow',
  'node_modules',
  'dist',
  'docs',
  'scripts',
  'handovers',
  'common',
  'shared',
  'temp',
  'tmp'
]);

const PRESET_AGENTS = [
  {
    id: 'Master',
    name: 'Master',
    role: '팀 총괄 / PM',
    source: 'preset',
    isLead: true,
    domainPath: `${DEFAULT_RULES_DIR}/Master/RULE.md`
  }
];

let cliAgentsCache = { fetchedAt: 0, list: [] };

/**
 * 작업 경로를 OS 대소문자 구분에 무관한 정규화 키로 변환
 * @author Jangsung
 * @param {String} workspacePath
 * @return {String}
 */
function normalizeWorkspaceKey(workspacePath) {
  const resolved = path.resolve(String(workspacePath || '.'));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 규칙 하위 디렉터리 상대 경로 검증 및 정규화 (Path Traversal 차단)
 * @author Jangsung
 * @param {String} rawDir
 * @return {String}
 */
function sanitizeRulesDir(rawDir) {
  const clean = typeof rawDir === 'string' ? rawDir.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
  if (!clean || clean.includes('..') || /^[a-zA-Z]:/.test(clean)) {
    return DEFAULT_RULES_DIR;
  }
  return clean;
}

/**
 * 에이전트 ID 형식 검증
 * @author Jangsung
 * @param {String} id
 * @return {Boolean}
 */
function isValidAgentId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{2,40}$/.test(id);
}

/**
 * 폴더/파일명을 유효한 에이전트 ID([a-zA-Z0-9_-]{2,40})로 변환
 * @author Jangsung
 * @param {String} rawName
 * @return {String}
 */
function toValidAgentId(rawName) {
  const cleaned = String(rawName || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (isValidAgentId(cleaned)) return cleaned;
  let hash = 0;
  const s = String(rawName || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return `proj_${Math.abs(hash).toString(36).slice(0, 8)}`;
}

/**
 * 마크다운 문서 앞부분에서 에이전트/프로젝트 역할 요약 추출
 * @author Jangsung
 * @param {String} ruleFilePath
 * @param {String} fallbackId
 * @return {String}
 */
function extractRoleFromRuleFile(ruleFilePath, fallbackId) {
  try {
    const fd = fs.openSync(ruleFilePath, 'r');
    try {
      const buf = Buffer.alloc(1024);
      const bytes = fs.readSync(fd, buf, 0, 1024, 0);
      const head = buf.slice(0, bytes).toString('utf8');
      const lines = head.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < Math.min(lines.length, 6); i++) {
        const line = lines[i];
        if (line.startsWith('#')) {
          const title = line.replace(/^#+\s*/, '').trim();
          if (title && title.toLowerCase() !== String(fallbackId || '').toLowerCase()) {
            return title.slice(0, 48);
          }
        }
      }
      for (let i = 0; i < Math.min(lines.length, 6); i++) {
        const clean = lines[i].replace(/^#+\s*/, '').trim();
        if (clean && clean.toLowerCase() !== String(fallbackId || '').toLowerCase() && !/^[-*>]+$/.test(clean)) {
          return clean.slice(0, 48);
        }
      }
      if (lines[0]) {
        return lines[0].replace(/^#+\s*/, '').slice(0, 48);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}
  return fallbackId === 'Master' ? '팀 총괄 / PM' : '실무 에이전트';
}

/**
 * agy agents CLI 출력에서 전역 에이전트 목록 조회 (30초 캐시)
 * @author Jangsung
 * @param {Boolean} forceRefresh
 * @return {Promise<Array<Object>>}
 */
function fetchCliAgents(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && now - cliAgentsCache.fetchedAt < 30 * 1000) {
    return Promise.resolve(cliAgentsCache.list);
  }

  return new Promise(resolve => {
    execFile(resolveAgyBin(), ['agents'], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        cliAgentsCache = { fetchedAt: Date.now(), list: cliAgentsCache.list };
        resolve(cliAgentsCache.list);
        return;
      }
      const parsed = [];
      const lines = stdout.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || /^Fetching/i.test(line) || /^No agents/i.test(line)) continue;
        const parts = line.split(/\t+|\s{2,}/);
        const id = (parts[0] || '').trim();
        if (!isValidAgentId(id)) continue;
        parsed.push({
          id,
          name: id,
          role: (parts[1] || 'CLI 전역 에이전트').trim().slice(0, 48),
          source: 'cli',
          isLead: id.toLowerCase() === 'master',
          domainPath: 'agy agents'
        });
      }
      cliAgentsCache = { fetchedAt: Date.now(), list: parsed };
      resolve(parsed);
    });
  });
}

/**
 * 대상 작업 경로에서 존재하는 규칙 디렉터리를 자동 탐색
 * @author Jangsung
 * @param {String} targetWorkspace
 * @param {Boolean} strict
 * @return {String|null}
 */
function autoDetectRulesDir(targetWorkspace, strict = false) {
  if (!targetWorkspace || typeof targetWorkspace !== 'string') return strict ? null : DEFAULT_RULES_DIR;
  let firstExistingDir = null;
  for (const candidate of CANDIDATE_RULES_DIRS) {
    const full = path.join(targetWorkspace, candidate);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        if (!firstExistingDir) firstExistingDir = candidate;
        if (scanWorkspaceAgents(targetWorkspace, candidate).length > 0) {
          return candidate;
        }
      }
    } catch (_) {}
  }
  if (firstExistingDir) return firstExistingDir;
  return strict ? null : DEFAULT_RULES_DIR;
}

/**
 * 프로젝트 루트의 대표 지침 파일(AGENTS.md / GEMINI.md) 탐색
 * @author Jangsung
 * @param {String} projectDir
 * @return {String|null}
 */
function findRootInstructionFile(projectDir) {
  for (const fileName of ROOT_INSTRUCTION_FILES) {
    const abs = path.join(projectDir, fileName);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return fileName;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 대상 경로가 단일 프로젝트 루트인지(또는 다중 프로젝트 상위 폴더인지) 판별
 * @author Jangsung
 * @param {String} dirPath
 * @param {Object} historyIndex
 * @return {Boolean}
 */
function isSingleProjectRoot(dirPath, historyIndex) {
  const markers = ['.git', 'package.json'];
  for (const m of markers) {
    if (fs.existsSync(path.join(dirPath, m))) return true;
  }
  if (autoDetectRulesDir(dirPath, true)) return true;
  if (findRootInstructionFile(dirPath)) return true;
  const wsKey = normalizeFsPathKey(dirPath);
  if (historyIndex && historyIndex.byWorkspace && historyIndex.byWorkspace.has(wsKey)) return true;
  return false;
}

/**
 * 대상 프로젝트의 규칙 디렉터리(<targetWorkspace>/<rulesDir>/*) 스캔
 * 디렉터리 형태(<id>/RULE.md) 및 단일 마크다운 파일(<id>.md) 모두 지원
 * @author Jangsung
 * @param {String} targetWorkspace
 * @param {String} rulesDir
 * @return {Array<Object>}
 */
function scanWorkspaceAgents(targetWorkspace, rulesDir) {
  const safeRulesDir = sanitizeRulesDir(rulesDir);
  const absRulesDir = path.join(targetWorkspace, safeRulesDir);
  if (!fs.existsSync(absRulesDir)) return [];

  const resolvedWs = path.resolve(targetWorkspace);
  const wsKey = normalizeWorkspaceKey(resolvedWs);
  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(absRulesDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  for (let i = 0; i < entries.length; i++) {
    const ent = entries[i];
    if (ent.isDirectory()) {
      if (!isValidAgentId(ent.name) || IGNORED_AGENT_IDS.has(ent.name.toLowerCase())) continue;
      const ruleFile = path.join(absRulesDir, ent.name, 'RULE.md');
      const relRulePath = `${safeRulesDir}/${ent.name}/RULE.md`;
      const hasRule = fs.existsSync(ruleFile);
      if (!hasRule) continue; // 실제 규칙(RULE.md)이 있는 유효한 에이전트 폴더만 등록
      result.push({
        id: ent.name,
        name: ent.name,
        role: extractRoleFromRuleFile(ruleFile, ent.name),
        source: 'workspace',
        isLead: ent.name.toLowerCase() === 'master',
        domainPath: relRulePath,
        hasRuleFile: true,
        workspacePath: resolvedWs,
        workspaceKey: wsKey
      });
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      const baseName = ent.name.replace(/\.md$/i, '');
      if (!isValidAgentId(baseName) || IGNORED_AGENT_IDS.has(baseName.toLowerCase()) || /^readme$/i.test(baseName)) continue;
      const ruleFile = path.join(absRulesDir, ent.name);
      const relRulePath = `${safeRulesDir}/${ent.name}`;
      result.push({
        id: baseName,
        name: baseName,
        role: extractRoleFromRuleFile(ruleFile, baseName),
        source: 'workspace',
        isLead: baseName.toLowerCase() === 'master',
        domainPath: relRulePath,
        hasRuleFile: true,
        workspacePath: resolvedWs,
        workspaceKey: wsKey
      });
    }
  }

  // Master를 항상 목록 최상단에 정렬
  result.sort((a, b) => {
    if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return result;
}

/**
 * 프로젝트 단위의 대표 에이전트 메타 생성 (규칙 파일 / AGENTS.md / HANDOVER.md / CLI 이력 기반)
 * @author Jangsung
 * @param {String} projectDir
 * @param {Object} opts
 * @return {Object}
 */
function buildProjectAgentEntry(projectDir, { ruleAgent, rootDoc, wsHistory, relPrefix, usedIds }) {
  const resolvedDir = path.resolve(projectDir);
  const wsKey = normalizeWorkspaceKey(resolvedDir);
  const folderName = path.basename(resolvedDir);
  const prefix = relPrefix ? `${relPrefix}/` : '';

  let id = toValidAgentId(folderName);
  if (usedIds && usedIds.has(id)) {
    id = toValidAgentId(relPrefix || `${folderName}-${wsHistory ? wsHistory.convIds.length : 'p'}`);
  }
  if (usedIds && usedIds.has(id)) {
    let suffix = 2;
    while (usedIds.has(`${id}_${suffix}`)) suffix += 1;
    id = `${id}_${suffix}`.slice(0, 40);
  }
  if (usedIds) usedIds.add(id);

  let role = '';
  if (ruleAgent && ruleAgent.role && ruleAgent.role !== '실무 에이전트') {
    role = ruleAgent.role;
  } else if (rootDoc) {
    role = extractRoleFromRuleFile(path.join(resolvedDir, rootDoc), folderName);
  } else {
    const docCandidates = ['HANDOVER.md', 'README.md'];
    for (const docName of docCandidates) {
      const docPath = path.join(resolvedDir, docName);
      if (fs.existsSync(docPath)) {
        role = extractRoleFromRuleFile(docPath, folderName);
        break;
      }
    }
  }
  if (!role || role === '실무 에이전트') {
    role = (wsHistory && wsHistory.lastPrompt)
      ? wsHistory.lastPrompt.slice(0, 48)
      : 'Antigravity CLI 프로젝트';
  }

  const hasRuleSource = Boolean(ruleAgent || rootDoc);
  const domainPath = ruleAgent
    ? `${prefix}${ruleAgent.domainPath}`
    : (rootDoc
        ? `${prefix}${rootDoc}`
        : `${relPrefix || folderName} (CLI 세션 ${wsHistory ? wsHistory.convIds.length : 0}건)`);

  return {
    id,
    name: relPrefix || folderName,
    role,
    source: hasRuleSource ? 'workspace' : 'cli',
    isLead: false,
    domainPath,
    hasRuleFile: hasRuleSource,
    workspacePath: resolvedDir,
    workspaceKey: wsKey,
    defaultConvId: wsHistory && wsHistory.convIds && wsHistory.convIds[0] ? wsHistory.convIds[0] : null
  };
}

/**
 * 단일 프로젝트 경로 스캔 (규칙 디렉터리 -> AGENTS.md/GEMINI.md -> CLI 세션 이력 순)
 * @author Jangsung
 * @param {String} projectDir
 * @param {String|null} explicitRulesDir
 * @param {Object} historyIndex
 * @return {Array<Object>}
 */
function scanSingleProjectAgents(projectDir, explicitRulesDir, historyIndex) {
  const detectedRulesDir = explicitRulesDir || autoDetectRulesDir(projectDir, true);
  if (detectedRulesDir) {
    const ruleAgents = scanWorkspaceAgents(projectDir, detectedRulesDir);
    if (ruleAgents.length > 0) return ruleAgents;
  }

  const rootDoc = findRootInstructionFile(projectDir);
  const wsKey = normalizeWorkspaceKey(projectDir);
  const wsHistory = historyIndex && historyIndex.byWorkspace ? historyIndex.byWorkspace.get(wsKey) : null;
  if (rootDoc || (wsHistory && wsHistory.convIds && wsHistory.convIds.length > 0)) {
    return [
      buildProjectAgentEntry(projectDir, {
        ruleAgent: null,
        rootDoc,
        wsHistory,
        relPrefix: '',
        usedIds: new Set()
      })
    ];
  }
  return [];
}

/**
 * 다중 프로젝트 상위 폴더(<targetWorkspace>/*)에서 Antigravity CLI 프로젝트 및 규칙 에이전트 탐색
 * @author Jangsung
 * @param {String} parentWorkspace
 * @param {Object} historyIndex
 * @return {Array<Object>}
 */
function scanChildProjectAgents(parentWorkspace, historyIndex) {
  const resolvedParent = path.resolve(parentWorkspace);
  const parentKey = normalizeWorkspaceKey(resolvedParent);
  const candidateMap = new Map();

  let entries = [];
  try {
    entries = fs.readdirSync(resolvedParent, { withFileTypes: true });
  } catch (_) {
    entries = [];
  }

  for (let i = 0; i < entries.length; i++) {
    const ent = entries[i];
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.') || IGNORED_SUBDIRS.has(ent.name.toLowerCase())) continue;
    const subPath = path.join(resolvedParent, ent.name);
    candidateMap.set(normalizeWorkspaceKey(subPath), subPath);
  }

  // history.jsonl에 기록된 하위 워크스페이스(중첩 폴더 포함)도 후보에 추가
  if (historyIndex && historyIndex.byWorkspace) {
    const prefix = parentKey.endsWith(path.sep) ? parentKey : `${parentKey}${path.sep}`;
    for (const [wsKey, wsEntry] of historyIndex.byWorkspace.entries()) {
      if (wsKey.startsWith(prefix) && fs.existsSync(wsEntry.workspacePath)) {
        if (!candidateMap.has(wsKey)) {
          candidateMap.set(wsKey, wsEntry.workspacePath);
        }
      }
    }
  }

  const result = [];
  const usedIds = new Set();
  const sortedDirs = Array.from(candidateMap.entries()).sort((a, b) => a[1].localeCompare(b[1]));

  for (const [subKey, subPath] of sortedDirs) {
    const relPrefix = path.relative(resolvedParent, subPath).replace(/\\/g, '/');
    const subRulesDir = autoDetectRulesDir(subPath, true);
    const ruleAgents = subRulesDir ? scanWorkspaceAgents(subPath, subRulesDir) : [];

    if (ruleAgents.length >= 2) {
      const folderId = toValidAgentId(path.basename(subPath));
      for (const ag of ruleAgents) {
        let nextId = ag.id;
        if (usedIds.has(nextId)) {
          nextId = toValidAgentId(`${folderId}_${ag.id}`);
        }
        usedIds.add(nextId);
        result.push({
          ...ag,
          id: nextId,
          name: `${relPrefix}/${ag.name}`,
          domainPath: `${relPrefix}/${ag.domainPath}`,
          workspacePath: path.resolve(subPath),
          workspaceKey: subKey
        });
      }
      continue;
    }

    const rootDoc = findRootInstructionFile(subPath);
    const wsHistory = historyIndex && historyIndex.byWorkspace ? historyIndex.byWorkspace.get(subKey) : null;
    if (ruleAgents.length === 1 || rootDoc || (wsHistory && wsHistory.convIds && wsHistory.convIds.length > 0)) {
      result.push(buildProjectAgentEntry(subPath, {
        ruleAgent: ruleAgents[0] || null,
        rootDoc,
        wsHistory,
        relPrefix,
        usedIds
      }));
    }
  }

  return result;
}

/**
 * office_config.json에서 특정 작업 경로의 프로필(rulesDir, activeAgentIds, customAgents) 조회
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @return {Object}
 */
function readWorkspaceProfile(configFile, targetWorkspace) {
  const cfg = readJsonSafe(configFile, {});
  const workspaces = cfg && typeof cfg.workspaces === 'object' ? cfg.workspaces : {};
  const key = normalizeWorkspaceKey(targetWorkspace);
  const profile = workspaces[key] || {};
  const hasExplicitRulesDir = Boolean(typeof profile.rulesDir === 'string' && profile.rulesDir.trim());
  const rulesDir = hasExplicitRulesDir ? sanitizeRulesDir(profile.rulesDir) : autoDetectRulesDir(targetWorkspace);
  return {
    rulesDir,
    hasExplicitRulesDir,
    activeAgentIds: Array.isArray(profile.activeAgentIds) ? profile.activeAgentIds.filter(isValidAgentId) : null,
    customAgents: Array.isArray(profile.customAgents) ? profile.customAgents : []
  };
}

/**
 * office_config.json의 특정 작업 경로 프로필 저장
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {Object} patch
 * @return {Object}
 */
function writeWorkspaceProfile(configFile, targetWorkspace, patch) {
  const cfg = readJsonSafe(configFile, {});
  if (!cfg.workspaces || typeof cfg.workspaces !== 'object') {
    cfg.workspaces = {};
  }
  const key = normalizeWorkspaceKey(targetWorkspace);
  const prev = cfg.workspaces[key] || {};
  let nextRulesDir;
  if (patch.rulesDir === null) {
    nextRulesDir = null;
  } else if (patch.rulesDir !== undefined) {
    nextRulesDir = sanitizeRulesDir(patch.rulesDir);
  } else {
    nextRulesDir = prev.rulesDir ? sanitizeRulesDir(prev.rulesDir) : null;
  }
  cfg.workspaces[key] = {
    workspacePath: path.resolve(targetWorkspace),
    rulesDir: nextRulesDir,
    activeAgentIds: Array.isArray(patch.activeAgentIds)
      ? Array.from(new Set(patch.activeAgentIds.filter(isValidAgentId)))
      : (Array.isArray(prev.activeAgentIds) ? prev.activeAgentIds : null),
    customAgents: Array.isArray(patch.customAgents)
      ? patch.customAgents
      : (Array.isArray(prev.customAgents) ? prev.customAgents : [])
  };
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg.workspaces[key];
}

/**
 * 작업 경로의 Workspace/Custom/Preset/캐시된 CLI 에이전트를 즉시 동기 병합
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {Object} opts
 * @return {Object}
 */
function resolveWorkspaceAgentsSync(configFile, targetWorkspace, opts = {}) {
  const resolvedWs = path.resolve(targetWorkspace);
  const wsKey = normalizeWorkspaceKey(resolvedWs);
  const profile = readWorkspaceProfile(configFile, resolvedWs);
  const rulesDir = profile.rulesDir;
  const historyIndex = opts.historyIndex || readCliHistoryIndex();
  const includeCliAgents = opts.includeCliAgents !== false;

  let workspaceList = [];
  let workspaceMode = 'single-project';
  if (isSingleProjectRoot(resolvedWs, historyIndex)) {
    workspaceMode = 'single-project';
    workspaceList = scanSingleProjectAgents(resolvedWs, profile.hasExplicitRulesDir ? rulesDir : null, historyIndex);
  } else {
    workspaceMode = 'multi-project';
    workspaceList = scanChildProjectAgents(resolvedWs, historyIndex);
    if (workspaceList.length === 0) {
      workspaceList = scanSingleProjectAgents(resolvedWs, profile.hasExplicitRulesDir ? rulesDir : null, historyIndex);
    }
  }

  const cliList = includeCliAgents ? cliAgentsCache.list : [];

  // 우선순위 병합: workspace > cli > custom > preset
  const mergedMap = new Map();
  for (const item of workspaceList) {
    mergedMap.set(item.id, item);
  }
  for (const item of cliList) {
    if (!mergedMap.has(item.id)) {
      mergedMap.set(item.id, {
        ...item,
        workspacePath: item.workspacePath || resolvedWs,
        workspaceKey: item.workspaceKey || wsKey
      });
    }
  }
  for (const item of profile.customAgents) {
    if (item && isValidAgentId(item.id) && !mergedMap.has(item.id)) {
      const customWs = item.workspacePath ? path.resolve(item.workspacePath) : resolvedWs;
      mergedMap.set(item.id, {
        id: item.id,
        name: item.name || item.id,
        role: item.role || '사용자 정의 에이전트',
        source: 'custom',
        isLead: item.id.toLowerCase() === 'master',
        domainPath: item.domainPath || `${rulesDir}/${item.id}/RULE.md`,
        workspacePath: customWs,
        workspaceKey: normalizeWorkspaceKey(customWs),
        ruleFormat: item.ruleFormat || null
      });
    }
  }
  for (const item of PRESET_AGENTS) {
    if (!mergedMap.has(item.id)) {
      mergedMap.set(item.id, {
        ...item,
        domainPath: `${rulesDir}/${item.id}/RULE.md`,
        workspacePath: resolvedWs,
        workspaceKey: wsKey
      });
    }
  }

  const allAgents = Array.from(mergedMap.values());
  let activeAgentIds = profile.activeAgentIds;

  // 아직 팀 구성이 저장되지 않은 신규/초기 프로젝트는 workspace에 존재하는 에이전트를 기본 편성
  if (!activeAgentIds || activeAgentIds.length === 0) {
    activeAgentIds = workspaceList.length > 0
      ? workspaceList.map(a => a.id)
      : ['Master'];
  }

  const activeSet = new Set(activeAgentIds);
  const activeAgents = allAgents.filter(a => activeSet.has(a.id));
  if (activeAgents.length === 0 && allAgents.length > 0) {
    activeAgents.push(allAgents[0]);
    activeAgentIds = [allAgents[0].id];
  }

  // 다중 프로젝트 모드에서 아직 에이전트로 연결되지 않은 하위 프로젝트 폴더 목록 수집
  const candidateProjects = [];
  if (workspaceMode === 'multi-project') {
    const linkedWsKeys = new Set(
      allAgents
        .filter(a => a.source !== 'preset' && a.workspaceKey)
        .map(a => a.workspaceKey)
    );
    try {
      const entries = fs.readdirSync(resolvedWs, { withFileTypes: true });
      for (let i = 0; i < entries.length; i++) {
        const ent = entries[i];
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.') || IGNORED_SUBDIRS.has(ent.name.toLowerCase())) continue;
        const subPath = path.join(resolvedWs, ent.name);
        const subKey = normalizeWorkspaceKey(subPath);
        if (linkedWsKeys.has(subKey)) continue;
        candidateProjects.push({
          name: ent.name,
          idSuggestion: toValidAgentId(ent.name),
          path: subPath
        });
      }
      candidateProjects.sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) {}
  }

  return {
    targetWorkspace: resolvedWs,
    workspaceMode,
    rulesDir,
    candidateProjects,
    allAgents,
    activeAgentIds,
    activeAgents
  };
}

/**
 * 대상 프로젝트에 존재하는 모든 에이전트(Workspace / CLI / Custom / Preset) 및 활성 팀원 목록 비동기 조회
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {Boolean} forceRefreshCli
 * @param {Object} opts
 * @return {Promise<Object>}
 */
async function resolveWorkspaceAgents(configFile, targetWorkspace, forceRefreshCli = false, opts = {}) {
  if (opts.includeCliAgents !== false) {
    await fetchCliAgents(forceRefreshCli);
  }
  return resolveWorkspaceAgentsSync(configFile, targetWorkspace, opts);
}

/**
 * 단일 프로젝트의 규칙 하위 경로만 변경하고 즉시 재스캔 (빈 값 전달 시 자동 탐색 복원)
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {String} rawRulesDir
 * @param {Object} opts
 * @return {Promise<Object>}
 */
async function updateWorkspaceRulesDir(configFile, targetWorkspace, rawRulesDir, opts = {}) {
  const historyIndex = opts.historyIndex || readCliHistoryIndex();
  if (!isSingleProjectRoot(targetWorkspace, historyIndex)) {
    return resolveWorkspaceAgents(configFile, targetWorkspace, false, opts);
  }
  const clean = typeof rawRulesDir === 'string' ? rawRulesDir.trim() : '';
  writeWorkspaceProfile(configFile, targetWorkspace, {
    rulesDir: clean ? sanitizeRulesDir(clean) : null
  });
  return resolveWorkspaceAgents(configFile, targetWorkspace, false, opts);
}

/**
 * 대상 프로젝트의 팀원 선택 목록 및 규칙 디렉터리 저장
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {Object} payload
 * @param {Object} opts
 * @return {Promise<Object>}
 */
async function saveWorkspaceRoster(configFile, targetWorkspace, { activeAgentIds, rulesDir }, opts = {}) {
  const cleanIds = Array.isArray(activeAgentIds) ? activeAgentIds.filter(isValidAgentId) : [];
  if (cleanIds.length === 0) {
    throw new Error('함께 일할 에이전트를 최소 1명 이상 선택하세요.');
  }
  const historyIndex = opts.historyIndex || readCliHistoryIndex();
  const isSingle = isSingleProjectRoot(targetWorkspace, historyIndex);
  writeWorkspaceProfile(configFile, targetWorkspace, {
    activeAgentIds: cleanIds,
    rulesDir: isSingle ? sanitizeRulesDir(rulesDir) : null
  });
  return resolveWorkspaceAgents(configFile, targetWorkspace, false, opts);
}

/**
 * 새 에이전트 정의 생성 또는 프로젝트 폴더 연결 및 팀 편입
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {Object} payload
 * @param {Object} opts
 * @return {Promise<Object>}
 */
async function createWorkspaceAgent(configFile, targetWorkspace, payload, opts = {}) {
  const resolvedWs = path.resolve(targetWorkspace);
  const historyIndex = opts.historyIndex || readCliHistoryIndex();
  const isSingle = isSingleProjectRoot(resolvedWs, historyIndex);
  const profile = readWorkspaceProfile(configFile, resolvedWs);
  const currentSnapshot = await resolveWorkspaceAgents(configFile, resolvedWs, false, opts);

  const rawProjectPath = typeof payload.projectPath === 'string' ? payload.projectPath.trim() : '';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : '';

  let id = typeof payload.id === 'string' ? payload.id.trim() : '';
  let role = typeof payload.role === 'string' ? payload.role.trim().slice(0, 60) : '';
  let agentWorkspacePath = resolvedWs;
  let relRulePath = '';
  let ruleFormat = typeof payload.ruleFormat === 'string' ? payload.ruleFormat.trim() : '';
  let rulesDirToSave = isSingle ? sanitizeRulesDir(payload.rulesDir || profile.rulesDir) : null;

  if (rawProjectPath) {
    // 방식 A: 기존/신규 프로젝트 폴더를 에이전트로 연결
    const resolvedProject = path.isAbsolute(rawProjectPath)
      ? path.resolve(rawProjectPath)
      : path.resolve(resolvedWs, rawProjectPath);
    let stat;
    try {
      stat = fs.statSync(resolvedProject);
    } catch (_) {
      throw new Error(`존재하지 않는 프로젝트 폴더입니다: ${resolvedProject}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`폴더가 아닙니다: ${resolvedProject}`);
    }

    agentWorkspacePath = resolvedProject;
    if (!id) {
      id = toValidAgentId(path.basename(resolvedProject));
    }
    if (!isValidAgentId(id)) {
      throw new Error('에이전트 ID는 영문/숫자/_/- 조합 2~40자여야 합니다.');
    }

    if (!role) {
      for (const docName of ['AGENTS.md', 'GEMINI.md', 'HANDOVER.md', 'README.md']) {
        const docPath = path.join(resolvedProject, docName);
        if (fs.existsSync(docPath)) {
          role = extractRoleFromRuleFile(docPath, id);
          break;
        }
      }
      if (!role || role === '실무 에이전트') {
        role = '연결된 프로젝트 에이전트';
      }
    }

    if (!ruleFormat) {
      ruleFormat = payload.createRuleFile === true ? 'agents-md' : 'none';
    }

    const relFromRoot = path.relative(resolvedWs, resolvedProject).replace(/\\/g, '/');
    const displayPrefix = relFromRoot && !relFromRoot.startsWith('..')
      ? relFromRoot
      : path.basename(resolvedProject);

    let absRulePath = '';
    if (ruleFormat === 'agents-md') {
      absRulePath = path.join(resolvedProject, 'AGENTS.md');
      relRulePath = `${displayPrefix}/AGENTS.md`;
    } else if (ruleFormat === 'gemini-rule') {
      absRulePath = path.join(resolvedProject, '.gemini', 'rules', `${id}.md`);
      relRulePath = `${displayPrefix}/.gemini/rules/${id}.md`;
    } else if (ruleFormat === 'agents-rule') {
      absRulePath = path.join(resolvedProject, '.agents', 'rules', `${id}.md`);
      relRulePath = `${displayPrefix}/.agents/rules/${id}.md`;
    } else {
      ruleFormat = 'none';
      relRulePath = `${displayPrefix} (연결된 프로젝트)`;
    }

    if (absRulePath && !fs.existsSync(absRulePath)) {
      fs.mkdirSync(path.dirname(absRulePath), { recursive: true });
      const ruleBody = [
        `# ${id} - ${role}`,
        '',
        `- 역할: ${role}`,
        `- 프로젝트 경로: \`${resolvedProject}\``,
        '',
        '## 세션 시작 및 인수인계 규칙',
        '- 새 대화 시작 시 프로젝트 루트의 `HANDOVER.md`가 있으면 먼저 읽고 현재 진행 상황과 다음 작업(Next Steps)을 파악한 뒤 이어서 진행합니다.',
        '',
        '## 핵심 업무 지침',
        instructions || '- 담당 프로젝트의 설계·구현·검증을 수행하고 확인된 코드·실행 결과만 보고합니다.',
        ''
      ].join('\n');
      fs.writeFileSync(absRulePath, ruleBody, 'utf8');
    }
  } else {
    // 단일 프로젝트 내부 규칙 에이전트 추가
    if (!isSingle) {
      throw new Error('다중 프로젝트 상위 폴더에서는 연결할 프로젝트 폴더를 선택하거나 경로를 입력하세요.');
    }
    if (!isValidAgentId(id)) {
      throw new Error('에이전트 ID는 영문/숫자/_/- 조합 2~40자여야 합니다.');
    }
    if (!role) role = '전담 실무 에이전트';

    const rulesDir = rulesDirToSave || DEFAULT_RULES_DIR;
    if (!ruleFormat) {
      if (payload.createRuleFile === false) {
        ruleFormat = 'none';
      } else {
        ruleFormat = /^Rules\//i.test(rulesDir) ? 'folder' : 'md';
      }
    }

    let absRulePath = '';
    if (ruleFormat === 'folder') {
      absRulePath = path.join(resolvedWs, rulesDir, id, 'RULE.md');
      relRulePath = `${rulesDir}/${id}/RULE.md`;
    } else if (ruleFormat === 'md') {
      absRulePath = path.join(resolvedWs, rulesDir, `${id}.md`);
      relRulePath = `${rulesDir}/${id}.md`;
    } else {
      ruleFormat = 'none';
      relRulePath = `${rulesDir}/${id}.md`;
    }

    if (absRulePath && !fs.existsSync(absRulePath)) {
      fs.mkdirSync(path.dirname(absRulePath), { recursive: true });
      const ruleBody = [
        `# ${id} - ${role}`,
        '',
        `- 역할: ${role}`,
        `- 규칙 경로: \`${relRulePath}\``,
        '',
        '## 핵심 업무 지침',
        instructions || '- 담당 범위의 설계·구현·검증을 수행하고 확인된 코드·실행 결과만 보고합니다.',
        ''
      ].join('\n');
      fs.writeFileSync(absRulePath, ruleBody, 'utf8');
    }
  }

  const nextCustom = profile.customAgents.filter(c => c && c.id !== id);
  nextCustom.push({
    id,
    name: id,
    role,
    domainPath: relRulePath,
    workspacePath: agentWorkspacePath,
    workspaceKey: normalizeWorkspaceKey(agentWorkspacePath),
    ruleFormat
  });

  const nextActiveIds = Array.from(new Set([...currentSnapshot.activeAgentIds, id]));

  writeWorkspaceProfile(configFile, resolvedWs, {
    rulesDir: rulesDirToSave,
    activeAgentIds: nextActiveIds,
    customAgents: nextCustom
  });

  return resolveWorkspaceAgents(configFile, resolvedWs, false, opts);
}

/**
 * 사용자가 추가한 CUSTOM 에이전트 등록 해제 (실제 디스크 파일/프로젝트 폴더는 삭제하지 않음)
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {String} agentId
 * @param {Object} opts
 * @return {Promise<Object>}
 */
async function removeWorkspaceAgent(configFile, targetWorkspace, agentId, opts = {}) {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!isValidAgentId(id)) {
    throw new Error('유효하지 않은 에이전트 ID입니다.');
  }
  const resolvedWs = path.resolve(targetWorkspace);
  const profile = readWorkspaceProfile(configFile, resolvedWs);
  const existsInCustom = profile.customAgents.some(c => c && c.id === id);
  if (!existsInCustom) {
    throw new Error('사용자 추가(CUSTOM) 에이전트만 목록에서 제거할 수 있습니다.');
  }

  const nextCustom = profile.customAgents.filter(c => c && c.id !== id);
  const nextActive = Array.isArray(profile.activeAgentIds)
    ? profile.activeAgentIds.filter(x => x !== id)
    : null;

  const historyIndex = opts.historyIndex || readCliHistoryIndex();
  const isSingle = isSingleProjectRoot(resolvedWs, historyIndex);
  writeWorkspaceProfile(configFile, resolvedWs, {
    rulesDir: isSingle && profile.hasExplicitRulesDir ? profile.rulesDir : null,
    activeAgentIds: nextActive && nextActive.length > 0 ? nextActive : null,
    customAgents: nextCustom
  });

  return resolveWorkspaceAgents(configFile, resolvedWs, false, opts);
}

module.exports = {
  DEFAULT_RULES_DIR,
  autoDetectRulesDir,
  sanitizeRulesDir,
  isValidAgentId,
  resolveWorkspaceAgentsSync,
  resolveWorkspaceAgents,
  updateWorkspaceRulesDir,
  saveWorkspaceRoster,
  createWorkspaceAgent,
  removeWorkspaceAgent
};
