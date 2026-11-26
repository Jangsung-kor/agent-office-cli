const fs = require('fs');
const path = require('path');
const os = require('os');

// 대용량 로그 파일 I/O 부하 방지를 위해 앞 64KB, 뒤 256KB 청크만 부분 읽기
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const FALLBACK_USER_SCAN_BYTES = 1024 * 1024;
const HANDOVER_SCAN_BYTES = 2 * 1024 * 1024;
const FULL_TRANSCRIPT_SCAN_BYTES = 2 * 1024 * 1024;
const TOKEN_FULL_SCAN_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * ISO 문자열 또는 ms 타임스탬프를 로컬 YYYY-MM-DD 날짜 키로 변환
 * @author Jangsung
 * @param {String|Number} ts
 * @return {String}
 */
function localDateKey(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 날짜별 토큰 누적 버킷 업데이트
 * @author Jangsung
 * @param {Object} byDate
 * @param {String} dateKey
 * @param {Object} delta
 */
function accumulateDailyTokens(byDate, dateKey, delta) {
  if (!byDate || !dateKey || !delta) return;
  const cur = byDate[dateKey] || {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  cur.inputTokens += Number(delta.inputTokens) || 0;
  cur.cacheReadTokens += Number(delta.cacheReadTokens) || 0;
  cur.outputTokens += Number(delta.outputTokens) || 0;
  cur.reasoningTokens += Number(delta.reasoningTokens) || 0;
  cur.totalTokens += Number(delta.totalTokens) || 0;
  byDate[dateKey] = cur;
}

/**
 * 정규화된 토큰 사용량 빈 객체 생성
 * @author Jangsung
 * @return {Object}
 */
function createEmptyTokenUsage() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    lastContextTokens: 0,
    contextWindow: null,
    model: null,
    startedAtIso: null,
    lastActiveIso: null,
    durationMs: 0,
    byDate: {},
    partial: false
  };
}

/**
 * Antigravity transcript.jsonl 스텝 목록에서 step_index 중복 제거 후 누적 토큰 및 기간 집계
 * @author Jangsung
 * @param {Array<Object>} items
 * @param {Boolean} partial
 * @param {Number|null} fallbackLastMs
 * @return {Object}
 */
function summarizeAntigravityTokens(items, partial = false, fallbackLastMs = null) {
  const usage = createEmptyTokenUsage();
  usage.partial = Boolean(partial);
  if (!Array.isArray(items) || items.length === 0) return usage;

  const stepMap = new Map();
  let seq = 0;
  let minMs = Infinity;
  let maxMs = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.created_at) {
      const ms = new Date(item.created_at).getTime();
      if (Number.isFinite(ms)) {
        if (ms < minMs) minMs = ms;
        if (ms > maxMs) maxMs = ms;
      }
    }
    if (item.type !== 'PLANNER_RESPONSE') continue;
    const key = typeof item.step_index === 'number' ? `s:${item.step_index}` : `q:${seq++}`;
    stepMap.set(key, item);
  }

  for (const step of stepMap.values()) {
    const inp = Number(step.input_tokens) || 0;
    const cache = Number(step.cache_read_tokens) || 0;
    const out = Number(step.output_tokens) || 0;
    const tot = inp + cache + out;
    if (tot > 0) {
      usage.inputTokens += inp;
      usage.cacheReadTokens += cache;
      usage.outputTokens += out;
      usage.totalTokens += tot;
      if (inp + cache > 0) {
        usage.lastContextTokens = inp + cache;
      }
      const dateKey = localDateKey(step.created_at || fallbackLastMs);
      accumulateDailyTokens(usage.byDate, dateKey, {
        inputTokens: inp,
        cacheReadTokens: cache,
        outputTokens: out,
        reasoningTokens: 0,
        totalTokens: tot
      });
    }
    if (typeof step.model === 'string' && step.model.trim()) {
      usage.model = step.model.trim();
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
 * Antigravity 세션 로그 파일 전체(또는 16MB 초과 시 꼬리 2MB)에서 토큰 합계 계산
 * @author Jangsung
 * @param {String} logPath
 * @param {Number} fileSize
 * @param {Number|null} mtimeMs
 * @return {Object}
 */
function readAntigravityTokenSummary(logPath, fileSize, mtimeMs = null) {
  try {
    if (fileSize <= TOKEN_FULL_SCAN_LIMIT_BYTES) {
      const items = parseJsonLines(fs.readFileSync(logPath, 'utf8'));
      return summarizeAntigravityTokens(items, false, mtimeMs);
    }
    const scanBytes = HANDOVER_SCAN_BYTES;
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(scanBytes);
      fs.readSync(fd, buf, 0, scanBytes, fileSize - scanBytes);
      let str = buf.toString('utf8');
      const nl = str.indexOf('\n');
      if (nl !== -1) str = str.slice(nl + 1);
      return summarizeAntigravityTokens(parseJsonLines(str), true, mtimeMs);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return createEmptyTokenUsage();
  }
}

/**
 * Antigravity CLI 전용 brain 디렉터리 경로 반환
 * 데스크톱 앱 저장소(~/.gemini/antigravity/brain)는 agy --conversation 전달 시 오류가 발생하므로 제외함
 * @author Jangsung
 * @return {String}
 */
function getCliBrainDir() {
  return process.env.ANTIGRAVITY_CLI_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
}

/**
 * 파일 시스템 경로를 OS 대소문자 규칙에 맞춰 비교 키로 정규화
 * @author Jangsung
 * @param {String} targetPath
 * @return {String}
 */
function normalizeFsPathKey(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return '';
  try {
    const resolved = path.resolve(targetPath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch (_) {
    return '';
  }
}

let historyIndexCache = { filePath: '', mtimeMs: -1, size: -1, data: null };

/**
 * ~/.gemini/antigravity-cli/history.jsonl에서 워크스페이스-세션 매핑 인덱스 조회 (mtime/size 캐시)
 * @author Jangsung
 * @return {Object}
 */
function readCliHistoryIndex() {
  const brainDir = getCliBrainDir();
  const historyPath = path.join(path.dirname(brainDir), 'history.jsonl');
  const empty = { byConvId: new Map(), byWorkspace: new Map() };
  if (!fs.existsSync(historyPath)) return empty;

  let stat;
  try {
    stat = fs.statSync(historyPath);
  } catch (_) {
    return empty;
  }

  if (
    historyIndexCache.data &&
    historyIndexCache.filePath === historyPath &&
    historyIndexCache.mtimeMs === stat.mtimeMs &&
    historyIndexCache.size === stat.size
  ) {
    return historyIndexCache.data;
  }

  const byConvId = new Map();
  const byWorkspace = new Map();

  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const convId = typeof obj.conversationId === 'string' ? obj.conversationId.trim() : '';
      const ws = typeof obj.workspace === 'string' ? obj.workspace.trim() : '';
      if (!convId || !ws || !/^[a-zA-Z0-9_-]{4,128}$/.test(convId)) continue;

      const wsResolved = path.resolve(ws);
      const wsKey = normalizeFsPathKey(wsResolved);
      const ts = typeof obj.timestamp === 'number' ? obj.timestamp : 0;
      const display = typeof obj.display === 'string'
        ? obj.display.replace(/\s+/g, ' ').trim().slice(0, 120)
        : '';

      const prevConv = byConvId.get(convId);
      if (!prevConv || ts >= prevConv.timestamp) {
        byConvId.set(convId, {
          convId,
          workspacePath: wsResolved,
          workspaceKey: wsKey,
          timestamp: ts,
          display
        });
      }

      let wsEntry = byWorkspace.get(wsKey);
      if (!wsEntry) {
        wsEntry = {
          workspacePath: wsResolved,
          workspaceKey: wsKey,
          convIds: [],
          convSet: new Set(),
          lastTimestamp: 0,
          lastPrompt: ''
        };
        byWorkspace.set(wsKey, wsEntry);
      }
      if (!wsEntry.convSet.has(convId)) {
        const logPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(logPath)) {
          wsEntry.convSet.add(convId);
          wsEntry.convIds.push({ convId, timestamp: ts });
        }
      } else if (ts > 0) {
        const existing = wsEntry.convIds.find(c => c.convId === convId);
        if (existing && ts > existing.timestamp) existing.timestamp = ts;
      }
      if (ts >= wsEntry.lastTimestamp) {
        wsEntry.lastTimestamp = ts;
        if (display && !display.startsWith('/')) {
          wsEntry.lastPrompt = display;
        }
      }
    }

    for (const entry of byWorkspace.values()) {
      entry.convIds.sort((a, b) => b.timestamp - a.timestamp);
      entry.convIds = entry.convIds.map(c => c.convId);
      delete entry.convSet;
    }
  } catch (_) {
    return empty;
  }

  const data = { byConvId, byWorkspace };
  historyIndexCache = { filePath: historyPath, mtimeMs: stat.mtimeMs, size: stat.size, data };
  return data;
}

/**
 * JSON 파일 안전 읽기
 * @author Jangsung
 * @param {String} filePath
 * @param {*} fallback
 * @return {*}
 */
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

/**
 * transcript.jsonl의 이중 인용 문자열("...") 복원
 * @author Jangsung
 * @param {*} val
 * @return {String}
 */
function unquoteArg(val) {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed;
    } catch (_) {
      s = s.slice(1, -1);
    }
  }
  return s;
}

