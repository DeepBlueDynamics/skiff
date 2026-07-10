//! Native MCP server (streamable-HTTP, stateless) mounted at `/mcp` on the
//! main axum router — one process, one port, Pi-friendly. No Python bridge.
//!
//! Implements the JSON-RPC surface MCP clients need from a tools-only server:
//! `initialize`, `notifications/*` (accepted and dropped), `ping`,
//! `tools/list`, `tools/call`. Responses are direct JSON (the streamable-HTTP
//! spec allows servers to answer POSTs with `application/json`; no SSE needed
//! for request/response tools).
//!
//! Register from an agent, e.g.:
//!   claude mcp add skiff --transport http http://<host>:18081/mcp

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::{create_initial_state, AppState, TANK_CAPACITY_L};
use skiff::core::Vec2Mps;

const PROTOCOL_VERSION: &str = "2025-03-26";

pub async fn handle_post(State(state): State<AppState>, Json(msg): Json<Value>) -> impl IntoResponse {
    // Notifications (no id) get a bare 202 per the streamable-HTTP transport.
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    if id.is_none() {
        return (StatusCode::ACCEPTED, Json(Value::Null)).into_response();
    }
    let id = id.unwrap();

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "skiff-sim",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "instructions": "Sim-grade Lagoon 450S sailing simulator. The boat \
                sails a real Grenada world (grounding enforced). Read telemetry \
                with get_state; drive with set_control; shape weather with \
                set_environment; teleport with set_position (on-land targets \
                snap to the nearest water)."
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let name = msg
                .pointer("/params/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let args = msg
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(&state, name, &args).await {
                Ok(text) => Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": false
                })),
                Err(e) => Ok(json!({
                    "content": [{ "type": "text", "text": format!("error: {e}") }],
                    "isError": true
                })),
            }
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };

    let body = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": code, "message": message }
        }),
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// Streamable-HTTP GET opens a server-push SSE stream; this server is pure
/// request/response, so decline politely.
pub async fn handle_get() -> impl IntoResponse {
    StatusCode::METHOD_NOT_ALLOWED
}

pub async fn handle_delete() -> impl IntoResponse {
    StatusCode::OK
}

fn num(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(|v| v.as_f64())
}

