import { agentSocket } from "../../core/agentSocket";
import {
  MODEL_CATALOG,
  PROVIDER_API_KEY_ENV,
  PROVIDER_LABELS,
  type AgentSettingsPatch,
  type AgentSettingsData,
  type McpServerDef,
} from "../../core/types";
import { editorSettings } from "../../state/store";
import { icon } from "../icons";

const ALL_TOOLS = [
  { name: "write_file", label: "Write File", desc: "Create or overwrite files", permissible: true },
  { name: "edit_file", label: "Edit File", desc: "Inline file edits", permissible: true },
  { name: "view_file", label: "View File", desc: "Read file contents", permissible: false },
  { name: "execute", label: "Execute", desc: "Run shell commands", permissible: true },
  { name: "read_output", label: "Read Output", desc: "Read terminal output", permissible: false },
  { name: "send_input", label: "Send Input", desc: "Send input to a terminal", permissible: false },
  { name: "terminate_terminal", label: "Terminate Terminal", desc: "Kill a terminal session", permissible: false },
  { name: "ask_user", label: "Ask User", desc: "Ask the user a question", permissible: false },
  { name: "find", label: "Find Files", desc: "Glob/grep search", permissible: false },
  { name: "semantic_search", label: "Semantic Search", desc: "Embedding-based code search", permissible: false },
  { name: "search_web", label: "Web Search", desc: "Search the internet", permissible: true },
];

type SettingsTab = "editor" | "model" | "tools" | "embedding" | "mcp" | "advanced";

export class SettingsPanel {
  private overlay: HTMLElement;
  private nav: HTMLElement;
  private body: HTMLElement;
  private footerStatus: HTMLElement;

  private tab: SettingsTab = "editor";
  private settingsData: AgentSettingsData | null = null;
  private requestedSettings = false;

