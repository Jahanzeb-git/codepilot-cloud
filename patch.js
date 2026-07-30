const fs = require('fs');
const content = fs.readFileSync('runner/extension/src/terminalPanel.ts', 'utf8');

const importFs = `import * as fs from 'fs';\nimport * as vscode from 'vscode';`;

const watcherProp = `    private disposed = false;
    private watcher: fs.FSWatcher | null = null;`;

const disposeWatcher = `    public dispose(): void {
        this.disposed = true;
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        this.ctrlSocket?.destroy();`;

const connectControl = `    private connectControl(): void {
        if (this.disposed || this.ctrlConnecting) return;
        this.ctrlConnecting = true;

        if (!this.watcher) {
            try {
                this.watcher = fs.watch('/tmp', (eventType, filename) => {
                    if (filename === 'codepilot_control.sock' && eventType === 'rename') {
                        console.log('[CodePilot] Control socket inode changed, forcing immediate reconnect.');
                        if (this.ctrlSocket) {
                            this.ctrlSocket.destroy();
                            // The close event will trigger a delayed reconnect, but we want it fast:
                            setTimeout(() => this.connectControl(), 100);
                        }
                    }
                });
            } catch (e) {
                console.error('[CodePilot] Failed to watch /tmp:', e);
            }
        }`;

let newContent = content.replace(`import * as vscode from 'vscode';`, importFs);
newContent = newContent.replace(`    private disposed = false;`, watcherProp);
newContent = newContent.replace(`    public dispose(): void {\n        this.disposed = true;\n        this.ctrlSocket?.destroy();`, disposeWatcher);
newContent = newContent.replace(`    private connectControl(): void {\n        if (this.disposed || this.ctrlConnecting) return;\n        this.ctrlConnecting = true;`, connectControl);

fs.writeFileSync('runner/extension/src/terminalPanel.ts', newContent);
