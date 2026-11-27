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
    { id: 'plan', label: '읽기' },
    { id: 'accept-edits', label: '편집' }
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

/**
 * Antigravity CLI 계정 상태 조회 (OS 키링 기반 인증 특성상 비대화형 이메일 조회는 미지원)
 * @author Jangsung
 * @param {String} customLabel
 * @return {Object}
 */
function getAccountInfo(customLabel = '') {
  const cli = detectCli();
  const cleanLabel = typeof customLabel === 'string' ? customLabel.trim().slice(0, 60) : '';
  return {
    providerId: PROVIDER_ID,
    authenticated: cli.available,
    autoDetected: false,
    supportsAutoDetect: false,
    detectedEmail: '',
    authMethod: 'OS Keyring (Google OAuth)',
    plan: '',
    customLabel: cleanLabel,
    displayLabel: cleanLabel || (cli.available ? 'OS 키링 인증 (라벨 미지정)' : 'CLI 미감지'),
    note: 'agy CLI는 OAuth 자격증명을 OS 키링에 보관하며 비대화형 계정 이메일 조회를 지원하지 않습니다. 터미널에서 agy 실행 후 /config 또는 /logout으로 계정을 확인·전환할 수 있습니다.'
  };
}

module.exports = {
  id: PROVIDER_ID,
  getCapabilities: () => ({ ...CAPABILITIES, sessionStoreDir: getCliBrainDir() }),
  detectCli,
  getAccountInfo,
  refreshAccountInfo: async (customLabel = '') => getAccountInfo(customLabel),
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
