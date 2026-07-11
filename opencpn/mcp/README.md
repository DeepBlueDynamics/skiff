# opencpn-mcp

Zero-dependency Node MCP (stdio) server giving agents control of OpenCPN and
vessel routing. Register:

```
claude mcp add opencpn -- node <this dir>\server.js
```

14 tools in three layers:

| layer | tools | transport |
|---|---|---|
| OpenCPN in-process | `jump_to`, `ocpn_ownship`, `ocpn_routes`, `ocpn_create_route`, `ocpn_delete_route` | HTTP → `ocpn_bridge_pi` plugin on 127.0.0.1:18082 |
| vessel routing | `set_destination`, `set_route`, `clear_course`, `course_status` | SignalK v2 Course API on the Pi (`SIGNALK_URL`, default 192.168.68.29:3000) |
| window fallback | `zoom`, `pan`, `follow`, `click`, `press_keys`, `screenshot` | Win32 keystroke/mouse injection (steals focus; avoid while a human types) |

Env overrides: `SIGNALK_URL`, `SKIFF_URL`, `OCPN_BRIDGE_URL`.

`tools/`:
- `check-route.js '<json waypoints>'` — verifies a route against skiff's
  grounding mask (point-in-polygon + 50 m leg sampling). Run before plotting.
- `build-grenada-mbtiles.js [out.mbtiles]` — builds the OSM raster chart for
  OpenCPN (Grenada + southern approaches; edit REGIONS to extend).

No npm install — plain `node` (>=22 for `node:sqlite` in the mbtiles tool).
