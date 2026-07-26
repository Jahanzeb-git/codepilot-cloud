import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { AgentSocketClient, AgentEvent } from './agentSocketClient';
import { getNonce } from './utils';
import { SessionSummary, AgentYamlSnapshot, ToolPermission, UpdateSettingsPayload } from './webview/chat/types';

// Duplicated here so the Node.js extension host bundle (which cannot import
// webview-only TypeScript) still has access to these for JSON embedding.
const MODELS_BY_PROVIDER: Record<string, string[]> = {
    anthropic: ['claude-opus-4-8', 'claude-sonnet-5'],
    openai:    ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    alibaba:   ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.5-flash'],
    deepseek:  ['deepseek-v4-pro', 'deepseek-v4-flash'],
};

const PROVIDER_ENV_VAR: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai:    'OPENAI_API_KEY',
    alibaba:   'DASHSCOPE_API_KEY',
    deepseek:  'DEEPSEEK_API_KEY',
};

/** Default max_tokens per model — duplicated from types.ts for the extension host bundle. */
const MAX_TOKENS_BY_MODEL_MAP: Record<string, number> = {
    'claude-opus-4-8':   128000,
    'claude-sonnet-5':   128000,
    'gpt-5.5':           128000,
    'gpt-5.6-sol':       128000,
    'gpt-5.6-terra':     128000,
    'gpt-5.6-luna':      128000,
    'qwen3.7-max':        65536,
    'qwen3.7-plus':       65536,
    'qwen3.5-flash':      65536,
    'deepseek-v4-pro':   384000,
    'deepseek-v4-flash': 384000,
};

const SESSIONS_DIR = path.join(os.homedir(), '.codepilot', 'sessions');
const AGENT_YAML_PATH = '/opt/codepilot/agent.yaml';
const TASK_INPUT_RE = /^\[Task \d+\]\[USER INPUT\]\n([\s\S]*)$/;
const TITLE_MAX_LEN = 60;

async function listSessionSummaries(): Promise<SessionSummary[]> {
    let files: string[];
    try {
        files = (await fs.readdir(SESSIONS_DIR)).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
        const full = path.join(SESSIONS_DIR, file);
        try {
            const stat = await fs.stat(full);
            const raw = await fs.readFile(full, 'utf-8');
            const parsed = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
            summaries.push({
                session_id: path.basename(file, '.json'),
                title: extractTitle(parsed.messages ?? []),
                updated_at: stat.mtimeMs / 1000
            });
        } catch (err) {
            console.error(`[CodePilot] Failed to read session file ${file}:`, err);
        }
    }

    summaries.sort((a, b) => b.updated_at - a.updated_at);
    return summaries;
}

function extractTitle(messages: Array<{ role: string; content: string }>): string {
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const match = msg.content.match(TASK_INPUT_RE);
        if (match) {
            const firstLine = match[1].split('\n')[0].trim();
            return firstLine.length > TITLE_MAX_LEN ? firstLine.slice(0, TITLE_MAX_LEN).trimEnd() + '…' : firstLine;
        }
    }
    return '(untitled session)';
}

function nextSessionId(existing: SessionSummary[]): string {
    let max = 0;
    for (const s of existing) {
        const match = s.session_id.match(/^session_(\d+)$/);
        if (match) max = Math.max(max, parseInt(match[1], 10));
    }
    return `session_${String(max + 1).padStart(3, '0')}`;
}

async function readSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    const full = path.join(SESSIONS_DIR, `${sessionId}.json`);
    try {
        const raw = await fs.readFile(full, 'utf-8');
        const parsed = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
        return parsed.messages ?? [];
    } catch {
        return [];
    }
}

async function readAgentYamlSnapshot(): Promise<AgentYamlSnapshot | null> {
    try {
        const raw = await fs.readFile(AGENT_YAML_PATH, 'utf-8');
        const cfg = yaml.load(raw) as any;
        const agentCfg = cfg?.agent ?? cfg;
        const tools: Record<string, ToolPermission> = {};
        for (const t of agentCfg.tools ?? []) {
            tools[t.name] = {
                enabled: t.enabled ?? true,
                require_permission: t.config?.require_permission ?? false
            };
        }
        return {
            provider:     agentCfg.model?.provider     ?? '',
            model:        agentCfg.model?.name         ?? '',
            temperature:  agentCfg.model?.temperature  ?? 1.0,
            max_tokens:   agentCfg.model?.max_tokens   ?? 4096,
            api_key_env:  agentCfg.model?.api_key_env  ?? '',
            max_steps:    agentCfg.runtime?.max_steps  ?? 25,
            unsafe_mode:  agentCfg.runtime?.unsafe_mode ?? false,
            system_prompt: agentCfg.system_prompt      ?? '',
            tools
        };
    } catch (err) {
        console.error('[CodePilot] Failed to read agent.yaml:', err);
        return null;
    }
}

