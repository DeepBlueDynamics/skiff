# ocpn_bridge_pi — full build & integration spec

Everything known about the OpenCPN control-bridge plugin as built and verified
2026-07-10/11: architecture, every constraint that bit us, the wire protocols,
and the SignalK semantics downstream. Source: `skiff/opencpn/bridge/`.
Companion consumer: `skiff/opencpn/mcp/server.js`. Operational context:
`skiff/DEPLOYMENT.md`.

---

## 1. Purpose and why in-process

Agents need deterministic control of OpenCPN. The first implementation was
keystroke/mouse injection from outside the process (still present in the MCP
server as fallback): it steals focus, Windows blocks it entirely while the
human is typing (foreground lock), and it cannot touch the route database at
all. The plugin moves control *inside* OpenCPN's process where the plugin API
gives: exact view positioning, first-class route CRUD, the ownship fix stream,
and (via our own code) route following. A human at the GUI and an agent on the
bridge coexist — with one hard rule, §10.

## 2. Architecture

```
agent (MCP tools) ──stdio──► opencpn/mcp/server.js ──HTTP──► 127.0.0.1:18082
                                                              │ (httplib thread)
                                              RunOnMain marshal│
                                                              ▼
                                                    wx main thread
                                              plugin API calls / wxTimer 1 Hz
                                                              │ follower emits
                                                              ▼
                                             UDP → Pi:10111 → SignalK → skiff AP
```

Two translation units, deliberately:

- `http_bridge.cpp` — cpp-httplib server + nlohmann JSON + winsock UDP sender.
  NO wx headers.
- `bridge_pi.cpp` — wxWidgets + `ocpn_plugin.h` + the plugin class, follower,
  NMEA composition. NO httplib.

**This split is not style — it is required.** httplib and wx both define
`ssize_t` on MSVC with different underlying types; sharing a TU is a hard
compile error (C2371), and "fixing" it with `HAVE_SSIZE_T` games risks silent
wxString ABI drift. The boundary is `http_bridge.h`: plain std types only
(`std::string`, `std::function`, `std::vector`, a POD waypoint struct).
Handlers return pre-composed JSON strings. `bridge_udp_send()` lives on the
socket side so the wx TU never sees winsock2.

## 3. ABI & toolchain — the exact recipe

Target is **OpenCPN 5.14.0 Windows = Win32 (x86), wxWidgets 3.2 vc14x, MSVC
/MD**. Every element below is load-bearing:

| element | value | why |
|---|---|---|
| arch | `-A Win32` | OpenCPN Windows is 32-bit; a x64 DLL silently fails the candidate check |
| wxWidgets | official 3.2.6 release binaries: `wxWidgets-3.2.6-headers.7z` + `wxMSW-3.2.6_vc14x_Dev.7z` | import libs reference `wxmsw32u_*_vc14x.dll` — the exact DLLs OpenCPN ships, so one wx instance in the process. Extract, rename `lib/vc14x_dll` → `lib/vc_dll` (the msvc auto-link header expects that layout) |
| include order | `include/msvc` BEFORE `include` | `include/msvc/wx/setup.h` does `#pragma comment(lib,…)` auto-link |
| defines | `__WXMSW__ _UNICODE UNICODE WXUSINGDLL` | standard wx-DLL client |
| plugin API | `opencpn-libs` clone, **api-18** (`ocpn_plugin.h` + `msvc-wx32/opencpn.lib`) | 1.18 has everything we use; class layouts verified byte-identical to api-21, so no drift risk against 5.14. `opencpn.lib` is the import lib for symbols exported by `opencpn.exe` itself |
| runtime | `/MD` (default) + **`_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR`** | OpenCPN ships an OLD `msvcp140.dll` in its app dir which wins DLL search. VS2022's constexpr `std::mutex` layout crashes against it — first Init used a mutex → instant startup crash in msvcp140. The define restores the compatible layout. NEVER remove |
| exports | `extern "C" DECL_EXP create_pi/destroy_pi` | `DECL_EXP` is dllexport on Windows in the API header |
| lists | `WX_DEFINE_LIST(Plugin_WaypointList)` + `(Plugin_WaypointExList)` in our TU | the API header only DECLARES them; each plugin must instantiate or you get `wxPlugin_WaypointListNode::DeleteData` link errors |

