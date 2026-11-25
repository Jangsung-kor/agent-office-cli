const fs = require('fs');
const path = require('path');
const os = require('os');

// 대용량 로그 파일 I/O 부하 방지를 위해 앞 64KB, 뒤 256KB 청크만 부분 읽기
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const FALLBACK_USER_SCAN_BYTES = 1024 * 1024;
const HANDOVER_SCAN_BYTES = 2 * 1024 * 1024;
const FULL_TRANSCRIPT_SCAN_BYTES = 2 * 1024 * 1024;

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
    : [
        { id: 'Agent_BMS' },
        { id: 'Agent_Audit' },
        { id: 'Agent_QA' },
        { id: 'Agent_Dev' },
        { id: 'Master' }
      ];

  // 구체적 도메인/실무 에이전트를 우선 매칭하고, Master는 마지막에 판별함
  const nonLead = list.filter(a => a && a.id && a.id.toLowerCase() !== 'master');
  const leads = list.filter(a => a && a.id && a.id.toLowerCase() === 'master');

  for (const ag of nonLead) {
    const escapedId = escapeRegExp(ag.id);
    const re = new RegExp(`(?:Personal|Rules)[\\\\/]${escapedId}|\\b${escapedId}\\b`, 'i');
    if (re.test(str)) return ag.id;
  }

  for (const ag of leads) {
    const escapedId = escapeRegExp(ag.id);
    const re = new RegExp(`(?:Personal|Rules)[\\\\/]${escapedId}|virtual_office|office_bridge|agent-office-cli|\\b${escapedId}\\b`, 'i');
    if (re.test(str)) return ag.id;
  }
  return null;
}

/**
 * 사용자 입력 및 도구 호출 경로를 분석하여 에이전트 역할 식별
 * @author Jangsung
 * @param {String} convId
 * @param {Array<Object>} headItems
 * @param {Array<Object>} tailItems
 * @param {Object} manualMapping
 * @param {Array<Object>} activeAgents
 * @return {String|null}
 */
function detectAgentRole(convId, headItems, tailItems, manualMapping, activeAgents) {
  if (manualMapping && manualMapping[convId]) {
    const m = manualMapping[convId];
    return m === 'NONE' ? null : m;
  }

  const activeIds = new Set(Array.isArray(activeAgents) ? activeAgents.map(a => a.id) : []);

  const headUsers = headItems.filter(x => x.type === 'USER_INPUT' && typeof x.content === 'string').slice(0, 3);
  for (let i = 0; i < headUsers.length; i++) {
    const c = headUsers[i].content;
    if (activeIds.has('Master') && /가상\s*오피스|virtual\s*office|office_bridge|agent-office-cli|Personal[\\/]Master/i.test(c)) {
      return 'Master';
    }
    const matched = matchRoleFromText(c, activeAgents);
    if (matched) return matched;
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
      if (activeIds.has('Master') && /virtual_office|office_bridge|agent-office-cli|Personal[\\/]Master/i.test(p)) return 'Master';
      const r = matchRoleFromText(p, activeAgents);
      if (r) touchedRoles.add(r);
    }
  }

  if (touchedRoles.size >= 3 && activeIds.has('Master')) return 'Master';
  if (touchedRoles.size >= 1) return Array.from(touchedRoles)[0];

  const recentUsers = tailItems.filter(x => x.type === 'USER_INPUT' && typeof x.content === 'string');
  const userSample = headUsers.concat(recentUsers).map(x => x.content).join(' ');
  if (activeIds.has('Agent_BMS') && /bms|배터리|셀\s*매핑|rsc_id|rsc_key|DcimBattery/i.test(userSample)) return 'Agent_BMS';
  if (activeIds.has('Agent_Audit') && /감사\s*로그|편집\s*이력|EditHistory|audit/i.test(userSample)) return 'Agent_Audit';
  if (activeIds.has('Master') && /가상\s*오피스|virtual_office|agent-office-cli/i.test(userSample)) return 'Master';

  return null;
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
function analyzeSessionActivity(convId, stat, headText, tailText, manualMapping, logPath, activeAgents) {
  const headItems = parseJsonLines(headText);
  const tailItems = parseJsonLines(tailText);
  const role = detectAgentRole(convId, headItems, tailItems, manualMapping, activeAgents);

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
    const isPlanningTool = ['update_focus', 'read_file', 'search_web', 'ask_question'].includes(latestToolName);
    state = isPlanningTool ? 'PLANNING' : 'WORKING';
  } else if (ageSec <= 180) {
    state = isTurnFinished ? 'DONE' : 'WORKING';
  }

  const taskSummary = chosenPrompt ? chosenPrompt.summary : (latestFocus || lastResponsePreview || '-');
  const taskRaw = chosenPrompt ? chosenPrompt.raw : (latestFocus || lastResponsePreview || '-');
  const taskPreview = chosenPrompt ? chosenPrompt.preview : (latestFocus || lastResponsePreview || '-');

  let bubbleText = '대기 중';
  if (state === 'WORKING' || state === 'PLANNING') {
    bubbleText = latestFocus || (latestToolTarget ? `${latestToolName}: ${latestToolTarget}` : '작업 수행 중...');
  } else if (state === 'DONE') {
    bubbleText = latestFocus ? `완료: ${latestFocus}` : (lastResponsePreview ? `완료: ${lastResponsePreview.slice(0, 20)}` : '최근 요청 응답 완료');
  } else if (taskPreview !== '-') {
    bubbleText = `대기 (최근: ${taskPreview.slice(0, 18)})`;
  }

  return {
    convId,
    origin: 'cli',
    role,
    mtimeMs: stat.mtimeMs,
    lastActiveIso: new Date(stat.mtimeMs).toISOString(),
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
    logs: logs.slice(-25),
    titlePreview: taskPreview !== '-' ? taskPreview : convId.slice(0, 8)
  };
}

