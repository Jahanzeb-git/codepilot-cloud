// File: server/src/state.rs
use std::sync::Arc;

use axum::extract::ws::Message;
use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

#[derive(Clone, Debug, serde::Serialize)]
pub struct FsEvent {
    /// One of "created" | "modified" | "deleted"
    pub event_type: String,
    pub path: String,
}

pub struct AppState {
    pub config: Arc<crate::config::Config>,
    /// Broadcasts inotify events to every /ws/control client.
    pub fs_events_tx: broadcast::Sender<FsEvent>,
    /// Live /ws/control connections (for server-pushed events like terminal_created).
    pub control_clients: Arc<DashMap<Uuid, mpsc::UnboundedSender<Message>>>,
    /// Live /ws/agent connections (fan-out of agent NDJSON).
    pub agent_clients: Arc<DashMap<Uuid, mpsc::UnboundedSender<Message>>>,
    /// Browser→Python NDJSON bytes, consumed by the agent bridge task.
    pub agent_inbound_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Bytes to write to /tmp/codepilot_control.sock (resize events), consumed by the control-plane task.
    pub control_plane_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Cached `terminal_created` events (keyed by session_id → full JSON string).
    /// Replayed to every new /ws/control client so agent terminals are never missed
    /// due to the browser connecting after the codepilot runtime already started.
    pub known_terminals: Arc<DashMap<String, String>>,
}