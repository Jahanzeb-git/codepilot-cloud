/**
 * TerminalManager — manages multiple CodePilot terminal WebviewPanels.
 *
 * Architecture:
 *   One persistent connection to /tmp/codepilot_control.sock.
 *   For each "terminal_created" event received → open a new WebviewPanel
 *   tab with xterm.js, connect to the per-terminal MuxServer socket, perform
 *   the JSON handshake, then pipe raw VT100 bytes bi-directionally.
 *
 *   Human "+" button → send {event:"human_terminal_created"} to control socket
 *   → CodePilot runtime creates a new MuxServer → broadcasts terminal_created
 *   → TerminalManager picks it up and opens a tab automatically.
 *
 *   Reconnection:
 *   The agent runtime is rebuilt (and its default terminal's MuxServer/socket
 *   torn down and recreated) on new_session, switch_session, and
 *   update_settings. When that happens, a tab's underlying socket closes.
 *   We handle this two ways, in priority order:
 *     1. If a fresh "terminal_created" arrives on the control channel for a
 *        session id we already have a tab for, that's the authoritative new
 *        socket path — reconnect to it immediately.
 *     2. Otherwise, on an unexpected socket close, retry connecting to the
 *        last known socket path for a few seconds in case it reappears at
 *        the same path before we hear from the control channel.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as net from 'net';
import { getNonce } from './utils';

const CONTROL_SOCKET_PATH = '/tmp/codepilot_control.sock';
const CTRL_RECONNECT_MS = 3000;
const PTY_RETRY_MS = 1000;
const PTY_MAX_RETRIES = 10;
const MAX_RECONNECT_ROUNDS = 3;

interface TerminalTab {
    sessionId: string;
    socketPath: string;
    terminal: vscode.Terminal;
    ptySocket: net.Socket | null;
    handshakeDone: boolean;
    handshakeBuf: Buffer;
    writeEmitter: vscode.EventEmitter<string>;
    closeEmitter: vscode.EventEmitter<number | void>;
    /** True once the user (or VS Code) has explicitly closed this tab — stops all reconnect attempts. */
    userClosed: boolean;
    /** Consecutive unexpected-close reconnect rounds since the last successful connection. */
    reconnectRound: number;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class TerminalManager {
    private static instance: TerminalManager | undefined;

    private extensionUri: vscode.Uri;
    private ctrlSocket: net.Socket | null = null;
    private ctrlBuf: Buffer = Buffer.alloc(0);
    private ctrlConnecting = false;
    private ctrlReconnectTimer: NodeJS.Timeout | null = null;
    private disposed = false;
    private watcher: fs.FSWatcher | null = null;

    /** session_id → open tab */
    private tabs = new Map<string, TerminalTab>();

    private humanCounter = 0;

    private constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
        this.connectControl();
    }

    // ── Public API ──────────────────────────────────────────────────────────

    public static getOrCreate(extensionUri: vscode.Uri): TerminalManager {
        if (!TerminalManager.instance || TerminalManager.instance.disposed) {
            TerminalManager.instance = new TerminalManager(extensionUri);
        }
        return TerminalManager.instance;
    }

    /** Called when the user clicks the "+" terminal button. */
    public openNewHumanTerminal(): void {
        this.humanCounter++;
        const sessionId = `human_${this.humanCounter}`;
        this.sendControl({ event: 'human_terminal_created', session_id: sessionId });
    }

    /** Reveal an existing tab or do nothing (tabs auto-open on terminal_created). */
    public revealTab(sessionId: string): void {
        this.tabs.get(sessionId)?.terminal.show();
    }

    public dispose(): void {
        this.disposed = true;
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        this.ctrlSocket?.destroy();
        for (const tab of this.tabs.values()) {
            if (tab.reconnectTimer) clearTimeout(tab.reconnectTimer);
            tab.ptySocket?.destroy();
            tab.terminal.dispose();
        }
        this.tabs.clear();
        TerminalManager.instance = undefined;
    }

    // ── Control socket ──────────────────────────────────────────────────────

    private connectControl(): void {
        if (this.disposed || this.ctrlConnecting) return;
        this.ctrlConnecting = true;
        if (this.ctrlReconnectTimer) {
            clearTimeout(this.ctrlReconnectTimer);
            this.ctrlReconnectTimer = null;
        }

        if (!this.watcher) {
            try {
                this.watcher = fs.watch('/tmp', (eventType, filename) => {
                    if (eventType === 'rename' && filename && filename.endsWith('.sock')) {
                        if (filename === 'codepilot_control.sock') {
                            console.log('[CodePilot] Control socket inode changed, forcing immediate reconnect.');
                            if (this.ctrlSocket) {
                                this.ctrlSocket.destroy();
                                // Clear the delayed reconnect timer and do it fast:
                                if (this.ctrlReconnectTimer) clearTimeout(this.ctrlReconnectTimer);
                                this.ctrlReconnectTimer = setTimeout(() => this.connectControl(), 100);
                            }
                        } else {
                            const fullPath = `/tmp/${filename}`;
                            for (const tab of this.tabs.values()) {
                                if (tab.socketPath === fullPath) {
                                    console.log(`[CodePilot] PTY socket inode changed for session "${tab.sessionId}", forcing immediate reconnect.`);
                                    // Give it a tiny delay to ensure the new MuxServer is ready to accept connections
                                    setTimeout(() => this.forceReconnect(tab), 100);
                                }
                            }
                        }
                    }
                });
            } catch (e) {
                console.error('[CodePilot] Failed to watch /tmp:', e);
            }
        }

        const sock = net.createConnection(CONTROL_SOCKET_PATH);
        this.ctrlSocket = sock;
        this.ctrlBuf = Buffer.alloc(0);

        sock.on('connect', () => {
            this.ctrlConnecting = false;
            console.log('[CodePilot] Control socket connected.');
        });

        sock.on('data', (data: Buffer) => {
            this.ctrlBuf = Buffer.concat([this.ctrlBuf, data]);
            let nl: number;
            while ((nl = this.ctrlBuf.indexOf('\n')) !== -1) {
                const line = this.ctrlBuf.subarray(0, nl).toString('utf-8').trim();
                this.ctrlBuf = this.ctrlBuf.subarray(nl + 1);
                if (!line) continue;
                try {
                    this.handleControlEvent(JSON.parse(line));
                } catch (e) {
                    console.error('[CodePilot] Control event parse error:', e, line);
                }
            }
        });

        sock.on('error', (err: Error) => {
            // ENOENT before agent_server starts — silently retry
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn('[CodePilot] Control socket error:', err.message);
            }
        });

        sock.on('close', () => {
            this.ctrlSocket = null;
            this.ctrlConnecting = false;
            if (!this.disposed) {
                this.ctrlReconnectTimer = setTimeout(() => this.connectControl(), CTRL_RECONNECT_MS);
            }
        });
    }

    private sendControl(obj: object): void {
        if (!this.ctrlSocket || this.ctrlSocket.destroyed) {
            console.warn('[CodePilot] Control socket not connected — buffering not implemented.');
            return;
        }
        this.ctrlSocket.write(JSON.stringify(obj) + '\n');
    }

    private handleControlEvent(msg: Record<string, unknown>): void {
        if (msg.event === 'terminal_created') {
            const sessionId = String(msg.session_id);
            const socketPath = String(msg.socket_path);

            const existing = this.tabs.get(sessionId);
            if (existing) {
                // The runtime re-initialized (new_session / switch_session /
                // update_settings) and spawned a fresh default terminal on
                // this same session id. The old socket is dead or dying —
                // point this tab at the new path and reconnect now, rather
                // than just revealing the (now-stale) existing tab.
                console.log(`[CodePilot] terminal_created replay for existing session "${sessionId}" — reconnecting to ${socketPath}`);
                existing.socketPath = socketPath;
                existing.terminal.show();
                this.forceReconnect(existing);
                return;
            }

            this.openTerminalTab(sessionId, socketPath);
        }
    }

    // ── Terminal tabs ───────────────────────────────────────────────────────

    private openTerminalTab(sessionId: string, socketPath: string): void {
        const label = this.friendlyLabel(sessionId);
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<number | void>();

        const tab: TerminalTab = {
            sessionId,
            socketPath,
            terminal: null as any, // assigned below
            ptySocket: null,
            handshakeDone: false,
            handshakeBuf: Buffer.alloc(0),
            writeEmitter,
            closeEmitter,
            userClosed: false,
            reconnectRound: 0,
            reconnectTimer: null,
        };

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,
            open: (initialDimensions) => {
                this.connectPty(tab);
                if (initialDimensions) {
                    this.sendControl({ event: 'resize', session_id: sessionId, cols: initialDimensions.columns, rows: initialDimensions.rows });
                }
            },
            close: () => {
                tab.userClosed = true;
                if (tab.reconnectTimer) {
                    clearTimeout(tab.reconnectTimer);
                    tab.reconnectTimer = null;
                }
                tab.ptySocket?.destroy();
                this.tabs.delete(sessionId);
            },
            handleInput: (data: string) => {
                if (tab.ptySocket && !tab.ptySocket.destroyed && tab.handshakeDone) {
                    tab.ptySocket.write(data);
                }
            },
            setDimensions: (dimensions: vscode.TerminalDimensions) => {
                this.sendControl({ event: 'resize', session_id: sessionId, cols: dimensions.columns, rows: dimensions.rows });
            }
        };

        const termName = sessionId === 'main' ? 'codepilot' : label;

        const terminal = vscode.window.createTerminal({
            name: termName,
            pty: pty,
            iconPath: new vscode.ThemeIcon('robot')
        });

        tab.terminal = terminal;
        this.tabs.set(sessionId, tab);

        // Show automatically if it's the main terminal or newly requested by the user
        terminal.show();
    }

    /** Immediately drop the current socket (if any) and reconnect — used when the control channel hands us a fresh socket_path. */
    private forceReconnect(tab: TerminalTab): void {
        if (tab.reconnectTimer) {
            clearTimeout(tab.reconnectTimer);
            tab.reconnectTimer = null;
        }
        tab.reconnectRound = 0;
        const stale = tab.ptySocket;
        tab.ptySocket = null;
        stale?.destroy();
        this.connectPty(tab);
    }

    private connectPty(tab: TerminalTab): void {
        let attempts = 0;

        const tryConnect = () => {
            const sock = net.createConnection(tab.socketPath);
            tab.ptySocket = sock;
            tab.handshakeDone = false;
            tab.handshakeBuf = Buffer.alloc(0);

            sock.on('connect', () => {
                console.log(`[CodePilot] PTY connected: ${tab.sessionId}`);
                attempts = 0;
                tab.reconnectRound = 0;
            });

            sock.on('data', (data: Buffer) => {
                if (tab.ptySocket !== sock) return; // stale socket, superseded already
                if (!tab.handshakeDone) {
                    tab.handshakeBuf = Buffer.concat([tab.handshakeBuf, data]);
                    const nl = tab.handshakeBuf.indexOf('\n');
                    if (nl !== -1) {
                        // Drop the JSON handshake line, keep remainder as VT100
                        const remainder = tab.handshakeBuf.subarray(nl + 1);
                        tab.handshakeDone = true;
                        tab.handshakeBuf = Buffer.alloc(0);
                        if (remainder.length > 0) {
                            tab.writeEmitter.fire(remainder.toString('utf-8'));
                        }
                    }
                    return;
                }
                tab.writeEmitter.fire(data.toString('utf-8'));
            });

            sock.on('error', (err: Error) => {
                if (tab.ptySocket !== sock) return;
                const code = (err as NodeJS.ErrnoException).code;
                if ((code === 'ENOENT' || code === 'ECONNREFUSED') && attempts < PTY_MAX_RETRIES) {
                    // MuxServer not ready yet — retry
                    attempts++;
                    setTimeout(tryConnect, PTY_RETRY_MS);
                } else {
                    console.error(`[CodePilot] PTY socket error (${tab.sessionId}):`, err.message);
                }
            });

            sock.on('close', () => {
                if (tab.ptySocket !== sock) return; // stale socket, a newer one already took over
                if (tab.userClosed) {
                    tab.closeEmitter.fire();
                    return;
                }
                // Socket died out from under us — most likely the runtime
                // re-initialized and tore down this terminal's MuxServer.
                // Don't kill the tab; try to reconnect to the same path.
                // If a fresh terminal_created arrives on the control channel
                // first, forceReconnect() above takes over instead.
                this.scheduleReconnect(tab);
            });
        };

        tryConnect();
    }

    private scheduleReconnect(tab: TerminalTab): void {
        if (tab.userClosed || this.disposed) return;

        tab.reconnectRound++;
        if (tab.reconnectRound === 1) {
            tab.writeEmitter.fire('\r\n\x1b[90m--- connection lost, reconnecting... ---\x1b[0m\r\n');
        }
        if (tab.reconnectRound > MAX_RECONNECT_ROUNDS) {
            tab.writeEmitter.fire('\r\n\x1b[91m--- could not reconnect; close and reopen this terminal ---\x1b[0m\r\n');
            return;
        }

        tab.reconnectTimer = setTimeout(() => {
            tab.reconnectTimer = null;
            if (tab.userClosed) return;
            this.connectPty(tab);
        }, PTY_RETRY_MS);
    }

    private friendlyLabel(sessionId: string): string {
        if (sessionId === 'main') return 'Agent Terminal';
        if (sessionId === 'server_logs') return 'Server Logs';
        if (sessionId.startsWith('human_')) {
            return `codepilot (${sessionId.replace('human_', '')})`;
        }
        return `Terminal: ${sessionId}`;
    }
}