async fn call_tool(state: &AppState, name: &str, args: &Value) -> anyhow::Result<String> {
    match name {
        "get_state" => {
            let include_trail = args
                .get("include_trail")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let snapshot = state.sim_state.read().unwrap().clone();
            let mut v = serde_json::to_value(&snapshot)?;
            if !include_trail {
                if let Some(obj) = v.as_object_mut() {
                    obj.remove("trail");
                    obj.remove("cat_state");
                }
            }
            Ok(v.to_string())
        }
        "set_control" => {
            let mut sim = state.sim_state.write().unwrap();
            let c = &mut sim.control;
            if let Some(x) = num(args, "helm") { c.helm = x.clamp(-1.0, 1.0); }
            if let Some(x) = num(args, "sail_trim") { c.sail_trim = x.clamp(0.0, 1.0); }
            if let Some(x) = num(args, "reef") { c.reef = x.clamp(0.0, 1.0); }
            if let Some(x) = num(args, "thrust_port") { c.thrust_port = x.clamp(-3000.0, 3000.0); }
            if let Some(x) = num(args, "thrust_stbd") { c.thrust_stbd = x.clamp(-3000.0, 3000.0); }
            if let Some(x) = num(args, "traveler") { c.traveler = x.clamp(-1.0, 1.0); }
            if let Some(x) = num(args, "mass_scale") { c.mass_scale = x.clamp(0.25, 4.0); }
            if let Some(x) = num(args, "fuel_burn_max_lph") { c.fuel_burn_max_lph = x.clamp(0.0, 40.0); }
            Ok(serde_json::to_value(&sim.control)?.to_string())
        }
        "set_environment" => {
            let mut sim = state.sim_state.write().unwrap();
            let wind_spd = num(args, "wind_speed_mps")
                .unwrap_or_else(|| sim.env.wind_ground_mps.magnitude());
            let wind_to = num(args, "wind_to_deg")
                .unwrap_or_else(|| sim.env.wind_ground_mps.to_deg());
            let cur_spd = num(args, "current_speed_mps")
                .unwrap_or_else(|| sim.env.current_ground_mps.magnitude());
            let cur_to = num(args, "current_to_deg")
                .unwrap_or_else(|| sim.env.current_ground_mps.to_deg());
            sim.env.wind_ground_mps = Vec2Mps::from_speed_to_deg(wind_spd, wind_to);
            sim.env.current_ground_mps = Vec2Mps::from_speed_to_deg(cur_spd, cur_to);
            if let Some(x) = num(args, "wave_height_m") { sim.env.wave_height_m = Some(x.clamp(0.0, 12.0)); }
            if let Some(x) = num(args, "wave_period_s") { sim.env.wave_period_s = Some(x.clamp(1.0, 25.0)); }
            if let Some(x) = num(args, "wave_to_deg") { sim.env.wave_to_deg = Some(x.rem_euclid(360.0)); }
            let manual = args.get("manual").and_then(|v| v.as_bool()).unwrap_or(true);
            if manual {
                sim.manual_env_override = true;
            }
            Ok(serde_json::to_value(&sim.env)?.to_string())
        }
        "set_position" => {
            let lat = num(args, "lat_deg").ok_or_else(|| anyhow::anyhow!("lat_deg required"))?;
            let lon = num(args, "lon_deg").ok_or_else(|| anyhow::anyhow!("lon_deg required"))?;
            let (lat, lon) = match state.land_mask.as_ref() {
                Some(mask) => mask.nearest_water(lat, lon, 10_000.0).unwrap_or((lat, lon)),
                None => (lat, lon),
            };
            let mut sim = state.sim_state.write().unwrap();
            sim.pos = skiff::core::LatLon { lat_deg: lat, lon_deg: lon };
            sim.local_pos_m = Vec2Mps::ZERO;
            sim.trail = vec![Vec2Mps::ZERO];
            Ok(json!({ "lat_deg": lat, "lon_deg": lon, "note": "snapped to water if requested point was on land" }).to_string())
        }
        "reset" => {
            {
                let mut wrench = state.sail_wrench.write().unwrap();
                *wrench = None;
            }
            let mut sim = state.sim_state.write().unwrap();
            *sim = create_initial_state();
            if let Some(h) = num(args, "heading_true_deg") {
                let h = h.rem_euclid(360.0);
                sim.cat_state.eta[5] = -h.to_radians();
                sim.heading_true_deg = h;
                sim.cog_true_deg = h;
            }
            Ok(json!({ "ok": true, "pos": sim.pos, "heading_true_deg": sim.heading_true_deg }).to_string())
        }
        "set_course" => {
            let mut sim = state.sim_state.write().unwrap();
            match num(args, "heading_true_deg") {
                Some(h) => {
                    let h = h.rem_euclid(360.0);
                    sim.ap_heading_deg = Some(h);
                    Ok(json!({ "course_hold": h, "note": "backend autopilot engaged" }).to_string())
                }
                None => {
                    sim.ap_heading_deg = None;
                    Ok(json!({ "course_hold": null, "note": "course hold released, manual helm" }).to_string())
                }
            }
        }
        "refuel" => {
            let mut sim = state.sim_state.write().unwrap();
            sim.fuel_port_l = TANK_CAPACITY_L;
            sim.fuel_stbd_l = TANK_CAPACITY_L;
            Ok(json!({ "fuel_port_l": sim.fuel_port_l, "fuel_stbd_l": sim.fuel_stbd_l }).to_string())
        }
        other => Err(anyhow::anyhow!("unknown tool: {other}")),
    }
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "get_state",
            "description": "Full simulator telemetry: position (Grenada), heading/COG/STW/SOG, wind (true+apparent), heel/pitch, sail forces, fuel tanks, aground flag, environment. Set include_trail=true for the position history.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "include_trail": { "type": "boolean", "description": "Include the position trail (default false)" }
                }
            }
        },
        {
            "name": "set_control",
            "description": "Drive the boat. All fields optional; unspecified controls are left unchanged.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "helm": { "type": "number", "description": "-1 (full port) .. +1 (full starboard)" },
                    "sail_trim": { "type": "number", "description": "0 (fully eased) .. 1 (hard sheeted)" },
                    "reef": { "type": "number", "description": "0 (full sail) .. 1 (fully reefed)" },
                    "thrust_port": { "type": "number", "description": "Port engine thrust, -3000..3000 N" },
                    "thrust_stbd": { "type": "number", "description": "Starboard engine thrust, -3000..3000 N" },
                    "traveler": { "type": "number", "description": "Mainsheet traveler car, -1 (port) .. +1 (stbd)" },
                    "mass_scale": { "type": "number", "description": "Displacement multiplier, 0.25..4 (1 = stock)" },
                    "fuel_burn_max_lph": { "type": "number", "description": "Full-throttle burn per engine, L/h" }
                }
            }
        },
        {
            "name": "set_environment",
            "description": "Set weather. All fields optional (partial update). manual=true (default) pauses the live Meridian feed; manual=false composes with it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "wind_speed_mps": { "type": "number" },
                    "wind_to_deg": { "type": "number", "description": "Direction wind blows TOWARD, compass deg" },
                    "current_speed_mps": { "type": "number" },
                    "current_to_deg": { "type": "number" },
                    "wave_height_m": { "type": "number" },
                    "wave_period_s": { "type": "number", "description": "Also sets wavelength via deep-water dispersion" },
                    "wave_to_deg": { "type": "number" },
                    "manual": { "type": "boolean" }
                }
            }
        },
        {
            "name": "set_position",
            "description": "Teleport the boat. On-land targets snap to the nearest water (spiral search), so you can never strand the boat inside the island.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "lat_deg": { "type": "number" },
                    "lon_deg": { "type": "number" }
                },
                "required": ["lat_deg", "lon_deg"]
            }
        },
        {
            "name": "reset",
            "description": "Full reset to the Prickly Bay anchorage (Spice Island Marine, Grenada), full tanks, default environment. Optional initial heading.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "heading_true_deg": { "type": "number" }
                }
            }
        },
        {
            "name": "set_course",
            "description": "Engage the backend course-hold: steer to a true heading (works headless, overrides manual helm). Call with no arguments to release back to manual helm.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "heading_true_deg": { "type": "number", "description": "True heading to hold (0-360). Omit to disengage." }
                }
            }
        },
        {
            "name": "refuel",
            "description": "Fill both diesel tanks to capacity (2 x 275 L).",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}
