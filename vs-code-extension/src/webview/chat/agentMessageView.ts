import { md } from './markdown';
import { TagAwareStreamParser, ParsedStreamEvent } from './state';

interface ToolCallEntry {
    tool: string;
    args: Record<string, unknown>;
    label?: string;
    status: 'running' | 'done';
    result?: string;
    el: HTMLElement;
}

/** Minimal diff stat parsed from a tool_result string. */
interface FileStat {
    path: string;
    added: number;
    removed: number;
}

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'create_file']);

/**
 * Very rough heuristic: count lines starting with '+' or '-' in unified-diff
 * output embedded in a tool result string. Falls back to 0/0 gracefully.
 */
function parseDiffStat(result: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of result.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
}

function extractFilePath(args: Record<string, unknown>): string | null {
    const raw = args['path'] ?? args['file_path'] ?? args['filename'];
    return typeof raw === 'string' ? raw : null;
}

export class AgentMessageView {
    private root: HTMLElement;
    private workingUiEl: HTMLElement;
    private workingHeader: HTMLElement;
    private workingHeaderText: HTMLElement;
    private workingTimer: HTMLElement;
    private workingTimelineEl: HTMLElement;
    
    private bodyEl: HTMLElement;
    private thinkingEl?: HTMLElement;
    private filesEl: HTMLElement;

    private parser = new TagAwareStreamParser();
    private rawText = '';
    private thinkingText = '';
    private isThinking = false;
    private toolCalls = new Map<string, ToolCallEntry>();
    private fileStats: FileStat[] = [];
    
    private startTime: number;
    private timerInterval: any;
    private isHistorical: boolean;

    constructor(container: HTMLElement, isHistorical: boolean = false) {
        this.isHistorical = isHistorical;
        this.root = document.createElement('div');
        this.root.className = 'message agent-message';

        // 1. Working UI (Top)
        this.workingUiEl = document.createElement('div');
        this.workingUiEl.className = 'working-ui-container expanded hidden';
        this.workingUiEl.innerHTML = `
            <div class="working-header">
                <span class="working-header-icon">
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path d="M4.5 2L11 8l-6.5 6V2z"/>
                    </svg>
                </span>
                <span class="working-header-text">Working...</span>
                <span class="working-timer"></span>
            </div>
            <div class="working-timeline"></div>
        `;
        this.workingHeader = this.workingUiEl.querySelector('.working-header')!;
        this.workingHeaderText = this.workingUiEl.querySelector('.working-header-text')!;
        this.workingTimer = this.workingUiEl.querySelector('.working-timer')!;
        this.workingTimelineEl = this.workingUiEl.querySelector('.working-timeline')!;
        
        this.workingHeader.addEventListener('click', () => {
            this.workingUiEl.classList.toggle('expanded');
            this.workingUiEl.classList.toggle('collapsed');
        });

        // 2. Body Text (Middle)
        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'message-body';

        // 3. Files Modified (Bottom)
        this.filesEl = document.createElement('div');
        this.filesEl.className = 'files-modified hidden';

        this.root.appendChild(this.workingUiEl);
        this.root.appendChild(this.bodyEl);
        this.root.appendChild(this.filesEl);
        container.appendChild(this.root);
        
        this.startTime = Date.now();
        if (!isHistorical) {
            this.workingTimer.textContent = '0s';
            this.timerInterval = setInterval(() => {
                const secs = Math.floor((Date.now() - this.startTime) / 1000);
                this.workingTimer.textContent = `${secs}s`;
            }, 1000);
        }
    }

    public pushChunk(text: string): void {
        const events = this.parser.feed(text);
        for (const event of events) {
            this.applyEvent(event);
        }
        this.render();
    }

    private applyEvent(event: ParsedStreamEvent): void {
        if (event.kind === 'text') {
            if (this.isThinking) {
                this.thinkingText += event.text;
            } else {
                this.rawText += event.text;
            }
        } else if (event.kind === 'thinking_start') {
            this.isThinking = true;
            this.ensureThinkingEl();
        } else if (event.kind === 'thinking_end') {
            this.isThinking = false;
            this.thinkingEl?.classList.add('collapsed');
        }
    }

    private ensureThinkingEl(): void {
        if (this.thinkingEl) return;
        this.thinkingEl = document.createElement('div');
        this.thinkingEl.className = 'thinking-block';
        this.thinkingEl.addEventListener('click', () => {
            this.thinkingEl!.classList.toggle('collapsed');
        });
        this.bodyEl.appendChild(this.thinkingEl);
    }

