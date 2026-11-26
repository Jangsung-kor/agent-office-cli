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
 * 안전 HTML 내 로컬 파일/아티팩트(file:///, 인라인 코드, 일반 텍스트 .md) 링크 변환
 * @author Jangsung
 * @param {String} html
 * @return {String}
 */
export function linkifyLocalFiles(html) {
  if (!html) return '';
  const withStyledAnchors = html.replace(
    /<a\b([^>]*\bhref\s*=\s*"([^"]+)"[^>]*)>/gi,
    (full, attrs, href) => {
      const cleanHref = String(href || '').trim();
      if (!cleanHref || cleanHref.startsWith('#') || /^https?:\/\//i.test(cleanHref) || /^mailto:/i.test(cleanHref)) {
        return full;
      }
      if (/class\s*=/i.test(attrs)) return full;
      return `<a${attrs} class="local-file-link" title="클릭하여 문서 미리보기">`;
    }
  );
  const withCodeLinks = withStyledAnchors.replace(
    /<code>([^<>\r\n]+\.(?:md|markdown|txt|json|log))<\/code>/gi,
    (full, filePath) => {
      const clean = filePath.trim();
      if (!clean || /^https?:\/\//i.test(clean)) return full;
      return `<a href="${clean.replace(/"/g, '&quot;')}" class="local-file-link" title="클릭하여 문서 미리보기"><code>${filePath}</code></a>`;
    }
  );
  return withCodeLinks
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>|<pre\b[^>]*>[\s\S]*?<\/pre>|<[^>]+>)/gi)
    .map(part => {
      if (!part || part[0] === '<') return part;
      return part.replace(
        /((?:[A-Za-z]:[\\/]|file:\/\/\/)?[^\s<>'"`()[\]]*\.(?:md|markdown))\b/gi,
        (full, filePath) => {
          if (/^https?:\/\//i.test(filePath)) return full;
          return `<a href="${filePath.replace(/"/g, '&quot;')}" class="local-file-link" title="클릭하여 문서 미리보기">${filePath}</a>`;
        }
      );
    })
    .join('');
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
  const sanitized = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['type', 'class'],
    // 로컬 아티팩트/문서 미리보기(file:///) 링크가 제거되지 않도록 file 스킴 허용 (javascript:, data: 등은 계속 차단)
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  });
  return linkifyLocalFiles(sanitized);
}