/**
 * 경로에서 파일명만 추출
 * @author Jangsung
 * @param {String} p
 * @return {String}
 */
function baseName(p) {
  const clean = unquoteArg(p);
  if (!clean) return '';
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

/**
 * JSON Lines 안전 파싱 (청크 경계에서 잘린 줄은 무시)
 * @author Jangsung
 * @param {String} text
 * @return {Array<Object>}
 */
function parseJsonLines(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const list = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    try {
      list.push(JSON.parse(line));
    } catch (_) {
      // 불완전한 경계 줄은 건너뜀
    }
  }
  return list;
}

/**
 * 대용량 로그 파일의 앞부분(식별용)과 끝부분(실시간 상태용)만 부분 읽기
 * @author Jangsung
 * @param {String} filePath
 * @param {Number} size
 * @return {Object}
 */
function readHeadAndTail(filePath, size) {
  const fd = fs.openSync(filePath, 'r');
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      const full = buf.toString('utf8');
      return { headText: full, tailText: full, isFull: true };
    }

    const headBuf = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, headBuf, 0, HEAD_BYTES, 0);

    const tailBuf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES);

    // 멀티바이트 깨짐 및 잘린 JSON 줄 방지를 위해 첫 개행 이후부터 사용
    let tailStr = tailBuf.toString('utf8');
    const firstNl = tailStr.indexOf('\n');
    if (firstNl !== -1) tailStr = tailStr.slice(firstNl + 1);

    return {
      headText: headBuf.toString('utf8'),
      tailText: tailStr,
      isFull: false
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 정규식 메타문자 이스케이프
 * @author Jangsung
 * @param {String} str
 * @return {String}
 */
function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 문자열에서 활성 팀원 목록 기준 에이전트 역할 키워드 매칭
 * @author Jangsung
 * @param {String} str
 * @param {Array<Object>} activeAgents
 * @return {String|null}
 */
function matchRoleFromText(str, activeAgents) {
  if (!str) return null;
  const list = Array.isArray(activeAgents) && activeAgents.length > 0
    ? activeAgents
    : [{ id: 'Master' }];

  // 구체적 도메인/실무 에이전트를 우선 매칭하고, Master는 마지막에 판별함
  const nonLead = list.filter(a => a && a.id && a.id.toLowerCase() !== 'master');
  const leads = list.filter(a => a && a.id && a.id.toLowerCase() === 'master');

  for (const ag of nonLead) {
    const escapedId = escapeRegExp(ag.id);
    const re = new RegExp(`(?:rules|agents|personal)[\\\\/]${escapedId}|\\b${escapedId}\\b`, 'i');
    if (re.test(str)) return ag.id;
  }

  for (const ag of leads) {
    const escapedId = escapeRegExp(ag.id);
    const re = new RegExp(`(?:rules|agents|personal)[\\\\/]${escapedId}|virtual_office|office_bridge|agent-office-cli|\\b${escapedId}\\b`, 'i');
    if (re.test(str)) return ag.id;
  }
  return null;
}

/**
 * 후보 에이전트 목록을 대상으로 사용자 입력 및 도구 경로에서 역할 매칭
 * @author Jangsung
 * @param {Array<Object>} headItems
 * @param {Array<Object>} tailItems
 * @param {Array<Object>} candidateAgents
 * @return {String|null}
 */
function matchRoleFromList(headItems, tailItems, candidateAgents) {
  const activeIds = new Set(Array.isArray(candidateAgents) ? candidateAgents.map(a => a.id) : []);

  const headUsers = headItems.filter(x => x.type === 'USER_INPUT' && typeof x.content === 'string').slice(0, 3);
  for (let i = 0; i < headUsers.length; i++) {
    const c = headUsers[i].content;
    const matched = matchRoleFromText(c, candidateAgents);
    if (matched) return matched;
    if (activeIds.has('Master') && /가상\s*오피스|virtual\s*office|office_bridge|agent-office-cli|총괄|pm|매니저/i.test(c)) {
      return 'Master';
    }
  }

  const allSteps = headItems.slice(0, 25).concat(tailItems.slice(-25));
  const touchedRoles = new Set();
  for (let i = 0; i < allSteps.length; i++) {
    const step = allSteps[i];
    const tCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    for (let j = 0; j < tCalls.length; j++) {
      const tc = tCalls[j];
      const p = tc.args && tc.args.Path ? unquoteArg(tc.args.Path) : '';
      if (!p) continue;
      const r = matchRoleFromText(p, candidateAgents);
      if (r) touchedRoles.add(r);
      else if (activeIds.has('Master') && /virtual_office|office_bridge|agent-office-cli/i.test(p)) return 'Master';
    }
  }

  if (touchedRoles.size >= 3 && activeIds.has('Master')) return 'Master';
  if (touchedRoles.size >= 1) return Array.from(touchedRoles)[0];

  const recentUsers = tailItems.filter(x => x.type === 'USER_INPUT' && typeof x.content === 'string');
  const userSample = headUsers.concat(recentUsers).map(x => x.content).join(' ');
  if (activeIds.has('Master') && /가상\s*오피스|virtual\s*office|agent-office-cli|총괄|pm|매니저/i.test(userSample)) return 'Master';

  return null;
}

/**
 * 사용자 입력, history.jsonl 작업 경로, 도구 호출 경로를 분석하여 에이전트 역할 식별
 * @author Jangsung
 * @param {String} convId
 * @param {Array<Object>} headItems
 * @param {Array<Object>} tailItems
 * @param {Object} manualMapping
 * @param {Array<Object>} activeAgents
 * @param {Object} historyIndex
 * @return {String|null}
 */
function detectAgentRole(convId, headItems, tailItems, manualMapping, activeAgents, historyIndex) {
  if (manualMapping && manualMapping[convId]) {
    const m = manualMapping[convId];
    return m === 'NONE' ? null : m;
  }

  const activeList = Array.isArray(activeAgents) ? activeAgents : [];
  const convMeta = historyIndex && historyIndex.byConvId ? historyIndex.byConvId.get(convId) : null;

  if (convMeta && convMeta.workspaceKey) {
    const wsMatches = activeList.filter(a => a && a.workspaceKey && a.workspaceKey === convMeta.workspaceKey);
    const nonPresetMatches = wsMatches.filter(a => a.source !== 'preset');
    if (wsMatches.length === 1) {
      return wsMatches[0].id;
    }
    if (wsMatches.length > 1) {
      const scopedMatch = matchRoleFromList(headItems, tailItems, wsMatches);
      if (scopedMatch) return scopedMatch;
      if (nonPresetMatches.length === 1) return nonPresetMatches[0].id;
      const lead = wsMatches.find(a => a.isLead);
      if (lead) return lead.id;
    }
    // 활성 팀원에 워크스페이스 소속 에이전트가 명시된 경우, 외부 워크스페이스 세션이 오인 매칭되지 않도록 차단
    const hasWorkspaceScopedAgents = activeList.some(a => a && a.workspaceKey && a.source !== 'preset');
    if (hasWorkspaceScopedAgents && wsMatches.length === 0) {
      return null;
    }
  }

  return matchRoleFromList(headItems, tailItems, activeList);
}

/**
 * 사용자 프롬프트에서 메타 태그를 제거하고 원문(raw)과 핵심 요약(summary) 추출
 * @author Jangsung
 * @param {String} rawContent
 * @return {Object}
 */
function extractPromptSummaryAndRaw(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    return { raw: '-', summary: '-', preview: '-' };
  }

  let cleaned = rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .replace(/<USER_REQUEST>\s*/gi, '')
    .replace(/\s*<\/USER_REQUEST>/gi, '')
    .trim();

  if (!cleaned) return { raw: '-', summary: '-', preview: '-' };

  const raw = cleaned.length > 50000
    ? cleaned.slice(0, 50000) + '\n... (원문 50,000자 초과분 생략)'
    : cleaned;

  if (/^Comments on artifact URI:/i.test(cleaned)) {
    const afterApproval = cleaned
      .replace(/^Comments on artifact URI:[\s\S]*?The user has approved this document\.?/i, '')
      .trim();
    if (!afterApproval) {
      return { raw, summary: '구현 계획 아티팩트 승인 완료 (후속 구현 진행)', preview: '아티팩트 승인 완료' };
    }
    cleaned = afterApproval;
  }

  const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const meaningful = [];
  const actionRegex = /(구현|수정|추가|작성|개발|생성|제거|삭제|변경|정리|분석|검증|확인|테스트|조회|적용|연동|반영|매핑|설계|분리|확장|해줘|해주세요|하세요|하라|하자|나눠|잡아|늘려|바꿔|찾아|고쳐|제공해|필요|원해|\?$)/;
  const boilerplateRegex = /^(너는\s+.*에이전트다\.?|상위\s*공통\s*규칙|-\s*Rules\/|좋아\.?$|고마워\.?$|네\.?$|응\.?$|확인\.?$)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (boilerplateRegex.test(line)) continue;
    if (/^너는\s+Rules\/Personal\/.*RULE\.md/i.test(line)) continue;

    if (actionRegex.test(line) || /^(\d+[.)]|[a-z][.)]|[-*•])\s+/.test(line)) {
      meaningful.push(line);
    }
  }

  let picked = meaningful.length > 0
    ? meaningful
    : lines.filter(l => !boilerplateRegex.test(l));

  if (picked.length === 0) picked = lines;

  const summaryLines = picked.slice(0, 25);
  let summary = summaryLines.join('\n');
  if (summary.length > 2500) {
    summary = summary.slice(0, 2500) + '\n...';
  }
  const preview = summaryLines[0].replace(/\s+/g, ' ').slice(0, 72);

  return { raw, summary, preview };
}

