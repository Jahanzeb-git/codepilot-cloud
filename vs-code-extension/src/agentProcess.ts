import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';

export class AgentProcess implements vscode.Disposable {
    private process?: cp.ChildProcess;

    constructor(private context: vscode.ExtensionContext) {
        this.start();
    }

    private async start() {
        // Path to the bundled python script
        const agentScriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'agent_server.py').fsPath;
        const agentYamlPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'agent.yaml').fsPath;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        const pythonExecutable = await this.ensurePythonExecutable(workspaceRoot);

        this.process = cp.spawn(pythonExecutable, [agentScriptPath], {
            env: {
                ...process.env,
                AGENT_YAML_PATH: agentYamlPath,
                PYTHONUNBUFFERED: '1',
                CODEPILOT_WORK_DIR: workspaceRoot,
            }
        });

        this.process.stdout?.on('data', (data) => {
            console.log(`[Agent] ${data.toString()}`);
        });

        this.process.stderr?.on('data', (data) => {
            console.error(`[Agent] ${data.toString()}`);
        });

        this.process.on('close', (code) => {
            console.log(`[Agent] process exited with code ${code}`);
            // Auto-restart or handle crash here if needed
        });
    }

    private async ensurePythonExecutable(workspaceRoot: string): Promise<string> {
        const dedicatedVenvDir = path.join(os.homedir(), '.codepilot', 'venv');
        const dedicatedPython = process.platform === 'win32'
            ? path.join(dedicatedVenvDir, 'Scripts', 'python.exe')
            : path.join(dedicatedVenvDir, 'bin', 'python');

        const testModule = (pythonBin: string): boolean => {
            if (!fs.existsSync(pythonBin)) return false;
            const res = cp.spawnSync(pythonBin, ['-c', 'import codepilot'], { encoding: 'utf-8' });
            return res.status === 0;
        };

        // 1. Check workspace venvs
        const venvPath = path.join(workspaceRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        const dotVenvPath = path.join(workspaceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        const localDevVenv = '/home/jahanzeb-ahmed/python/codepilot-platform/venv/bin/python';

        let configured = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath');
        if (configured && configured !== 'python' && testModule(configured)) {
            return configured;
        }
        if (testModule(venvPath)) return venvPath;
        if (testModule(dotVenvPath)) return dotVenvPath;
        if (testModule(localDevVenv)) return localDevVenv;
        if (testModule(dedicatedPython)) return dedicatedPython;

        // 2. Need to initialize dedicated ~/.codepilot/venv and install codepilot-ai
        const basePython = process.platform === 'win32' ? 'python' : 'python3';
        console.log('[CodePilot] Setting up dedicated Python virtual environment at ~/.codepilot/venv...');
        
        fs.mkdirSync(path.join(os.homedir(), '.codepilot'), { recursive: true });

        if (!fs.existsSync(dedicatedPython)) {
            const createVenvRes = cp.spawnSync(basePython, ['-m', 'venv', dedicatedVenvDir], { encoding: 'utf-8' });
            if (createVenvRes.status !== 0) {
                console.error('[CodePilot] Failed to create venv:', createVenvRes.stderr);
            }
        }

        const localDevPkg = '/home/jahanzeb-ahmed/codepilot';
        const installArgs = fs.existsSync(localDevPkg)
            ? ['-m', 'pip', 'install', '-e', localDevPkg]
            : ['-m', 'pip', 'install', 'codepilot-ai'];

        console.log(`[CodePilot] Installing codepilot via pip... (${installArgs.join(' ')})`);
        const pipRes = cp.spawnSync(dedicatedPython, installArgs, { encoding: 'utf-8' });
        if (pipRes.status !== 0) {
            console.error('[CodePilot] pip install failed:', pipRes.stderr);
        }

        return fs.existsSync(dedicatedPython) ? dedicatedPython : basePython;
    }

    public dispose() {
        if (this.process) {
            this.process.kill();
            this.process = undefined;
        }
    }
}
