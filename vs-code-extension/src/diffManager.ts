import * as vscode from 'vscode';
import * as path from 'path';
import { AgentSocketClient, AgentEvent } from './agentSocketClient';

const DIFF_SCHEME = 'codepilot-diff-before';

// Heuristic list — the codepilot-ai library doesn't expose file-mutation
// metadata directly, so we infer it from tool name + presence of a path-like
// arg. Adjust FILE_MUTATING_TOOL_HINTS if your library's actual tool names
// differ (e.g. if it's "write" instead of "write_file").
const FILE_MUTATING_TOOL_HINTS = ['write_file', 'edit_file', 'create_file', 'str_replace', 'patch_file'];

function looksLikeFileMutation(tool: string, args: Record<string, unknown>): boolean {
    const nameMatches = FILE_MUTATING_TOOL_HINTS.some((hint) => tool.toLowerCase().includes(hint));
    const hasPathArg =
        typeof args?.path === 'string' || typeof args?.filename === 'string' || typeof args?.file === 'string';
    return nameMatches && hasPathArg;
}

function extractPath(args: Record<string, unknown>): string | undefined {
    return (args.path as string) || (args.filename as string) || (args.file as string);
}

class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private snapshots = new Map<string, string>();
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.emitter.event;

    public setSnapshot(key: string, content: string): void {
        this.snapshots.set(key, content);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this.snapshots.get(uri.query) ?? '';
    }
}

/**
 * Note on timing: the "before" snapshot is taken as soon as the extension
 * receives the tool_call event over the socket. If agent_server.py's
 * on_tool_call hook fires strictly before the tool's actual file write
 * executes (typical for pre-execution hooks), this is safe. If your library
 * fires it concurrently with or after execution, the snapshot can race the
 * write and show no diff. Flag this to me if diffs come back empty/wrong —
 * it's a one-line fix (move where we snapshot) once we know the library's
 * actual hook timing.
 */
export class DiffManager {
    private provider = new DiffContentProvider();
    private pendingTool: { tool: string; absPath: string; snapshotKey: string } | null = null;
    private snapshotCounter = 0;

    constructor(
        private workspaceRoot: vscode.Uri | undefined,
        agentClient: AgentSocketClient,
        context: vscode.ExtensionContext
    ) {
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this.provider)
        );
        context.subscriptions.push(agentClient.onAgentEvent((event) => this.handleEvent(event)));
    }

    private resolvePath(relOrAbs: string): vscode.Uri {
        if (path.isAbsolute(relOrAbs)) return vscode.Uri.file(relOrAbs);
        const base = this.workspaceRoot ?? vscode.Uri.file('/workspace');
        return vscode.Uri.joinPath(base, relOrAbs);
    }

    private async handleEvent(event: AgentEvent): Promise<void> {
        if (event.type === 'tool_call') {
            if (!looksLikeFileMutation(event.tool, event.args)) return;

            const rel = extractPath(event.args)!;
            const uri = this.resolvePath(rel);

            let before = '';
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                before = Buffer.from(bytes).toString('utf-8');
            } catch {
                before = ''; // file doesn't exist yet — this is a create, diff against empty
            }

            const snapshotKey = `${uri.fsPath}#${this.snapshotCounter++}`;
            this.provider.setSnapshot(snapshotKey, before);
            this.pendingTool = { tool: event.tool, absPath: uri.fsPath, snapshotKey };
            return;
        }

        if (event.type === 'tool_result' && this.pendingTool && event.tool === this.pendingTool.tool) {
            const { absPath, snapshotKey } = this.pendingTool;
            this.pendingTool = null;

            const afterUri = vscode.Uri.file(absPath);
            try {
                await vscode.workspace.fs.stat(afterUri);
            } catch {
                return; // file no longer exists (deleted) — skip diff for this case
            }

            const beforeUri = vscode.Uri.from({
                scheme: DIFF_SCHEME,
                path: path.basename(absPath),
                query: snapshotKey
            });
            const filename = path.basename(absPath);
            await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${filename} (CodePilot edit)`);
        }
    }
}