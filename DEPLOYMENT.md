# Deployment book: skiff sim + SignalK + OpenCPN, from bare hardware

Audience: a clean Claude (or human) instance on the Windows host, starting from
nothing but this folder and a Raspberry Pi. Everything here was executed and
verified live on 2026-07-10/11; the failure modes at the bottom are all real.

The stack, once assembled:

```
Windows host                                Raspberry Pi (192.168.68.29)
────────────                                ────────────────────────────
OpenCPN 5.14 (chart display + human GUI)    skiff        :18081  (Rust sim + MCP + web UI)
  ├─ SignalK input  ← ws ──────────────────  SignalK     :3000   (vessel data hub)
  ├─ NMEA UDP output → :10111 ─────────────►   ├─ provider "opencpn-nav" (UDP 10111 in)
  └─ ocpn_bridge_pi plugin :18082              └─ v2 Course API (route guidance)
opencpn/mcp (agent MCP server, stdio)       skiff ⇄ SignalK: deltas out (ws), guidance in
```

Everything lives in this repo (`skiff/`): the sim, `runbook_pi.md` (redeploys),
`opencpn/bridge/` (OpenCPN plugin), `opencpn/mcp/` (agent MCP server + tools).

Parameterize as needed: Pi IP `192.168.68.29`, hostname alias `skiff-pi`,
SSH key `skiff/id_ed25519_pi`.

---

## Stage 1 — Raspberry Pi: key-only SSH from a flashed SD card

Works headless against a stock Raspberry Pi OS (Bookworm) card. Mount the
card's **boot partition** (FAT32, shows as a drive letter, e.g. `F:`).

1. Copy the PUBLIC key to the boot partition as `id_ed25519_pi.pub`
   (never the private key — it lives in `skiff/` on the host).
2. Copy **`pi-provision/setup.sh`** (in this folder — the exact script that
   provisioned this Pi) onto the boot partition. What it does:
   - creates user `pi` if missing; installs the pubkey to `authorized_keys`
   - sets the shadow field to `*` — NOT `!` (sshd refuses key logins to
     `!`-locked accounts; this is the classic silent failure)
   - drops `/etc/ssh/sshd_config.d/10-key-only.conf` with
     `PasswordAuthentication no` + `KbdInteractiveAuthentication no`
   - writes `/etc/sudoers.d/010_pi-nopasswd` (`pi ALL=(ALL) NOPASSWD: ALL`)
   - `systemctl enable ssh`, deletes any private keys off the partition,
     restores `cmdline.txt`, logs everything to `setup.log` on the partition
3. Back up `cmdline.txt` to `cmdline.normal`, then append to the single line
   of `cmdline.txt`:
   `systemd.run="/bin/bash /boot/firmware/setup.sh" systemd.run_success_action=reboot systemd.unit=kernel-command-line.target`
4. **Gotchas that will burn you**: the script must be LF-only with NO utf-8
   BOM; `cmdline.txt` must stay one line.
5. Boot the Pi. It configures itself, reboots, and key-only SSH works.
   On the host add to `~/.ssh/config` (and `icacls` the private key to the
   current user only):
   ```
   Host skiff-pi
     HostName 192.168.68.29
     User pi
     IdentityFile C:\...\skiff\id_ed25519_pi
     IdentitiesOnly yes
   ```
   Verify: `ssh skiff-pi 'whoami && sudo -n true && echo OK'`
   Debug: plug the card back in and read `setup.log`.

## Stage 2 — Pi toolchain

```bash
ssh skiff-pi 'sudo apt-get update -qq && sudo apt-get install -y -qq build-essential pkg-config git curl'
ssh skiff-pi 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable'
# Node >= 22 if not present (Pi OS desktop images may ship it; else NodeSource):
ssh skiff-pi 'node -v || (curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs)'
```

## Stage 3 — SignalK server on the Pi

```bash
ssh skiff-pi 'sudo npm install -g signalk-server'
ssh skiff-pi 'sudo tee /etc/systemd/system/signalk.service' <<'EOF'
[Unit]
Description=Signal K Server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=pi
Group=pi
Environment=HOME=/home/pi
Environment=NODE_ENV=production
WorkingDirectory=/home/pi/.signalk
ExecStart=/usr/bin/signalk-server
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
```

Write `~/.signalk/settings.json` with the OpenCPN NMEA input provider:

