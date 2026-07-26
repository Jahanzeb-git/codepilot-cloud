# agent_server.py
from codepilot import (
    Runtime,
    on_stream,
    on_finish,
    on_tool_call,
    on_tool_result,
    on_ask_user,
    on_user_message_queued,
    on_user_message_injected,
    on_permission_request,
    on_thinking_stream,
    EventType,
)

import socket
import threading
import json
import os
import queue
import urllib.request
import yaml

SESSIONS_DIR = os.path.expanduser("~/.codepilot/sessions")
INSTRUCTIONS_FILE = os.path.expanduser("~/.codepilot/prompts/instructions.md")
AGENT_YAML_PATH = os.environ.get("AGENT_YAML_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent.yaml"))
WORK_DIR = os.environ.get("CODEPILOT_WORK_DIR")

if WORK_DIR and os.path.exists(AGENT_YAML_PATH):
    try:
        with open(AGENT_YAML_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        if "agent" not in config:
            config["agent"] = {}
        if "runtime" not in config["agent"]:
            config["agent"]["runtime"] = {}
        config["agent"]["runtime"]["work_dir"] = WORK_DIR
        with open(AGENT_YAML_PATH, "w") as f:
            yaml.safe_dump(config, f, sort_keys=False)
    except Exception as e:
        print(f"[ERROR] Failed to dynamically set work_dir in {AGENT_YAML_PATH}: {e}")

os.makedirs(SESSIONS_DIR, exist_ok=True)

SOCKET_PATH = "/tmp/agent_runtime.sock"

if os.path.exists(SOCKET_PATH):
    os.unlink(SOCKET_PATH)

print("[INFO] Creating unix socket...")
server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

print(f"[INFO] Binding to {SOCKET_PATH}")
server_socket.bind(SOCKET_PATH)

print("[INFO] Listening for connections...")
server_socket.listen(1)


def generate_session_id(dir: str) -> str:
    if not os.listdir(dir):
        return "session_001"
    files = [
        f for f in os.listdir(dir)
        if os.path.isfile(os.path.join(dir, f))
        and f.startswith("session_") and f.endswith(".json")
    ]
    if not files:
        return "session_001"
    files.sort()
    last_file = files[-1]
    session_num = int(last_file.split("_")[1].split(".")[0]) + 1
    return f"session_{session_num:03d}"


# --- shared mutable state ---
lock = threading.Lock()
_client_socket: socket.socket | None = None
runtime_thread: threading.Thread | None = None
permission_queue: queue.Queue = queue.Queue()
ask_user_queue: queue.Queue = queue.Queue()

# None means the runtime failed to init — will emit error to next connected client
runtime = None
_runtime_init_error: str | None = None


def emit(obj: dict) -> None:
    """Send a NDJSON event to the currently connected extension client."""
    line = (json.dumps(obj) + "\n").encode()
    try:
        with lock:
            if _client_socket is not None:
                _client_socket.sendall(line)
    except (BrokenPipeError, ConnectionResetError, OSError) as e:
        print(f"[ERROR] emit failed, client likely disconnected: {e}")


def init_runtime(session_id: str) -> Runtime:
    """Create a Runtime and bind all event handlers to it."""
    r = Runtime(
        agent_file=AGENT_YAML_PATH,
        stream=True,
        session="file",
        session_id=session_id,
    )
    
    state = {"in_thinking": False}

    @on_thinking_stream(r)
    def _thinking_stream(thinking: str, **_):
        if not state["in_thinking"]:
            emit({"type": "stream", "text": "<thinking>\n"})
            state["in_thinking"] = True
        emit({"type": "stream", "text": thinking})

    @on_stream(r)
    def _stream(text: str, **_):
        if state["in_thinking"]:
            emit({"type": "stream", "text": "\n</thinking>\n"})
            state["in_thinking"] = False
        print("[EVENT] on_stream called.")
        emit({"type": "stream", "text": text})

    @on_finish(r)
    def _finish(summary: str, **_):
        if state["in_thinking"]:
            emit({"type": "stream", "text": "\n</thinking>\n"})
            state["in_thinking"] = False
        print("[EVENT] on_finish called.")
        emit({"type": "finish"})

    @on_tool_call(r)
    def _tool_call(tool: str, args: dict, label: str = "", **_):
        if state["in_thinking"]:
            emit({"type": "stream", "text": "\n</thinking>\n"})
            state["in_thinking"] = False
        print("[EVENT] on_tool_call called.")
        emit({"type": "tool_call", "tool": tool, "args": args, "label": label})

    @on_tool_result(r)
    def _tool_result(tool: str, result: str, **_):
        print("[EVENT] on_tool_result called.")
        emit({"type": "tool_result", "tool": tool, "result": result})

    @on_ask_user(r)
    def _ask(question: str, **_) -> str:
        if state["in_thinking"]:
            emit({"type": "stream", "text": "\n</thinking>\n"})
            state["in_thinking"] = False
        print("[EVENT] on_ask_user called.")
        emit({"type": "ask_user", "question": question})
        answer = ask_user_queue.get()
        print(f"[EVENT] Received ask_user response: {answer}")
        return answer

    @on_user_message_queued(r)
    def _queued(message: str, **_):
        print("[EVENT] on_user_message_queued called.")
        emit({"type": "queued_message", "message": message})

    @on_user_message_injected(r)
    def _injected(message: str, **_):
        print("[EVENT] on_user_message_injected called.")
        emit({"type": "inject", "message": message})

    @on_permission_request(r)
    def _gate(tool: str, description: str, **_) -> bool:
        print("[EVENT] on_permission_request called.")
        emit({"type": "permission_request", "tool": tool, "description": description})
        allowed = permission_queue.get()
        print(f"[EVENT] Permission {'granted' if allowed else 'denied'} for tool: {tool}")
        return allowed

    print(f"[INFO] Runtime initialised for session: {session_id}")
    return r


def try_init_runtime(session_id: str) -> tuple[Runtime | None, str | None]:
    """Safely initialise a runtime. Returns (runtime, None) or (None, error_message)."""
    try:
        return init_runtime(session_id), None
    except (OSError, EnvironmentError) as e:
        msg = f"Configuration error: {e}"
        print(f"[ERROR] {msg}")
        return None, msg
    except Exception as e:
        msg = f"Runtime error: {e}"
        print(f"[ERROR] {msg}")
        return None, msg


# ── Initial runtime boot ──────────────────────────────────────────────────────
runtime, _runtime_init_error = try_init_runtime(generate_session_id(SESSIONS_DIR))

# ── Outer loop: accept a new connection after each disconnect ─────────────────
shutdown = False

while not shutdown:
    print("[INFO] Waiting for client to connect...")
    try:
        conn, addr = server_socket.accept()
    except OSError as e:
        print(f"[ERROR] server socket error: {e}")
        break

    print(f"[INFO] Client connected: {addr}")

    with lock:
        _client_socket = conn

    # If the initial runtime boot failed, immediately notify the newly connected client
    if runtime is None and _runtime_init_error:
        emit({"type": "error", "message": _runtime_init_error})

    recv_buffer = b""

    # ── Inner loop: read NDJSON messages from this client ────────────────────
    while True:
        try:
            chunk = conn.recv(4096)
        except (ConnectionResetError, OSError) as e:
            print(f"[ERROR] client connection reset: {e}")
            break

        if not chunk:
            print("[INFO] Client disconnected (EOF).")
            break

        recv_buffer += chunk

        while b"\n" in recv_buffer:
            line, recv_buffer = recv_buffer.split(b"\n", 1)
            if not line.strip():
                continue

            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"[ERROR] Failed to parse NDJSON: {e}")
                continue

            if obj["type"] == "task":
                if runtime is None:
                    emit({"type": "error", "message": _runtime_init_error or "Agent runtime is not initialised. Please check your settings."})
                elif runtime_thread is None or not runtime_thread.is_alive():
                    def _run_with_catch(text):
                        try:
                            runtime.run(text)
                        except Exception as e:
                            print(f"[ERROR] Runtime error:\n{e}")
                            emit({"type": "error", "message": f"LLM provider error: {e}"})

                    runtime_thread = threading.Thread(
                        target=_run_with_catch,
                        args=(obj["text"],),
                        daemon=True,
                    )
                    runtime_thread.start()
                else:
                    try:
                        runtime.send_message(obj["text"])
                    except Exception as e:
                        print(f"[ERROR] Runtime error:\n{e}")
                        emit({"type": "error", "message": f"LLM provider error: {e}"})

            elif obj["type"] == "event" and obj["event_type"] == "abort":
                if runtime:
                    runtime.abort()

            elif obj["type"] == "event" and obj["event_type"] == "permission_response":
                permission_queue.put(obj["value"])

            elif obj["type"] == "event" and obj["event_type"] == "ask_user_response":
                ask_user_queue.put(obj["value"])

            elif obj["type"] == "event" and obj["event_type"] == "suspend":
                if runtime:
                    runtime.abort()
                try:
                    URL = f"{os.environ.get('CONTROL_PLANE_URL')}/machines/suspend"
                    req = urllib.request.Request(
                        URL,
                        method="POST",
                        headers={
                            "X-Machine-Secret": os.environ.get("MACHINE_SECRET"),
                            "Content-Type": "application/json",
                        },
                    )
                    with urllib.request.urlopen(req) as resp:
                        data = resp.read()
                        print(f"[INFO] machine suspended: status={resp.status} response={json.loads(data)}")
                except Exception as e:
                    print(f"[ERROR] Failed to notify control plane of suspension: {e}")
                break

            elif obj["type"] == "event" and obj["event_type"] == "new_session":
                new_rt, err = try_init_runtime(obj["session_id"])
                if err:
                    emit({"type": "error", "message": err})
                else:
                    runtime = new_rt
                    _runtime_init_error = None
                    emit({"type": "session_switched", "session_id": obj["session_id"]})

            elif obj["type"] == "event" and obj["event_type"] == "switch_session":
                new_rt, err = try_init_runtime(obj["session_id"])
                if err:
                    emit({"type": "error", "message": err})
                else:
                    runtime = new_rt
                    _runtime_init_error = None
                    emit({"type": "session_switched", "session_id": obj["session_id"]})

            elif obj["type"] == "event" and obj["event_type"] == "update_settings":

                with open(AGENT_YAML_PATH, "r") as f:
                    data = yaml.safe_load(f)

                settings = obj.get("settings", {})

                def update_if_present(target_dict, key, source_dict, source_key=None):
                    skey = source_key or key
                    val = source_dict.get(skey)
                    if val not in (None, "", [], {}):
                        target_dict[key] = val

                update_if_present(data["agent"]["model"], "provider", settings)
                update_if_present(data["agent"]["model"], "name", settings, "model")
                update_if_present(data["agent"]["model"], "temperature", settings)
                update_if_present(data["agent"]["model"], "max_tokens", settings)
                update_if_present(data["agent"]["model"], "api_key_env", settings)

                # Thinking config
                thinking_settings = settings.get("thinking", {})
                if thinking_settings:
                    if "thinking" not in data["agent"]["model"]:
                        data["agent"]["model"]["thinking"] = {}
                    thinking_block = data["agent"]["model"]["thinking"]
                    if "enabled" in thinking_settings:
                        thinking_block["enabled"] = thinking_settings["enabled"]
                    if thinking_settings.get("enabled"):
                        if thinking_settings.get("budget_tokens"):
                            thinking_block["budget_tokens"] = int(thinking_settings["budget_tokens"])
                        if thinking_settings.get("reasoning_effort"):
                            thinking_block["reasoning_effort"] = thinking_settings["reasoning_effort"]
                    else:
                        # Collapse to just enabled: false to avoid sending stale config
                        data["agent"]["model"]["thinking"] = {"enabled": False}

                update_if_present(data["agent"]["runtime"], "max_steps", settings)
                update_if_present(data["agent"]["runtime"], "unsafe_mode", settings)

                if "tools" in settings and settings["tools"]:
                    for tool_name, tool_conf in settings["tools"].items():
                        for t in data["agent"]["tools"]:
                            if t["name"] == tool_name:
                                for k, v in tool_conf.items():
                                    if v not in (None, "", [], {}):
                                        if k == "require_permission":
                                            t.setdefault("config", {})
                                            t["config"][k] = v
                                        else:
                                            t[k] = v

                if settings.get("system_prompt_append"):
                    data["agent"]["system_prompt"] += " " + settings["system_prompt_append"]

                with open(AGENT_YAML_PATH, "w") as f:
                    yaml.safe_dump(data, f, sort_keys=False)

                new_api_key = settings.get("api_key", "").strip()
                env_var_name = settings.get("api_key_env", "").strip()
                if new_api_key and env_var_name:
                    os.environ[env_var_name] = new_api_key
                    print(f"[INFO] Injected new key into {env_var_name}")

                curr_sid = runtime.session_id if runtime and hasattr(runtime, 'session_id') else generate_session_id(SESSIONS_DIR)
                if runtime and hasattr(runtime, 'cleanup'):
                    try:
                        runtime.cleanup()
                    except Exception:
                        pass
                new_rt, err = try_init_runtime(curr_sid)
                if err:
                    runtime = None
                    _runtime_init_error = err
                    emit({"type": "settings_updated", "success": False, "message": err})
                else:
                    runtime = new_rt
                    _runtime_init_error = None
                    emit({"type": "settings_updated", "success": True})

    with lock:
        _client_socket = None
    try:
        conn.close()
    except OSError:
        pass

    if not shutdown:
        print("[INFO] Client disconnected. Waiting for reconnect...")

print("[INFO] Agent server shutting down.")