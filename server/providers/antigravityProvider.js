const fs = require('fs');
const path = require('path');
const {
  getCliBrainDir,
  readCliHistoryIndex,
  findCliTranscriptPath,
  scanCliSessions,
  readSessionMessages,
  generateHandoverDocument,
  deleteCliSession
} = require('../transcript');
const {
  ALLOWED_MODES,
  ALLOWED_EFFORTS,
  resolveAgyBin,
  getAvailableModels,
  startAgyPromptJob,
  stopAgyJob
} = require('../agyRunner');

const PROVIDER_ID = 'antigravity';

const CAPABILITIES = {
  providerId: PROVIDER_ID,
  name: 'ANTIGRAVITY',
  label: 'Antigravity CLI',
  subtitle: 'Google Antigravity CLI (agy.exe) 기반 관제 및 stream-json 스트리밍',
  cliCommand: 'agy',
  cliLabel: 'agy-cli',
  supportsCliAgents: true,
  supportsHandover: true,
  defaultModelId: 'gemini-4-hydrogen-high',
  defaultEffort: 'auto',
  defaultMode: 'plan',
  builtInEffortRegex: '-(low|medium|high|xhigh|max)$',
  healthBasis: 'transcript.jsonl 파일 크기',
  modes: [
    { id: 'plan', label: 'plan (읽기/계획)' },
    { id: 'accept-edits', label: 'accept-edits (편집 허용)' },
    { id: 'auto', label: 'auto (자동 실행)' }
  ],
  efforts: [
    { id: 'auto', label: 'auto (기본)' },
    { id: 'low', label: 'low (최소)' },
    { id: 'medium', label: 'medium (보통)' },
    { id: 'high', label: 'high (권장)' },
    { id: 'xhigh', label: 'xhigh (최대)' },
    { id: 'max', label: 'max (최상한)' }
  ]
};

/**
 * 로컬 Antigravity CLI 바이너리 감지 상태 조회
 * @author Jangsung
 * @return {Object}
 */
function detectCli() {
  const binPath = resolveAgyBin();
  const isAbs = path.isAbsolute(binPath);
  const available = isAbs ? fs.existsSync(binPath) : false;
  return {
    available,
    binPath,
    sessionStoreDir: getCliBrainDir()
  };
}

/**
 * 실행 옵션 유효성 정규화
 * @author Jangsung
 * @param {Object} raw
 * @return {Object}
 */
function normalizePromptOptions({ modelId, effort, mode }) {
  const safeMode = ALLOWED_MODES.includes(mode) ? mode : CAPABILITIES.defaultMode;
  const safeEffort = ALLOWED_EFFORTS.includes(effort) ? effort : CAPABILITIES.defaultEffort;
  const safeModel = typeof modelId === 'string' && modelId.trim()
    ? modelId.trim()
    : CAPABILITIES.defaultModelId;
  if (!/^[a-zA-Z0-9._-]+$/.test(safeModel)) {
    throw new Error('유효하지 않은 modelId 형식입니다.');
  }
  return { modelId: safeModel, effort: safeEffort, mode: safeMode };
}

module.exports = {
  id: PROVIDER_ID,
  getCapabilities: () => ({ ...CAPABILITIES, sessionStoreDir: getCliBrainDir() }),
  detectCli,
  getSessionStoreDir: getCliBrainDir,
  readHistoryIndex: readCliHistoryIndex,
  getModels: getAvailableModels,
  findSessionExists: convId => Boolean(findCliTranscriptPath(convId)),
  scanSessions: scanCliSessions,
  readSessionMessages,
  normalizePromptOptions,
  startPromptJob: startAgyPromptJob,
  stopJob: stopAgyJob,
  generateHandover: generateHandoverDocument,
  deleteSession: deleteCliSession
};