/**
 * 잘린(truncated_fields) 단일 스텝의 content를 transcript_full.jsonl에서 복원
 * @author Jangsung
 * @param {String} logPath
 * @param {Object} stepObj
 * @return {String}
 */
function resolveFullStepContent(logPath, stepObj) {
  if (!stepObj || !logPath) return stepObj ? (stepObj.content || '') : '';
  const hasTruncated = Array.isArray(stepObj.truncated_fields) && stepObj.truncated_fields.includes('content');
  if (!hasTruncated || typeof stepObj.step_index !== 'number') {
    return stepObj.content || '';
  }

  const fullPath = path.join(path.dirname(logPath), 'transcript_full.jsonl');
  if (!fs.existsSync(fullPath)) return stepObj.content || '';

  try {
    const fStat = fs.statSync(fullPath);
    const targetStep = stepObj.step_index;
    const chunkBytes = Math.min(fStat.size, FULL_TRANSCRIPT_SCAN_BYTES);
    const fd = fs.openSync(fullPath, 'r');
    try {
      const offsets = fStat.size > chunkBytes ? [fStat.size - chunkBytes, 0] : [0];
      for (const offset of offsets) {
        const len = Math.min(chunkBytes, fStat.size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        let str = buf.toString('utf8');
        if (offset > 0) {
          const nl = str.indexOf('\n');
          if (nl !== -1) str = str.slice(nl + 1);
        }
        const lines = str.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line || line[0] !== '{') continue;
          if (!line.includes(`"step_index":${targetStep}`)) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.step_index === targetStep && typeof parsed.content === 'string') {
              return parsed.content;
            }
          } catch (_) {}
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}

  return stepObj.content || '';
}

