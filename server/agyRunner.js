const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { readJsonSafe } = require('./transcript');

const FALLBACK_MODELS = [
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' }
];

const ALLOWED_MODES = ['plan', 'accept-edits', 'auto'];
const ALLOWED_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;

let modelCache = { fetchedAt: 0, list: [] };

/**
 * 모델 ID와 --effort 플래그 충돌을 방지하는 실행 인자 해석
 * Gemini 등 모델 ID 자체에 effort 접미사가 포함된 경우 동일 계열 variant로 전환하거나 --effort를 생략함
 * @author Jangsung
 * @param {String} modelId
 * @param {String} effort
 * @return {Object}
 */
function resolveModelAndEffort(modelId, effort) {
  const safeEffort = ALLOWED_EFFORTS.includes(effort) ? effort : 'auto';
  if (!safeEffort || safeEffort === 'auto') {
    return { effectiveModel: modelId, effectiveEffort: '' };
  }

  if (EFFORT_SUFFIX_RE.test(modelId)) {
    const base = modelId.replace(EFFORT_SUFFIX_RE, '');
    const candidate = `${base}-${safeEffort}`;
    const hasVariant = modelCache.list.some(m => m.id === candidate);
    if (hasVariant) {
      return { effectiveModel: candidate, effectiveEffort: '' };
    }
    return { effectiveModel: modelId, effectiveEffort: '' };
  }

  return { effectiveModel: modelId, effectiveEffort: safeEffort };
}

/**
 * Antigravity CLI 실행 파일 경로 해석
 * @author Jangsung
 * @return {String}
 */
function resolveAgyBin() {
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) {
    return process.env.AGY_BIN;
  }
  const localAgy = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'agy',
    'bin',
    'agy.exe'
  );
  if (fs.existsSync(localAgy)) {
    return localAgy;
  }
  return 'agy';
}

/**
 * agy models 출력 결과를 파싱하여 사용 가능한 모델 목록 조회 (5분 캐시)
 * @author Jangsung
 * @param {Boolean} forceRefresh
 * @return {Promise<Array<Object>>}
 */
function getAvailableModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && modelCache.list.length > 0 && now - modelCache.fetchedAt < 5 * 60 * 1000) {
    return Promise.resolve(modelCache.list);
  }

  return new Promise(resolve => {
    execFile(resolveAgyBin(), ['models'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        resolve(modelCache.list.length > 0 ? modelCache.list : FALLBACK_MODELS);
        return;
      }
      const parsed = [];
      const lines = stdout.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || /^Fetching/i.test(line)) continue;
        const tabParts = line.split(/\t+/);
        if (tabParts.length >= 2) {
          parsed.push({ id: tabParts[0].trim(), label: tabParts[1].trim() });
        }
      }
      if (parsed.length > 0) {
        modelCache = { fetchedAt: Date.now(), list: parsed };
        resolve(parsed);
      } else {
        resolve(modelCache.list.length > 0 ? modelCache.list : FALLBACK_MODELS);
      }
    });
  });
}

/**
 * agy.exe CLI 비동기 실행 및 stream-json 실시간 이벤트 스트리밍
 * @author Jangsung
 * @param {Object} params
 * @return {Object}
 */
