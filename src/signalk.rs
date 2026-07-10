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

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// Route guidance received FROM SignalK (e.g. OpenCPN with an activated
/// route emits APB/RMB → server-node exposes navigation.course* paths).
/// Partial: each delta may carry only some fields; the consumer merges.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RouteGuidance {
    /// Bearing to the next waypoint, true degrees.
    pub bearing_true_deg: Option<f64>,
    /// Cross-track error, metres (sign per source convention).
    pub xte_m: Option<f64>,
    /// Next waypoint, if the source publishes it.
    pub next_lat_deg: Option<f64>,
    pub next_lon_deg: Option<f64>,
}

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
    /// is up are buffered in the channel (and drained on connect). Incoming
    /// course/steering deltas are parsed into [`RouteGuidance`] and pushed to
    /// `guidance_tx` when provided.
    pub fn new(
        host: String,
        token: Option<String>,
        guidance_tx: Option<mpsc::UnboundedSender<RouteGuidance>>,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        let ws_url = Self::ws_url(&host);
        tokio::spawn(connection_task(ws_url, token, rx, guidance_tx));
        Self { tx }
    }

    fn ws_url(host: &str) -> String {
        let bare = host
            .trim_end_matches('/')
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_start_matches("ws://")
            .trim_start_matches("wss://");
        // subscribe=none at connect; we send an explicit subscription for the
        // course/steering paths right after the handshake.
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
    guidance_tx: Option<mpsc::UnboundedSender<RouteGuidance>>,
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
                // Subscribe to route guidance (OpenCPN's activated route
                // arrives as navigation.course* / steering.* on self).
                if guidance_tx.is_some() {
                    let sub = serde_json::json!({
                        "context": "vessels.self",
                        "subscribe": [
                            { "path": "navigation.*", "period": 1000, "policy": "instant" },
                            { "path": "steering.*", "period": 1000, "policy": "instant" }
                        ]
                    });
                    let _ = ws.send(Message::Text(sub.to_string())).await;
                }
                loop {
                    tokio::select! {
                        out = rx.recv() => {
                            match out {
                                Some(json) => {
                                    if let Err(e) = ws.send(Message::Text(json)).await {
                                        tracing::warn!("SignalK send failed ({e}); reconnecting");
                                        break;
                                    }
                                }
                                None => return, // client dropped
                            }
                        }
                        incoming = ws.next() => {
                            match incoming {
                                Some(Ok(Message::Text(text))) => {
                                    if let Some(tx) = &guidance_tx {
                                        if let Some(g) = parse_guidance(&text) {
                                            let _ = tx.send(g);
                                        }
                                    }
                                }
                                Some(Ok(_)) => {} // ping/pong/binary — ignore
                                Some(Err(e)) => {
                                    tracing::warn!("SignalK read failed ({e}); reconnecting");
                                    break;
                                }
                                None => {
                                    tracing::warn!("SignalK stream closed; reconnecting");
                                    break;
                                }
                            }
                        }
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

/// Extract route guidance from an incoming SignalK delta. Tolerant of both
/// the classic course paths (courseRhumbline/courseGreatCircle, from APB/RMB
/// conversion) and the v2 Course API calcValues.
fn parse_guidance(text: &str) -> Option<RouteGuidance> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let updates = v.get("updates")?.as_array()?;
    let mut g = RouteGuidance::default();
    let mut any = false;
    for u in updates {
        let Some(values) = u.get("values").and_then(|x| x.as_array()) else {
            continue;
        };
        for pv in values {
            let Some(path) = pv.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            let value = pv.get("value");
            let as_f64 = value.and_then(|x| x.as_f64());
            if path.ends_with("crossTrackError") {
                if let Some(x) = as_f64 {
                    g.xte_m = Some(x);
                    any = true;
                }
            } else if path.ends_with("nextPoint.bearingTrue")
                || path.ends_with("bearingToDestinationTrue")
                || path.ends_with("bearingOriginToDestinationTrue")
                || path.ends_with("calcValues.bearingTrue")
                || path.ends_with("bearingTrackTrue")
                || path.ends_with("autopilot.target.headingTrue")
            {
                if let Some(rad) = as_f64 {
                    g.bearing_true_deg = Some(rad.to_degrees().rem_euclid(360.0));
                    any = true;
                }
            } else if path.ends_with("nextPoint.position") {
                if let Some(pos) = value {
                    let lat = pos.get("latitude").and_then(|x| x.as_f64());
                    let lon = pos.get("longitude").and_then(|x| x.as_f64());
                    if lat.is_some() && lon.is_some() {
                        g.next_lat_deg = lat;
                        g.next_lon_deg = lon;
                        any = true;
                    }
                }
            }
        }
    }
    if any { Some(g) } else { None }
}
