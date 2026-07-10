//! SignalK delta publisher.
//!
//! Server-node does NOT accept HTTP-POSTed deltas (verified against a live
//! v2.28 server: `Cannot POST /signalk/v1/api/`) — the standard input channel
//! is the WebSocket stream at `/signalk/v1/stream`. This client owns a
//! background task with automatic reconnect; `send_delta` just enqueues.
//!
//! Config: `SIGNALK_HOST` = `host[:port]`, scheme optional
//! (Pi: `localhost:3000`; dev: `192.168.68.29:3000`).
//! `SIGNALK_TOKEN` (optional) is sent as a Bearer header on the handshake.

use futures_util::SinkExt;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize)]
pub struct SignalKDelta {
    pub context: String,
    pub updates: Vec<SignalKUpdate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalKUpdate {
    pub source: SignalKSource,
    pub values: Vec<SignalKPathValue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalKSource {
    pub label: String,
    #[serde(rename = "type")]
    pub source_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalKPathValue {
    pub path: String,
    pub value: serde_json::Value,
}

pub struct SignalKClient {
    tx: mpsc::UnboundedSender<String>,
}

impl SignalKClient {
    /// Spawns the connection task immediately; deltas sent before the socket
    /// is up are buffered in the channel (and drained on connect).
    pub fn new(host: String, token: Option<String>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let ws_url = Self::ws_url(&host);
        tokio::spawn(connection_task(ws_url, token, rx));
        Self { tx }
    }

    fn ws_url(host: &str) -> String {
        let bare = host
            .trim_end_matches('/')
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_start_matches("ws://")
            .trim_start_matches("wss://");
        // subscribe=none: we are a producer, not a consumer.
        format!("ws://{bare}/signalk/v1/stream?subscribe=none")
    }

    pub async fn send_delta(&self, delta: &SignalKDelta) -> anyhow::Result<()> {
        let json = serde_json::to_string(delta)?;
        self.tx
            .send(json)
            .map_err(|_| anyhow::anyhow!("SignalK connection task has shut down"))?;
        Ok(())
    }
}

async fn connection_task(
    ws_url: String,
    token: Option<String>,
    mut rx: mpsc::UnboundedReceiver<String>,
) {
    let mut backoff_s = 1u64;
    loop {
        let mut request = match ws_url.clone().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("SignalK: invalid WS URL {ws_url}: {e}");
                return;
            }
        };
        if let Some(t) = &token {
            if !t.is_empty() {
                if let Ok(v) = format!("Bearer {t}").parse() {
                    request.headers_mut().insert("Authorization", v);
                }
            }
        }

        match tokio_tungstenite::connect_async(request).await {
            Ok((mut ws, _resp)) => {
                tracing::info!("SignalK connected: {ws_url}");
                backoff_s = 1;
                while let Some(json) = rx.recv().await {
                    if let Err(e) = ws.send(Message::Text(json)).await {
                        tracing::warn!("SignalK send failed ({e}); reconnecting");
                        break;
                    }
                }
            }
            Err(e) => {
                tracing::warn!("SignalK connect to {ws_url} failed: {e} (retry in {backoff_s}s)");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff_s)).await;
        backoff_s = (backoff_s * 2).min(30);
    }
}
