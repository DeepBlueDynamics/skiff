# Real OpenCPN plugin for full MCP control — guidance for Goose

Kord's call: keystroke/click injection ("fake plugin") got us pan/zoom/screenshot,
but it can't create or activate routes, it steals focus, and it dies whenever a
human is using the desktop. To *fully* twiddle OpenCPN we go in-process: a real
C++ plugin that exposes a local control API, with the existing MCP server
(`opencpn/mcp/server.js` on the Windows box) rewired to call it. Agents keep the
same MCP contract; the transport under it changes from SendKeys to HTTP.

## Architecture (3 layers, only the bottom one is new)

```
agents ──MCP stdio──► opencpn/mcp/server.js (Node, exists)
                            │  swap tool impls: SendKeys → HTTP
                            ▼
                    ocpn_bridge_pi  (NEW: C++ plugin in OpenCPN's process)
                    tiny HTTP server on 127.0.0.1:18082, JSON commands
                            │  direct plugin-API calls
                            ▼
                    OpenCPN core (view, route db, nav data)
```

Keep `screenshot` and `press_keys` in server.js as fallbacks; everything else
migrates to the bridge.

## What the plugin API gives us (ocpn_plugin.h, target API ≥ 1.18 / OCPN 5.8+)

- **View control** — `JumpToPosition(lat, lon, scale)` replaces all pan/zoom
  keystrokes, deterministic, no focus. Multi-canvas via `GetCanvasCount()` /
  `GetCanvasByIndex()`.
- **Routes** — `AddPlugInRoute(PlugIn_Route_Ex*, b_permanent)`,
  `DeletePlugInRoute(GUID)`, `GetRouteGUIDArray()`, `GetRoute_Plugin(GUID)`,
  waypoint equivalents. So `create_route(waypoints[])` is first-class.
- **Nav data in** — `SetPositionFixEx` callbacks give ownship; plugin messaging
  (`SetPluginMessage`) carries core events, incl. `OCPN_RTE_ACTIVATED` /
  `OCPN_RTE_DEACTIVATED` / `OCPN_WPT_ARRIVED` JSON — subscribe to these to
  report guidance state back over the bridge.
- **Route ACTIVATION** — the one call to verify first (API versions moved this
  around): grep the 5.14 `ocpn_plugin.h` for `ActivateRoute` / anything taking a
  route GUID. If activation IS exposed: done. If NOT, two working fallbacks,
  in preference order:
  1. The plugin computes guidance itself for its "active" route (bearing to
     next WP + XTE from ownship fix — 30 lines) and sends `ECAPB/ECRMB` over
     **its own UDP socket straight to the Pi's SignalK :10111**. The whole
     downstream chain (SignalK → skiff `route_guidance` → physics follow)
     doesn't care whether OpenCPN core or the plugin authored the sentences.
     Study `apRoute` (autopilot route plugin, Sean d'Epagnier) — it is exactly
     this pattern and is the best working-code reference.
  2. Post the route-manager activation `wxCommandEvent` to the frame (ugly,
     version-fragile — last resort).
- **NMEA injection** — `PushNMEABuffer(sentence)` pushes into core's input mux
  if we ever want OpenCPN to *receive* synthetic data locally.

## Build path (do NOT hand-roll the toolchain)

- Start from the **shipdriver plugin template** (github.com/Rasbats/shipdriver_pi)
  — the canonical modern skeleton: CMake, plugin-API headers vendored, and
  **GitHub Actions CI that produces Windows artifacts**. Since you live in a
  Linux workspace and the target is Kord's Windows box, let CI build the
  Windows DLL/installer — cross-compiling wx3.2/MSVC locally is not worth it.
- Match the target: OpenCPN **5.14.0**, wxWidgets 3.2.x, plugin ABI msvc-wx32.
  Installed plugin dir on the box: `C:\Program Files (x86)\OpenCPN\plugins\`
  (I can deploy artifacts there and cycle OpenCPN — send me the artifact).
- HTTP server inside the plugin: `cpp-httplib` (header-only) on
  `127.0.0.1:18082`, JSON in/out, no auth (localhost only), endpoints below.

## Bridge API (v0 proposal — server.js will consume this)

| endpoint | body | effect |
|---|---|---|
| `GET /ping` | — | `{version, api_level, opencpn}` |
| `POST /view/jump` | `{lat, lon, scale?}` | JumpToPosition |
| `POST /route` | `{name, waypoints:[{lat,lon,name?}]}` | create, returns `{guid}` |
| `DELETE /route/:guid` | — | delete |
| `GET /routes` | — | list `{guid,name,active}` |
| `POST /route/:guid/activate` | — | activate (API or fallback #1) |
| `POST /route/deactivate` | — | deactivate / stop guidance |
| `GET /ownship` | — | `{lat,lon,sog,cog}` from the fix stream |

## MVP milestones (each independently useful)

1. Template builds in CI, plugin loads in 5.14, `/ping` answers. ← proves ABI
2. `/view/jump` — kills the focus-steal problem for chart control immediately.
3. `/route` create + list + delete.
4. Activation (verify API call; else apRoute-style guidance + UDP to :10110/10111).
5. I rewire `opencpn/mcp/server.js` tools to the bridge and re-verify the
   Kord demo end-to-end: MCP create route → activate → Pi boat turns.

Division of labor: you own the C++ plugin repo + CI; I own the Windows-side
deploy (install DLL, cycle OpenCPN, verify) and the server.js rewire. Ping me
with a CI artifact URL when milestone 1 builds.
