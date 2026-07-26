import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

export const md: MarkdownIt = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight(code: string, lang: string): string {
        const validLang = lang && hljs.getLanguage(lang);
        let highlighted: string;
        try {
            highlighted = validLang
                ? hljs.highlight(code, { language: lang }).value
                : hljs.highlightAuto(code).value;
        } catch {
            highlighted = md.utils.escapeHtml(code);
        }
        // Encode the raw code into a data attribute; click is handled via
        // event delegation in main.ts so no inline script is needed.
        const encoded = encodeURIComponent(code);
        const langLabel = lang ? lang : 'code';
        return `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-block-lang">${langLabel}</span>
    <button class="code-copy-btn" data-code="${encoded}" title="Copy">Copy</button>
  </div>
  <pre class="code-block"><code class="hljs${lang ? ' language-' + lang : ''}">${highlighted}</code></pre>
</div>`;
    }
});