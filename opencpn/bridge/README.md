# ocpn_bridge_pi

> Full spec — architecture, ABI constraints, follower semantics, SignalK
> integration, debugging playbook: **`skiff/plan/ocpn_bridge_plugin_spec.md`**

Native OpenCPN plugin exposing a localhost HTTP control bridge
(`127.0.0.1:18082`) so agents can drive the chart programmatically:
view jump, route create/list/delete, route **follow** (plugin-side waypoint
sequencing emitting APB/RMB/XTE over UDP to a SignalK server), and ownship
readback. Consumed by the companion `opencpn-mcp` server; endpoint reference
in `skiff/plan/mcp_no_install_access.md`.

Target: OpenCPN 5.14 Windows (Win32/x86, wxWidgets 3.2 vc14x). API level 1.18.

## Build

```powershell
./fetch-deps.ps1     # clones OpenCPN plugin API, downloads wxWidgets 3.2.6 binaries
cmake -B build -G "Visual Studio 17 2022" -A Win32
cmake --build build --config Release
# → build/Release/ocpn_bridge_pi.dll
```

Requires VS 2022 Build Tools (C++), CMake, 7-Zip.

## Install (any OpenCPN 5.14 Windows box)

1. Copy `ocpn_bridge_pi.dll` to `%LOCALAPPDATA%\opencpn\plugins\` (create the
   dir if absent; no admin needed — OpenCPN scans it).
2. With OpenCPN closed, add to `C:\ProgramData\opencpn\opencpn.ini`:
   ```
   [PlugIns/ocpn_bridge_pi.dll]
   bEnabled=1
   ```
   (or enable it in Options → Plugins after first launch)
3. Start OpenCPN. `curl http://127.0.0.1:18082/ping` should answer.

## Hard-won build knowledge (do not relearn these)

- OpenCPN ships an **older msvcp140.dll**; VS2022's constexpr `std::mutex`
  crashes against it → `_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR` is set in
  CMakeLists and must stay.
- `httplib.h` and wxWidgets **cannot share a translation unit** (`ssize_t`
  redefinition) — hence `http_bridge.cpp` (sockets) / `bridge_pi.cpp` (wx).
- `PlugIn_Route_Ex`'s core constructor allocates `pWaypointList` and its
  destructor dereferences it unconditionally: never replace/delete/null the
  list; free only the waypoint *data*. Violating this crashes OpenCPN *after*
  the route is created.
- Route **activation** is not in the plugin API; the follower reimplements
  sequencing (apRoute pattern). When a human activates a route in the GUI,
  OpenCPN core emits the same sentences — never run both at once.
