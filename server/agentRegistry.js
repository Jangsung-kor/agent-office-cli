const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readJsonSafe } = require('./transcript');
const { resolveAgyBin } = require('./agyRunner');

const DEFAULT_RULES_DIR = 'Rules/Personal';

const PRESET_AGENTS = [
  {
    id: 'Master',
    name: 'Master',
    role: '팀 총괄 / PM',
    source: 'preset',
    isLead: true,
    domainPath: 'Rules/Personal/Master/RULE.md'
  },
  {
    id: 'Agent_FE',
    name: 'Agent_FE',
    role: '프론트엔드 / UI',
    source: 'preset',
    isLead: false,
    domainPath: 'Rules/Personal/Agent_FE/RULE.md'
  },
  {
    id: 'Agent_BE',
    name: 'Agent_BE',
    role: '백엔드 / API',
    source: 'preset',
    isLead: false,
    domainPath: 'Rules/Personal/Agent_BE/RULE.md'
  },
  {
    id: 'Agent_QA',
    name: 'Agent_QA',
    role: '품질 검증 / QA',
    source: 'preset',
    isLead: false,
    domainPath: 'Rules/Personal/Agent_QA/RULE.md'
  },
  {
    id: 'Agent_Review',
    name: 'Agent_Review',
    role: '코드 리뷰 / 보안',
    source: 'preset',
    isLead: false,
    domainPath: 'Rules/Personal/Agent_Review/RULE.md'
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
 * RULE.md 앞부분에서 에이전트 역할 요약 추출
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
          if (title && title.toLowerCase() !== fallbackId.toLowerCase()) {
            return title.slice(0, 48);
          }
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
 * 대상 프로젝트의 규칙 디렉터리(<targetWorkspace>/<rulesDir>/*) 스캔
 * @author Jangsung
 * @param {String} targetWorkspace
 * @param {String} rulesDir
 * @return {Array<Object>}
 */
function scanWorkspaceAgents(targetWorkspace, rulesDir) {
  const safeRulesDir = sanitizeRulesDir(rulesDir);
  const absRulesDir = path.join(targetWorkspace, safeRulesDir);
  if (!fs.existsSync(absRulesDir)) return [];

  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(absRulesDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  for (let i = 0; i < entries.length; i++) {
    const ent = entries[i];
    if (!ent.isDirectory() || !isValidAgentId(ent.name)) continue;
    const ruleFile = path.join(absRulesDir, ent.name, 'RULE.md');
    const relRulePath = `${safeRulesDir}/${ent.name}/RULE.md`;
    const hasRule = fs.existsSync(ruleFile);
    result.push({
      id: ent.name,
      name: ent.name,
      role: hasRule ? extractRoleFromRuleFile(ruleFile, ent.name) : '규칙 폴더 (RULE.md 미작성)',
      source: 'workspace',
      isLead: ent.name.toLowerCase() === 'master',
      domainPath: relRulePath,
      hasRuleFile: hasRule
    });
  }

  // Master를 항상 목록 최상단에 정렬
  result.sort((a, b) => {
    if (a.isLead !== b.isLead) return a.isLead ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
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
  return {
    rulesDir: sanitizeRulesDir(profile.rulesDir),
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
  cfg.workspaces[key] = {
    workspacePath: path.resolve(targetWorkspace),
    rulesDir: sanitizeRulesDir(patch.rulesDir !== undefined ? patch.rulesDir : prev.rulesDir),
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
 * @return {Object}
 */
function resolveWorkspaceAgentsSync(configFile, targetWorkspace) {
  const profile = readWorkspaceProfile(configFile, targetWorkspace);
  const rulesDir = profile.rulesDir;
  const workspaceList = scanWorkspaceAgents(targetWorkspace, rulesDir);
  const cliList = cliAgentsCache.list;

  // 우선순위 병합: workspace > cli > custom > preset
  const mergedMap = new Map();
  for (const item of workspaceList) {
    mergedMap.set(item.id, item);
  }
  for (const item of cliList) {
    if (!mergedMap.has(item.id)) mergedMap.set(item.id, item);
  }
  for (const item of profile.customAgents) {
    if (item && isValidAgentId(item.id) && !mergedMap.has(item.id)) {
      mergedMap.set(item.id, {
        id: item.id,
        name: item.name || item.id,
        role: item.role || '사용자 정의 에이전트',
        source: 'custom',
        isLead: item.id.toLowerCase() === 'master',
        domainPath: item.domainPath || `${rulesDir}/${item.id}/RULE.md`
      });
    }
  }
  for (const item of PRESET_AGENTS) {
    if (!mergedMap.has(item.id)) {
      mergedMap.set(item.id, {
        ...item,
        domainPath: `${rulesDir}/${item.id}/RULE.md`
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

  return {
    targetWorkspace: path.resolve(targetWorkspace),
    rulesDir,
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
 * @return {Promise<Object>}
 */
async function resolveWorkspaceAgents(configFile, targetWorkspace, forceRefreshCli = false) {
  await fetchCliAgents(forceRefreshCli);
  return resolveWorkspaceAgentsSync(configFile, targetWorkspace);
}

/**
 * 대상 프로젝트의 팀원 선택 목록 및 규칙 디렉터리 저장
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {Object} payload
 * @return {Promise<Object>}
 */
async function saveWorkspaceRoster(configFile, targetWorkspace, { activeAgentIds, rulesDir }) {
  const cleanIds = Array.isArray(activeAgentIds) ? activeAgentIds.filter(isValidAgentId) : [];
  if (cleanIds.length === 0) {
    throw new Error('함께 일할 에이전트를 최소 1명 이상 선택하세요.');
  }
  writeWorkspaceProfile(configFile, targetWorkspace, {
    activeAgentIds: cleanIds,
    rulesDir: sanitizeRulesDir(rulesDir)
  });
  return resolveWorkspaceAgents(configFile, targetWorkspace, false);
}

/**
 * 새 에이전트 정의 생성 (필요 시 <targetWorkspace>/<rulesDir>/<id>/RULE.md 생성) 및 팀 편입
 * @author Jangsung
 * @param {String} configFile
 * @param {String} targetWorkspace
 * @param {Object} payload
 * @return {Promise<Object>}
 */
async function createWorkspaceAgent(configFile, targetWorkspace, payload) {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!isValidAgentId(id)) {
    throw new Error('에이전트 ID는 영문/숫자/_/- 조합 2~40자여야 합니다.');
  }
  const role = (typeof payload.role === 'string' && payload.role.trim())
    ? payload.role.trim().slice(0, 60)
    : '전담 실무 에이전트';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : '';
  const createRuleFile = payload.createRuleFile !== false;

  const profile = readWorkspaceProfile(configFile, targetWorkspace);
  const rulesDir = sanitizeRulesDir(payload.rulesDir || profile.rulesDir);
  const relRulePath = `${rulesDir}/${id}/RULE.md`;
  // RULE.md 생성 전에 현재 활성 팀원 목록을 먼저 스냅샷해야 기존 기본 팀원(Master 등)이 유지됨
  const currentSnapshot = await resolveWorkspaceAgents(configFile, targetWorkspace, false);

  if (createRuleFile) {
    const absAgentDir = path.join(targetWorkspace, rulesDir, id);
    const absRulePath = path.join(absAgentDir, 'RULE.md');
    fs.mkdirSync(absAgentDir, { recursive: true });
    // 기존에 이미 작성된 RULE.md가 있으면 덮어쓰지 않고 보존함
    if (!fs.existsSync(absRulePath)) {
      const ruleBody = [
        `# ${id} - ${role}`,
        '',
        `- 역할: ${role}`,
        `- 규칙 경로: \`${relRulePath}\``,
        '',
        '## 핵심 업무 지침',
        instructions ? instructions : '- 담당 범위의 설계·구현·검증을 수행하고 확인된 코드·실행 결과만 보고합니다.',
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
    domainPath: relRulePath
  });

  const nextActiveIds = Array.from(new Set([...currentSnapshot.activeAgentIds, id]));

  writeWorkspaceProfile(configFile, targetWorkspace, {
    rulesDir,
    activeAgentIds: nextActiveIds,
    customAgents: nextCustom
  });

  return resolveWorkspaceAgents(configFile, targetWorkspace, false);
}

module.exports = {
  DEFAULT_RULES_DIR,
  sanitizeRulesDir,
  isValidAgentId,
  resolveWorkspaceAgentsSync,
  resolveWorkspaceAgents,
  saveWorkspaceRoster,
  createWorkspaceAgent
};
