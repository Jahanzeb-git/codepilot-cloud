import { AgentMessageView } from './agentMessageView';
import { renderPermissionPrompt } from './permissionPrompt';
import { renderSessionHistory } from './sessionHistory';
import { vscode } from './vscodeApi';
import { SessionSummary } from './types';
import './styles.css';

// ── DOM scaffold ─────────────────────────────────────────────────────────────
const root = document.getElementById('root')!;
root.innerHTML = `
    <div id="chat-container">
        <div id="empty-state">
            <div id="empty-state-icon" aria-hidden="true"></div>
            <div id="empty-state-title">CodePilot</div>
            <div id="empty-state-subtitle">Ask anything about this workspace, or hand off a task.</div>
            <div id="empty-state-shortcuts">
                <div><kbd>Enter</kbd> Send</div>
                <div><kbd>Shift</kbd>+<kbd>Enter</kbd> New line</div>
                <div><kbd>Esc</kbd> Stop</div>
                <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> Focus CodePilot</div>
            </div>
        </div>
    </div>
    <div id="status-bar" class="status-bar hidden"></div>
    <div id="input-container">
        <div id="input-pill">
            <textarea id="task-input" rows="1" placeholder="Ask CodePilot…"></textarea>
            <div id="input-pill-actions">
                <button id="send-btn" class="pill-send-btn" title="Send (Enter)" aria-label="Send">
                    <svg viewBox="0 0 16 16" width="14" height="14">
                        <path d="M2 2l12 6-12 6V9.5l8.5-1.5L2 6.5V2z" fill="currentColor"/>
                    </svg>
                </button>
                <button id="abort-btn" class="pill-abort-btn hidden" title="Stop (Esc)" aria-label="Stop">
                    <svg viewBox="0 0 16 16" width="11" height="11">
                        <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor"/>
                    </svg>
                </button>
            </div>
        </div>
    </div>
`;

const chatContainer = document.getElementById('chat-container')!;
const emptyState    = document.getElementById('empty-state')!;
const statusBar     = document.getElementById('status-bar')!;
const taskInput     = document.getElementById('task-input') as HTMLTextAreaElement;
const sendBtn       = document.getElementById('send-btn')!;
const abortBtn      = document.getElementById('abort-btn')!;

let currentAgentMessage: AgentMessageView | null = null;
let agentBusy = false;
/** True while agent is running but hasn't streamed a chunk yet (shows "Working…") */
let agentWorking = false;
let workingEl: HTMLElement | null = null;
let isAskingUser = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
const MAX_INPUT_HEIGHT = 180;

