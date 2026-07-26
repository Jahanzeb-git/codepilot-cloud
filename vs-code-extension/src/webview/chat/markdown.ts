import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

export const md: MarkdownIt = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight(code: string, lang: string): string {
        const validLang = lang && hljs.getLanguage(lang);
        try {
            const highlighted = validLang
                ? hljs.highlight(code, { language: lang }).value
                : hljs.highlightAuto(code).value;
            return `<pre class="code-block"><code class="hljs${lang ? ' language-' + lang : ''}">${highlighted}</code></pre>`;
        } catch {
            return `<pre class="code-block"><code>${md.utils.escapeHtml(code)}</code></pre>`;
        }
    }
});