Build: `fetch-deps.ps1` then `cmake -B build -G "Visual Studio 17 2022" -A
Win32 && cmake --build build --config Release`. VS 2022 Build Tools' bundled
CMake works (`…\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\…`).

Install: `%LOCALAPPDATA%\opencpn\plugins\` (scanned by the loader, **no admin
needed** — Program Files requires elevation and isn't worth it), plus
`[PlugIns/ocpn_bridge_pi.dll] bEnabled=1` in `opencpn.ini` (a newly discovered
plugin is loaded for metadata but Init is NOT called until enabled; there is
no log line telling you this — the silence is the tell).

## 4. Threading model

- httplib runs its own accept/worker thread (started in `Init`, joined in
  `DeInit` — after `svr.stop()`).
- Every plugin-API call must happen on the wx main thread. `RunOnMain(fn)`:
  `wxTheApp->CallAfter(lambda)` capturing a `shared_ptr<promise<string>>`,
  caller waits on the future with a **5 s timeout** (returns a JSON error on
  timeout instead of wedging the HTTP thread). Exceptions on the main thread
  are caught and returned as `{"error": …}`.
- NEVER call `RunOnMain` from the main thread (self-deadlock). All callers are
  HTTP-thread handlers, so this holds by construction; keep it that way.
- The follower runs on a `wxTimer` (1 Hz) bound to a member `wxEvtHandler` —
  i.e. main-thread ticks. All follower state (`m_follow`) is therefore
  main-thread-only; no lock. The ONLY cross-thread state is the last position
  fix (`m_fix` + `m_have_fix`), guarded by `m_fix_mutex`, written by
  `SetPositionFixEx` (main thread) and read by `/ownship` (HTTP thread) and
  the follower.
- Capability flags: `Init` returns `WANTS_NMEA_EVENTS` (that's what routes
  `SetPositionFixEx` to us). Nothing else requested.

## 5. Plugin-API usage notes (the sharp edges)

- **`JumpToPosition(lat, lon, scale)`** — `scale` is viewport scale in
  pixels-per-meter, not a chart scale. Conversion used: `ppm = 3779.5 /
  chart_scale` (3779.5 px/m ≈ 96 dpi). `/view/jump` takes human-friendly
  `chart_scale` (e.g. 50000) and converts.
- **Route creation — the ownership contract** (source-verified against 5.14
  `ocpn_plugin_gui.cpp`; violating it produced every crash in the bring-up):
  - `PlugIn_Route_Ex`'s **constructor allocates `pWaypointList`**; its
    **destructor unconditionally dereferences it** (`DeleteContents(false)`,
    `Clear()`, `delete`). Therefore: use the ctor-provided list, never
    replace it, never delete it, never null it.
  - `DeleteContents(false)` means the dtor frees the list but NOT the
    waypoint objects → the caller frees waypoint *data* (after
    `AddPlugInRouteEx` returns, which copies), then `Clear()`s the nodes.
  - Failure mode if violated: `AddPlugInRouteEx` SUCCEEDS (route persists!)
    and OpenCPN crashes moments later in the dtor — which misleads you into
    debugging the API call. Ask me how I know.
- **Use the Ex API** (`PlugIn_Waypoint_Ex` / `AddPlugInRouteEx`): it goes
  through core's managed `CreateNewPoint`/`FindRoutePointByGUID` path, which
  is what maintained plugins exercise. The waypoint 5-arg ctor (core-exported)
  initializes `m_CreateTime` (UTC now) and nulls the hyperlink list — no
  manual stamping needed.
- **`GetRoute_Plugin(guid)`** returns `std::unique_ptr<PlugIn_Route>` (legacy
  type — fine for reading lat/lon/name). Core-constructed, safe to let the
  unique_ptr destroy.
- **`GetNewGUID()`** for both route and waypoint GUIDs.
- **No route activation exists in the plugin API** — verified absent across
  api-16…21. Core's `Routeman::ActivateRoute` is not exported. Hence §6.
- wxString ↔ std::string across the boundary is safe (same wx DLL instance);
  `wxString(s.c_str(), wxConvUTF8)` in, `std::string(ws.mb_str())` out.

## 6. The route follower (plugin-side "activation")

Since core activation isn't exposed, the follower reimplements it — the
apRoute pattern — producing the *same wire output* core would:

- **State**: `{active, completed, guid, name, pts[], idx, prev_lat/lon,
  radius_m, nmea_host/port}`. Idle → active (`/route/activate`) → completed
  (arrival) | deactivated (`/route/deactivate`, route deleted, or DeInit).
- **Leg model**: target is `pts[idx]`; the XTE reference line runs from
  `prev` (ownship position at activation for leg 0, else the previous
  waypoint) to the target.
- **Arrival**: inside `radius_m` (default 60, parameter) → advance; a `while`
  loop so overlapping circles skip multiple marks in one tick. Past the last
  point → log, stop the timer, mark `completed`, **stop emitting** — the
  downstream chain releases via staleness (skiff nulls guidance >15 s and
  frees the helm).
- **Live route re-read**: every tick re-fetches the route by GUID and rebuilds
  `pts` — a human dragging/adding/deleting waypoints in the GUI redirects the
  boat within a second. If the route is deleted, the follower stops. CAVEAT:
  edits bypass any pre-activation land check (`opencpn/mcp/tools/check-route.js`);
  whoever drags owns the grounding risk.
- **`start_leg`** (1-based) on activation: resume a passage mid-route without
  the boat doubling back to waypoint 1 (needed after any plugin/OpenCPN
  restart, which wipes follower state — it is deliberately NOT persisted).
- **Cadence**: 1 Hz, matching OpenCPN core's own autopilot output rate, and
  comfortably inside skiff's 15 s staleness window.

## 7. NMEA emission

Composed in the wx TU, sent via `bridge_udp_send` (fire-and-forget datagram,
one per tick carrying all three sentences concatenated):

- `$ECRMB,A,x.xxx,d,FROM,TO,llll.llll,N,yyyyy.yyyy,W,r.rr,b.b,v.v,A|V,A*cs`
  — XTE (NM, clamped 9.99), steer direction, origin/dest names (sanitized:
  `,*$`→`_`, ≤10 chars), dest position (ddmm.mmmm), range NM, bearing °T,
  VMG (SOG·cos(COG−brg)), arrival flag inside the circle.
- `$ECAPB,A,A,x.xxx,d,N,V,V,b.b,T,TO,b.b,T,b.b,T,A*cs`
- `$ECXTE,A,A,x.xxx,d,N,A*cs`
- Checksum: XOR of the body, `*HH\r\n`.
- **Talker `EC`** deliberately matches OpenCPN core's own emissions so the
  downstream parser treats both identically — which is also why the two must
  never run at once (§10).
- XTE sign: cross-track computed by great-circle formula; boat right of track
  → steer `L`, and vice versa.
- Deliberately NOT emitted: RMC/GGA/GLL (position echoes) — and SignalK
  additionally filters them (defense in depth, §9).

## 8. HTTP API (localhost:18082, JSON)

| endpoint | in | out / notes |
|---|---|---|
| `GET /ping` | — | `{plugin, version, api}` — liveness + "is it enabled" probe |
| `GET /ownship` | — | `{lat, lon, sog, cog, hdt, fix_time}`; 404-style error before first fix |
| `POST /view/jump` | `{lat, lon, chart_scale?=50000}` | centers chart; `{jumped:[lat,lon]}` |
| `GET /routes` | — | `[{guid, name}]` (no waypoints — gap, §12) |
| `POST /route` | `{name?, waypoints:[{lat,lon,name?}]≥2, permanent?=true}` | creates in route manager; `{guid, waypoints}`; `permanent:false` = temp, gone on exit |
| `DELETE /route?guid=` | — | `{deleted: bool}` |
| `POST /route/activate` | `{guid, arrival_radius_m?=60, nmea_target?="192.168.68.29:10111", start_leg?=1}` | starts follower; errors: unknown guid, no fix yet |
| `POST /route/deactivate` | — | stops follower (`completed:false`) |
| `GET /route/active` | — | `{active, completed, guid, name, leg, legs_total, next_wp, dist_to_next_m, bearing_to_next}` |

Binding is `127.0.0.1` **only** — no auth exists, localhost IS the auth
boundary. Agents not on this machine relay through one that is, or the
binding gets widened only with an auth story and Kord's sign-off.

## 9. Talking to SignalK — full semantics

The sentences land on the Pi's SignalK UDP provider `opencpn-nav` (port
10111). What happens next, all verified live:

- **Path mapping** (source label `opencpn-nav.EC`): APB →
  `steering.autopilot.target.headingTrue` (rad) +
  `navigation.courseRhumbline.bearingTrackTrue`/`bearingOriginToDestinationTrue`;
  RMB → `navigation.courseRhumbline.crossTrackError` (m, NM→m converted) +
  `.bearingToDestinationTrue` (rad). Note: `courseRhumbline.nextPoint.bearingTrue`
  does NOT exist on server-node 2.28 — don't parse for it.
- **Course API side effect (the important one)**: RMB's destination position
  activates signalk-server's Course API — `navigation.course.calcValues.*`
  (bearingTrue, crossTrackError, distance, VMG, timeToGo, ETA) are then
  **recomputed continuously server-side from the boat's live position**,
  fresher than the 1 Hz sentences. skiff's autopilot consumes this. Also
  `navigation.courseRhumbline.activeRoute.startTime` goes non-null.
- **The orphaned-destination trap**: when the emitter stops (route completed
  / deactivated / OpenCPN closed), the Course API destination PERSISTS and
  calcValues keep updating "fresh" toward a stale target — a staleness check
  on calcValues can never catch it. Live consequences: boat circles a passed
  waypoint or stalls head-to-wind. Mitigations, all deployed: skiff
  self-clears single-target arrivals (DELETEs the course inside 60 m when no
  route sequencing `pointIndex/pointTotal` is present); anyone can
  `DELETE /signalk/v2/api/vessels/self/navigation/course`; multi-leg routes
  carry sequencing so the emitter's advance handles them.
- **Provider sentence filter** (`ignoredSentences`): NORMAL =
  `[RMC,GGA,GLL]` (OpenCPN/bridge may NEVER publish position — skiff is the
  sole position authority; a second source makes ownship jump). STANDDOWN
  adds `[RMB,APB,XTE]` = guidance kill switch for lockouts; MUST be reverted
  (a forgotten standdown presents as "routing mysteriously dead").
- **Downstream (skiff)**: subscribes over its SignalK WebSocket, populates
  `route_guidance` (bearing/XTE/next point), physics loop steers when
  guidance is fresh (<15 s), nulls it when stale. Guidance outranks manual
  helm; the UI shows agent-control state and a Take Helm override.
- Alternative headless path that bypasses NMEA entirely: PUT the Course API
  directly (`course/destination`, `resources/routes` + `course/activeRoute`)
  — that's what the MCP `set_destination`/`set_route` tools do. Caveat: the
  v2 API does NOT auto-advance `activeRoute` waypoints (verified: pointIndex
  stays 0 forever) — which is exactly why the follower/core-emission path
  exists for multi-leg.

## 10. Coexistence with OpenCPN core activation — the one rule

A human right-clicking a route → Activate makes **core** emit the same EC
sentences at 1 Hz through the same UDP output connection. Core activation and
the bridge follower are therefore mutually exclusive: **never both at once**
(two EC talkers fight over the course; DELETE won't stick; the boat obeys
whoever spoke last). The follower doesn't currently detect GUI activation —
operational discipline plus the standdown filter are the guards (§12 for the
proper fix). Core activation notes: it targets waypoint 1 regardless of boat
position, auto-deactivates on final arrival (then orphans the destination —
§9), and its GoTo ("navigate to here") is a single-target variant with the
same ending.

## 11. Debugging playbook

- OpenCPN log: `C:\ProgramData\opencpn\opencpn.log` — plugin candidate/
  compat/load lines, our `ocpn_bridge_pi:` messages (bridge start, leg
  advances, route-deleted stop).
- Crashes: `C:\ProgramData\opencpn\CrashReports\<uuid>\crashrpt.xml` —
  `<ExceptionModule>` is the fastest signal: `msvcp140.dll` → runtime/mutex
  ABI (§3); `opencpn.exe` during route ops → ownership contract (§5);
  our DLL → our bug.
- Crash AFTER a route successfully appears = destructor-path bug, not the
  API call.
- Bridge liveness: `/ping` fails ⇒ OpenCPN down, plugin not enabled, or Init
  crashed — check the log for which.
- Smoke-test the MCP layer without a client: pipe JSON-RPC lines
  (`initialize`, `notifications/initialized`, `tools/call`) into
  `node server.js`; note the server dispatches concurrently, so piped calls
  can complete out of order (real MCP clients serialize).

## 12. Known gaps / future work (priority order)

1. **GUI-activation detection**: subscribe to core's plugin messages
   (`OCPN_RTE_ACTIVATED`/`DEACTIVATED`/`WPT_ARRIVED` JSON via
   `SetPluginMessage`) → auto-pause the follower when a human activates,
   expose core route state on `/route/active`, and clear the SignalK course
   on core deactivation (kills the orphan trap at the source).
2. `GET /route/:guid` detail (waypoint coords) — today you can't read back
   what a GUI edit did except by watching the follower's behavior.
3. Follower state persistence across OpenCPN restarts (guid + idx to a file;
   `start_leg` is the manual workaround).
4. Active-leg visual: core draws activated routes highlighted; bridge-followed
   routes look inert on the chart. Cosmetic; possibly solvable with a
   plugin-drawn overlay.
5. Auth + LAN binding option for the bridge (only with a real token scheme).
6. Linux/mac builds via the shipdriver CI template → OpenCPN plugin catalog
   if this ever goes public; also enables the "OpenCPN on the Pi" variant.
7. In-plugin canvas capture endpoint (replace the focus-stealing window
   screenshot fallback entirely).
8. Arrival behavior options: perpendicular-passed detection in addition to
   the circle (matches core), configurable end-of-route action (hold last
   bearing / drop sail / loiter).

## 13. Acceptance test (the one we ran)

1. `/ping` answers after OpenCPN start.
2. `/ownship` tracks the sim.
3. `/view/jump` centers Prickly Bay at 1:50k.
4. Create 3-WP route → visible in GUI + `/routes`; delete works.
5. Activate with 80 m radius → skiff `route_guidance` matches
   `bearing_to_next` to 4+ decimals within seconds; boat converges to the
   line (XTE single-digit meters under track-hold).
6. Legs auto-advance through the passage (watch `/route/active`); completion
   stops emission; skiff releases within 15 s.
7. Drag a waypoint mid-passage in the GUI → boat re-steers within ~1 s.
8. `start_leg` resume after an OpenCPN restart does not double back.
