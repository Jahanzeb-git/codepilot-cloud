import * as vscode from 'vscode';
import { AgentSocketClient } from './agentSocketClient';
import { ChatViewProvider } from './chatViewProvider';
import { TerminalManager } from './terminalPanel';
import { DiffManager } from './diffManager';

export function activate(context: vscode.ExtensionContext) {
    const agentClient = new AgentSocketClient();
    context.subscriptions.push(agentClient);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    new DiffManager(workspaceRoot, agentClient, context);

    const chatProvider = new ChatViewProvider(context.extensionUri, agentClient);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Eagerly create the TerminalManager so it connects to the control
    // socket as soon as the extension activates (not only when the user
    // first opens a terminal).
    const terminalManager = TerminalManager.getOrCreate(context.extensionUri);
    context.subscriptions.push({ dispose: () => terminalManager.dispose() });

    context.subscriptions.push(
        vscode.commands.registerCommand('codepilot.openTerminal', () => {
            terminalManager.openNewHumanTerminal();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codepilot.focus', () => {
            vscode.commands.executeCommand('workbench.view.extension.codepilot');
        })
    );

    // Native panel title-bar buttons
    context.subscriptions.push(
        vscode.commands.registerCommand('codepilot.showSessions', () => {
            chatProvider.showSessionsPicker();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codepilot.showSettings', () => {
            chatProvider.showSettingsPanel();
        })
    );
}

export function deactivate() { }