function startAgyPromptJob({
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
  // agy CLI는 -p 뒤에 다른 플래그가 오면 플래그를 프롬프트로 오인하므로 -p= 형태로 맨 마지막에 배치
  const safePrompt = prompt.startsWith('-') ? ' ' + prompt : prompt;
  const safeMode = ALLOWED_MODES.includes(mode) ? mode : 'plan';
  const { effectiveModel, effectiveEffort } = resolveModelAndEffort(modelId, effort);

  const args = ['--model', effectiveModel, '--mode', safeMode, '--output-format', 'stream-json'];
  if (effectiveEffort) {
    args.push('--effort', effectiveEffort);
  }
  if (convId) {
    args.push('--conversation', convId);
  }
  args.push(`-p=${safePrompt}`);

  const agyBin = resolveAgyBin();
  const child = spawn(agyBin, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const job = {
    pid: child.pid,
    child,
    agentId,
    convId: convId || null,
    modelId: effectiveModel,
    effort: effectiveEffort || 'auto',
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
        message: `[CLI 시작] 모델=${effectiveModel}${effectiveEffort ? `, 강도=${effectiveEffort}` : ''}, 모드=${safeMode}${convId ? `, 세션=${convId.slice(0, 8)}` : ' (새 세션)'}`,
        level: 'warn'
      }
    ]
  };
  runningJobs.set(agentId, job);

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
      if (job.aborted) return;
      const line = lines[i].trim();
      if (!line) continue;
      appendRawLine(line);
      if (line[0] !== '{') {
        appendLog(line);
        continue;
      }

      try {
        const obj = JSON.parse(line);
        if (obj.event === 'init' && obj.conversation_id) {
          job.convId = obj.conversation_id;
          appendLog(`[세션 연결] ID=${obj.conversation_id.slice(0, 8)}`, 'info');
          if (!convId && mappingFile) {
            const mapping = readJsonSafe(mappingFile, {});
            for (const k of Object.keys(mapping)) {
              if (mapping[k] === agentId) delete mapping[k];
            }
            mapping[obj.conversation_id] = agentId;
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
        } else if (obj.event === 'step_update' && obj.step_update) {
          const su = obj.step_update;
          if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
            job.streamText += su.text_delta;
          }
          if (su.step_type) {
            job.activeTool = su.step_type;
          }
          if (su.usage) {
            job.usage = su.usage;
          }
          if (su.state === 'DONE' && su.step_type === 'agent_response' && su.usage) {
            const dur = su.duration_seconds ? ` (${su.duration_seconds.toFixed(1)}s)` : '';
            appendLog(`[토큰 사용] total=${su.usage.total_tokens || 0}${dur}`, 'info');
          }
          if (onStreamEvent) {
            onStreamEvent('chat_delta', {
              agentId,
              convId: job.convId,
              eventType: 'step_update',
              stepType: su.step_type || '',
              state: su.state || '',
              textDelta: typeof su.text_delta === 'string' ? su.text_delta : '',
              accumulatedText: job.streamText,
              usage: su.usage || null,
              durationSeconds: su.duration_seconds || null,
              rawLine: line
            });
          }
        } else if (obj.event === 'result' && obj.result) {
          const r = obj.result;
          if (r.conversation_id && !job.convId) {
            job.convId = r.conversation_id;
          }
          const tok = r.usage && r.usage.total_tokens ? `, tokens=${r.usage.total_tokens}` : '';
          const fullResp = r.response ? String(r.response) : job.streamText;
          const errText = r.error ? String(r.error) : null;
          const preview = (fullResp || errText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          job.finalResponse = fullResp;
          job.responsePreview = preview;
          if (errText) job.error = errText;
          if (r.usage) job.usage = r.usage;
          job.resultEmitted = true;

          if (errText || r.status === 'ERROR') {
            appendLog(`[CLI 오류] ${errText || preview || '실행 실패'}`, 'warn');
          } else {
            appendLog(`[CLI 응답 완료${tok}] ${preview}`, 'done');
          }

          if (onStreamEvent) {
            onStreamEvent('chat_result', {
              agentId,
              convId: job.convId,
              status: r.status || 'SUCCESS',
              response: fullResp,
              error: errText,
              usage: r.usage || job.usage || null,
              rawLine: line,
              endedAt: new Date().toISOString()
            });
          }
        } else if (obj.error) {
          appendLog(`[CLI 오류] ${obj.error}`, 'warn');
          if (onStreamEvent) {
            onStreamEvent('chat_delta', {
              agentId,
              convId: job.convId,
              eventType: 'error',
              error: String(obj.error),
              textDelta: '',
              accumulatedText: job.streamText,
              rawLine: line
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
      appendLog(`[CLI 종료] exit=${code}`, code === 0 ? 'done' : 'warn');
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
        error: errMsg || job.error || (code !== 0 ? `CLI 종료 코드 ${code}` : null),
        usage: job.usage || null,
        endedAt: job.endedAt
      });
    }
    if (onStateChange) onStateChange();
  };

  child.on('error', err => finalizeJob(-1, err.message));
  child.on('close', code => {
    // error 이벤트에서 이미 종료 처리된 경우 중복 호출 방지
    if (!runningJobs.has(agentId)) return;
    finalizeJob(code, null);
  });

  return job;
}

/**
 * 실행 중인 agy.exe 자식 프로세스 중단 및 중단 상태 기록
 * 강제 종료 시 transcript.jsonl의 마지막 RUNNING 스텝이 닫히지 않을 수 있으므로 finishedJobs에 중단 기록을 남김
 * @author Jangsung
 * @param {String} agentId
 * @param {Map} runningJobs
 * @param {Map} finishedJobs
 * @param {Function} onStreamEvent
 * @return {Boolean}
 */
function stopAgyJob(agentId, runningJobs, finishedJobs, onStreamEvent, opts = {}) {
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
    job.logs.push({ time: timeStr, message: '[CLI 중단] 사용자 요청으로 실행을 중단했습니다.', level: 'warn' });
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
    if (finishedJobs) {
      finishedJobs.set(agentId, job);
    }
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

  // 실행 중 프로세스가 이미 종료되었더라도 transcript.jsonl의 RUNNING 잔재 상태를 해제할 수 있도록 중단 마커 기록
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

module.exports = {
  ALLOWED_MODES,
  ALLOWED_EFFORTS,
  FALLBACK_MODELS,
  resolveAgyBin,
  getAvailableModels,
  startAgyPromptJob,
  stopAgyJob
};
