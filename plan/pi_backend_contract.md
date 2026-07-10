# Skiff backend contract for Pi deployment

One Rust binary serves everything on one port. The deployment agent owns HOW
it gets to the Pi; this is WHAT it needs at runtime.

## Build
- `cargo build --release --bin skiff` — pure rustls (no OpenSSL), edition
  2024 (rust >= 1.85). Target `aarch64-unknown-linux-gnu` for Pi 4/5.

## Runtime layout
- Working dir must contain `web/dist/` (UI + `web/dist/world/grenada.geojson`
  which also drives grounding — backend loads it from disk at startup).

## Env
| Var | Meaning | Pi value |
|---|---|---|
| `SKIFF_PORT` / `PORT` | HTTP port (SKIFF_PORT wins) | default 18081 |
| `SIGNALK_HOST` | SignalK server, `host[:port]`, scheme optional | `localhost:3000` |
| `SIGNALK_TOKEN` | optional Bearer for the WS handshake | as issued |
| `MERIDIAN_URL` | weather service | default meridian.deepbluedynamics.com |
| `MERIDIAN_USER_TOKEN` | optional seed JWT (else browser login flow) | — |

## SignalK
Deltas stream over WebSocket `ws://{SIGNALK_HOST}/signalk/v1/stream` (server-node
rejects HTTP-POSTed deltas; verified v2.28). Auto-reconnect w/ backoff. Verify:
`curl http://localhost:3000/signalk/v1/api/vessels/self/navigation/speedThroughWater`

## MCP (native, in-binary)
Streamable-HTTP, stateless, at `POST /mcp` on the main port.
Register: `claude mcp add skiff --transport http http://<pi>:18081/mcp`
Tools: `get_state`, `set_control`, `set_environment`, `set_position`
(on-land snaps to nearest water), `reset`, `refuel`.
The old `mcp/skiff_mcp.py` FastMCP bridge is deleted — superseded.
