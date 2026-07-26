import { vscode } from './vscodeApi';
import {
    AgentYamlSnapshot,
    MODELS_BY_PROVIDER,
    MAX_TOKENS_BY_MODEL,
    PROVIDER_ENV_VAR,
    APPEND_PROMPT_MAX_LEN,
    ToolPermission,
    ThinkingConfig,
    UpdateSettingsPayload
} from './types';

function providerOptions(selected: string): string {
    return Object.keys(MODELS_BY_PROVIDER)
        .map((p) => `<option value="${p}" ${p === selected ? 'selected' : ''}>${p}</option>`)
        .join('');
}

function modelOptions(provider: string, selected: string): string {
    return (MODELS_BY_PROVIDER[provider] || [])
        .map((m) => `<option value="${m}" ${m === selected ? 'selected' : ''}>${m}</option>`)
        .join('');
}

function reasoningEffortOptions(provider: string, selected: string): string {
    const opts = provider === 'deepseek'
        ? ['high', 'max']
        : ['low', 'medium', 'high'];
    return opts.map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
}

export function showSettingsModal(current: AgentYamlSnapshot | null): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const provider = current?.provider || 'alibaba';
    const model = current?.model || (MODELS_BY_PROVIDER[provider]?.[0] ?? '');
    const tools: Record<string, ToolPermission> = current?.tools ?? {};
    const thinking: ThinkingConfig = current?.thinking ?? { enabled: false, budget_tokens: 8000, reasoning_effort: 'high' };

    const modal = document.createElement('div');
    modal.className = 'modal modal-settings';
    modal.innerHTML = `
        <div class="modal-header">
            <span>Settings</span>
            <button class="modal-close-btn" id="settings-close-btn">×</button>
        </div>
        <div class="modal-body">
            <div class="settings-section">
                <label class="settings-label">Provider &amp; Model</label>
                <div class="settings-row">
                    <select id="provider-select" class="settings-select">${providerOptions(provider)}</select>
                    <select id="model-select" class="settings-select">${modelOptions(provider, model)}</select>
                </div>
            </div>

            <div class="settings-section settings-row-split">
                <div>
                    <label class="settings-label">Temperature</label>
                    <input id="temperature-input" class="settings-input settings-input-narrow" type="number"
                        min="0" max="2" step="0.1" value="${current?.temperature ?? 1.0}" />
                </div>
                <div>
                    <label class="settings-label">Max Tokens</label>
                    <input id="max-tokens-input" class="settings-input settings-input-narrow" type="number"
                        min="256" step="256" value="${current?.max_tokens ?? (MAX_TOKENS_BY_MODEL[model] ?? 65536)}" />
                </div>
            </div>

            <div class="settings-section">
                <label class="settings-label">API Key</label>
                <div class="settings-row">
                    <input id="api-key-input" class="settings-input" type="password"
                        placeholder="Enter to set/replace ${PROVIDER_ENV_VAR[provider] ?? ''}" />
                </div>
                <div id="api-key-env-hint" class="settings-hint">
                    Stored in the <code>${PROVIDER_ENV_VAR[provider] ?? current?.api_key_env ?? ''}</code> environment variable on this machine.
                </div>
            </div>

            <div class="settings-section">
                <label class="settings-label">Thinking / Reasoning</label>
                <div class="settings-hint">Enable extended reasoning for supported models (Anthropic, OpenAI o-series, DeepSeek).</div>
                <div class="settings-row-split" style="display:flex;gap:16px;align-items:center;margin-top:6px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <label class="settings-hint" style="margin:0">Enable</label>
                        <label class="toggle-switch">
                            <input id="thinking-toggle" type="checkbox" ${thinking.enabled ? 'checked' : ''} />
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div id="thinking-extra" style="${thinking.enabled ? '' : 'opacity:0.4;pointer-events:none'}">
                        <div style="display:flex;gap:12px;flex-wrap:wrap;">
                            <div>
                                <label class="settings-hint">Budget Tokens (Anthropic)</label>
                                <input id="thinking-budget" class="settings-input settings-input-narrow" type="number"
                                    min="1000" step="1000" value="${thinking.budget_tokens ?? 8000}" />
                            </div>
                            <div>
                                <label class="settings-hint">Reasoning Effort</label>
                                <select id="thinking-effort" class="settings-select">${reasoningEffortOptions(provider, thinking.reasoning_effort ?? 'high')}</select>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="settings-section settings-row-split">
                <div>
                    <label class="settings-label">Max Steps</label>
                    <input id="max-steps-input" class="settings-input settings-input-narrow" type="number"
                        min="1" max="200" value="${current?.max_steps ?? 25}" />
                </div>
                <div>
                    <label class="settings-label">Unsafe Mode</label>
                    <label class="toggle-switch">
                        <input id="unsafe-mode-toggle" type="checkbox" ${current?.unsafe_mode ? 'checked' : ''} />
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>

            <div class="settings-section">
                <label class="settings-label">Tool Permissions</label>
                <div class="settings-hint">Toggle which tools are enabled and which require your approval each time.</div>
                <div id="tool-permission-list" class="tool-permission-list"></div>
            </div>

            <div class="settings-section">
                <label class="settings-label">System Prompt</label>
                <div class="settings-hint">Appended to the existing prompt on save.</div>
                <textarea id="prompt-append-input" class="settings-textarea"
                    placeholder="Additional instructions to append…"></textarea>
                <div id="prompt-char-count" class="settings-hint"></div>
                <button id="open-instructions-btn" class="btn btn-secondary">
                    Open instructions.md (overrides prompt entirely if non-empty)
                </button>
            </div>
        </div>
        <div class="modal-footer">
            <button id="settings-save-btn" class="btn btn-primary">Save Settings</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const providerSelect  = modal.querySelector('#provider-select') as HTMLSelectElement;
    const modelSelect     = modal.querySelector('#model-select') as HTMLSelectElement;
    const maxTokensInput  = modal.querySelector('#max-tokens-input') as HTMLInputElement;
    const apiKeyEnvHint   = modal.querySelector('#api-key-env-hint') as HTMLElement;
    const apiKeyInput     = modal.querySelector('#api-key-input') as HTMLInputElement;
    const thinkingToggle  = modal.querySelector('#thinking-toggle') as HTMLInputElement;
    const thinkingExtra   = modal.querySelector('#thinking-extra') as HTMLElement;
    const thinkingEffort  = modal.querySelector('#thinking-effort') as HTMLSelectElement;

    // When provider changes: refresh models, max_tokens, env var hint, reasoning effort options
    providerSelect.addEventListener('change', () => {
        const p = providerSelect.value;
        modelSelect.innerHTML = modelOptions(p, '');
        const firstModel = MODELS_BY_PROVIDER[p]?.[0] ?? '';
        if (firstModel && MAX_TOKENS_BY_MODEL[firstModel]) {
            maxTokensInput.value = String(MAX_TOKENS_BY_MODEL[firstModel]);
        }
        const envVar = PROVIDER_ENV_VAR[p] ?? '';
        apiKeyEnvHint.innerHTML = `Stored in the <code>${envVar}</code> environment variable on this machine.`;
        apiKeyInput.placeholder = `Enter to set/replace ${envVar}`;
        thinkingEffort.innerHTML = reasoningEffortOptions(p, 'high');
    });

    // When model changes: auto-fill max_tokens
    modelSelect.addEventListener('change', () => {
        const tok = MAX_TOKENS_BY_MODEL[modelSelect.value];
        if (tok) maxTokensInput.value = String(tok);
    });

    // Thinking toggle dims/enables the extra controls
    thinkingToggle.addEventListener('change', () => {
        thinkingExtra.style.opacity = thinkingToggle.checked ? '1' : '0.4';
        thinkingExtra.style.pointerEvents = thinkingToggle.checked ? '' : 'none';
    });

    const toolList = modal.querySelector('#tool-permission-list') as HTMLElement;
    const toolState: Record<string, ToolPermission> = JSON.parse(JSON.stringify(tools));

    function renderToolList(): void {
        toolList.innerHTML = '';
        for (const [tool, perm] of Object.entries(toolState)) {
            const row = document.createElement('div');
            row.className = 'tool-permission-row';
            row.innerHTML = `
                <span class="tool-permission-name">${tool}</span>
                <label class="settings-hint">Enabled</label>
                <label class="toggle-switch toggle-switch-small">
                    <input type="checkbox" ${perm.enabled ? 'checked' : ''} data-tool="${tool}" data-field="enabled" />
                    <span class="toggle-slider"></span>
                </label>
                <label class="settings-hint">Requires approval</label>
                <label class="toggle-switch toggle-switch-small">
                    <input type="checkbox" ${perm.require_permission ? 'checked' : ''} data-tool="${tool}" data-field="require_permission" />
                    <span class="toggle-slider"></span>
                </label>
            `;
            toolList.appendChild(row);
        }
        toolList.querySelectorAll('input[type=checkbox]').forEach((el) => {
            el.addEventListener('change', (e) => {
                const target = e.target as HTMLInputElement;
                const tool = target.dataset.tool!;
                const field = target.dataset.field as 'enabled' | 'require_permission';
                toolState[tool][field] = target.checked;
            });
        });
    }
    renderToolList();

    const promptAppendInput = modal.querySelector('#prompt-append-input') as HTMLTextAreaElement;
    const charCount = modal.querySelector('#prompt-char-count') as HTMLElement;
    function updateCharCount(): void {
        const len = promptAppendInput.value.length;
        charCount.textContent = `${len} / ${APPEND_PROMPT_MAX_LEN} characters`;
        charCount.classList.toggle('settings-hint-warning', len > APPEND_PROMPT_MAX_LEN);
    }
    promptAppendInput.addEventListener('input', updateCharCount);
    updateCharCount();

    (modal.querySelector('#open-instructions-btn') as HTMLButtonElement).addEventListener('click', () => {
        vscode.postMessage({ type: 'open_instructions_file' });
    });

    (modal.querySelector('#settings-close-btn') as HTMLButtonElement).onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });

    (modal.querySelector('#settings-save-btn') as HTMLButtonElement).addEventListener('click', () => {
        const providerVal = providerSelect.value;
        const thinkingEnabled = thinkingToggle.checked;
        const thinkingPayload: ThinkingConfig = { enabled: thinkingEnabled };
        if (thinkingEnabled) {
            const budget = parseInt((modal.querySelector('#thinking-budget') as HTMLInputElement).value, 10);
            if (budget > 0) thinkingPayload.budget_tokens = budget;
            thinkingPayload.reasoning_effort = thinkingEffort.value || 'high';
        }

        const settings: UpdateSettingsPayload = {
            provider: providerVal,
            model: modelSelect.value,
            temperature: parseFloat((modal.querySelector('#temperature-input') as HTMLInputElement).value) || 1.0,
            max_tokens: parseInt((modal.querySelector('#max-tokens-input') as HTMLInputElement).value, 10) || 65536,
            api_key_env: PROVIDER_ENV_VAR[providerVal] ?? current?.api_key_env ?? '',
            max_steps: parseInt((modal.querySelector('#max-steps-input') as HTMLInputElement).value, 10) || 25,
            unsafe_mode: (modal.querySelector('#unsafe-mode-toggle') as HTMLInputElement).checked,
            tools: toolState,
            system_prompt_append: promptAppendInput.value.slice(0, APPEND_PROMPT_MAX_LEN),
            thinking: thinkingPayload,
        };

        const newKey = apiKeyInput.value.trim();
        if (newKey) settings.api_key = newKey;

        vscode.postMessage({ type: 'update_settings', settings });
        overlay.remove();
    });
}