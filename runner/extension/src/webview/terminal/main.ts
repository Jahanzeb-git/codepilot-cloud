import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

const term = new Terminal({
    theme: {
        background: getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e',
        foreground: getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground') || '#d4d4d4',
        cursor:     getComputedStyle(document.body).getPropertyValue('--vscode-editorCursor-foreground') || '#aeafad',
        selectionBackground: 'rgba(255,255,255,0.15)',
    },
    fontFamily: 'var(--vscode-editor-font-family, "Cascadia Code", "Fira Code", monospace)',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const container = document.getElementById('terminal-container')!;
term.open(container);
fitAddon.fit();

// Notify extension host that xterm.js is ready — this triggers PTY connection
vscode.postMessage({ type: 'ready' });

function postResize(): void {
    vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
}

window.addEventListener('resize', () => {
    fitAddon.fit();
    postResize();
});

// Delay first resize to allow layout to settle
setTimeout(() => {
    fitAddon.fit();
    postResize();
}, 100);

term.onData((data) => {
    vscode.postMessage({ type: 'input', data });
});

window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'pty_data') {
        // Decode base64-encoded raw VT100 bytes and write to xterm.js
        const raw = atob(message.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) {
            bytes[i] = raw.charCodeAt(i);
        }
        term.write(bytes);
    } else if (message.type === 'pty_closed') {
        term.writeln('\r\n\x1b[90m--- terminal session ended ---\x1b[0m');
    }
});