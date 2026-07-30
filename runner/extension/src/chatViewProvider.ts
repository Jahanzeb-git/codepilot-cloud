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
    if (messages.length > 5) {
        const msg = messages[5];
        if (msg && msg.content) {
            const match = msg.content.match(TASK_INPUT_RE);
            if (match) {
                const firstLine = match[1].split('\n')[0].trim();
                return firstLine.length > TITLE_MAX_LEN ? firstLine.slice(0, TITLE_MAX_LEN).trimEnd() + '…' : firstLine;
            }
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
            tools,
            thinking: {
                enabled: agentCfg.model?.thinking?.enabled ?? false,
                budget_tokens: agentCfg.model?.thinking?.budget_tokens,
                reasoning_effort: agentCfg.model?.thinking?.reasoning_effort
            },
            sub_agents: {
                enabled: agentCfg.sub_agents?.enabled ?? false,
                max_steps: agentCfg.sub_agents?.max_steps ?? 20
            }
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

        const deleteButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: 'Delete Session'
        };

        for (const s of sessions) {
            items.push({
                label: `$(comment-discussion)  ${s.title || '(untitled session)'}`,
                description: formatRelativeTime(s.updated_at),
                sessionId: s.session_id,
                buttons: [deleteButton]
            });
        }

        if (sessions.length === 0) {
            items.push({ label: 'No previous sessions yet.', description: '' });
        }

        const quickPick = vscode.window.createQuickPick<SessionItem>();
        quickPick.items = items;
        quickPick.placeholder = 'Switch session or start a new one';
        quickPick.title = 'CodePilot Sessions';
        quickPick.matchOnDescription = true;

        quickPick.onDidTriggerItemButton(async (e) => {
            if (e.button === deleteButton && e.item.sessionId) {
                const confirm = await vscode.window.showWarningMessage(
                    `Are you sure you want to permanently delete session "${e.item.label.replace('$(comment-discussion)  ', '')}"?`,
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    this.agentClient.deleteSession(e.item.sessionId);
                    quickPick.hide();
                }
            }
        });

        quickPick.onDidAccept(() => {
            const pick = quickPick.selectedItems[0];
            if (!pick) return;

            if (pick.isNew) {
                this.agentClient.newSession(nextSessionId(sessions));
            } else if (pick.sessionId) {
                this.agentClient.switchSession(pick.sessionId);
            }
            quickPick.hide();
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
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
            vscode.window.showInformationMessage(`[DEBUG] session_switched received for ${event.session_id}`);
            const messages = await readSessionMessages(event.session_id);
            vscode.window.showInformationMessage(`[DEBUG] Read ${messages.length} messages for ${event.session_id}`);
            this.view?.webview.postMessage({ type: 'session_switched', session_id: event.session_id, messages });
            return;
        } else if (event.type === 'session_deleted') {
            vscode.window.showInformationMessage(`Session ${event.session_id} has been deleted.`);
            // Forward it to webview so it can clear its state if it was looking at this session
            this.view?.webview.postMessage(event);
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
                <title>CodePilot Settings</title>
                <style>
                    body.settings-panel-body {
                        margin: 0; padding: 0;
                        background-color: var(--vscode-editor-background) !important;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                    }
                    #settings-modal {
                        width: 950px;
                        height: 750px;
                        background-color: var(--vscode-editorWidget-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 12px;
                        display: flex;
                        overflow: hidden;
                        box-shadow: 0 25px 50px -12px var(--vscode-widget-shadow);
                    }
                    .sp-sidebar {
                        width: 240px;
                        background-color: var(--vscode-sideBar-background);
                        border-right: 1px solid var(--vscode-widget-border);
                        display: flex;
                        flex-direction: column;
                        padding: 24px 0;
                    }
                    .sp-sidebar-header {
                        padding: 0 24px 24px 24px;
                        font-weight: 600;
                        font-size: 15px;
                        color: var(--vscode-sideBarTitle-foreground);
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        letter-spacing: 0.5px;
                    }
                    .sp-nav-group {
                        margin-bottom: 24px;
                    }
                    .sp-nav-group-title {
                        padding: 0 24px 8px 24px;
                        font-size: 11px;
                        text-transform: uppercase;
                        color: var(--vscode-descriptionForeground);
                        font-weight: 600;
                        letter-spacing: 0.5px;
                    }
                    .sp-nav-item {
                        padding: 10px 24px;
                        cursor: pointer;
                        font-size: 13px;
                        color: var(--vscode-sideBar-foreground);
                        transition: all 0.2s;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }
                    .sp-nav-item:hover {
                        background-color: var(--vscode-list-hoverBackground);
                        color: var(--vscode-list-hoverForeground);
                    }
                    .sp-nav-item.active {
                        background-color: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                        font-weight: 500;
                        border-left: 3px solid var(--vscode-focusBorder);
                        padding-left: 21px;
                    }
                    .sp-main {
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        background-color: var(--vscode-editor-background);
                    }
                    .sp-content-header {
                        height: 70px;
                        border-bottom: 1px solid var(--vscode-widget-border);
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        padding: 0 40px;
                    }
                    .sp-content-title {
                        font-size: 18px;
                        font-weight: 500;
                        color: var(--vscode-editor-foreground);
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }
                    .sp-content-subtitle {
                        font-size: 13px;
                        color: var(--vscode-descriptionForeground);
                        margin-top: 4px;
                    }
                    .sp-content-body {
                        flex: 1;
                        overflow-y: auto;
                        padding: 40px;
                    }
                    .sp-section {
                        display: none;
                        animation: fadeIn 0.3s ease;
                    }
                    .sp-section.active {
                        display: block;
                    }
                    @keyframes fadeIn {
                        from { opacity: 0; transform: translateY(5px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    .sp-card-new {
                        background-color: var(--vscode-editorWidget-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 10px;
                        padding: 24px;
                        margin-bottom: 24px;
                    }
                    .sp-card-title {
                        font-size: 15px;
                        font-weight: 600;
                        margin-bottom: 20px;
                        color: var(--vscode-editor-foreground);
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .sp-field-group {
                        margin-bottom: 20px;
                    }
                    .sp-field-group:last-child {
                        margin-bottom: 0;
                    }
                    .sp-field-row-new {
                        display: flex;
                        gap: 20px;
                        margin-bottom: 20px;
                    }
                    .sp-field-row-new > div {
                        flex: 1;
                    }
                    .sp-label-new {
                        display: block;
                        font-size: 13px;
                        color: var(--vscode-editor-foreground);
                        margin-bottom: 8px;
                        font-weight: 500;
                    }
                    .sp-input-new, .sp-select-new, .sp-textarea-new {
                        width: 100%;
                        background-color: var(--vscode-input-background);
                        border: 1px solid var(--vscode-input-border);
                        color: var(--vscode-input-foreground);
                        border-radius: 6px;
                        padding: 10px 14px;
                        font-size: 13px;
                        outline: none;
                        box-sizing: border-box;
                        transition: border-color 0.2s, box-shadow 0.2s;
                    }
                    .sp-input-new:focus, .sp-select-new:focus, .sp-textarea-new:focus {
                        border-color: var(--vscode-focusBorder);
                        box-shadow: 0 0 0 2px var(--vscode-focusBorder);
                    }
                    .sp-textarea-new {
                        resize: vertical;
                        min-height: 80px;
                    }
                    .sp-btn-new {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 9px 20px;
                        border-radius: 6px;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: background-color 0.2s, transform 0.1s;
                        display: inline-flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .sp-btn-new:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .sp-btn-new:active {
                        transform: scale(0.98);
                    }
                    .sp-btn-secondary {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    .sp-btn-secondary:hover {
                        background-color: var(--vscode-button-secondaryHoverBackground);
                    }
                    .sp-hint-new {
                        font-size: 12px;
                        color: var(--vscode-descriptionForeground);
                        margin-top: 6px;
                    }
                    .sp-hint-new code {
                        background-color: var(--vscode-textCodeBlock-background);
                        padding: 2px 6px;
                        border-radius: 4px;
                        color: var(--vscode-editor-foreground);
                    }
                    
                    /* Custom Toggle */
                    .sp-toggle-container {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        padding: 12px 16px;
                        background-color: var(--vscode-editorWidget-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 6px;
                        margin-bottom: 12px;
                    }
                    .sp-toggle-label {
                        font-size: 13px;
                        color: var(--vscode-editor-foreground);
                    }
                    .sp-toggle {
                        position: relative;
                        display: inline-block;
                        width: 36px;
                        height: 20px;
                    }
                    .sp-toggle input {
                        opacity: 0;
                        width: 0;
                        height: 0;
                    }
                    .sp-toggle-slider {
                        position: absolute;
                        cursor: pointer;
                        top: 0; left: 0; right: 0; bottom: 0;
                        background-color: var(--vscode-scrollbarSlider-background);
                        transition: .2s;
                        border-radius: 20px;
                    }
                    .sp-toggle-slider:before {
                        position: absolute;
                        content: "";
                        height: 14px;
                        width: 14px;
                        left: 3px;
                        bottom: 3px;
                        background-color: var(--vscode-editor-background);
                        transition: .2s;
                        border-radius: 50%;
                    }
                    input:checked + .sp-toggle-slider {
                        background-color: var(--vscode-button-background);
                    }
                    input:checked + .sp-toggle-slider:before {
                        transform: translateX(16px);
                        background-color: var(--vscode-button-foreground);
                    }
                    
                    /* Save Status */
                    .sp-save-status {
                        font-size: 13px;
                        color: #10b981;
                        opacity: 0;
                        transition: opacity 0.3s;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .sp-save-status.show {
                        opacity: 1;
                    }

                    /* Tool Grid */
                    .sp-tool-grid {
                        display: grid;
                        grid-template-columns: 1fr auto auto;
                        gap: 16px;
                        align-items: center;
                        padding: 12px 16px;
                        border-bottom: 1px solid var(--vscode-widget-border);
                    }
                    .sp-tool-grid:last-child {
                        border-bottom: none;
                    }
                    .sp-tool-header-grid {
                        font-size: 11px;
                        text-transform: uppercase;
                        color: var(--vscode-descriptionForeground);
                        font-weight: 600;
                        border-bottom: 1px solid var(--vscode-widget-border);
                        padding-bottom: 12px;
                        margin-bottom: 8px;
                    }
                </style>
            </head>
            <body class="settings-panel-body">
                <div id="settings-modal">
                    
                    <div class="sp-sidebar">
                        <div class="sp-sidebar-header">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                                <rect x="3" y="5" width="18" height="14" rx="3" stroke="var(--vscode-editor-foreground)" stroke-width="2"/>
                                <circle cx="8.5" cy="12" r="1.5" fill="var(--vscode-editor-foreground)"/>
                                <circle cx="12" cy="12" r="1.5" fill="var(--vscode-editor-foreground)"/>
                                <circle cx="15.5" cy="12" r="1.5" fill="var(--vscode-editor-foreground)"/>
                            </svg>
                            CodePilot Settings
                        </div>
                        
                        <div class="sp-nav-group">
                            <div class="sp-nav-group-title">Configuration</div>
                            <div class="sp-nav-item active" data-target="section-api">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                                API & Models
                            </div>
                            <div class="sp-nav-item" data-target="section-behavior">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                                Agent Behavior
                            </div>
                            <div class="sp-nav-item" data-target="section-tools">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                                Tool Permissions
                            </div>
                            <div class="sp-nav-item" data-target="section-advanced">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>
                                Advanced
                            </div>
                        </div>
                    </div>
                    
                    <div class="sp-main">
                        <div class="sp-content-header">
                            <div>
                                <div class="sp-content-title" id="header-title">API & Models</div>
                                <div class="sp-content-subtitle">Manage connection settings to Large Language Models.</div>
                            </div>
                            <div style="display:flex; align-items:center; gap:16px">
                                <div id="sp-save-status" class="sp-save-status">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                    Saved
                                </div>
                                <button id="sp-save-btn" class="sp-btn-new">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                                    Save Changes
                                </button>
                            </div>
                        </div>
                        
                        <div class="sp-content-body">
                            
                            <!-- API & Models Section -->
                            <div id="section-api" class="sp-section active">
                                <div class="sp-card-new">
                                    <div class="sp-card-title">LLM Connection</div>
                                    <div class="sp-field-group">
                                        <label class="sp-label-new">AI Provider</label>
                                        <select id="sp-provider" class="sp-select-new"></select>
                                    </div>
                                    <div class="sp-field-group">
                                        <label class="sp-label-new">Model Selection</label>
                                        <select id="sp-model" class="sp-select-new"></select>
                                    </div>
                                </div>
                                
                                <div class="sp-card-new">
                                    <div class="sp-card-title">Authentication</div>
                                    <div class="sp-field-group">
                                        <label class="sp-label-new">Secret API Key</label>
                                        <input id="sp-api-key" class="sp-input-new" type="password" placeholder="Enter to set or replace current key" autocomplete="off" />
                                        <div id="sp-env-hint" class="sp-hint-new"></div>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Agent Behavior Section -->
                            <div id="section-behavior" class="sp-section">
                                <div class="sp-card-new">
                                    <div class="sp-card-title">Generation Parameters</div>
                                    <div class="sp-field-row-new">
                                        <div>
                                            <label class="sp-label-new">Temperature</label>
                                            <input id="sp-temperature" class="sp-input-new" type="number" min="0" max="2" step="0.1" />
                                            <div class="sp-hint-new">Higher values produce more creative outputs.</div>
                                        </div>
                                        <div>
                                            <label class="sp-label-new">Max Tokens</label>
                                            <input id="sp-max-tokens" class="sp-input-new" type="number" min="256" step="256" />
                                            <div class="sp-hint-new">Maximum length of the generated response.</div>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="sp-card-new">
                                    <div class="sp-card-title">System Prompt</div>
                                    <div class="sp-field-group">
                                        <label class="sp-label-new">Additional Instructions</label>
                                        <textarea id="sp-prompt-append" class="sp-textarea-new" placeholder="Custom text appended to the core system prompt..."></textarea>
                                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
                                            <div id="sp-char-count" class="sp-hint-new">0 / 2000</div>
                                            <button id="sp-open-instructions" class="sp-btn-new sp-btn-secondary">Open full instructions.md</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Tool Permissions Section -->
                            <div id="section-tools" class="sp-section">
                                <div class="sp-card-new">
                                    <div class="sp-card-title">Security & Access</div>
                                    <div class="sp-hint-new" style="margin-bottom: 20px;">Configure which actions the agent is allowed to execute autonomously, and which require explicit user approval.</div>
                                    
                                    <div class="sp-tool-grid sp-tool-header-grid">
                                        <div>Tool Name</div>
                                        <div style="text-align:center">Enabled</div>
                                        <div style="text-align:center">Requires Approval</div>
                                    </div>
                                    <div id="sp-tool-list"></div>
                                </div>
                            </div>
                            
                            <!-- Advanced Section -->
                            <div id="section-advanced" class="sp-section">
                                <div class="sp-card-new">
                                    <div class="sp-card-title">Runtime Limits</div>
                                    <div class="sp-field-group">
                                        <label class="sp-label-new">Max Autonomous Steps</label>
                                        <input id="sp-max-steps" class="sp-input-new" type="number" min="1" max="200" />
                                        <div class="sp-hint-new">Maximum number of consecutive tool executions without user interaction.</div>
                                    </div>
                                </div>
                                
                                <div class="sp-card-new">
                                    <div class="sp-card-title">Experimental Features</div>
                                    
                                    <div class="sp-toggle-container">
                                        <div>
                                            <div class="sp-toggle-label">Unsafe Mode</div>
                                            <div class="sp-hint-new" style="margin-top:2px">Disables certain safety checks. Use with caution.</div>
                                        </div>
                                        <label class="sp-toggle">
                                            <input id="sp-unsafe-mode" type="checkbox" />
                                            <span class="sp-toggle-slider"></span>
                                        </label>
                                    </div>
                                    
                                    <div class="sp-toggle-container">
                                        <div>
                                            <div class="sp-toggle-label">Thinking Mode</div>
                                            <div class="sp-hint-new" style="margin-top:2px">Enables hidden chain-of-thought reasoning for supported models.</div>
                                        </div>
                                        <label class="sp-toggle">
                                            <input id="sp-thinking-mode" type="checkbox" />
                                            <span class="sp-toggle-slider"></span>
                                        </label>
                                    </div>
                                </div>

                                <div class="sp-card-new">
                                    <div class="sp-card-title">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                            <circle cx="9" cy="7" r="4"></circle>
                                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                                            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                                        </svg>
                                        Sub-Agents Configuration
                                    </div>
                                    <div class="sp-field-group">
                                        <label class="sp-toggle-container">
                                            <div class="sp-toggle-label">
                                                Enable Sub-Agents
                                                <div class="sp-hint-new" style="margin-top: 4px;">Allows the agent to spawn specialized sub-agents for complex tasks.</div>
                                            </div>
                                            <label class="sp-toggle">
                                                <input type="checkbox" id="subagents-enabled" ${snapshot?.sub_agents?.enabled ? 'checked' : ''} />
                                                <span class="sp-toggle-slider"></span>
                                            </label>
                                        </label>
                                    </div>
                                    <div class="sp-field-group">
                                        <label class="sp-label-new">Sub-Agent Max Steps</label>
                                        <input type="number" id="subagents-max-steps" class="sp-input-new" value="${snapshot?.sub_agents?.max_steps ?? 20}" />
                                        <div class="sp-hint-new">Maximum execution steps per spawned worker sub-agent.</div>
                                    </div>
                                </div>
                            </div>
                            
                        </div>
                    </div>
                </div>

                <script nonce="${nonce}">
                    (function() {
                        const vscode = acquireVsCodeApi();
                        const snapshot = ${snapshotJson};
                        const MODELS_BY_PROVIDER = ${modelsJson};
                        const PROVIDER_ENV_VAR = ${envVarsJson};
                        const APPEND_PROMPT_MAX_LEN = 2000;
                        const MAX_TOKENS_BY_MODEL = ${JSON.stringify(MAX_TOKENS_BY_MODEL_MAP)};

                        // Tab Switching Logic
                        const navItems = document.querySelectorAll('.sp-nav-item');
                        const sections = document.querySelectorAll('.sp-section');
                        const headerTitle = document.getElementById('header-title');
                        
                        navItems.forEach(item => {
                            item.addEventListener('click', () => {
                                navItems.forEach(n => n.classList.remove('active'));
                                sections.forEach(s => s.classList.remove('active'));
                                
                                item.classList.add('active');
                                const targetId = item.getAttribute('data-target');
                                document.getElementById(targetId).classList.add('active');
                                headerTitle.textContent = item.textContent.trim();
                            });
                        });

                        // Populate Data
                        const providerEl = document.getElementById('sp-provider');
                        const modelEl = document.getElementById('sp-model');
                        const envHint = document.getElementById('sp-env-hint');
                        const apiKeyEl = document.getElementById('sp-api-key');
                        
                        const currentProvider = snapshot.provider || 'alibaba';
                        const currentModel = snapshot.model || (MODELS_BY_PROVIDER[currentProvider]?.[0] ?? '');
                        
                        function renderProviderOptions() {
                            providerEl.innerHTML = Object.keys(MODELS_BY_PROVIDER)
                                .map(p => '<option value="' + p + '"' + (p === currentProvider ? ' selected' : '') + '>' + p + '</option>')
                                .join('');
                        }
                        
                        function renderModelOptions(provider, selected) {
                            modelEl.innerHTML = (MODELS_BY_PROVIDER[provider] || [])
                                .map(m => '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + '</option>')
                                .join('');
                        }

                        renderProviderOptions();
                        renderModelOptions(currentProvider, currentModel);
                        envHint.innerHTML = 'Stored in <code>' + (PROVIDER_ENV_VAR[currentProvider] || snapshot.api_key_env || '') + '</code> on this machine.';

                        providerEl.addEventListener('change', () => {
                            renderModelOptions(providerEl.value, '');
                            const envVar = PROVIDER_ENV_VAR[providerEl.value] || '';
                            envHint.innerHTML = 'Stored in <code>' + envVar + '</code> on this machine.';
                            apiKeyEl.placeholder = 'Enter to set or replace current key';
                        });

                        modelEl.addEventListener('change', () => {
                            const maxTokens = MAX_TOKENS_BY_MODEL[modelEl.value];
                            if (maxTokens) document.getElementById('sp-max-tokens').value = maxTokens;
                        });

                        // Basic Settings
                        document.getElementById('sp-temperature').value = snapshot.temperature ?? 1.0;
                        document.getElementById('sp-max-tokens').value = snapshot.max_tokens ?? 4096;
                        document.getElementById('sp-max-steps').value = snapshot.max_steps ?? 25;
                        document.getElementById('sp-unsafe-mode').checked = !!snapshot.unsafe_mode;
                        document.getElementById('sp-thinking-mode').checked = !!snapshot?.thinking?.enabled;

                        // Tool Permissions
                        const tools = snapshot.tools || {};
                        const toolState = JSON.parse(JSON.stringify(tools));
                        const toolListEl = document.getElementById('sp-tool-list');
                        
                        function renderTools() {
                            toolListEl.innerHTML = Object.entries(toolState).map(([name, perm]) => \`
                                <div class="sp-tool-grid" style="border-radius: 6px; margin-bottom: 8px;">
                                    <div style="font-size: 13px; font-weight: 500; color: var(--vscode-editor-foreground)">\${name}</div>
                                    <div style="display:flex; justify-content:center">
                                        <label class="sp-toggle">
                                            <input type="checkbox" \${perm.enabled ? 'checked' : ''} data-tool="\${name}" data-field="enabled" />
                                            <span class="sp-toggle-slider"></span>
                                        </label>
                                    </div>
                                    <div style="display:flex; justify-content:center">
                                        <label class="sp-toggle">
                                            <input type="checkbox" \${perm.require_permission ? 'checked' : ''} data-tool="\${name}" data-field="require_permission" />
                                            <span class="sp-toggle-slider"></span>
                                        </label>
                                    </div>
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

                        // System Prompt Appender
                        const promptEl = document.getElementById('sp-prompt-append');
                        const charCount = document.getElementById('sp-char-count');
                        
                        function updateChar() {
                            charCount.textContent = promptEl.value.length + ' / ' + APPEND_PROMPT_MAX_LEN;
                            charCount.style.color = promptEl.value.length > APPEND_PROMPT_MAX_LEN ? '#ef4444' : '#71717a';
                        }
                        promptEl.addEventListener('input', updateChar);
                        updateChar();

                        document.getElementById('sp-open-instructions').addEventListener('click', () => {
                            vscode.postMessage({ type: 'open_instructions_file' });
                        });

                        // Save Logic
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
                                system_prompt_append: promptEl.value.slice(0, APPEND_PROMPT_MAX_LEN),
                                sub_agents: {
                                    enabled: document.getElementById('subagents-enabled').checked,
                                    max_steps: parseInt(document.getElementById('subagents-max-steps').value, 10)
                                }
                            };
                            const newKey = apiKeyEl.value.trim();
                            if (newKey) settings.api_key = newKey;
                            vscode.postMessage({ type: 'update_settings', settings });
                        });

                        window.addEventListener('message', e => {
                            if (e.data.type === 'settings_saved') {
                                const status = document.getElementById('sp-save-status');
                                status.classList.add('show');
                                setTimeout(() => status.classList.remove('show'), 2500);
                            }
                        });
                    })();
                </script>
            </body>
            </html>
        `;
    }
}