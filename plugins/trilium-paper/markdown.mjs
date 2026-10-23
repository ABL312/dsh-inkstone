/**
 * Minimal, dependency-free Markdown -> HTML conversion for Trilium note
 * content.
 *
 * Scope is deliberately small: headings, bold/italic, inline code, fenced code
 * blocks, ordered/unordered lists, blockquotes, horizontal rules, links and
 * paragraphs. Raw HTML in the source is escaped, so a model-written Markdown
 * document can never smuggle arbitrary markup into Trilium. `trilium_write`
 * with `format: "html"` bypasses this module and writes HTML as-is.
 *
 * @module dsh-inkstone/plugins/trilium-paper/markdown
 */

/**
 * Escape text for HTML text and attribute contexts.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whether a link target is safe to place in an href.
 * @param {string} href
 * @returns {boolean}
 */
function isSafeHref(href) {
  const value = String(href).trim();
  if (value.length === 0) return false;
  if (/[\u0000-\u001f"'<>]/.test(value)) return false;
  if (/^javascript:/i.test(value)) return false;
  return /^(https?:|mailto:|#|\/|\.{1,2}\/)/i.test(value);
}

/**
 * Convert inline Markdown constructs to HTML. Input must already be a single
 * logical line (paragraph/link text).
 * @param {string} text
 * @returns {string}
 */
function renderInline(text) {
  const codeSpans = [];
  // Protect inline code first so emphasis/link rules never rewrite its body.
  let source = String(text).replace(/`([^`]+)`/g, (_match, code) => {
    codeSpans.push(code);
    return `\u0000code${codeSpans.length - 1}\u0000`;
  });
  source = escapeHtml(source);
  source = source.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (!isSafeHref(href)) return label;
    return `<a href="${escapeHtml(href.trim())}">${label}</a>`;
  });
  source = source.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  source = source.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  source = source.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  source = source.replace(/(^|[^_])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  source = source.replace(/\u0000code(\d+)\u0000/g, (_match, index) => `<code>${escapeHtml(codeSpans[Number(index)])}</code>`);
  return source;
}

/**
 * Convert Markdown to the small HTML subset Trilium text notes render well.
 * @param {string} markdown
 * @returns {string}
 */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let codeLines = null;
  let listTag = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const flushBlocks = () => {
    flushParagraph();
    closeList();
  };

  for (const line of lines) {
    if (codeLines !== null) {
      if (/^\s*```/.test(line)) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = null;
      } else {
        codeLines.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushBlocks();
      continue;
    }
    const fence = trimmed.match(/^```[\w-]*$/);
    if (fence) {
      flushBlocks();
      codeLines = [];
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(trimmed)) {
      flushBlocks();
      html.push('<hr>');
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (listTag !== 'ul') {
        closeList();
        html.push('<ul>');
        listTag = 'ul';
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (listTag !== 'ol') {
        closeList();
        html.push('<ol>');
        listTag = 'ol';
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushBlocks();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }
    paragraph.push(trimmed);
  }

  if (codeLines !== null) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushBlocks();
  return html.join('\n');
}

/**
 * Heuristic used by `format: "auto"`: does this text look like Markdown rather
 * than HTML? HTML input is passed through unchanged by `trilium_write`.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeMarkdown(text) {
  const value = String(text ?? '');
  if (value.trim().length === 0) return false;
  if (/<(?:p|div|h[1-6]|ul|ol|li|table|strong|em|code|pre|blockquote|a)\b[^>]*>/i.test(value)) {
    return false;
  }
  return (
    /^#{1,6}\s+\S/m.test(value) ||
    /\*\*[^*\n]+\*\*/.test(value) ||
    /^\s*[-*+]\s+\S/m.test(value) ||
    /^\s*\d+[.)]\s+\S/m.test(value) ||
    /^>\s+\S/m.test(value) ||
    /```/.test(value) ||
    /\[[^\]\n]+\]\([^)\s]+\)/.test(value)
  );
}
