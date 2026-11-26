const antigravityProvider = require('./antigravityProvider');
const codexProvider = require('./codexProvider');

const PROVIDERS = {
  antigravity: antigravityProvider,
  codex: codexProvider
};

const PROVIDER_ORDER = ['antigravity', 'codex'];

/**
 * 유효한 프로바이더 ID 여부 확인
 * @author Jangsung
 * @param {String} providerId
 * @return {Boolean}
 */
function isValidProviderId(providerId) {
  return typeof providerId === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, providerId);
}

/**
 * 프로바이더 ID로 어댑터 인스턴스 조회 (기본값 antigravity)
 * @author Jangsung
 * @param {String} providerId
 * @return {Object}
 */
function getProvider(providerId) {
  if (isValidProviderId(providerId)) {
    return PROVIDERS[providerId];
  }
  return PROVIDERS.antigravity;
}

/**
 * 등록된 전체 프로바이더의 상태, CLI 감지, 최근 세션 수 요약 조회
 * @author Jangsung
 * @param {Function} getRuntimeForProvider
 * @return {Promise<Array<Object>>}
 */
async function listProvidersSummary(getRuntimeForProvider, getAccountLabelForProvider) {
  const results = [];
  for (const id of PROVIDER_ORDER) {
    const provider = PROVIDERS[id];
    const caps = provider.getCapabilities();
    const cli = provider.detectCli();
    const runtime = typeof getRuntimeForProvider === 'function' ? getRuntimeForProvider(id) : null;
    const cacheMap = runtime && runtime.sessionCache ? runtime.sessionCache : new Map();
    const sessions = provider.scanSessions(cacheMap, {}, []);
    const models = await provider.getModels(false);
    const customLabel = typeof getAccountLabelForProvider === 'function' ? getAccountLabelForProvider(id) : '';
    const accountInfo = typeof provider.refreshAccountInfo === 'function'
      ? await provider.refreshAccountInfo(customLabel, false)
      : (typeof provider.getAccountInfo === 'function' ? provider.getAccountInfo(customLabel) : null);

    results.push({
      ...caps,
      available: cli.available,
      binPath: cli.binPath,
      sessionStoreDir: cli.sessionStoreDir,
      accountInfo,
      sessionCount: sessions.length,
      runningCount: runtime && runtime.runningJobs ? runtime.runningJobs.size : 0,
      modelCount: Array.isArray(models) ? models.length : 0,
      sampleModels: Array.isArray(models) ? models.slice(0, 3).map(m => m.label) : []
    });
  }
  return results;
}

module.exports = {
  PROVIDER_ORDER,
  isValidProviderId,
  getProvider,
  listProvidersSummary
};