```json
{
  "interfaces": {}, "ssl": false, "mdns": true,
  "pipedProviders": [{
    "id": "opencpn-nav", "enabled": true,
    "pipeElements": [{ "type": "providers/simple", "options": {
      "logging": false, "type": "NMEA0183",
      "subOptions": { "type": "udp", "port": "10111",
        "suppress0183event": false, "validateChecksum": true,
        "sentenceEvent": "nmea0183-opencpn",
        "ignoredSentences": ["RMC", "GGA", "GLL"] }}}]
  }]
}
```

`ignoredSentences` is load-bearing and has exactly TWO valid states:

| state | ignoredSentences | meaning |
|---|---|---|
| **NORMAL** | `["RMC","GGA","GLL"]` | position stays skiff-authoritative; route guidance (RMB/APB/XTE) flows |
| **STANDDOWN** | `["RMC","GGA","GLL","RMB","APB","XTE"]` | emergency: ALL route guidance blocked, boat fully manual |

RMC/GGA/GLL are never removed (OpenCPN's position echo would become a second
position source → ownship jumps). STANDDOWN is for lockouts only — e.g. a GUI
route/GoTo re-arming the course faster than it can be DELETEd — and MUST be
reverted afterward or all routing silently dies (this happened once; a
standdown copy lives at `~/.signalk/settings.json.bak-standdown` on the Pi).
Either change requires `sudo systemctl restart signalk`.

`sudo systemctl enable --now signalk`. Verify: `:3000` web UI up,
`ss -ulnp | grep 10111` listening. Ports: 3000 HTTP/WS, 8375 SignalK-TCP,
10110 NMEA0183 out, 10111 NMEA0183 in (ours).

## Stage 4 — skiff sim on the Pi

Full procedure: **`skiff/runbook_pi.md`** (transfer excludes, detached builds,
verification). Essentials: tar-over-ssh the working tree (EXCLUDE `target/`,
`web/node_modules*`, `web/dist`, `models/`, `*.zip`, `id_ed25519*`, and
**`skiff_boat_state.json`** — shipping that teleports the boat to a dev
machine's checkpoint); `npm install && npm run build` in `web/`;
`cargo build --release --bin skiff`; systemd unit with
`SKIFF_PORT=18081`, `SIGNALK_HOST=localhost:3000`,
`WorkingDirectory=/home/pi/skiff` (serves `web/dist` relatively).

Deploy semantics: **web-only changes need NO restart** (dist served from
disk); binary restarts **resume** boat position from `skiff_boat_state.json`
(checkpointed every 5 s). SignalK deltas go over WebSocket
(`/signalk/v1/stream`) — server-node has no HTTP POST delta endpoint.

Verify: `curl :18081/v1/sim/state` returns JSON;
`curl :3000/signalk/v1/api/vessels/self/navigation/speedThroughWater` shows a
live value within seconds; MCP answers at `POST :18081/mcp`.

## Stage 5 — OpenCPN on the Windows host

(Variant: OpenCPN also runs on the Pi via `apt install opencpn`, but the
bridge plugin below is Windows-built and everything here was verified with
OpenCPN on the host.)

```powershell
winget install --id OpenCPN.OpenCPN -e   # 5.14, lands in Program Files (x86)
```

Config is `C:\ProgramData\opencpn\opencpn.ini` (created on first run; edit
only while OpenCPN is closed — it rewrites the file on exit). Two connections
under `[Settings/NMEADataSource]`, pipe-separated in one `DataConnections=`:

```
DataConnections=1;3;192.168.68.29;3000;2;;0;0;0;0;;0;;0;0;0;0;1;;0;;0;0;|1;1;192.168.68.29;10111;0;;0;1;2;0;;0;;0;0;0;0;1;;0;;0;0;
```

(First = SignalK input, ws to Pi:3000. Second = NMEA0183 **UDP output** to
Pi:10111 — this carries APB/RMB when a route is active.)

Charts: build the OSM MBTiles with
`node opencpn/mcp/tools/build-grenada-mbtiles.js`, output to
`C:\ProgramData\opencpn\charts\`, then add:

```
[ChartDirectories]
ChartDir1=C:\\ProgramData\\opencpn\\charts
```

**Backslashes MUST be doubled** (wxFileConfig escaping — single backslashes
parse to garbage and the dir is silently ignored). If charts don't appear:
delete `C:\ProgramData\opencpn\CHRTLIST.DAT` and restart to force a rescan.
MBTiles require OpenGL enabled (`OpenGL=1`, default on).

## Stage 6 — the bridge plugin (agent control of OpenCPN)

Prebuilt: copy `opencpn/bridge/build/Release/ocpn_bridge_pi.dll` →
`%LOCALAPPDATA%\opencpn\plugins\` (no admin). From source: see
`opencpn/bridge/README.md` (`fetch-deps.ps1` + CMake, VS 2022 Build Tools,
Win32 arch). Enable it (OpenCPN closed):

```
[PlugIns/ocpn_bridge_pi.dll]
bEnabled=1
```

Start OpenCPN; `curl http://127.0.0.1:18082/ping` answers. The plugin's
route-follower emits guidance to the Pi's UDP 10111 (target configurable per
activation). Loopback-only by design.