/**
 * CLI brain 디렉터리를 스캔하여 최근 24시간 내 활성 세션 목록 반환
 * @author Jangsung
 * @param {Map} sessionCache
 * @param {Object} manualMapping
 * @return {Array<Object>}
 */
function scanCliSessions(sessionCache, manualMapping, activeAgents) {
  const cliBrainDir = getCliBrainDir();
  if (!fs.existsSync(cliBrainDir)) return [];

  const detectedSessions = [];
  const dirs = fs.readdirSync(cliBrainDir, { withFileTypes: true });
  const rosterSig = Array.isArray(activeAgents) ? activeAgents.map(a => a.id).join(',') : '';

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

    if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) continue;

    const cached = sessionCache.get(convId);
    let analyzed;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.rosterSig === rosterSig) {
      const reAge = Math.max(0, (Date.now() - stat.mtimeMs) / 1000);
      analyzed = { ...cached.analyzed, origin: 'cli', ageSec: Math.round(reAge) };
      if (analyzed.state !== 'IDLE' && reAge > 180) {
        analyzed.state = 'IDLE';
        analyzed.bubbleText = analyzed.currentTask !== '-'
          ? `대기 (최근: ${analyzed.currentTask.slice(0, 18)})`
          : '대기 중';
      }
      if (manualMapping[convId]) {
        analyzed.role = manualMapping[convId] === 'NONE' ? null : manualMapping[convId];
      }
    } else {
      try {
        const { headText, tailText } = readHeadAndTail(logPath, stat.size);
        analyzed = analyzeSessionActivity(convId, stat, headText, tailText, manualMapping, logPath, activeAgents);
        sessionCache.set(convId, { mtimeMs: stat.mtimeMs, size: stat.size, rosterSig, analyzed });
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
      messages.push({
        id: `a-${step.step_index ?? i}`,
        stepIndex: step.step_index ?? i,
        role: 'assistant',
        content: text,
        toolCalls: tCalls,
        isIntermediate: tCalls.length > 0,
        isError: false,
        status: step.status || 'DONE',
        timestamp: step.created_at || null
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
    messages
  };
}

/**
 * SESSION_HANDOVER_TEMPLATE.md 표준 양식에 맞춰 인수인계서 파일 생성
 * @author Jangsung
 * @param {Object} params
 * @return {Object}
 */
function generateHandoverDocument({ agentId, convId, targetWorkspace, rulesDir, fallbackBaseDir }) {
  const found = findCliTranscriptPath(convId);
  if (!found) {
    throw new Error('CLI 세션 로그 파일을 찾을 수 없습니다: ' + convId);
  }
  const logPath = found.logPath;
  const stat = fs.statSync(logPath);
  const fileSizeMB = Number((stat.size / (1024 * 1024)).toFixed(2));
  const healthLabel = fileSizeMB >= 10 ? '위험' : (fileSizeMB >= 5 ? '주의' : '양호');

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
  const safeRulesSub = (typeof rulesDir === 'string' && rulesDir.trim() && !rulesDir.includes('..'))
    ? rulesDir.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    : 'Rules/Personal';

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

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());

  const dateTag = `${y}${m}${d}`;
  const timeTag = `${hh}${mm}`;
  const displayDt = `${y}-${m}-${d} ${hh}:${mm}`;
  const displaySec = `${displayDt}:${ss}`;

  const workspaceRulesBase = workspaceNorm ? path.join(workspaceNorm, safeRulesSub) : '';
  const hasWorkspaceRules = workspaceRulesBase && fs.existsSync(workspaceRulesBase);
  const handoverDir = hasWorkspaceRules
    ? path.join(workspaceRulesBase, agentId, 'handovers')
    : path.join(fallbackBaseDir, 'handovers', agentId);

  fs.mkdirSync(handoverDir, { recursive: true });

  const fileName = `HANDOVER_${dateTag}_${timeTag}_${agentId}.md`;
  const filePath = path.join(handoverDir, fileName);
  const relPath = hasWorkspaceRules
    ? `${safeRulesSub}/${agentId}/handovers/${fileName}`
    : `handovers/${agentId}/${fileName}`;
  const relRuleRef = `${safeRulesSub}/${agentId}/RULE.md`;

  const recentReqLines = userPrompts.slice(-5).map((p, idx) => `${idx + 1}. ${p.replace(/\n+/g, ' / ')}`);
  const fileLines = Array.from(modifiedFiles.entries()).slice(-20).map(([p, op]) => `- \`${p}\` (${op})`);
  const cmdLines = commandList.slice(-8).map(c => `- ${c}`);

  const docContent = `# [세션 인수인계서] ${agentId} (${displayDt})

- 대상 에이전트: ${agentId}
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
> ${agentId} 전담 규칙과 아래 인수인계 문서를 먼저 읽고, 4번(다음 단계)부터 작업을 이어서 진행해줘.
> - 참조 규칙: \`${relRuleRef}\`
> - 인수인계서: \`${relPath}\`
`;

  fs.writeFileSync(filePath, docContent, 'utf8');

  const agentRefinePrompt = [
    `현재 세션 로그 용량이 ${fileSizeMB} MB(${healthLabel})에 도달하여 세션을 정리하고 새 창으로 이관하려 합니다.`,
    `표준 양식(${relPath})으로 초안 파일이 이미 생성되어 있으니, 별도 파일이나 임의 제목을 새로 만들지 말고 아래 파일만 수정하여 내용을 보완해주세요.`,
    `- 대상 파일: \`${relPath}\``,
    `- 보완 요청: '2. 확정된 기술 결정 및 제약 조건', '4. 미완료 작업 및 즉시 이어갈 다음 단계', '5. 주의사항' 항목을 현재 작업 중인 코드와 맥락을 기준으로 보완해주세요.`
  ].join('\n');

  const bootstrapPrompt = [
    `너는 ${agentId} 전담 에이전트다.`,
    `먼저 아래 규칙 파일과 직전 세션 인수인계서를 읽고 작업 맥락을 확인한 뒤, 인수인계서의 '4. 미완료 작업 및 즉시 이어갈 다음 단계'부터 작업을 이어서 진행해줘.`,
    `- 전담 규칙: ${relRuleRef}`,
    `- 인수인계서: ${relPath}`
  ].join('\n');

  return {
    agentId,
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

module.exports = {
  getCliBrainDir,
  readJsonSafe,
  isValidConvId,
  findCliTranscriptPath,
  scanCliSessions,
  readSessionMessages,
  generateHandoverDocument
};