/**
 * 256KB Tail에서 USER_INPUT을 찾지 못한 경우 최대 1MB까지 추가 역추적
 * @author Jangsung
 * @param {String} filePath
 * @param {Number} size
 * @return {Object|null}
 */
function findLatestUserInputFallback(filePath, size) {
  if (size <= TAIL_BYTES) return null;
  const scanSize = Math.min(size, FALLBACK_USER_SCAN_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(scanSize);
    fs.readSync(fd, buf, 0, scanSize, size - scanSize);
    let str = buf.toString('utf8');
    const nl = str.indexOf('\n');
    if (nl !== -1) str = str.slice(nl + 1);
    const items = parseJsonLines(str);
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].type === 'USER_INPUT' && typeof items[i].content === 'string') {
        const fullContent = resolveFullStepContent(filePath, items[i]);
        const parsed = extractPromptSummaryAndRaw(fullContent);
        if (parsed.raw !== '-') return parsed;
      }
    }
  } catch (_) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/**
 * convId 형식 검증 (Path Traversal 차단)
 * @author Jangsung
 * @param {String} convId
 * @return {Boolean}
 */
function isValidConvId(convId) {
  return typeof convId === 'string' && /^[a-zA-Z0-9_-]{4,128}$/.test(convId);
}

/**
 * CLI brain 저장소에서 convId에 해당하는 transcript.jsonl 경로 반환
 * @author Jangsung
 * @param {String} convId
 * @return {Object|null}
 */
function findCliTranscriptPath(convId) {
  if (!isValidConvId(convId)) return null;
  const logPath = path.join(getCliBrainDir(), convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(logPath)) {
    return { logPath, origin: 'cli' };
  }
  return null;
}

/**
 * 세션 로그 스텝에서 현재 상태, 말풍선, 도구, 최근 로그 추출
 * @author Jangsung
 * @param {String} convId
 * @param {fs.Stats} stat
 * @param {String} headText
 * @param {String} tailText
 * @param {Object} manualMapping
 * @param {String} logPath
 * @return {Object}
 */
