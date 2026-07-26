import * as net from 'net';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { UpdateSettingsPayload } from './webview/chat/types';

const SOCKET_PATH = '/tmp/agent_runtime.sock';
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 2000, 2000];

export type AgentEvent =
    | { type: 'stream'; text: string }
    | { type: 'finish' }
    | { type: 'tool_call'; tool: string; args: Record<string, unknown>; label?: string }
    | { type: 'tool_result'; tool: string; result: string }
    | { type: 'ask_user'; question: string }
    | { type: 'queued_message'; message: string }
    | { type: 'inject'; message: string }
    | { type: 'permission_request'; tool: string; description: string }
    | { type: 'connection_status'; status: 'connected' | 'disconnected' | 'reconnecting' | 'error'; detail?: string }
    | { type: 'session_switched'; session_id: string }
    | { type: 'settings_updated'; success: boolean; message?: string };

/**
 * Owns the single unix-socket connection to agent_server.py.
 *
 * WIRE CONTRACT (extension -> server):
 *   {"type":"task","text":"..."}
 *   {"type":"event","event_type":"abort"}
 *   {"type":"event","event_type":"permission_response","value":true|false}
 *   {"type":"event","event_type":"ask_user_response","value":"<user answer>"}
 *   {"type":"event","event_type":"suspend"}
 *   {"type":"event","event_type":"new_session","session_id":"session_00N"}
 *   {"type":"event","event_type":"switch_session","session_id":"session_00N"}
 *   {"type":"event","event_type":"update_settings","settings":{...UpdateSettingsPayload}}
 *
 * Expected inbound responses (server -> extension), see AgentEvent above:
 *   stream, finish, tool_call, tool_result, ask_user, queued_message, inject,
 *   permission_request, connection_status, session_switched, settings_updated
 *
 * Sessions listing and current-settings display are NOT part of this wire
 * contract — the extension host reads those straight off disk
 * (~/.codepilot/sessions/, /opt/codepilot/agent.yaml) and never asks
 * agent_server.py for them.
 */
export class AgentSocketClient extends EventEmitter implements vscode.Disposable {
    private socket?: net.Socket;
    private connectionState: 'idle' | 'connecting' | 'connected' | 'closed' = 'idle';
    private recvBuffer = '';
    private writeQueue: string[] = [];
    private reconnectAttempt = 0;
    private reconnectTimer?: NodeJS.Timeout;
    private manuallyDisposed = false;

    private ensureConnected(): void {
        if (this.connectionState === 'connecting' || this.connectionState === 'connected') return;
        this.connect();
    }

    private connect(): void {
        if (this.manuallyDisposed) return;

        this.connectionState = 'connecting';
        this.socket = net.createConnection(SOCKET_PATH);

        this.socket.on('connect', () => {
            this.connectionState = 'connected';
            this.reconnectAttempt = 0;
            this.emit('agentEvent', { type: 'connection_status', status: 'connected' } as AgentEvent);
            this.flushWriteQueue();
        });

        this.socket.on('data', (chunk) => {
            this.recvBuffer += chunk.toString('utf-8');
            let boundary = this.recvBuffer.indexOf('\n');
            while (boundary !== -1) {
                const line = this.recvBuffer.slice(0, boundary);
                this.recvBuffer = this.recvBuffer.slice(boundary + 1);
                if (line.trim().length > 0) {
                    try {
                        const parsed = JSON.parse(line) as AgentEvent;
                        this.emit('agentEvent', parsed);
                    } catch (err) {
                        console.error('[CodePilot] Failed to parse NDJSON line from agent:', err, line);
                    }
                }
                boundary = this.recvBuffer.indexOf('\n');
            }
        });

        this.socket.on('error', (err) => console.error('[CodePilot] agent socket error:', err));

        this.socket.on('close', () => {
            const wasConnected = this.connectionState === 'connected';
            this.connectionState = 'closed';
            if (this.manuallyDisposed) return;
            this.emit('agentEvent', {
                type: 'connection_status',
                status: 'reconnecting',
                detail: wasConnected ? 'Agent connection lost, reconnecting…' : undefined
            } as AgentEvent);
            this.scheduleReconnect();
        });
    }

    private scheduleReconnect(): void {
        const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }

    private flushWriteQueue(): void {
        if (!this.socket || this.connectionState !== 'connected') return;
        while (this.writeQueue.length > 0) {
            this.socket.write(this.writeQueue.shift()!);
        }
    }

    private send(obj: Record<string, unknown>): void {
        const payload = JSON.stringify(obj) + '\n';
        this.ensureConnected();
        if (this.connectionState === 'connected') {
            this.socket!.write(payload);
        } else {
            this.writeQueue.push(payload);
        }
    }

    public sendTask(text: string): void {
        this.send({ type: 'task', text });
    }

    public sendPermissionResponse(value: boolean): void {
        this.send({ type: 'event', event_type: 'permission_response', value });
    }

    public sendAskUserResponse(value: string): void {
        this.send({ type: 'event', event_type: 'ask_user_response', value });
    }

    public abort(): void {
        this.send({ type: 'event', event_type: 'abort' });
    }

    public suspend(): void {
        this.send({ type: 'event', event_type: 'suspend' });
    }

    public newSession(sessionId: string): void {
        this.send({ type: 'event', event_type: 'new_session', session_id: sessionId });
    }

    public switchSession(sessionId: string): void {
        this.send({ type: 'event', event_type: 'switch_session', session_id: sessionId });
    }

    public updateSettings(settings: UpdateSettingsPayload): void {
        this.send({ type: 'event', event_type: 'update_settings', settings });
    }

    public onAgentEvent(listener: (event: AgentEvent) => void): vscode.Disposable {
        this.on('agentEvent', listener);
        return { dispose: () => this.off('agentEvent', listener) };
    }

    public dispose(): void {
        this.manuallyDisposed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.connectionState === 'connected') this.suspend();
        this.socket?.destroy();
        this.removeAllListeners();
    }
}