import { marked } from 'marked';
import DOMPurify from 'dompurify';

const renderer = new marked.Renderer();

/**
 * HTML 특수문자 이스케이프
 * @author Jangsung
 * @param {String} str
 * @return {String}
 */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 코드블록 상단에 언어 라벨 및 복사 버튼 헤더를 포함한 안전 구조 생성
renderer.code = function renderCodeBlock(code, infostring) {
  const lang = (infostring || '').trim().split(/\s+/)[0] || 'text';
  return [
    '<div class="md-code-wrap">',
    `<div class="md-code-head"><span class="md-code-lang">${escapeHtml(lang)}</span><button type="button" class="md-code-copy">복사</button></div>`,
    `<pre class="md-pre"><code>${escapeHtml(code)}</code></pre>`,
    '</div>'
  ].join('');
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: true
});

/**
 * 앞뒤 공백이 포함된 강조 표기(** text **)를 CommonMark 파서가 인식하도록 정규화 (코드블록 제외)
 * @author Jangsung
 * @param {String} text
 * @return {String}
 */
function normalizeEmphasisSpacing(text) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((segment, idx) => {
    if (idx % 2 === 1) return segment;
    return segment.replace(/\*\*([^*\n]+?)\*\*/g, (full, inner) => {
      const trimmed = inner.trim();
      return trimmed && trimmed !== inner ? `**${trimmed}**` : full;
    });
  }).join('');
}

/**
 * 마크다운 문자열을 XSS 차단된 안전 HTML로 변환
 * @author Jangsung
 * @param {String} text
 * @return {String}
 */
export function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  const normalized = normalizeEmphasisSpacing(text);
  const rawHtml = marked.parse(normalized);
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['type', 'class']
  });
}
