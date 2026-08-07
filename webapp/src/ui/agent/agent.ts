import { agentSocket } from "../../core/agentSocket";
import type { AgentInbound } from "../../core/types";
import { icon } from "../icons";
import { loadActiveSession, saveActiveSession } from "../../state/store";
import { marked } from "marked";
import DOMPurify from "dompurify";

type FileWrittenHandler = (path: string) => void;

/**
 * Redesigned agent chat: append-only DOM rendering (no full re-render per
 * token) for speed, with dedicated cards for tool calls, permission gates,
 * and ask_user prompts instead of dumping them as plain text.
 */
export class AgentPanel {
  private el: HTMLElement;
  private messagesEl: HTMLElement;
  private composerBox: HTMLElement;
  private composer: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private abortBtn: HTMLButtonElement;

  private currentThinkingEl: HTMLElement | null = null;
  private currentTextEl: HTMLElement | null = null;
  private currentRawText: string = "";
  private inThinking = false;

  private currentTurnEl: HTMLElement | null = null;
  private currentWorkingBoxEl: HTMLElement | null = null;
  private currentWorkingListEl: HTMLElement | null = null;
  private currentWorkingTimerEl: HTMLElement | null = null;
  private currentPillsEl: HTMLElement | null = null;
  private currentPills = new Set<string>();
  private currentTimerInterval: any = null;
  private currentTurnStartTime: number = 0;

  // Custom dropdown state
  private activeSession: string;
  private sessionsList: any[] = [];
  private fileWrittenHandlers = new Set<FileWrittenHandler>();