  constructor(parent: HTMLElement) {
    this.overlay = document.createElement("div");
    this.overlay.className = "settings-overlay";
    this.overlay.hidden = true;

    this.overlay.innerHTML = `
      <div class="settings-modal">
        <div class="settings-nav"></div>
        <div class="settings-body">
          <div class="settings-header">
            <span>Settings</span>
            <button class="icon-btn" data-close>${icon("close")}</button>
          </div>
          <div class="settings-content"></div>
          <div class="settings-footer">
            <span class="save-status"></span>
            <button class="btn" data-cancel>Cancel</button>
            <button class="btn primary" data-save>Save &amp; Restart</button>
          </div>
        </div>
      </div>
    `;
    parent.appendChild(this.overlay);

    this.nav = this.overlay.querySelector(".settings-nav")!;
    this.body = this.overlay.querySelector(".settings-content")!;
    this.footerStatus = this.overlay.querySelector(".save-status")!;

    this.overlay.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    this.overlay.querySelector("[data-cancel]")!.addEventListener("click", () => this.close());
    this.overlay.querySelector("[data-save]")!.addEventListener("click", () => this.save());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });

    agentSocket.onMessage((m) => {
      if (m.type === "settings_data") {
        this.settingsData = (m as any).settings;
        this.renderTab();
      }
      if (m.type === "settings_updated") {
        this.footerStatus.textContent = m.success ? "Saved ✓" : `Error: ${m.message}`;
        this.footerStatus.className = "save-status " + (m.success ? "ok" : "err");
        if (m.success) setTimeout(() => this.close(), 800);
      }
    });
  }

  open() {
    this.overlay.hidden = false;
    this.footerStatus.textContent = "";
    this.footerStatus.className = "save-status";
    if (!this.requestedSettings) {
      agentSocket.send({ type: "event", event_type: "get_settings" });
      this.requestedSettings = true;
    }
    this.renderNav();
    this.renderTab();
  }

  close() {
    this.overlay.hidden = true;
    this.requestedSettings = false;
  }

  // ----------------------------------------------------------------- nav

  private renderNav() {
    const tabs: [SettingsTab, string, string][] = [
      ["editor", "Editor", "moon"],
      ["model", "Model", "cpu"],
      ["tools", "Tools", "wrench"],
      ["embedding", "Embedding", "search"],
      ["mcp", "MCP Servers", "server"],
      ["advanced", "Advanced", "sliders"],
    ];
    this.nav.innerHTML = tabs
      .map(
        ([id, label, ic]) =>
          `<div class="settings-nav-item ${id === this.tab ? "active" : ""}" data-tab="${id}">
             ${icon(ic as any)} ${label}
           </div>`
      )
      .join("");
    this.nav.querySelectorAll("[data-tab]").forEach((el) =>
      el.addEventListener("click", () => {
        this.tab = el.getAttribute("data-tab")! as SettingsTab;
        this.renderNav();
        this.renderTab();
      })
    );
  }

  // ---------------------------------------------------------------- tabs

  private renderTab() {
    this.body.innerHTML = "";
    switch (this.tab) {
      case "editor": return this.renderEditor();
      case "model": return this.renderModel();
      case "tools": return this.renderTools();
      case "embedding": return this.renderEmbedding();
      case "mcp": return this.renderMcp();
      case "advanced": return this.renderAdvanced();
    }
  }

  // ---- Editor ----

  private renderEditor() {
    const s = editorSettings.get();
    this.body.innerHTML = `
      <div class="field-group">
        <div class="group-title">Appearance</div>
        ${this.themeRow(s.theme)}
        ${this.numRow("font-size", "Font Size", "Editor font size in pixels", s.fontSize, 8, 32)}
        ${this.numRow("tab-size", "Tab Size", "Spaces per tab", s.tabSize, 1, 8)}
      </div>
      <div class="field-group">
        <div class="group-title">Behavior</div>
        ${this.switchRow("word-wrap", "Word Wrap", "Wrap long lines", s.wordWrap)}
        ${this.switchRow("minimap", "Minimap", "Show scrollbar overview", s.minimap)}
        ${this.switchRow("format-save", "Format on Save", "Auto-format when saving", s.formatOnSave)}
      </div>
    `;
    this.bindEditorEvents();
  }

  private themeRow(current: "dark" | "light") {
    return `
      <div class="field-row">
        <div class="label"><span class="t">Theme</span><span class="d">Editor and UI color scheme</span></div>
        <div class="control">
          <div class="theme-toggle">
            <button class="theme-opt ${current === "dark" ? "active" : ""}" data-theme="dark">${icon("moon")} Dark</button>
            <button class="theme-opt ${current === "light" ? "active" : ""}" data-theme="light">${icon("sun")} Light</button>
          </div>
        </div>
      </div>`;
  }

  private numRow(id: string, label: string, desc: string, value: number, min: number, max: number) {
    return `
      <div class="field-row">
        <div class="label"><span class="t">${label}</span><span class="d">${desc}</span></div>
        <div class="control"><input type="number" data-field="${id}" value="${value}" min="${min}" max="${max}" style="width:70px"/></div>
      </div>`;
  }

  private switchRow(id: string, label: string, desc: string, on: boolean) {
    return `
      <div class="field-row">
        <div class="label"><span class="t">${label}</span><span class="d">${desc}</span></div>
        <div class="control"><div class="switch ${on ? "on" : ""}" data-field="${id}"></div></div>
      </div>`;
  }

  private bindEditorEvents() {
    this.body.querySelectorAll("[data-theme]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const theme = btn.getAttribute("data-theme") as "dark" | "light";
        editorSettings.update((s) => ({ ...s, theme }));
        this.renderTab();
      })
    );
    this.body.querySelectorAll('input[type="number"]').forEach((inp) =>
      inp.addEventListener("change", () => {
        const field = (inp as HTMLInputElement).dataset.field!;
        const val = parseInt((inp as HTMLInputElement).value, 10);
        if (isNaN(val)) return;
        editorSettings.update((s) => ({
          ...s,
          ...(field === "font-size" && { fontSize: val }),
          ...(field === "tab-size" && { tabSize: val }),
        }));
      })
    );
    this.body.querySelectorAll(".switch").forEach((sw) =>
      sw.addEventListener("click", () => {
        const field = (sw as HTMLElement).dataset.field!;
        sw.classList.toggle("on");
        const on = sw.classList.contains("on");
        editorSettings.update((s) => ({
          ...s,
          ...(field === "word-wrap" && { wordWrap: on }),
          ...(field === "minimap" && { minimap: on }),
          ...(field === "format-save" && { formatOnSave: on }),
        }));
      })
    );
  }

  // ---- Model ----

  private renderModel() {
    const d = this.settingsData;
    const provider = d?.provider || "alibaba";
    const models = MODEL_CATALOG[provider] || [];
    const currentModel = models.find((m) => m.name === d?.model) || models[0];
    const thinkingEnabled = d?.thinking?.enabled ?? false;

    this.body.innerHTML = `
      <div class="field-group">
        <div class="group-title">LLM Provider ${this.infoTip("Select the AI provider. Each provider requires its own API key.")}</div>
        ${this.selectRow("provider", "Provider", "AI model provider", Object.keys(MODEL_CATALOG).map((k) => [k, PROVIDER_LABELS[k] || k]), provider)}
        ${this.selectRow("model", "Model", "Specific model to use", models.map((m) => [m.name, `${m.name} (${m.notes})`]), d?.model || "")}
      </div>
      <div class="field-group">
        <div class="group-title">Parameters ${this.infoTip("Temperature: higher = more creative, lower = more deterministic. Max tokens: maximum output length.")}</div>
        ${this.numRow("temperature", "Temperature", "0.0–2.0", d?.temperature ?? 1.0, 0, 2)}
        ${this.numRow("max-tokens", "Max Tokens", "Maximum output tokens", d?.max_tokens ?? 65536, 1, 384000)}
      </div>
      <div class="field-group">
        <div class="group-title">Authentication ${this.infoTip("Environment variable where the API key is stored. Provide your key below if using your own.")}</div>
        ${this.textRow("api-key-env", "API Key Env Var", "e.g. DASHSCOPE_API_KEY", d?.api_key_env || PROVIDER_API_KEY_ENV[provider] || "")}
        ${this.textRow("api-key", "API Key", "Your API key (optional, uses platform default if empty)", "", "password")}
      </div>
      <div class="field-group">
        <div class="group-title">Thinking / Reasoning ${this.infoTip("Enable extended reasoning. Budget tokens control thinking depth. Reasoning effort controls how thoroughly the model reasons.")}</div>
        ${this.switchRow("thinking-enabled", "Enable Thinking", currentModel ? `Mode: ${currentModel.thinkingMode}` : "", thinkingEnabled)}
        ${currentModel?.reasoningEffortSupport && thinkingEnabled ? this.selectRow(
          "reasoning-effort",
          "Reasoning Effort",
          "How deeply the model should reason",
          currentModel.reasoningEffortLevels.map((l) => [l, l.charAt(0).toUpperCase() + l.slice(1)]),
          d?.thinking?.reasoning_effort || "high"
        ) : ""}
        ${thinkingEnabled ? this.numRow("budget-tokens", "Budget Tokens", "Max thinking tokens", d?.thinking?.budget_tokens ?? 32000, 1000, 200000) : ""}
      </div>
      ${currentModel ? `<div class="model-info-card">
        <div style="font-size:11px;color:var(--fg-2);margin-bottom:4px">Model Info</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px;color:var(--fg-1)">
          <span>Context Window</span><span>${(currentModel.contextWindow/1000).toFixed(0)}K tokens</span>
          <span>Max Output</span><span>${(currentModel.maxOutputTokens/1000).toFixed(0)}K tokens</span>
          <span>Pricing</span><span>$${currentModel.pricing.input}/$${currentModel.pricing.output} per 1M tokens</span>
        </div>
      </div>` : ""}
    `;
    this.bindModelEvents();
  }

  private selectRow(id: string, label: string, desc: string, options: [string, string][], current: string) {
    const opts = options.map(([val, lbl]) => `<option value="${val}" ${val === current ? "selected" : ""}>${escapeHtml(lbl)}</option>`).join("");
    return `
      <div class="field-row">
        <div class="label"><span class="t">${label}</span><span class="d">${desc}</span></div>
        <div class="control"><select data-field="${id}">${opts}</select></div>
      </div>`;
  }

  private textRow(id: string, label: string, placeholder: string, value: string, type = "text") {
    return `
      <div class="field-row">
        <div class="label"><span class="t">${label}</span></div>
        <div class="control"><input type="${type}" data-field="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" style="min-width:200px"/></div>
      </div>`;
  }

  private infoTip(text: string) {
    return `<span class="info-tip" title="${escapeHtml(text)}">${icon("info")}</span>`;
  }

  private bindModelEvents() {
    const providerSel = this.body.querySelector('[data-field="provider"]') as HTMLSelectElement | null;
    providerSel?.addEventListener("change", () => {
      if (!this.settingsData) return;
      this.settingsData.provider = providerSel.value;
      const models = MODEL_CATALOG[providerSel.value] || [];
      this.settingsData.model = models[0]?.name || "";
      this.settingsData.api_key_env = PROVIDER_API_KEY_ENV[providerSel.value] || "";
      this.renderTab();
    });

    const modelSel = this.body.querySelector('[data-field="model"]') as HTMLSelectElement | null;
    modelSel?.addEventListener("change", () => {
      if (!this.settingsData) return;
      this.settingsData.model = modelSel.value;
      this.renderTab();
    });

    const thinkingSwitch = this.body.querySelector('[data-field="thinking-enabled"]') as HTMLElement | null;
    thinkingSwitch?.addEventListener("click", () => {
      if (!this.settingsData) return;
      thinkingSwitch.classList.toggle("on");
      this.settingsData.thinking.enabled = thinkingSwitch.classList.contains("on");
      this.renderTab();
    });
  }

  // ---- Tools ----

  private renderTools() {
    const toolStates: Record<string, { enabled: boolean; require_permission: boolean }> = {};
    for (const t of ALL_TOOLS) {
      const serverTool = this.settingsData?.tools?.find((st) => st.name === t.name);
      toolStates[t.name] = {
        enabled: serverTool?.enabled ?? true,
        require_permission: serverTool?.require_permission ?? false,
      };
    }

    this.body.innerHTML = `
      <div class="field-group">
        <div class="group-title">Agent Tools ${this.infoTip("Enable or disable individual tools the agent can use. 'Permission' tools require user approval before executing.")}</div>
        <div class="tool-toggle-list">
          ${ALL_TOOLS.map((t) => {
            const st = toolStates[t.name];
            return `
              <div class="tool-toggle-row">
                <div class="switch ${st.enabled ? "on" : ""}" data-tool="${t.name}" data-action="toggle"></div>
                <div class="tool-toggle-info">
                  <span class="tool-toggle-name">${t.label}</span>
                  <span class="tool-toggle-desc">${t.desc}</span>
                </div>
                ${t.permissible ? `
                  <div class="tool-perm">
                    <label class="tool-perm-label">
                      <input type="checkbox" data-tool-perm="${t.name}" ${st.require_permission ? "checked" : ""} />
                      <span>Require permission</span>
                    </label>
                  </div>
                ` : ""}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;

    this.body.querySelectorAll('[data-action="toggle"]').forEach((sw) =>
      sw.addEventListener("click", () => sw.classList.toggle("on"))
    );
  }

  // ---- Embedding ----

  private renderEmbedding() {
    const e = this.settingsData?.embedding;
    this.body.innerHTML = `
      <div class="field-group">
        <div class="group-title">Embedding Model ${this.infoTip("Used by Semantic Search and MCP tools for code similarity search. Requires a separate API key from the LLM provider.")}</div>
        ${this.textRow("emb-model", "Model Name", "e.g. voyage-code-3", e?.model || "voyage-code-3")}
        ${this.textRow("emb-base-url", "Base URL", "API endpoint", e?.base_url || "https://api.voyageai.com/v1")}
        ${this.textRow("emb-api-key-env", "API Key Env Var", "e.g. VOYAGE_API_KEY", e?.api_key_env || "VOYAGE_API_KEY")}
        ${this.textRow("emb-api-key", "Embedding API Key", "Your embedding API key (optional)", "", "password")}
      </div>
      <div class="field-group">
        <div class="group-title">Features</div>
        ${this.switchRow("semantic-search", "Semantic Search", "Enable embedding-based code search tool", this.settingsData?.semantic_search_enabled ?? true)}
      </div>
    `;
    this.body.querySelectorAll(".switch").forEach((sw) =>
      sw.addEventListener("click", () => sw.classList.toggle("on"))
    );
  }

  // ---- MCP ----

  private renderMcp() {
    const mcpEnabled = this.settingsData?.mcp_enabled ?? false;
    const servers = this.settingsData?.mcp_servers || [];

    this.body.innerHTML = `
      <div class="field-group">
        <div class="group-title">MCP (Model Context Protocol) ${this.infoTip("Connect to external tool servers via MCP. Each server provides additional capabilities to the agent.")}</div>
        ${this.switchRow("mcp-enabled", "Enable MCP", "Allow agent to use MCP tool servers", mcpEnabled)}
      </div>
      ${mcpEnabled ? `
        <div class="field-group">
          <div class="group-title">MCP Servers</div>
          <div class="mcp-server-list" id="mcp-servers">
            ${servers.map((srv, i) => this.renderMcpServer(srv, i)).join("")}
          </div>
          <button class="btn" id="add-mcp-server" style="margin-top:8px">${icon("plus")} Add Server</button>
        </div>
      ` : ""}
    `;

    this.body.querySelector("#add-mcp-server")?.addEventListener("click", () => {
      if (!this.settingsData) return;
      this.settingsData.mcp_servers = [
        ...(this.settingsData.mcp_servers || []),
        { name: "", url: "", api_key_env: "", api_key_param: "", auth_type: "header" },
      ];
      this.renderTab();
    });

    this.body.querySelectorAll(".switch").forEach((sw) =>
      sw.addEventListener("click", () => {
        sw.classList.toggle("on");
        if ((sw as HTMLElement).dataset.field === "mcp-enabled" && this.settingsData) {
          this.settingsData.mcp_enabled = sw.classList.contains("on");
          this.renderTab();
        }
      })
    );

    this.body.querySelectorAll("[data-remove-server]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const idx = parseInt((btn as HTMLElement).dataset.removeServer!, 10);
        if (this.settingsData) {
          this.settingsData.mcp_servers = this.settingsData.mcp_servers.filter((_, i) => i !== idx);
          this.renderTab();
        }
      })
    );
  }

  private renderMcpServer(srv: McpServerDef, idx: number) {
    return `
      <div class="mcp-server-card">
        <div class="mcp-server-header">
          <span style="font-weight:600;font-size:12px">${srv.name || `Server ${idx + 1}`}</span>
          <button class="icon-btn" data-remove-server="${idx}" title="Remove">${icon("trash")}</button>
        </div>
        <div class="mcp-server-fields">
          <input type="text" data-mcp="${idx}" data-key="name" placeholder="Server name" value="${escapeHtml(srv.name)}" />
          <input type="text" data-mcp="${idx}" data-key="url" placeholder="https://mcp-server.example.com" value="${escapeHtml(srv.url)}" />
          <input type="text" data-mcp="${idx}" data-key="api_key_env" placeholder="API Key Env Var" value="${escapeHtml(srv.api_key_env)}" />
          <input type="text" data-mcp="${idx}" data-key="api_key_param" placeholder="API Key Param name" value="${escapeHtml(srv.api_key_param)}" />
        </div>
      </div>
    `;
  }

  // ---- Advanced ----

  private renderAdvanced() {
    const d = this.settingsData;
    this.body.innerHTML = `
      <div class="field-group">
        <div class="group-title">Runtime ${this.infoTip("Max steps: limits agent tool-call loops. Unsafe mode: skips all permission prompts.")}</div>
        ${this.numRow("max-steps", "Max Steps", "Maximum agent steps per task", d?.max_steps ?? 35, 1, 200)}
        ${this.switchRow("unsafe-mode", "Unsafe Mode", "Skip all tool permission prompts (⚠️ use with caution)", d?.unsafe_mode ?? true)}
      </div>
      <div class="field-group">
        <div class="group-title">Sub-Agents ${this.infoTip("Enable the agent to spawn sub-agents for parallel work.")}</div>
        ${this.switchRow("sub-agents-enabled", "Enable Sub-Agents", "Allow spawning sub-agents", d?.sub_agents?.enabled ?? false)}
        ${this.numRow("sub-agents-steps", "Sub-Agent Max Steps", "Step limit for each sub-agent", d?.sub_agents?.max_steps ?? 20, 1, 100)}
      </div>
      <div class="field-group">
        <div class="group-title">System Prompt ${this.infoTip("Append custom instructions to the agent's system prompt. This is added after the default prompt.")}</div>
        <div class="field-row full">
          <div class="label"><span class="t">Custom Instructions</span><span class="d">Additional system prompt text appended to the default</span></div>
          <div class="control">
            <textarea data-field="system-prompt" rows="4" placeholder="Add custom instructions for the agent…">${escapeHtml(d?.system_prompt || "")}</textarea>
          </div>
        </div>
      </div>
    `;
    this.body.querySelectorAll(".switch").forEach((sw) =>
      sw.addEventListener("click", () => sw.classList.toggle("on"))
    );
  }

  // ---------------------------------------------------------------- save

  private save() {
    this.footerStatus.textContent = "Saving…";
    this.footerStatus.className = "save-status";

    const patch: AgentSettingsPatch = {};

    // Editor settings are saved to localStorage immediately by their event
    // handlers — they don't go to agent.yaml.

    // Model
    const provider = this.getVal("provider");
    const model = this.getVal("model");
    if (provider) patch.provider = provider;
    if (model) patch.model = model;
    const temp = this.getNumVal("temperature");
    if (temp !== null) patch.temperature = temp;
    const maxTok = this.getNumVal("max-tokens");
    if (maxTok !== null) patch.max_tokens = maxTok;
    const apiKeyEnv = this.getVal("api-key-env");
    if (apiKeyEnv) patch.api_key_env = apiKeyEnv;
    const apiKey = this.getVal("api-key");
    if (apiKey) patch.api_key = apiKey;

    // Thinking
    const thinkingOn = this.getSwitchVal("thinking-enabled");
    if (thinkingOn !== null) {
      patch.thinking = { enabled: thinkingOn };
      if (thinkingOn) {
        const effort = this.getVal("reasoning-effort");
        if (effort) patch.thinking.reasoning_effort = effort;
        const budget = this.getNumVal("budget-tokens");
        if (budget !== null) patch.thinking.budget_tokens = budget;
      }
    }

    // Tools
    const toolToggles = this.body.querySelectorAll('[data-action="toggle"]');
    if (toolToggles.length > 0) {
      patch.tools = {};
      toolToggles.forEach((sw) => {
        const name = (sw as HTMLElement).dataset.tool!;
        const enabled = sw.classList.contains("on");
        const permEl = this.body.querySelector(`[data-tool-perm="${name}"]`) as HTMLInputElement | null;
        const require_permission = permEl?.checked ?? false;
        patch.tools![name] = { enabled, require_permission };
      });
    }

    // Embedding
    const embModel = this.getVal("emb-model");
    const embUrl = this.getVal("emb-base-url");
    const embEnv = this.getVal("emb-api-key-env");
    const embKey = this.getVal("emb-api-key");
    if (embModel || embUrl || embEnv) {
      patch.embedding = {
        model: embModel || "voyage-code-3",
        base_url: embUrl || "https://api.voyageai.com/v1",
        api_key_env: embEnv || "VOYAGE_API_KEY",
        api_key: embKey || undefined,
      };
    }
    const semSearchOn = this.getSwitchVal("semantic-search");
    if (semSearchOn !== null) patch.semantic_search_enabled = semSearchOn;

    // MCP
    const mcpEnabled = this.getSwitchVal("mcp-enabled");
    if (mcpEnabled !== null) {
      const servers: McpServerDef[] = [];
      this.body.querySelectorAll(".mcp-server-card").forEach((card, idx) => {
        const getName = (key: string) => {
          const inp = card.querySelector(`[data-mcp="${idx}"][data-key="${key}"]`) as HTMLInputElement | null;
          return inp?.value?.trim() || "";
        };
        servers.push({
          name: getName("name"),
          url: getName("url"),
          api_key_env: getName("api_key_env"),
          api_key_param: getName("api_key_param"),
          auth_type: "header",
        });
      });
      patch.mcp = {
        enabled: mcpEnabled,
        servers,
        embedding_model: embModel || undefined,
        embedding_api_key_env: embEnv || undefined,
        embedding_base_url: embUrl || undefined,
        embedding_api_key: embKey || undefined,
      };
    }

    // Advanced
    const maxSteps = this.getNumVal("max-steps");
    if (maxSteps !== null) patch.max_steps = maxSteps;
    const unsafeMode = this.getSwitchVal("unsafe-mode");
    if (unsafeMode !== null) patch.unsafe_mode = unsafeMode;

    const subEnabled = this.getSwitchVal("sub-agents-enabled");
    const subSteps = this.getNumVal("sub-agents-steps");
    if (subEnabled !== null) {
      patch.sub_agents = { enabled: subEnabled, max_steps: subSteps ?? 20 };
    }

    const sysprompt = (this.body.querySelector('[data-field="system-prompt"]') as HTMLTextAreaElement)?.value?.trim();
    if (sysprompt) patch.system_prompt_append = sysprompt;

    agentSocket.send({ type: "event", event_type: "update_settings", settings: patch });
  }

  // ---------------------------------------------------------------- utils

  private getVal(field: string): string {
    const el = this.body.querySelector(`[data-field="${field}"]`) as HTMLInputElement | HTMLSelectElement | null;
    return el?.value?.trim() || "";
  }
  private getNumVal(field: string): number | null {
    const v = this.getVal(field);
    if (!v) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  private getSwitchVal(field: string): boolean | null {
    const el = this.body.querySelector(`[data-field="${field}"].switch`) as HTMLElement | null;
    if (!el) return null;
    return el.classList.contains("on");
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
