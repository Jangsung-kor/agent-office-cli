import ERROR_RULES from '../../shared/errorRules.json';

/**
 * 오류 문자열 기반 결정적 캐시 키 생성
 * @author Jangsung
 * @param {String} rawError
 * @return {String}
 */
export function makeErrorKey(rawError) {
  const s = String(rawError || '').trim();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `err_${(h >>> 0).toString(36)}_${s.length}`;
}

/**
 * 클라이언트 측 0토큰 정형 오류 규칙 해석 (server/errorTranslator.js와 동일 규칙 테이블 공유)
 * @author Jangsung
 * @param {String} rawError
 * @return {Object}
 */
export function translateErrorByRules(rawError) {
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