  constructor(container: HTMLElement) {
    this.activeSession = loadActiveSession();

    this.el = document.createElement("div");
    this.el.className = "panel";
    this.el.innerHTML = `
      <div class="panel-header">
        <span>Agent</span>
        <div class="actions">
          <button class="icon-btn" data-act="sessions" title="History / Sessions">${icon("clock")}</button>
          <button class="icon-btn" data-act="new-session" title="New Session">${icon("plus")}</button>
        </div>
      </div>
      <div class="agent-messages"></div>
      <div class="agent-composer">
        <div class="composer-box">
          <textarea rows="1" placeholder="Message the agent…"></textarea>
          <div class="composer-actions">
            <button class="icon-btn abort-btn" title="Abort" style="display:none">${icon("stop")}</button>
            <button class="icon-btn send-btn" title="Send">${icon("send")}</button>
          </div>
        </div>
        <div class="composer-meta">
          <span>⌘/Ctrl+Enter to send</span>
          <span data-conn>connecting…</span>
        </div>
      </div>
    `;
    container.appendChild(this.el);

    this.messagesEl = this.el.querySelector(".agent-messages")!;
    this.composerBox = this.el.querySelector(".composer-box")!;
    this.composer = this.el.querySelector("textarea")!;
    this.sendBtn = this.el.querySelector(".send-btn")!;
    this.abortBtn = this.el.querySelector(".abort-btn")!;

    this.renderEmptyState();

    this.el.querySelector('[data-act="new-session"]')!.addEventListener("click", () => this.newSession());
    this.el.querySelector('[data-act="sessions"]')!.addEventListener("click", () => {
      agentSocket.send({ type: "event", event_type: "list_sessions" });
    });

    this.abortBtn.addEventListener("click", () => this.abort());
    this.sendBtn.addEventListener("click", () => this.send());
    this.composer.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.send();
      }
    });
    this.composer.addEventListener("input", () => {
      this.composer.style.height = "auto";
      this.composer.style.height = Math.min(this.composer.scrollHeight, 160) + "px";
      this.sendBtn.disabled = this.composer.value.trim().length === 0;
    });
    this.sendBtn.disabled = true;

    agentSocket.onConnectionChange((c) => {
      const el = this.el.querySelector("[data-conn]")!;
      el.textContent = c ? "" : "reconnecting…";
    });
    agentSocket.onMessage((m) => this.handleInbound(m));
  }

  onFileWritten(h: FileWrittenHandler) {
    this.fileWrittenHandlers.add(h);
  }

  private renderSessionsModal() {
    const existing = document.getElementById("sessions-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "sessions-modal";
    overlay.className = "modal-overlay";
    
    let listHtml = "";
    for (const s of this.sessionsList) {
      const isActive = s.session_id === this.activeSession;
      const date = new Date(s.updated_at * 1000).toLocaleString();
      listHtml += `
        <div class="session-card ${isActive ? 'active' : ''}" data-id="${s.session_id}">
          <div class="session-card-header">
            <span class="session-card-title">${isActive ? '<span class="session-active-dot"></span>' : ''}${escapeHtml(s.session_id)}</span>
            <span class="session-card-date">${date}</span>
          </div>
          <div class="session-card-snippet">${escapeHtml(s.snippet)}</div>
          <button class="icon-btn delete-btn" title="Delete Session" data-id="${s.session_id}">${icon("trash")}</button>
        </div>
      `;
    }

    overlay.innerHTML = `
      <div class="modal sessions-modal">
        <div class="modal-header">
          <h3>Chat History</h3>
          <button class="icon-btn close-btn">${icon("close")}</button>
        </div>
        <div class="sessions-list">
          ${listHtml || '<div style="padding:20px;color:var(--fg-2);text-align:center;">No sessions found.</div>'}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector(".close-btn")!.addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    overlay.querySelectorAll(".session-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".delete-btn")) return;
        const id = card.getAttribute("data-id")!;
        this.switchSession(id);
        overlay.remove();
      });
    });

    overlay.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id")!;
        if (confirm(`Are you sure you want to delete session ${id}?`)) {
          agentSocket.send({ type: "event", event_type: "delete_session", session_id: id });
          btn.closest(".session-card")?.remove();
        }
      });
    });
  }

  private newSession() {
    const id = `session_${Date.now()}`; // Backend will replace it correctly if we want, or just a timestamp
    agentSocket.send({ type: "event", event_type: "new_session", session_id: id });
  }

  private switchSession(id: string) {
    if (id === this.activeSession) return;
    agentSocket.send({ type: "event", event_type: "switch_session", session_id: id });
  }

  // ---------------------------------------------------------------- send

  private send() {
    const text = this.composer.value.trim();
    if (!text) return;
    this.appendUserMessage(text);
    agentSocket.send({ type: "task", text });
    this.composer.value = "";
    this.composer.style.height = "auto";
    this.sendBtn.disabled = true;
    this.setRunning(true);
  }

  private abort() {
    agentSocket.send({ type: "event", event_type: "abort" });
    this.setRunning(false);
  }

  private setRunning(running: boolean) {
    this.abortBtn.style.display = running ? "flex" : "none";
  }

  // ------------------------------------------------------------ inbound

  private handleInbound(msg: AgentInbound) {
    switch (msg.type) {
      case "stream":
        this.handleStream(msg.text);
        break;
      case "finish":
        this.finalizeTurn();
        this.setRunning(false);
        break;
      case "tool_call":
        this.appendToolCall(msg.tool, msg.args, msg.label);
        break;
      case "tool_result":
        this.appendToolResult(msg.tool, msg.result);
        if ((msg.tool === "write_file" || msg.tool === "edit_file") && typeof msg.result === "string") {
          // Best-effort: surface which file to refresh — args carried the path on tool_call.
        }
        break;
      case "ask_user":
        this.appendAskUser(msg.question);
        break;
      case "permission_request":
        this.appendPermission(msg.tool, msg.description);
        break;
      case "queued_message":
        this.appendSystemNote(`Queued: "${msg.message}" — will run after the current step.`);
        break;
      case "inject":
        this.appendSystemNote(`Injected into the running task: "${msg.message}"`);
        break;
      case "error":
        this.finalizeTurn();
        this.setRunning(false);
        this.appendError(msg.message);
        break;
      case "sessions_list":
        this.sessionsList = (msg as any).sessions;
        this.activeSession = (msg as any).active_session_id;
        this.renderSessionsModal();
        break;
      case "session_switched":
        this.activeSession = msg.session_id;
        saveActiveSession(msg.session_id);
        this.messagesEl.innerHTML = "";
        
        if (msg.history && Array.isArray(msg.history)) {
          this.currentTurnEl = null;
          this.currentWorkingBoxEl = null;

          for (const item of msg.history) {
            if (item.role === "user") {
              const text = item.content || "";
              if (text.startsWith("[EXECUTION RESULT]") || text.startsWith("[SYSTEM]") || text.startsWith("[TOOL_RESULT]")) {
                continue;
              }
              let userText = text;
              if (userText.includes("[USER INPUT]")) {
                userText = userText.split("[USER INPUT]")[1].trim();
              }
              if (userText) {
                if (this.currentTurnEl) this.finalizeTurn();
                this.appendUserMessage(userText);
              }
            } else if (item.role === "assistant") {
              if (!this.currentTurnEl) {
                // In case assistant responds without a preceding user message
                this.appendUserMessage("...");
              }
              let content = item.content || "";
              
              // Remove payload blocks
              content = content.replace(/```[a-zA-Z0-9_.-]+\s+filename=[^\n]+\n<<<<<<< CONTENT[\s\S]*?>>>>>>> CONTENT\n```/g, "");
              
              // Extract tools
              const toolCalls: string[] = [];
              content = content.replace(/```codepilot\n([\s\S]*?)\n```/g, (match: string, code: string) => {
                const lines = code.split("\\n");
                for (const line of lines) {
                  const m = line.trim().match(/^([a-zA-Z0-9_]+)\(/);
                  if (m) toolCalls.push(m[1]);
                }
                return "";
              });

              content = content.trim();
              if (content) {
                const bubble = this.appendAgentBlock("bubble", "");
                Promise.resolve(marked.parse(content)).then((html) => {
                  bubble.innerHTML = DOMPurify.sanitize(html as string);
                  bubble.querySelectorAll("pre").forEach(pre => {
                    const codeEl = pre.querySelector("code");
                    let lang = "text";
                    if (codeEl) {
                      const match = codeEl.className.match(/language-(\w+)/);
                      if (match) lang = match[1];
                    }
                    const header = document.createElement("div");
                    header.className = "code-header";
                    header.innerHTML = `<span>${escapeHtml(lang)}</span><button class="icon-btn copy-btn" title="Copy code">${icon("files")}</button>`;
                    header.querySelector(".copy-btn")!.addEventListener("click", () => {
                      navigator.clipboard.writeText(codeEl?.textContent || "");
                      const btn = header.querySelector(".copy-btn")!;
                      btn.innerHTML = icon("check");
                      setTimeout(() => btn.innerHTML = icon("files"), 2000);
                    });
                    pre.insertBefore(header, pre.firstChild);
                  });
                });
              }

              for (const tool of toolCalls) {
                this.appendToolCall(tool, null);
                this.appendToolResult(tool, null);
              }
            }
          }
          if (this.currentTurnEl) {
            this.finalizeTurn();
          }
        }
        
        if (this.messagesEl.children.length === 0) {
          this.renderEmptyState();
        } else {
          this.scrollToBottom();
        }
        this.setRunning(false);
        break;
      case "session_deleted":
        this.sessionsList = this.sessionsList.filter((s) => s.session_id !== msg.session_id);
        const existing = document.getElementById("sessions-modal");
        if (existing) this.renderSessionsModal(); // re-render if open
        break;
      case "settings_updated":
        this.appendSystemNote(msg.success ? "Settings updated." : `Settings update failed: ${msg.message}`);
        break;
    }
  }

  private handleStream(text: string) {
    this.clearEmptyState();
    if (text === "<thinking>\n") {
      this.inThinking = true;
      this.currentThinkingEl = this.appendAgentBlock("thinking", "");
      return;
    }
    if (text === "\n</thinking>\n") {
      this.inThinking = false;
      this.currentThinkingEl = null;
      return;
    }
    if (this.inThinking) {
      if (!this.currentThinkingEl) {
        this.currentThinkingEl = this.appendAgentBlock("thinking", "");
      }
      this.currentThinkingEl.textContent += text;
    } else {
      if (!this.currentTextEl) {
        this.currentTextEl = this.appendAgentBlock("bubble", "");
        this.currentRawText = "";
      }
      this.currentRawText += text;
      Promise.resolve(marked.parse(this.currentRawText)).then((html) => {
        if (this.currentTextEl) {
          this.currentTextEl.innerHTML = DOMPurify.sanitize(html as string);
          this.currentTextEl.querySelectorAll("pre").forEach(pre => {
            const codeEl = pre.querySelector("code");
            let lang = "text";
            if (codeEl) {
              const match = codeEl.className.match(/language-(\w+)/);
              if (match) lang = match[1];
            }
            const header = document.createElement("div");
            header.className = "code-header";
            // Use SVG string for copy directly if icon("copy") doesn't exist, but icon("copy") is generally safe.
            header.innerHTML = `<span>${escapeHtml(lang)}</span><button class="icon-btn copy-btn" title="Copy code">${icon("files")}</button>`;
            header.querySelector(".copy-btn")!.addEventListener("click", () => {
              navigator.clipboard.writeText(codeEl?.textContent || "");
              const btn = header.querySelector(".copy-btn")!;
              btn.innerHTML = icon("check");
              setTimeout(() => btn.innerHTML = icon("files"), 2000);
            });
            pre.insertBefore(header, pre.firstChild);
          });
        }
      });
    }
    this.scrollToBottom();
  }

  private finalizeTurn() {
    this.currentTextEl = null;
    this.currentThinkingEl = null;
    this.currentRawText = "";
    this.inThinking = false;

    if (this.currentTimerInterval) {
      clearInterval(this.currentTimerInterval);
      this.currentTimerInterval = null;
    }

    if (this.currentWorkingBoxEl) {
      this.currentWorkingBoxEl.classList.add("collapsed");
      const spinner = this.currentWorkingBoxEl.querySelector(".working-spinner");
      if (spinner) {
        spinner.innerHTML = icon("check");
        spinner.classList.add("done");
      }
    }

    if (this.currentPillsEl && this.currentPills.size > 0) {
      this.currentPillsEl.innerHTML = Array.from(this.currentPills).map(p => {
        const name = p.split("/").pop();
        return `<span class="pill">${icon("openFile")} ${escapeHtml(name!)}</span>`;
      }).join("");
    }
  }

  // ------------------------------------------------------------ render

  private renderEmptyState() {
    if (this.messagesEl.children.length > 0) return;
    const el = document.createElement("div");
    el.className = "agent-empty";
    el.innerHTML = `${icon("bot")}<div>Ask the agent to explore, edit, or run something in this workspace.</div>`;
    this.messagesEl.appendChild(el);
  }
  private clearEmptyState() {
    this.messagesEl.querySelector(".agent-empty")?.remove();
  }

  private appendUserMessage(text: string) {
    this.clearEmptyState();
    
    if (this.currentTimerInterval) clearInterval(this.currentTimerInterval);
    this.currentTimerInterval = null;
    this.currentTurnStartTime = Date.now();
    this.currentPills.clear();

    const turnEl = document.createElement("div");
    turnEl.className = "turn-wrapper";

    const wrap = document.createElement("div");
    wrap.className = "msg user";
    wrap.innerHTML = `<div class="bubble"></div>`;
    wrap.querySelector(".bubble")!.textContent = text;
    turnEl.appendChild(wrap);

    const workingBox = document.createElement("div");
    workingBox.className = "working-box";
    workingBox.innerHTML = `
      <div class="working-header">
        <div class="working-spinner">${icon("spinner")}</div>
        <span>Working...</span>
        <span class="working-time">0.0s</span>
      </div>
      <div class="working-list"></div>
    `;
    turnEl.appendChild(workingBox);

    const pillsEl = document.createElement("div");
    pillsEl.className = "file-pills";
    turnEl.appendChild(pillsEl);

    this.messagesEl.appendChild(turnEl);
    this.scrollToBottom();

    this.currentTurnEl = turnEl;
    this.currentWorkingBoxEl = workingBox;
    this.currentWorkingListEl = workingBox.querySelector(".working-list")!;
    this.currentWorkingTimerEl = workingBox.querySelector(".working-time")!;
    this.currentPillsEl = pillsEl;
    
    this.currentTextEl = null;
    this.currentThinkingEl = null;

    this.currentTimerInterval = setInterval(() => {
      if (this.currentWorkingTimerEl) {
        const diff = (Date.now() - this.currentTurnStartTime) / 1000;
        this.currentWorkingTimerEl.textContent = diff.toFixed(1) + "s";
      }
    }, 100) as any;
  }

  /** Appends (or reuses, for streaming) a text node inside a fresh agent message wrapper, returns the element that should receive further streamed text. */
  private appendAgentBlock(kind: "bubble" | "thinking", initial: string): HTMLElement {
    this.currentTextEl = kind === "bubble" ? this.currentTextEl : this.currentTextEl;
    const wrap = document.createElement("div");
    wrap.className = "msg agent";
    const inner = document.createElement("div");
    inner.className = kind;
    inner.textContent = initial;
    wrap.appendChild(inner);
    if (this.currentTurnEl) {
      this.currentTurnEl.appendChild(wrap);
    } else {
      this.messagesEl.appendChild(wrap);
    }
    return inner;
  }

  private appendToolCall(tool: string, args: unknown, label?: string) {
    this.clearEmptyState();
    this.currentTextEl = null;

    if (!this.currentWorkingListEl) return;
    
    if (this.currentWorkingBoxEl) {
      this.currentWorkingBoxEl.classList.remove("collapsed");
    }

    const row = document.createElement("div");
    row.className = "tool-row";
    row.dataset.tool = tool;

    row.innerHTML = `
      <div class="tool-spinner">${icon("spinner")}</div>
      <span class="tool-name">${escapeHtml(tool)}</span>
      ${label ? `<span class="tool-label">${escapeHtml(label)}</span>` : ""}
    `;
    this.currentWorkingListEl.appendChild(row);

    this.currentWorkingListEl.scrollTop = this.currentWorkingListEl.scrollHeight;
    this.scrollToBottom();

    if ((tool === "write_file" || tool === "edit_file") && args && typeof args === "object") {
      const path = (args as any).path || (args as any).file_path;
      if (typeof path === "string") {
        this.currentPills.add(path);
        this.fileWrittenHandlers.forEach((h) => h(path));
      }
    }
  }

  private appendToolResult(tool: string, result: unknown) {
    if (!this.currentWorkingListEl) return;
    const rows = Array.from(this.currentWorkingListEl.querySelectorAll(".tool-row:not([data-has-result])"));
    const match = rows.reverse().find(r => (r as HTMLElement).dataset.tool === tool);
    if (match) {
      (match as HTMLElement).dataset.hasResult = "true";
      const spinner = match.querySelector(".tool-spinner")!;
      spinner.innerHTML = icon("check");
      spinner.classList.add("done");
    }
  }

  private appendAskUser(question: string) {
    this.clearEmptyState();
    this.currentTextEl = null;
    const wrap = document.createElement("div");
    wrap.className = "msg agent";
    const card = document.createElement("div");
    card.className = "card ask-user";
    card.innerHTML = `
      <div class="row-label">${escapeHtml(question)}</div>
      <input type="text" placeholder="Type your answer…" />
      <div class="actions"><button class="btn primary">Reply</button></div>
    `;
    const input = card.querySelector("input")! as HTMLInputElement;
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      agentSocket.send({ type: "event", event_type: "ask_user_response", value });
      card.innerHTML = `<div class="row-label">${escapeHtml(question)}</div><div style="color:var(--fg-1)">You answered: "${escapeHtml(value)}"</div>`;
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    card.querySelector("button")!.addEventListener("click", submit);
    wrap.appendChild(card);
    this.messagesEl.appendChild(wrap);
    setTimeout(() => input.focus());
    this.scrollToBottom();
  }

  private appendPermission(tool: string, description: string) {
    this.clearEmptyState();
    this.currentTextEl = null;

    const textarea = this.composerBox.querySelector("textarea")!;
    const actions = this.composerBox.querySelector(".composer-actions") as HTMLElement;
    textarea.style.display = "none";
    if (actions) actions.style.display = "none";

    const overlay = document.createElement("div");
    overlay.className = "permission-overlay";
    overlay.innerHTML = `
      <div class="perm-title">${icon("zap")} <span><b>${escapeHtml(tool)}</b> requires permission</span></div>
      <div class="perm-desc">${escapeHtml(description)}</div>
      <div class="perm-actions">
        <button class="btn minimal deny-btn">Reject (Esc)</button>
        <button class="btn primary allow-btn">Allow (Alt+Enter)</button>
      </div>
    `;

    this.composerBox.appendChild(overlay);

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(false);
      } else if (e.altKey && e.key === "Enter") {
        e.preventDefault();
        resolve(true);
      }
    };

    const resolve = (val: boolean) => {
      window.removeEventListener("keydown", handleKey);
      agentSocket.send({ type: "event", event_type: "permission_response", value: val });
      overlay.remove();
      textarea.style.display = "";
      if (actions) actions.style.display = "flex";
      textarea.focus();
    };

    overlay.querySelector(".allow-btn")!.addEventListener("click", () => resolve(true));
    overlay.querySelector(".deny-btn")!.addEventListener("click", () => resolve(false));
    window.addEventListener("keydown", handleKey);
  }

  private appendSystemNote(text: string) {
    const wrap = document.createElement("div");
    wrap.className = "msg agent";
    wrap.innerHTML = `<div class="card" style="color:var(--fg-1);font-size:12px">${escapeHtml(text)}</div>`;
    this.messagesEl.appendChild(wrap);
    this.scrollToBottom();
  }

  private appendError(text: string) {
    const wrap = document.createElement("div");
    wrap.className = "msg agent";
    wrap.innerHTML = `<div class="card error">${escapeHtml(text)}</div>`;
    this.messagesEl.appendChild(wrap);
    this.scrollToBottom();
  }

  private scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