function analyzeSessionActivity(convId, stat, headText, tailText, manualMapping, logPath, activeAgents, historyIndex) {
  const headItems = parseJsonLines(headText);
  const tailItems = parseJsonLines(tailText);
  const role = detectAgentRole(convId, headItems, tailItems, manualMapping, activeAgents, historyIndex);
  const convMeta = historyIndex && historyIndex.byConvId ? historyIndex.byConvId.get(convId) : null;

  const now = Date.now();
  const ageSec = Math.max(0, (now - stat.mtimeMs) / 1000);
  const fileSizeMB = Number((stat.size / (1024 * 1024)).toFixed(2));

  let firstUserItem = null;
  for (let i = 0; i < headItems.length; i++) {
    if (headItems[i].type === 'USER_INPUT' && typeof headItems[i].content === 'string') {
      firstUserItem = headItems[i];
      break;
    }
  }

  let lastUserItem = null;
  let latestFocus = '';
  let latestToolName = '';
  let latestToolTarget = '';
  let lastResponsePreview = '';
  let lastPlannerHasTools = false;
  let lastStepType = '';
  let lastStepStatus = '';
  let lastStepIndex = 0;
  const stepStatusMap = new Map();
  const logs = [];

  for (let i = 0; i < tailItems.length; i++) {
    const item = tailItems[i];
    if (typeof item.step_index === 'number') {
      lastStepIndex = Math.max(lastStepIndex, item.step_index);
      if (item.status) {
        stepStatusMap.set(item.step_index, item.status);
      }
    }
    const timeStr = item.created_at
      ? new Date(item.created_at).toTimeString().slice(0, 8)
      : new Date(stat.mtimeMs).toTimeString().slice(0, 8);

    lastStepType = item.type || '';
    lastStepStatus = item.status || '';

    if (item.type === 'USER_INPUT' && typeof item.content === 'string') {
      lastUserItem = item;
      const quickParsed = extractPromptSummaryAndRaw(item.content);
      if (quickParsed.raw !== '-') {
        logs.push({ time: timeStr, message: `[사용자 요청] ${quickParsed.preview}`, level: 'warn' });
      }
    } else if (item.type === 'PLANNER_RESPONSE') {
      const tCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      lastPlannerHasTools = tCalls.length > 0;

      if (tCalls.length > 0) {
        for (let j = 0; j < tCalls.length; j++) {
          const tc = tCalls[j];
          const args = tc.args || {};
          latestToolName = tc.name || 'tool';

          if (tc.name === 'update_focus' && args.focus) {
            latestFocus = unquoteArg(args.focus);
            logs.push({ time: timeStr, message: `[단계] ${latestFocus}`, level: 'info' });
          } else if (tc.name === 'read_file' && args.Path) {
            latestToolTarget = baseName(args.Path);
            logs.push({ time: timeStr, message: `파일 조회: ${latestToolTarget}`, level: 'info' });
          } else if ((tc.name === 'edit_file' || tc.name === 'write_file') && args.Path) {
            latestToolTarget = baseName(args.Path);
            logs.push({ time: timeStr, message: `파일 편집: ${latestToolTarget}`, level: 'info' });
          } else if (tc.name === 'run_command') {
            const sum = unquoteArg(args.toolSummary) || 'Command';
            latestToolTarget = sum;
            logs.push({ time: timeStr, message: `명령 실행: ${sum}`, level: 'info' });
          } else if (tc.name === 'search_web') {
            latestToolTarget = unquoteArg(args.query) || 'Web Search';
            logs.push({ time: timeStr, message: `웹 검색: ${latestToolTarget}`, level: 'info' });
          }
        }
      } else if (item.content && item.status === 'DONE') {
        const preview = String(item.content).replace(/\s+/g, ' ').trim().slice(0, 75);
        if (preview) {
          lastResponsePreview = preview;
          logs.push({ time: timeStr, message: `[응답 완료] ${preview}`, level: 'done' });
        }
      }
    }
  }

  let lastUserPrompt = lastUserItem
    ? extractPromptSummaryAndRaw(resolveFullStepContent(logPath, lastUserItem))
    : null;
  if (lastUserPrompt && lastUserPrompt.raw === '-') lastUserPrompt = null;

  if (!lastUserPrompt && logPath && stat.size > TAIL_BYTES) {
    lastUserPrompt = findLatestUserInputFallback(logPath, stat.size);
  }

  let firstUserPrompt = null;
  if (!lastUserPrompt && firstUserItem) {
    firstUserPrompt = extractPromptSummaryAndRaw(resolveFullStepContent(logPath, firstUserItem));
    if (firstUserPrompt.raw === '-') firstUserPrompt = null;
  }

  const chosenPrompt = lastUserPrompt || firstUserPrompt;

  let hasRunningStep = false;
  if (ageSec <= 120) {
    for (let s = Math.max(0, lastStepIndex - 1); s <= lastStepIndex; s++) {
      if (stepStatusMap.get(s) === 'RUNNING') {
        hasRunningStep = true;
        break;
      }
    }
  }

  let state = 'IDLE';
  const isTurnFinished = lastStepType === 'PLANNER_RESPONSE' && !lastPlannerHasTools && lastStepStatus === 'DONE';

  if (hasRunningStep || (!isTurnFinished && ageSec <= 40)) {
    state = 'WORKING';
  } else if (ageSec <= 180) {
    state = isTurnFinished ? 'DONE' : 'WORKING';
  }

  const taskSummary = chosenPrompt ? chosenPrompt.summary : (latestFocus || lastResponsePreview || '-');
  const taskRaw = chosenPrompt ? chosenPrompt.raw : (latestFocus || lastResponsePreview || '-');
  const taskPreview = chosenPrompt ? chosenPrompt.preview : (latestFocus || lastResponsePreview || '-');

  let bubbleText = '대기 중';
  if (state === 'WORKING') {
    bubbleText = latestFocus || (latestToolTarget ? `${latestToolName}: ${latestToolTarget}` : '작업 수행 중...');
  } else if (state === 'DONE') {
    bubbleText = latestFocus ? `완료: ${latestFocus}` : (lastResponsePreview ? `완료: ${lastResponsePreview.slice(0, 20)}` : '최근 요청 응답 완료');
  } else if (taskPreview !== '-') {
    bubbleText = `대기 (최근: ${taskPreview.slice(0, 18)})`;
  }

  const tokenUsage = logPath ? readAntigravityTokenSummary(logPath, stat.size, stat.mtimeMs) : createEmptyTokenUsage();

  let startedMs = Infinity;
  for (let i = 0; i < headItems.length; i++) {
    if (headItems[i] && headItems[i].created_at) {
      const ms = new Date(headItems[i].created_at).getTime();
      if (Number.isFinite(ms)) {
        startedMs = ms;
        break;
      }
    }
  }
  if (!Number.isFinite(startedMs) && tokenUsage.startedAtIso) {
    const ms = new Date(tokenUsage.startedAtIso).getTime();
    if (Number.isFinite(ms)) startedMs = ms;
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
    origin: 'cli',
    role,
    workspacePath: convMeta ? convMeta.workspacePath : null,
    mtimeMs: stat.mtimeMs,
    startedAtIso,
    lastActiveIso,
    durationMs,
    ageSec: Math.round(ageSec),
    fileSizeBytes: stat.size,
    fileSizeMB,
    lastStepIndex,
    state,
    bubbleText,
    currentTask: taskPreview,
    currentTaskSummary: taskSummary,
    currentTaskRaw: taskRaw,
    currentTool: latestToolName ? `${latestToolName}${latestToolTarget ? ` (${latestToolTarget})` : ''}` : '-',
    tokenUsage,
    logs: logs.slice(-25),
    titlePreview: taskPreview !== '-' ? taskPreview : convId.slice(0, 8)
  };
}

/**
 * CLI brain 디렉터리를 스캔하여 최근 CLI 세션 목록 반환 (최대 180일, 최신 80개)
 * @author Jangsung
 * @param {Map} sessionCache
 * @param {Object} manualMapping
 * @return {Array<Object>}
 */
function scanCliSessions(sessionCache, manualMapping, activeAgents) {
  const cliBrainDir = getCliBrainDir();
  if (!fs.existsSync(cliBrainDir)) return [];

  const historyIndex = readCliHistoryIndex();
  const candidates = [];
  const dirs = fs.readdirSync(cliBrainDir, { withFileTypes: true });
  const maxAgeMs = 180 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    if (!dir.isDirectory()) continue;
    const convId = dir.name;
    const logPath = path.join(cliBrainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(logPath)) continue;

    let stat;
    try {
      stat = fs.statSync(logPath);
    } catch (_) {
      continue;
    }

    if (now - stat.mtimeMs > maxAgeMs) continue;
    candidates.push({ convId, logPath, stat });
  }

  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const topCandidates = candidates.slice(0, 80);
  const rosterSig = (Array.isArray(activeAgents)
    ? activeAgents.map(a => `${a.id}:${a.source || ''}:${a.workspaceKey || ''}`).join(',')
    : '') + `|h:${historyIndexCache.mtimeMs}`;

  const detectedSessions = [];
  for (let i = 0; i < topCandidates.length; i++) {
    const { convId, logPath, stat } = topCandidates[i];
    const cached = sessionCache.get(convId);
    const manualRole = (manualMapping && manualMapping[convId]) ? String(manualMapping[convId]) : '';
    let analyzed;
    if (
      cached
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
      && cached.rosterSig === rosterSig
      && cached.manualRole === manualRole
    ) {
      const reAge = Math.max(0, (now - stat.mtimeMs) / 1000);
      analyzed = { ...cached.analyzed, origin: 'cli', ageSec: Math.round(reAge) };
      if (analyzed.state !== 'IDLE' && reAge > 180) {
        analyzed.state = 'IDLE';
        analyzed.bubbleText = analyzed.currentTask !== '-'
          ? `대기 (최근: ${analyzed.currentTask.slice(0, 18)})`
          : '대기 중';
      }
    } else {
      try {
        const { headText, tailText } = readHeadAndTail(logPath, stat.size);
        analyzed = analyzeSessionActivity(convId, stat, headText, tailText, manualMapping, logPath, activeAgents, historyIndex);
        sessionCache.set(convId, { mtimeMs: stat.mtimeMs, size: stat.size, rosterSig, manualRole, analyzed });
      } catch (_) {
        continue;
      }
    }

    detectedSessions.push(analyzed);
  }

  detectedSessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return detectedSessions;
}

