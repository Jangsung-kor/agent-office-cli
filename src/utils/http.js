/**
 * fetch 응답을 안전하게 JSON으로 파싱 (구버전 브리지의 404/HTML 폴백 시 원인 안내)
 * @author Jangsung
 * @param {Response} res
 * @param {String} fallbackLabel
 * @return {Promise<Object>}
 */
export async function readJsonResponse(res, fallbackLabel = 'API 요청') {
  const rawText = await res.text();
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object') {
        if (
          res.status === 404
          && typeof parsed.error === 'string'
          && parsed.error.startsWith('지원하지 않는 API 경로입니다:')
        ) {
          throw new Error(
            `${fallbackLabel} 실패: 구버전 브리지 서버가 실행 중입니다. 실행 중인 yarn.cmd dev 또는 yarn.cmd bridge를 재시작하세요.`
          );
        }
        return parsed;
      }
    } catch (err) {
      if (err && err.message && err.message.includes('구버전 브리지 서버')) {
        throw err;
      }
    }
  }
  const trimmed = rawText.trim();
  const looksOutdatedBridge = res.status === 404
    || trimmed === 'Not Found'
    || trimmed.startsWith('<!DOCTYPE')
    || trimmed.startsWith('<html');
  if (looksOutdatedBridge) {
    throw new Error(
      `${fallbackLabel} 실패 (HTTP ${res.status}): 구버전 브리지 서버가 실행 중이거나 API 경로가 없습니다. 실행 중인 yarn.cmd dev 또는 yarn.cmd bridge를 재시작하세요.`
    );
  }
  throw new Error(`${fallbackLabel} 실패 (HTTP ${res.status}): 유효한 JSON 응답이 아닙니다.`);
}
