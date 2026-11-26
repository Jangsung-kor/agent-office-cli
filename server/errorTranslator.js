const { spawn } = require('child_process');
const path = require('path');
const ERROR_RULES = require('../shared/errorRules.json');
const { resolveAgyBin, getAvailableModels } = require('./agyRunner');

const MAX_ERROR_INPUT_CHARS = 3000;
const AI_EXPLAIN_TIMEOUT_MS = 28000;

/**
 * 0토큰 정형 패턴 기반 CLI 오류 1차 한국어 해석
 * @author Jangsung
 * @param {String} rawError
 * @return {Object}
 */
function translateErrorByRules(rawError) {
  const text = typeof rawError === 'string' ? rawError.trim() : '';
  if (!text) {
    return { matched: false, id: null, title: '', summary: '', action: '', aiExplainable: false };
  }
  for (let i = 0; i < ERROR_RULES.length; i++) {
    const rule = ERROR_RULES[i];
    const matched = (rule.patterns || []).some(pat => {
      try {
        return new RegExp(pat, 'i').test(text);
      } catch (_) {
        return false;
      }
    });
    if (matched) {
      return {
        matched: true,
        id: rule.id,
        title: rule.title,
        summary: rule.summary,
        action: rule.action,
        aiExplainable: Boolean(rule.aiExplainable)
      };
    }
  }
  return {
    matched: false,
    id: 'unknown',
    title: 'CLI 실행 오류',
    summary: '정형 패턴으로 분류되지 않은 오류입니다.',
    action: '원문 로그를 확인하거나 [AI 원인 해석]으로 요약을 조회할 수 있습니다.',
    aiExplainable: true
  };
}

/**
 * 에러 해석 전용 경량 모델 선택 (기존 작업 모델보다 가볍고 빠른 모델 우선)
 * @author Jangsung
 * @param {Object} provider
 * @return {Promise<String>}
 */
async function pickLightweightModel(provider) {
  const caps = provider.getCapabilities();
  try {
    const models = await provider.getModels(false);
    if (Array.isArray(models) && models.length > 0) {
      const preferred = provider.id === 'antigravity'
        ? (models.find(m => /flash.*low$/i.test(m.id)) || models.find(m => /flash/i.test(m.id)))
        : (models.find(m => /astra|mini|fast/i.test(m.id)));
      if (preferred && preferred.id) return preferred.id;
      return models[0].id;
    }
  } catch (_) {}
  return caps.defaultModelId;
}

/**
 * 에러 로그를 기존 에이전트 세션(--conversation/resume)과 분리된 단발 세션으로 해석 후 임시 세션 즉시 정리
 * @author Jangsung
 * @param {Object} params
 * @return {Promise<Object>}
 */