/**
 * tool_call 객체를 UI 표시용 요약 객체로 변환
 * @author Jangsung
 * @param {Object} tc
 * @return {Object}
 */
function summarizeToolCall(tc) {
  const args = tc && tc.args ? tc.args : {};
  let target = '';
  if (args.Path) target = baseName(args.Path);
  else if (args.toolSummary) target = unquoteArg(args.toolSummary);
  else if (args.focus) target = unquoteArg(args.focus);
  else if (args.query) target = unquoteArg(args.query);
  else if (args.CommandLine) target = unquoteArg(args.CommandLine).slice(0, 80);

  return {
    name: (tc && tc.name) || 'tool',
    target
  };
}

/**
 * 특정 CLI 세션의 대화 스레드(USER_INPUT / PLANNER_RESPONSE)를 시간순으로 로드
 * 대용량 성능 및 중복 step_index 정리를 위해 step_index 기준으로 병합 후 최근 N개 반환
 * @author Jangsung
 * @param {String} convId
 * @param {Number} limit
 * @return {Object}
 */
function readSessionMessages(convId, limit = 150) {
  const found = findCliTranscriptPath(convId);
  if (!found) {
    throw new Error('CLI 세션을 찾을 수 없습니다: ' + convId);
  }

  const logPath = found.logPath;
  const fullPath = path.join(path.dirname(logPath), 'transcript_full.jsonl');
  const rawTranscript = fs.readFileSync(logPath, 'utf8');
  const items = parseJsonLines(rawTranscript);

  // step_index 기준 최신 상태 병합 (RUNNING -> DONE 갱신 줄 중복 제거)
  const mergedSteps = new Map();
  let autoSeq = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isErrorGeneric = item.type === 'GENERIC' && (item.status === 'ERROR' || Boolean(item.error));
    if (item.type !== 'USER_INPUT' && item.type !== 'PLANNER_RESPONSE' && !isErrorGeneric) continue;
    const key = typeof item.step_index === 'number' ? `step:${item.step_index}` : `seq:${autoSeq++}`;
    mergedSteps.set(key, item);
  }

  const steps = Array.from(mergedSteps.values());
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 150));
  const sliced = steps.length > safeLimit ? steps.slice(steps.length - safeLimit) : steps;

  // 잘린(truncated_fields) 스텝이 있을 때만 transcript_full.jsonl을 1회 파싱해 복원
  const needFullMap = sliced.some(
    s => Array.isArray(s.truncated_fields) && s.truncated_fields.includes('content') && typeof s.step_index === 'number'
  );
  const fullContentByStep = new Map();
  if (needFullMap && fs.existsSync(fullPath)) {
    try {
      const fullItems = parseJsonLines(fs.readFileSync(fullPath, 'utf8'));
      for (let i = 0; i < fullItems.length; i++) {
        const fi = fullItems[i];
        if (typeof fi.step_index === 'number' && typeof fi.content === 'string') {
          fullContentByStep.set(fi.step_index, fi.content);
        }
      }
    } catch (_) {}
  }

  const stat = fs.statSync(logPath);
  const sessionUsage = summarizeAntigravityTokens(steps, false, stat.mtimeMs);

  const messages = [];
  for (let i = 0; i < sliced.length; i++) {
    const step = sliced[i];
    const hasTruncated = Array.isArray(step.truncated_fields) && step.truncated_fields.includes('content');
    const rawContent = (hasTruncated && fullContentByStep.has(step.step_index))
      ? fullContentByStep.get(step.step_index)
      : (typeof step.content === 'string' ? step.content : '');

    if (step.type === 'USER_INPUT') {
      const parsed = extractPromptSummaryAndRaw(rawContent);
      if (parsed.raw === '-') continue;
      messages.push({
        id: `u-${step.step_index ?? i}`,
        stepIndex: step.step_index ?? i,
        role: 'user',
        content: parsed.raw,
        preview: parsed.preview,
        toolCalls: [],
        status: step.status || 'DONE',
        timestamp: step.created_at || null
      });
    } else if (step.type === 'PLANNER_RESPONSE') {
      const tCalls = Array.isArray(step.tool_calls) ? step.tool_calls.map(summarizeToolCall) : [];
      const text = rawContent.trim();
      if (!text && tCalls.length === 0) continue;
      const inp = Number(step.input_tokens) || 0;
      const cache = Number(step.cache_read_tokens) || 0;
      const out = Number(step.output_tokens) || 0;
      const msgUsage = (inp > 0 || cache > 0 || out > 0)
        ? {
            inputTokens: inp,
            cacheReadTokens: cache,
            outputTokens: out,
            reasoningTokens: 0,
            totalTokens: inp + cache + out,
            model: typeof step.model === 'string' ? step.model : null
          }
        : null;
      messages.push({
        id: `a-${step.step_index ?? i}`,
        stepIndex: step.step_index ?? i,
        role: 'assistant',
        content: text,
        toolCalls: tCalls,
        isIntermediate: tCalls.length > 0,
        isError: false,
        status: step.status || 'DONE',
        timestamp: step.created_at || null,
        usage: msgUsage
      });
    } else if (step.type === 'GENERIC') {
      const errMsg = (typeof step.error === 'string' && step.error.trim())
        ? step.error.trim()
        : rawContent.trim();
      if (!errMsg) continue;
      messages.push({
        id: `e-${step.step_index ?? i}`,
        stepIndex: step.step_index ?? i,
        role: 'assistant',
        content: errMsg,
        toolCalls: [],
        isIntermediate: false,
        isError: true,
        status: step.status || 'ERROR',
        timestamp: step.created_at || null
      });
    }
  }

  return {
    convId,
    totalSteps: steps.length,
    returnedCount: messages.length,
    sessionUsage,
    messages
  };
}

/**
 * 대상 프로젝트에서 실제 존재하는 규칙 파일 상대 경로 해석
 * @author Jangsung
 * @param {String} workspaceNorm
 * @param {String} safeRulesSub
 * @param {String} agentId
 * @param {String} domainPath
 * @return {String|null}
 */