## Stage 7 — agent access (MCP)

```
claude mcp add skiff  --transport http http://192.168.68.29:18081/mcp
claude mcp add opencpn -- node C:\...\skiff\opencpn\mcp\server.js
```

Zero-install HTTP equivalents for any other agent:
`skiff/plan/mcp_no_install_access.md`. Route-guidance path reference:
`skiff/plan/opencpn_signalk_observations.md`.

## Stage 8 — end-to-end acceptance test

1. `ssh skiff-pi 'systemctl is-active skiff signalk'` → both `active`.
2. OpenCPN shows ownship at the sim's position, moving (status bar SOG).
3. Set a destination:
   `curl -X PUT http://192.168.68.29:3000/signalk/v2/api/vessels/self/navigation/course/destination -H "Content-Type: application/json" -d '{"position":{"latitude":11.985,"longitude":-61.775}}'`
   → skiff's `/v1/sim/state` shows `route_guidance` populated and the boat
   turns to the bearing. DELETE the course; guidance nulls within ~15 s.
4. Bridge round-trip: create a 2-waypoint route via
   `POST 127.0.0.1:18082/route`, `POST /route/activate`, watch
   `GET /route/active` advance legs, boat follows. Deactivate, delete.
5. Land-check any route first: `node opencpn/mcp/tools/check-route.js '<json>'`.

## Failure modes seen in production (check here first)

| symptom | cause / fix |
|---|---|
| SSH refuses key on fresh Pi | account shadow field is `!` (locked) — set `*`; or setup.sh had a BOM/CRLF |
| ownship frozen in OpenCPN, "GNSS fix lost" | OpenCPN's ws to SignalK went zombie after a SignalK restart — restart OpenCPN |
| ownship jumping between positions | two position sources — keep RMC/GGA/GLL in `ignoredSentences`; sim resets/teleports also read as "jumps" |
| boat resets to anchorage on deploy | pre-persistence binary, or `skiff_boat_state.json` clobbered by tar — keep the exclude |
| UI fixes "not showing" after web deploy | skiff serves index.html with no cache headers — hard refresh (Ctrl+Shift+R); real fix: `Cache-Control: no-cache` on index.html |
| boat circles/returns to a passed waypoint, or stalls head-to-wind | orphaned SignalK course destination after the commander stopped — DELETE the course; skiff's self-clearing arrival handles single-target cases |
| OpenCPN routing "does nothing" — course never builds, no guidance ever | leftover STANDDOWN filter: RMB/APB/XTE still in `ignoredSentences` — restore NORMAL state (Stage 3) and restart signalk |
| DELETE course won't stick, keeps re-arming | something still emits RMB ~1 Hz: a GUI-activated route/GoTo in OpenCPN, or the bridge follower — deactivate it; nuclear option = add RMB/APB/XTE to `ignoredSentences` (revert after) |
| two guidance sources fight | never run a GUI-activated route AND the bridge follower at once — both talk `EC` |
| chart dir ignored | single backslashes in `ChartDir1` — double them; delete `CHRTLIST.DAT` to force rescan |
| OpenCPN crashes on plugin route ops | see `opencpn/bridge/README.md` "hard-won build knowledge" (ownership contract, msvcp140 define) |
| keystroke/click/screenshot tools hit the wrong window | Windows blocks focus-steal while the human types — use the bridge endpoints instead; injection is fallback only |