    private render(): void {
        if (this.thinkingEl) {
            this.thinkingEl.textContent = this.thinkingText;
        }

        let cleanText = this.rawText;
        // Strip codepilot blocks completely
        cleanText = cleanText.replace(/```codepilot[\s\S]*?(?:```|$)/g, '');
        // Strip any fenced blocks with filename= in the header (used for file edits/writes)
        cleanText = cleanText.replace(/```\w*\s+filename=[^\n]*\n[\s\S]*?(?:```|$)/g, '');
        // Strip any diff blocks explicitly
        cleanText = cleanText.replace(/```\w*\n<<<<<<< SEARCH[\s\S]*?(?:```|$)/g, '');
        // Trim trailing whitespace to avoid dangling empty blocks
        cleanText = cleanText.trim();

        let bodyHtml = md.render(cleanText);
        this.bodyEl.innerHTML = bodyHtml;
        if (this.thinkingEl) {
            this.thinkingEl.textContent = this.thinkingText;
            if (!this.isThinking) this.thinkingEl.classList.add('collapsed');
            this.bodyEl.insertBefore(this.thinkingEl, this.bodyEl.firstChild);
        }
    }

    public addToolCall(tool: string, args: Record<string, unknown>, label?: string): void {
        this.workingUiEl.classList.remove('hidden'); // Show working UI if hidden
        this.workingHeaderText.textContent = 'Working...';
        
        const el = document.createElement('div');
        el.className = 'tool-call running';

        const icon = document.createElement('span');
        icon.className = 'tool-call-spinner';

        const text = document.createElement('span');
        text.className = 'tool-call-label';
        text.textContent = label || `Running ${tool}`;

        el.appendChild(icon);
        el.appendChild(text);
        this.workingTimelineEl.appendChild(el);
        
        // Auto-scroll the timeline to show the latest tool call
        this.workingTimelineEl.scrollTop = this.workingTimelineEl.scrollHeight;

        this.toolCalls.set(tool, { tool, args, label, status: 'running', el });
    }

    public resolveToolCall(tool: string, result: string): void {
        const entry = this.toolCalls.get(tool);
        if (!entry) return;
        entry.status = 'done';
        entry.result = result;
        entry.el.className = 'tool-call done';
        const label = entry.el.querySelector('.tool-call-label');
        if (label) label.textContent = entry.label || `Completed ${tool}`;

        // Track file modifications for the summary capsules
        if (FILE_TOOLS.has(tool)) {
            const filePath = extractFilePath(entry.args);
            if (filePath) {
                const stat = parseDiffStat(result);
                // Merge with existing entry if same file
                const existing = this.fileStats.find((f) => f.path === filePath);
                if (existing) {
                    existing.added += stat.added;
                    existing.removed += stat.removed;
                } else {
                    this.fileStats.push({ path: filePath, ...stat });
                }
            }
        }
    }

    /** Called by main.ts when the 'finish' event arrives. */
    public finish(): void {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
        }
        
        let timeStr = "";
        if (!this.isHistorical) {
            const totalSecs = Math.floor((Date.now() - this.startTime) / 1000);
            timeStr = ` (${totalSecs}s)`;
        }
        
        if (this.toolCalls.size > 0) {
            // Collapse the Working UI smoothly
            this.workingUiEl.classList.remove('expanded');
            this.workingUiEl.classList.add('collapsed');
            
            const actionsCount = this.toolCalls.size;
            const actionLabel = actionsCount === 1 ? 'action' : 'actions';
            this.workingHeaderText.textContent = `${actionsCount} ${actionLabel} taken${timeStr}`;
            if (this.isHistorical) {
                this.workingTimer.textContent = '';
            }
        } else {
            // No tools called, we can just hide it
            this.workingUiEl.classList.add('hidden');
        }

        if (this.fileStats.length === 0) return;
        this.filesEl.classList.remove('hidden');
        this.filesEl.innerHTML = `
            <div class="files-modified-header">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                    <path d="M13.5 3.5l-3-3H3.5A1.5 1.5 0 002 2v12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 14V3.5h-.5zM10 1.5L12.5 4H10V1.5z"/>
                </svg>
                <span>Files Modified</span>
                <span class="files-modified-count">${this.fileStats.length}</span>
            </div>
            <div class="files-modified-list">
                ${this.fileStats.map((f) => {
                    const name = f.path.split('/').pop() || f.path;
                    const addStr = f.added > 0 ? `<span class="fm-add">+${f.added}</span>` : '';
                    const remStr = f.removed > 0 ? `<span class="fm-rem">-${f.removed}</span>` : '';
                    return `
                        <div class="fm-capsule" title="${f.path}">
                            <span class="fm-name">${name}</span>
                            ${addStr}${remStr}
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    public appendError(message: string): void {
        this.finish(); 
        const errorEl = document.createElement('div');
        errorEl.className = 'message-error';
        errorEl.textContent = message;
        this.bodyEl.appendChild(errorEl);
    }

    public appendQuestion(question: string): void {
        const qEl = document.createElement('div');
        qEl.className = 'permission-prompt'; 
        
        const labelEl = document.createElement('strong');
        labelEl.textContent = 'Question: ';
        qEl.appendChild(labelEl);
        
        const textEl = document.createElement('span');
        textEl.textContent = question;
        qEl.appendChild(textEl);
        
        this.bodyEl.appendChild(qEl);
    }

    public getRoot(): HTMLElement {
        return this.root;
    }
}