function resolveHandoverRuleRef(workspaceNorm, safeRulesSub, agentId, domainPath) {
  if (!workspaceNorm) return null;
  const candidates = [];
  if (typeof domainPath === 'string' && domainPath.trim() && !domainPath.includes('(')) {
    const cleanDomain = domainPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    candidates.push(cleanDomain);
    const wsBasePrefix = `${path.basename(workspaceNorm)}/`;
    if (cleanDomain.startsWith(wsBasePrefix)) {
      candidates.push(cleanDomain.slice(wsBasePrefix.length));
    }
  }
  candidates.push(
    'AGENTS.md',
    'GEMINI.md',
    `${safeRulesSub}/${agentId}/RULE.md`,
    `${safeRulesSub}/${agentId}.md`
  );
  for (const rel of candidates) {
    if (!rel || rel.includes('..')) continue;
    const abs = path.join(workspaceNorm, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return rel;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 추출된 세션 활동 데이터를 기반으로 표준 인수인계서 마크다운 작성 및 저장
 * @author Jangsung
 * @param {Object} params
 * @return {Object}
 */
function writeHandoverMarkdownFile({
  agentId,
  ruleAgentId,
  convId,
  fileSizeMB,
  lastStepIndex,
  userPrompts,
  modifiedFiles,
  commandList,
  latestSummaryResponse,
  latestFocus,
  targetWorkspace,
  rulesDir,
  domainPath,
  fallbackBaseDir
}) {
  const healthLabel = fileSizeMB >= 10 ? '위험' : (fileSizeMB >= 5 ? '주의' : '양호');
  const workspaceNorm = targetWorkspace ? path.resolve(targetWorkspace) : '';
  let effectiveRulesSub = (typeof rulesDir === 'string' && rulesDir.trim() && !rulesDir.includes('..'))
    ? rulesDir.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    : '.agents/rules';
  let effectiveAgentId = (typeof ruleAgentId === 'string' && ruleAgentId.trim()) ? ruleAgentId.trim() : agentId;

  // 다중 프로젝트 모드에서 domainPath(<project>/<rulesDir>/<agent>/RULE.md)가 전달되면 실제 하위 규칙 디렉터리를 우선 해석
  if (workspaceNorm && typeof domainPath === 'string' && domainPath.trim() && !domainPath.includes('..')) {
    let cleanDomain = domainPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const wsBasePrefix = `${path.basename(workspaceNorm)}/`;
    if (cleanDomain.startsWith(wsBasePrefix)) {
      cleanDomain = cleanDomain.slice(wsBasePrefix.length);
    }
    const ruleMatch = cleanDomain.match(/^(.+)\/([^/]+)\/RULE\.md$/i);
    if (ruleMatch && fs.existsSync(path.join(workspaceNorm, cleanDomain))) {
      effectiveRulesSub = ruleMatch[1];
      effectiveAgentId = ruleMatch[2];
    }
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());

  const displayDt = `${y}-${m}-${d} ${hh}:${mm}`;
  const displaySec = `${displayDt}:${ss}`;

  const workspaceRulesBase = workspaceNorm ? path.join(workspaceNorm, effectiveRulesSub) : '';
  const hasPerAgentRuleDir = Boolean(workspaceRulesBase && fs.existsSync(path.join(workspaceRulesBase, effectiveAgentId, 'RULE.md')));
  const relRuleRef = resolveHandoverRuleRef(workspaceNorm, effectiveRulesSub, effectiveAgentId, domainPath);

  let targetDir = '';
  let relDir = '';

  if (hasPerAgentRuleDir) {
    // 다중 에이전트 프로젝트: Rules/Personal/<Agent_Name>/HANDOVER.md
    targetDir = path.join(workspaceRulesBase, effectiveAgentId);
    relDir = `${effectiveRulesSub}/${effectiveAgentId}`;
  } else if (workspaceNorm) {
    // 단일 프로젝트: <workspace>/HANDOVER.md
    targetDir = workspaceNorm;
    relDir = '';
  } else {
    targetDir = path.join(fallbackBaseDir, 'handovers', effectiveAgentId);
    relDir = `handovers/${effectiveAgentId}`;
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // 정본 HANDOVER.md 존재 시 덮어쓰지 않고 HANDOVER.draft.md로 임시 생성해 병합 유도
  const canonicalPath = path.join(targetDir, 'HANDOVER.md');
  const isExistingHandover = fs.existsSync(canonicalPath);
  const fileName = isExistingHandover ? 'HANDOVER.draft.md' : 'HANDOVER.md';
  const filePath = path.join(targetDir, fileName);
  const relPath = relDir ? `${relDir}/${fileName}` : fileName;
  const bootstrapHandoverPath = relDir ? `${relDir}/HANDOVER.md` : 'HANDOVER.md';
  const recentReqLines = userPrompts.slice(-5).map((p, idx) => `${idx + 1}. ${p.replace(/\n+/g, ' / ')}`);
  const fileLines = Array.from(modifiedFiles.entries()).slice(-20).map(([p, op]) => `- \`${p}\` (${op})`);
  const cmdLines = commandList.slice(-8).map(c => `- ${c}`);

  const docContent = `# [세션 인수인계서] ${effectiveAgentId} (${displayDt})

- 대상 에이전트: ${effectiveAgentId}
- 정리 시점 상태: ${healthLabel} (${fileSizeMB} MB / Step ${lastStepIndex.toLocaleString()})
- 원본 세션 ID: \`${convId}\`
- 작성 일시: ${displaySec}

---

## 1. 현재 수행 과업 및 최종 목표
${recentReqLines.length > 0 ? recentReqLines.join('\n') : '- (최근 사용자 요청 기록 없음)'}
${latestFocus ? `- 마지막 진행 단계: ${latestFocus}` : ''}

## 2. 확정된 기술 결정 및 제약 조건
- 본 문서는 세션 로그에서 자동 추출된 초안입니다. 확정된 스키마/설계 제약이 있다면 기존 세션에서 아래 항목으로 보완하거나 최신 응답 요약을 참조하세요.
${latestSummaryResponse ? `- 최근 에이전트 보고 요약: ${latestSummaryResponse}` : '- (최근 요약 없음)'}

## 3. 완료된 작업 및 변경 파일 목록
${fileLines.length > 0 ? fileLines.join('\n') : '- (최근 스캔 범위 내 직접 수정/생성 파일 없음)'}

## 4. 미완료 작업 및 즉시 이어갈 다음 단계
1. 위 1번 과업 및 최근 변경 파일 기준으로 미완료 구현·검증 항목 이어서 진행
${cmdLines.length > 0 ? `\n### 참고: 최근 실행 명령 이력\n${cmdLines.join('\n')}` : ''}

## 5. 주의사항 및 미해결 이슈
- 원본 세션 용량이 ${fileSizeMB} MB(${healthLabel})에 도달하여 컨텍스트 압축 누락을 방지하기 위해 새 세션 전환을 권장합니다.

## 6. 새 세션 시작용 복구 프롬프트 (Bootstrap Prompt)
> ${relRuleRef ? '아래 규칙과 ' : ''}인수인계 문서를 먼저 읽고, 4번(다음 단계)부터 작업을 이어서 진행해줘.
${relRuleRef ? `> - 참조 규칙: \`${relRuleRef}\`\n` : ''}> - 인수인계서: \`${bootstrapHandoverPath}\`
`;

  fs.writeFileSync(filePath, docContent, 'utf8');

  const agentRefinePrompt = isExistingHandover
    ? [
        `현재 세션 로그 용량이 ${fileSizeMB} MB(${healthLabel})에 도달하여 \`${bootstrapHandoverPath}\`를 최신 상태로 갱신하려 합니다.`,
        `기존 \`${bootstrapHandoverPath}\`를 보존하기 위해 새 세션 요약 초안을 \`${relPath}\`에 생성했습니다.`,
        `- 요청 사항: \`${relPath}\`의 최근 작업 내용과 변경 파일을 검토하여 기존 \`${bootstrapHandoverPath}\`를 최신 내용으로 병합·갱신한 뒤, 임시 초안 파일(\`${relPath}\`)은 삭제해주세요.`
      ].join('\n')
    : [
        `현재 세션 로그 용량이 ${fileSizeMB} MB(${healthLabel})에 도달하여 세션을 정리하고 새 창으로 이관하려 합니다.`,
        `표준 양식(${relPath})으로 초안 파일이 이미 생성되어 있으니, 별도 파일이나 임의 제목을 새로 만들지 말고 아래 파일만 수정하여 내용을 보완해주세요.`,
        `- 대상 파일: \`${relPath}\``,
        `- 보완 요청: '2. 확정된 기술 결정 및 제약 조건', '4. 미완료 작업 및 즉시 이어갈 다음 단계', '5. 주의사항' 항목을 현재 작업 중인 코드와 맥락을 기준으로 보완해주세요.`
      ].join('\n');

  const bootstrapLines = [
    `너는 ${effectiveAgentId} 담당 에이전트다.`,
    `먼저 ${relRuleRef ? '아래 규칙 파일과 ' : ''}직전 세션 인수인계서를 읽고 작업 맥락을 확인한 뒤, 인수인계서의 '4. 미완료 작업 및 즉시 이어갈 다음 단계'부터 작업을 이어서 진행해줘.`
  ];
  if (relRuleRef) bootstrapLines.push(`- 참조 규칙: ${relRuleRef}`);
  bootstrapLines.push(`- 인수인계서: ${bootstrapHandoverPath}`);
  const bootstrapPrompt = bootstrapLines.join('\n');

  return {
    agentId,
    ruleAgentId: effectiveAgentId,
    convId,
    fileName,
    filePath,
    relPath,
    fileSizeMB,
    healthLabel,
    content: docContent,
    agentRefinePrompt,
    bootstrapPrompt
  };
}

/**
 * SESSION_HANDOVER_TEMPLATE.md 표준 양식에 맞춰 인수인계서 파일 생성
 * @author Jangsung
 * @param {Object} params
 * @return {Object}
 */
function generateHandoverDocument({ agentId, ruleAgentId, convId, targetWorkspace, rulesDir, domainPath, fallbackBaseDir }) {
  const found = findCliTranscriptPath(convId);
  if (!found) {
    throw new Error('CLI 세션 로그 파일을 찾을 수 없습니다: ' + convId);
  }
  const logPath = found.logPath;
  const stat = fs.statSync(logPath);
  const fileSizeMB = Number((stat.size / (1024 * 1024)).toFixed(2));

  const scanSize = Math.min(stat.size, HANDOVER_SCAN_BYTES);
  const fd = fs.openSync(logPath, 'r');
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
  let latestFocus = '';

  const workspaceNorm = targetWorkspace ? path.resolve(targetWorkspace) : '';

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item.step_index === 'number') {
      lastStepIndex = Math.max(lastStepIndex, item.step_index);
    }
    if (item.type === 'USER_INPUT' && typeof item.content === 'string') {
      const fullContent = resolveFullStepContent(logPath, item);
      const parsed = extractPromptSummaryAndRaw(fullContent);
      if (parsed.raw !== '-') userPrompts.push(parsed.summary);
    } else if (item.type === 'PLANNER_RESPONSE') {
      const tCalls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
      for (let j = 0; j < tCalls.length; j++) {
        const tc = tCalls[j];
        const args = tc.args || {};
        if ((tc.name === 'edit_file' || tc.name === 'write_file') && args.Path) {
          let p = unquoteArg(args.Path);
          if (workspaceNorm && p.toLowerCase().startsWith(workspaceNorm.toLowerCase())) {
            p = p.slice(workspaceNorm.length).replace(/^[\\/]+/, '');
          }
          modifiedFiles.set(p, tc.name);
        } else if (tc.name === 'run_command' && args.toolSummary) {
          const sum = unquoteArg(args.toolSummary);
          if (sum && !commandList.includes(sum)) commandList.push(sum);
        } else if (tc.name === 'update_focus' && args.focus) {
          latestFocus = unquoteArg(args.focus);
        }
      }
      if (item.content && item.status === 'DONE' && tCalls.length === 0) {
        const cleanedResp = String(item.content).replace(/\s+/g, ' ').trim();
        if (cleanedResp) latestSummaryResponse = cleanedResp.slice(0, 420);
      }
    }
  }

  return writeHandoverMarkdownFile({
    agentId,
    ruleAgentId,
    convId,
    fileSizeMB,
    lastStepIndex,
    userPrompts,
    modifiedFiles,
    commandList,
    latestSummaryResponse,
    latestFocus,
    targetWorkspace,
    rulesDir,
    domainPath,
    fallbackBaseDir
  });
}

/**
 * Antigravity CLI 세션 폴더 영구 삭제 (경로 이탈 차단 검증 포함)
 * @author Jangsung
 * @param {String} convId
 * @return {Boolean}
 */
function deleteCliSession(convId) {
  if (!isValidConvId(convId)) {
    throw new Error('유효하지 않은 convId 형식입니다.');
  }
  const brainDir = path.resolve(getCliBrainDir());
  const sessionDir = path.resolve(brainDir, convId);
  const rel = path.relative(brainDir, sessionDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('허용되지 않은 세션 경로입니다.');
  }
  if (!fs.existsSync(sessionDir)) {
    return false;
  }
  fs.rmSync(sessionDir, { recursive: true, force: true });
  return true;
}

module.exports = {
  getCliBrainDir,
  normalizeFsPathKey,
  readCliHistoryIndex,
  readJsonSafe,
  parseJsonLines,
  readHeadAndTail,
  createEmptyTokenUsage,
  localDateKey,
  accumulateDailyTokens,
  extractPromptSummaryAndRaw,
  matchRoleFromList,
  resolveHandoverRuleRef,
  writeHandoverMarkdownFile,
  isValidConvId,
  findCliTranscriptPath,
  scanCliSessions,
  readSessionMessages,
  generateHandoverDocument,
  deleteCliSession
};