async function explainErrorWithProvider({ provider, errorText, commandLine = '', cwd = process.cwd() }) {
  const cleanError = String(errorText || '').trim().slice(0, MAX_ERROR_INPUT_CHARS);
  if (!cleanError) {
    throw new Error('해석할 오류 로그가 비어 있습니다.');
  }
  const cli = provider.detectCli();
  if (!cli || !cli.available) {
    throw new Error(`${provider.getCapabilities().label} CLI를 찾을 수 없어 AI 해석을 실행할 수 없습니다.`);
  }

  const modelId = await pickLightweightModel(provider);
  const safeCmd = String(commandLine || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const prompt = [
    '아래 CLI 실행 오류 로그를 개발자가 바로 이해하고 조치할 수 있게 한국어로 간결하게 설명해줘.',
    '규칙: 불필요한 인사말, 과장된 표현, 이모지 없이 로그에 나온 사실만 바탕으로 1) 원인 요약, 2) 조치 방법 1~3가지만 작성해. 파일을 수정하거나 명령을 실행하지 마.',
    safeCmd ? `[실행 명령]: ${safeCmd}` : '',
    `[오류 로그 원문]:\n${cleanError}`
  ].filter(Boolean).join('\n\n');

  const safePrompt = prompt.startsWith('-') ? ` ${prompt}` : prompt;
  let binPath = cli.binPath;
  let args = [];
  if (provider.id === 'antigravity') {
    binPath = resolveAgyBin();
    args = ['--model', modelId, '--mode', 'plan', '--output-format', 'stream-json', `-p=${safePrompt}`];
  } else {
    args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      modelId,
      '-C',
      path.resolve(cwd || process.cwd()),
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'model_reasoning_effort="low"',
      safePrompt
    ];
  }

  let tempConvId = null;
  let collectedText = '';
  let finalResultText = '';
  let errOutput = '';
  let usage = null;

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(binPath, args, {
        cwd: path.resolve(cwd || process.cwd()),
        shell: process.platform === 'win32' && binPath.toLowerCase().endsWith('.cmd'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let settled = false;
      const done = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const timer = setTimeout(() => {
        if (child.pid && process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
        done(new Error('오류 원인 해석 시간이 초과되었습니다(28초).'));
      }, AI_EXPLAIN_TIMEOUT_MS);

      let outBuf = '';
      child.stdout.on('data', chunk => {
        outBuf += chunk.toString('utf8');
        const lines = outBuf.split(/\r?\n/);
        outBuf = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line[0] !== '{') continue;
          try {
            const obj = JSON.parse(line);
            if (provider.id === 'antigravity') {
              if (obj.event === 'init' && obj.conversation_id) tempConvId = obj.conversation_id;
              else if (obj.event === 'step_update' && obj.step_update) {
                if (typeof obj.step_update.text_delta === 'string') collectedText += obj.step_update.text_delta;
                if (obj.step_update.usage) usage = obj.step_update.usage;
              } else if (obj.event === 'result' && obj.result) {
                if (obj.result.conversation_id && !tempConvId) tempConvId = obj.result.conversation_id;
                if (obj.result.response) finalResultText = String(obj.result.response);
                if (obj.result.usage) usage = obj.result.usage;
                if (obj.result.error) errOutput = String(obj.result.error);
              }
            } else {
              if (obj.type === 'thread.started' && obj.thread_id) tempConvId = obj.thread_id;
              else if (obj.type === 'item.completed' && obj.item && obj.item.type === 'agent_message' && obj.item.text) {
                collectedText = collectedText ? `${collectedText}\n${obj.item.text}` : obj.item.text;
              } else if (obj.type === 'turn.completed' && obj.usage) {
                usage = {
                  input_tokens: obj.usage.input_tokens || 0,
                  output_tokens: obj.usage.output_tokens || 0,
                  total_tokens: (obj.usage.input_tokens || 0) + (obj.usage.output_tokens || 0)
                };
              } else if (obj.type === 'error' && obj.message) {
                errOutput = String(obj.message);
              }
            }
          } catch (_) {}
        }
      });

      child.stderr.on('data', chunk => {
        const s = chunk.toString('utf8').trim();
        if (s) errOutput = errOutput ? `${errOutput}\n${s}` : s;
      });

      child.on('error', err => done(err));
      child.on('close', code => {
        if (finalResultText || collectedText) done(null);
        else if (code !== 0) done(new Error(errOutput || `오류 해석 CLI 종료 (exit=${code})`));
        else done(new Error(errOutput || '오류 해석 응답이 비어 있습니다.'));
      });
    });
  } finally {
    // 단발 해석용 임시 세션은 기존 대화·목록을 오염시키지 않도록 즉시 삭제
    if (tempConvId && typeof provider.deleteSession === 'function') {
      try {
        provider.deleteSession(tempConvId);
      } catch (_) {}
    }
  }

  return {
    modelUsed: modelId,
    aiExplanation: (finalResultText || collectedText).trim(),
    tokensUsed: usage ? Number(usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0)) || 0) : 0
  };
}

module.exports = {
  translateErrorByRules,
  explainErrorWithProvider
};