function autoGrow(): void {
    taskInput.style.height = 'auto';
    taskInput.style.height = Math.min(taskInput.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
}

function scrollToBottom(): void {
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function hideEmptyState(): void {
    emptyState.classList.add('hidden');
}

function resetToEmptyState(): void {
    chatContainer.innerHTML = `
        <div id="empty-state">
            <div id="empty-state-icon" aria-hidden="true"></div>
            <div id="empty-state-title">CodePilot</div>
            <div id="empty-state-subtitle">Ask anything about this workspace, or hand off a task.</div>
            <div id="empty-state-shortcuts">
                <div><kbd>Enter</kbd> Send</div>
                <div><kbd>Shift</kbd>+<kbd>Enter</kbd> New line</div>
                <div><kbd>Esc</kbd> Stop</div>
                <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> Focus CodePilot</div>
            </div>
        </div>
    `;
}

function ensureAgentMessage(): AgentMessageView {
    if (!currentAgentMessage) {
        currentAgentMessage = new AgentMessageView(chatContainer);
    }
    return currentAgentMessage;
}

function appendUserMessage(text: string): void {
    hideEmptyState();
    const div = document.createElement('div');
    div.className = 'message user-message';
    div.textContent = text;
    chatContainer.appendChild(div);
    currentAgentMessage = null;
    scrollToBottom();
}

function appendSystemNote(text: string, kind: 'queued' | 'injected'): void {
    const div = document.createElement('div');
    div.className = `system-note system-note-${kind}`;
    const label = kind === 'queued' ? 'Queued' : 'Injected';
    div.innerHTML = `<span class="system-note-label">${label}</span> ${text}`;
    chatContainer.appendChild(div);
    scrollToBottom();
}

function setStatus(text: string | null): void {
    if (!text) { statusBar.classList.add('hidden'); return; }
    statusBar.textContent = text;
    statusBar.classList.remove('hidden');
}

function setBusy(busy: boolean): void {
    agentBusy = busy;
    sendBtn.classList.toggle('hidden', busy);
    abortBtn.classList.toggle('hidden', !busy);
}

// ── Working animation ─────────────────────────────────────────────────────────
function showWorking(): void {
    if (workingEl) return;
    hideEmptyState();
    workingEl = document.createElement('div');
    workingEl.className = 'working-indicator';
    workingEl.innerHTML = `
        <span class="working-dots">
            <span></span><span></span><span></span>
        </span>
        <span class="working-label">Working</span>
    `;
    chatContainer.appendChild(workingEl);
    scrollToBottom();
}

function hideWorking(): void {
    workingEl?.remove();
    workingEl = null;
    agentWorking = false;
}

// ── Input handling ────────────────────────────────────────────────────────────
function sendCurrentInput(): void {
    const text = taskInput.value.trim();
    if (!text) return;

    if (isAskingUser) {
        vscode.postMessage({ type: 'ask_user_response', value: text });
        appendUserMessage(text);
        taskInput.value = '';
        taskInput.placeholder = 'Ask CodePilot...';
        isAskingUser = false;
        autoGrow();
        return;
    }

    appendUserMessage(text);
    vscode.postMessage({ type: 'send_task', text });
    taskInput.value = '';
    taskInput.style.height = 'auto';
    if (!agentBusy) {
        setBusy(true);
        agentWorking = true;
        showWorking();
    }
}

taskInput.addEventListener('input', autoGrow);
taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentInput();
    } else if (e.key === 'Escape' && agentBusy) {
        e.preventDefault();
        vscode.postMessage({ type: 'abort' });
        setBusy(false);
        hideWorking();
    }
});
sendBtn.addEventListener('click', sendCurrentInput);
abortBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'abort' });
    setBusy(false);
    hideWorking();
});

// ── Message bus ───────────────────────────────────────────────────────────────
window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
        case 'stream':
            hideWorking();
            hideEmptyState();
            ensureAgentMessage().pushChunk(message.text);
            scrollToBottom();
            break;

        case 'tool_call':
            hideWorking();
            hideEmptyState();
            ensureAgentMessage().addToolCall(message.tool, message.args, message.label);
            scrollToBottom();
            break;

        case 'tool_result':
            hideWorking();
            ensureAgentMessage().resolveToolCall(message.tool, message.result);
            break;

        case 'permission_request':
            hideWorking();
            renderPermissionPrompt(
                ensureAgentMessage().getRoot(),
                message.tool,
                message.description,
                (allowed) => vscode.postMessage({ type: 'permission_response', value: allowed })
            );
            scrollToBottom();
            break;

        case 'ask_user':
            hideWorking();
            ensureAgentMessage().appendQuestion(message.question);
            isAskingUser = true;
            taskInput.placeholder = `Agent asks: ${message.question}`;
            taskInput.focus();
            scrollToBottom();
            break;

        case 'queued_message':
            // appendSystemNote(message.message, 'queued'); // Hidden from UI per user request
            break;

        case 'inject':
            // appendSystemNote(message.message, 'injected'); // Hidden from UI per user request
            break;

        case 'finish':
            hideWorking();
            currentAgentMessage?.finish();
            currentAgentMessage = null;
            setBusy(false);
            break;

        case 'connection_status':
            if (message.status === 'connected') setStatus(null);
            else if (message.status === 'reconnecting') setStatus(message.detail || 'Reconnecting to agent…');
            else if (message.status === 'error') setStatus(message.detail || 'Agent connection error.');
            break;

        case 'error':
            hideWorking();
            ensureAgentMessage().appendError(message.message);
            setBusy(false);
            break;

        case 'session_switched':
            currentAgentMessage = null;
            setBusy(false);
            hideWorking();
            if (message.messages && message.messages.length > 5) {
                renderSessionHistory(chatContainer, message.messages);
            } else {
                resetToEmptyState();
            }
            break;

        case 'settings_updated':
            setStatus(message.success ? null : message.message || 'Failed to update settings.');
            break;
    }
});