function formatRelativeTime(unixSeconds: number): string {
    const diffMs = Date.now() - unixSeconds * 1000;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codepilot-sidebar';
    private view?: vscode.WebviewView;
    private eventSub?: vscode.Disposable;
    private settingsPanel?: vscode.WebviewPanel;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly agentClient: AgentSocketClient
    ) { }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'send_task':
                    this.agentClient.sendTask(data.text);
                    break;
                case 'permission_response':
                    this.agentClient.sendPermissionResponse(data.value);
                    break;
                case 'abort':
                    this.agentClient.abort();
                    break;
                case 'new_session': {
                    const sessions = await listSessionSummaries();
                    this.agentClient.newSession(nextSessionId(sessions));
                    break;
                }
                case 'switch_session':
                    this.agentClient.switchSession(data.session_id);
                    break;
                case 'update_settings':
                    this.agentClient.updateSettings(data.settings as UpdateSettingsPayload);
                    // Also push to settings panel if open
                    this.settingsPanel?.webview.postMessage({ type: 'settings_saved' });
                    break;
                case 'ask_user_response':
                    this.agentClient.sendAskUserResponse(data.value);
                    break;
                case 'open_instructions_file':
                    await this.openInstructionsFile();
                    break;
            }
        });

        this.eventSub = this.agentClient.onAgentEvent((event) => this.handleAgentEvent(event));

        webviewView.onDidDispose(() => {
            this.eventSub?.dispose();
        });
    }

    /** Called by extension.ts when the native panel button is clicked. */
    public async showSessionsPicker(): Promise<void> {
        const sessions = await listSessionSummaries();

        type SessionItem = vscode.QuickPickItem & { sessionId?: string; isNew?: boolean };

        const items: SessionItem[] = [
            {
                label: '$(add)  New Session',
                description: 'Start a fresh conversation',
                isNew: true
            },
            { kind: vscode.QuickPickItemKind.Separator, label: 'Recent Sessions' }
        ];

        for (const s of sessions) {
            items.push({
                label: `$(comment-discussion)  ${s.title || '(untitled session)'}`,
                description: formatRelativeTime(s.updated_at),
                sessionId: s.session_id
            });
        }

        if (sessions.length === 0) {
            items.push({ label: 'No previous sessions yet.', description: '' });
        }

        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Switch session or start a new one',
            title: 'CodePilot Sessions',
            matchOnDescription: true
        });

        if (!pick) return;

        if (pick.isNew) {
            this.agentClient.newSession(nextSessionId(sessions));
        } else if (pick.sessionId) {
            this.agentClient.switchSession(pick.sessionId);
        }
    }

    /** Called by extension.ts when the native panel button is clicked. */
    public async showSettingsPanel(): Promise<void> {
        // If already open, just reveal it
        if (this.settingsPanel) {
            this.settingsPanel.reveal(vscode.ViewColumn.Active);
            return;
        }

        this.settingsPanel = vscode.window.createWebviewPanel(
            'codepilot-settings',
            'CodePilot Settings',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
            }
        );

        const snapshot = await readAgentYamlSnapshot();
        this.settingsPanel.webview.html = this.getSettingsHtml(this.settingsPanel.webview, snapshot);

        this.settingsPanel.webview.onDidReceiveMessage(async (data) => {
            if (data.type === 'update_settings') {
                this.agentClient.updateSettings(data.settings as UpdateSettingsPayload);
                // Echo confirmation back to settings panel
                this.settingsPanel?.webview.postMessage({ type: 'settings_saved' });
                // Also tell the chat webview
                this.view?.webview.postMessage({ type: 'settings_updated', success: true });
            } else if (data.type === 'open_instructions_file') {
                await this.openInstructionsFile();
            }
        });

        this.settingsPanel.onDidDispose(() => {
            this.settingsPanel = undefined;
        });
    }

    private async handleAgentEvent(event: AgentEvent): Promise<void> {
        if (event.type === 'session_switched') {
            const messages = await readSessionMessages(event.session_id);
            this.view?.webview.postMessage({ type: 'session_switched', session_id: event.session_id, messages });
            return;
        }
        this.view?.webview.postMessage(event);
    }

    private async openInstructionsFile(): Promise<void> {
        const dir = path.join(os.homedir(), '.codepilot', 'prompts');
        const file = path.join(dir, 'instructions.md');
        try {
            await fs.mkdir(dir, { recursive: true });
            if (!fsSync.existsSync(file)) {
                await fs.writeFile(file, '', 'utf-8');
            }
            const doc = await vscode.workspace.openTextDocument(file);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
            vscode.window.showErrorMessage(`[CodePilot] Could not open instructions.md: ${err}`);
        }
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const webviewDist = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'chat.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'chat.css'));
        const hljsThemeUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'hljs-theme.css'));

        return /* html */ `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="Content-Security-Policy"
                    content="default-src 'none';
                             img-src ${webview.cspSource} https: data:;
                             style-src ${webview.cspSource} 'unsafe-inline';
                             script-src 'nonce-${nonce}';" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <link rel="stylesheet" href="${hljsThemeUri}" />
                <link rel="stylesheet" href="${styleUri}" />
                <title>CodePilot</title>
            </head>
            <body>
                <div id="root"></div>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }

    private getSettingsHtml(webview: vscode.Webview, snapshot: AgentYamlSnapshot | null): string {
        const nonce = getNonce();
        const webviewDist = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDist, 'chat.css'));

        const snapshotJson = JSON.stringify(snapshot ?? {});
        const modelsJson = JSON.stringify(MODELS_BY_PROVIDER);
        const envVarsJson = JSON.stringify(PROVIDER_ENV_VAR);

        return /* html */ `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="Content-Security-Policy"
                    content="default-src 'none';
                             style-src ${webview.cspSource} 'unsafe-inline';
                             script-src 'nonce-${nonce}';" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <link rel="stylesheet" href="${styleUri}" />
                <title>CodePilot Settings</title>
            </head>
            <body class="settings-panel-body">
                <div id="settings-root"></div>
                <script nonce="${nonce}">
                    (function() {
                        const vscode = acquireVsCodeApi();
                        const snapshot = ${snapshotJson};
                        const MODELS_BY_PROVIDER = ${modelsJson};
                        const PROVIDER_ENV_VAR = ${envVarsJson};
                        const APPEND_PROMPT_MAX_LEN = 2000;

                        function providerOptions(selected) {
                            return Object.keys(MODELS_BY_PROVIDER)
                                .map(p => '<option value="' + p + '"' + (p === selected ? ' selected' : '') + '>' + p + '</option>')
                                .join('');
                        }
                        function modelOptions(provider, selected) {
                            return (MODELS_BY_PROVIDER[provider] || [])
                                .map(m => '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + '</option>')
                                .join('');
                        }

                        const provider = snapshot.provider || 'alibaba';
                        const model = snapshot.model || (MODELS_BY_PROVIDER[provider]?.[0] ?? '');
                        const tools = snapshot.tools || {};

                        const root = document.getElementById('settings-root');
                        root.innerHTML = \`
                        <div class="sp-layout">
                          <div class="sp-header">
                            <div class="sp-header-left">
                              <svg class="sp-logo-icon" viewBox="0 0 24 24" width="20" height="20" fill="none">
                                <rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" stroke-width="1.6"/>
                                <circle cx="8.5" cy="12" r="1.5" fill="currentColor"/>
                                <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                                <circle cx="15.5" cy="12" r="1.5" fill="currentColor"/>
                              </svg>
                              <span class="sp-header-title">CodePilot Settings</span>
                            </div>
                            <div id="sp-save-status" class="sp-save-status"></div>
                          </div>
                          <div class="sp-content">
                            <div class="sp-grid">

                              <div class="sp-card">
                                <div class="sp-card-header">
                                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13 3H3a1 1 0 00-1 1v8a1 1 0 001 1h10a1 1 0 001-1V4a1 1 0 00-1-1zM8 9.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/></svg>
                                  Model
                                </div>
                                <div class="sp-card-body">
                                  <div class="sp-field">
                                    <label class="sp-label">Provider</label>
                                    <select id="sp-provider" class="sp-select">\${providerOptions(provider)}</select>
                                  </div>
                                  <div class="sp-field">
                                    <label class="sp-label">Model</label>
                                    <select id="sp-model" class="sp-select">\${modelOptions(provider, model)}</select>
                                  </div>
                                  <div class="sp-field-row">
                                    <div class="sp-field">
                                      <label class="sp-label">Temperature</label>
                                      <input id="sp-temperature" class="sp-input" type="number" min="0" max="2" step="0.1" value="\${snapshot.temperature ?? 1.0}" />
                                    </div>
                                    <div class="sp-field">
                                      <label class="sp-label">Max Tokens</label>
                                      <input id="sp-max-tokens" class="sp-input" type="number" min="256" step="256" value="\${snapshot.max_tokens ?? 4096}" />
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div class="sp-card">
                                <div class="sp-card-header">
                                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 10.5h-1.5v-5h1.5v5zm0-6.5h-1.5V3.5h1.5V5z"/></svg>
                                  API Key
                                </div>
                                <div class="sp-card-body">
                                  <div class="sp-field">
                                    <label class="sp-label">Secret Key</label>
                                    <input id="sp-api-key" class="sp-input sp-input-password" type="password"
                                      placeholder="Enter to set / replace current key" autocomplete="off" />
                                  </div>
                                  <div id="sp-env-hint" class="sp-hint">
                                    Stored in <code>\${PROVIDER_ENV_VAR[provider] ?? snapshot.api_key_env ?? ''}</code> on this machine.
                                  </div>
                                </div>
                              </div>

                              <div class="sp-card">
                                 <div class="sp-card-header">
                                   <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1l1.7 3.4L14 5.2l-3 2.9.7 4.1L8 10.5 4.3 12.2 5 8.1 2 5.2l4.3-.8L8 1z"/></svg>
                                   Runtime
                                 </div>
                                 <div class="sp-card-body">
                                   <div class="sp-field-row">
                                     <div class="sp-field">
                                       <label class="sp-label">Max Steps</label>
                                       <input id="sp-max-steps" class="sp-input" type="number" min="1" max="200" value="\${snapshot.max_steps ?? 25}" />
                                     </div>
                                     <div class="sp-field">
                                       <label class="sp-label">Unsafe Mode</label>
                                       <label class="sp-toggle">
                                         <input id="sp-unsafe-mode" type="checkbox" \${snapshot.unsafe_mode ? 'checked' : ''} />
                                         <span class="sp-toggle-track"><span class="sp-toggle-thumb"></span></span>
                                       </label>
                                     </div>
                                     <div class="sp-field">
                                       <label class="sp-label">Thinking</label>
                                       <label class="sp-toggle">
                                         <input id="sp-thinking-mode" type="checkbox" \${snapshot?.thinking?.enabled ? 'checked' : ''} />
                                         <span class="sp-toggle-track"><span class="sp-toggle-thumb"></span></span>
                                       </label>
                                     </div>
                                   </div>
                                 </div>
                               </div>

                              <div class="sp-card sp-card-wide">
                                <div class="sp-card-header">
                                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 3h10v1H3zm0 3h10v1H3zm0 3h7v1H3z"/></svg>
                                  Tool Permissions
                                </div>
                                <div class="sp-card-body">
                                  <div class="sp-tools-header">
                                    <span class="sp-tools-col">Tool</span>
                                    <span class="sp-tools-col sp-tools-col-center">Enabled</span>
                                    <span class="sp-tools-col sp-tools-col-center">Requires Approval</span>
                                  </div>
                                  <div id="sp-tool-list"></div>
                                </div>
                              </div>

                              <div class="sp-card sp-card-wide">
                                <div class="sp-card-header">
                                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 4h12v1H2zm0 3h9v1H2zm0 3h6v1H2z"/></svg>
                                  System Prompt
                                </div>
                                <div class="sp-card-body">
                                  <div class="sp-hint" style="margin-bottom:8px">Text appended to the existing prompt on save.</div>
                                  <textarea id="sp-prompt-append" class="sp-textarea"
                                    placeholder="Additional instructions to append…" rows="4"></textarea>
                                  <div class="sp-field-row" style="margin-top:8px;align-items:center">
                                    <div id="sp-char-count" class="sp-hint"></div>
                                    <button id="sp-open-instructions" class="sp-btn sp-btn-secondary">Open instructions.md</button>
                                  </div>
                                </div>
                              </div>

                            </div>
                          </div>
                          <div class="sp-footer">
                            <button id="sp-save-btn" class="sp-btn sp-btn-primary">
                              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style="margin-right:6px"><path d="M13.5 1.5h-11A1.5 1.5 0 001 3v10a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0015 13V3a1.5 1.5 0 00-1.5-1.5zM11 13H5V9h6v4zm1.5-7.5H3.5v-3h9v3z"/></svg>
                              Save Settings
                            </button>
                          </div>
                        </div>\`;

                        // Wire up provider -> model cascade
                        const providerEl = document.getElementById('sp-provider');
                        const modelEl = document.getElementById('sp-model');
                        const envHint = document.getElementById('sp-env-hint');
                        const apiKeyEl = document.getElementById('sp-api-key');
                        providerEl.addEventListener('change', () => {
                            modelEl.innerHTML = modelOptions(providerEl.value, '');
                            const envVar = PROVIDER_ENV_VAR[providerEl.value] || '';
                            envHint.innerHTML = 'Stored in <code>' + envVar + '</code> on this machine.';
                            apiKeyEl.placeholder = 'Enter to set / replace current key';
                        });

                        // Tool permissions
                        const toolState = JSON.parse(JSON.stringify(tools));
                        const toolListEl = document.getElementById('sp-tool-list');
                        function renderTools() {
                            toolListEl.innerHTML = Object.entries(toolState).map(([name, perm]) => \`
                                <div class="sp-tool-row">
                                  <span class="sp-tool-name">\${name}</span>
                                  <span class="sp-tools-col-center">
                                    <label class="sp-toggle sp-toggle-sm">
                                      <input type="checkbox" \${perm.enabled ? 'checked' : ''} data-tool="\${name}" data-field="enabled" />
                                      <span class="sp-toggle-track"><span class="sp-toggle-thumb"></span></span>
                                    </label>
                                  </span>
                                  <span class="sp-tools-col-center">
                                    <label class="sp-toggle sp-toggle-sm">
                                      <input type="checkbox" \${perm.require_permission ? 'checked' : ''} data-tool="\${name}" data-field="require_permission" />
                                      <span class="sp-toggle-track"><span class="sp-toggle-thumb"></span></span>
                                    </label>
                                  </span>
                                </div>
                            \`).join('');
                            toolListEl.querySelectorAll('input[type=checkbox]').forEach(el => {
                                el.addEventListener('change', e => {
                                    const t = e.target;
                                    toolState[t.dataset.tool][t.dataset.field] = t.checked;
                                });
                            });
                        }
                        renderTools();

                        // Char count
                        const promptEl = document.getElementById('sp-prompt-append');
                        const charCount = document.getElementById('sp-char-count');
                        function updateChar() {
                            charCount.textContent = promptEl.value.length + ' / ' + APPEND_PROMPT_MAX_LEN;
                            charCount.style.color = promptEl.value.length > APPEND_PROMPT_MAX_LEN
                                ? 'var(--vscode-errorForeground)' : '';
                        }
                        promptEl.addEventListener('input', updateChar);
                        updateChar();

                        document.getElementById('sp-open-instructions').addEventListener('click', () => {
                            vscode.postMessage({ type: 'open_instructions_file' });
                        });

                        // Save
                        document.getElementById('sp-save-btn').addEventListener('click', () => {
                            const providerVal = providerEl.value;
                            const settings = {
                                provider: providerVal,
                                model: modelEl.value,
                                temperature: parseFloat(document.getElementById('sp-temperature').value) || 1.0,
                                max_tokens: parseInt(document.getElementById('sp-max-tokens').value, 10) || 4096,
                                api_key_env: PROVIDER_ENV_VAR[providerVal] || snapshot.api_key_env || '',
                                max_steps: parseInt(document.getElementById('sp-max-steps').value, 10) || 25,
                                unsafe_mode: document.getElementById('sp-unsafe-mode').checked,
                                thinking: { enabled: document.getElementById('sp-thinking-mode').checked },
                                tools: toolState,
                                system_prompt_append: promptEl.value.slice(0, APPEND_PROMPT_MAX_LEN)
                            };
                            const newKey = apiKeyEl.value.trim();
                            if (newKey) settings.api_key = newKey;
                            vscode.postMessage({ type: 'update_settings', settings });
                        });

                        const MAX_TOKENS_BY_MODEL = ${JSON.stringify(MAX_TOKENS_BY_MODEL_MAP)};
                        modelEl.addEventListener('change', () => {
                            const selectedModel = modelEl.value;
                            const maxTokens = MAX_TOKENS_BY_MODEL[selectedModel];
                            if (maxTokens) {
                                document.getElementById('sp-max-tokens').value = maxTokens;
                            }
                        });

                        // Receive confirmation
                        window.addEventListener('message', e => {
                            if (e.data.type === 'settings_saved') {
                                const status = document.getElementById('sp-save-status');
                                status.textContent = '✓ Saved';
                                status.className = 'sp-save-status sp-save-ok';
                                setTimeout(() => { status.textContent = ''; status.className = 'sp-save-status'; }, 2500);
                            }
                        });
                    })();
                </script>
            </body>
            </html>
        `;
    }
}