# Skiff → Raspberry Pi deploy runbook

Deploys the skiff sim server (Rust/axum + built web client) to the Pi at
`192.168.68.29` and wires its Signal K delta stream into the Signal K server
already running there. Written to be followed by an agent on the Windows
workstation; every command is copy-pasteable from Git Bash.

## Facts / invariants

| Thing | Value |
|---|---|
| Pi host | `192.168.68.29`, hostname `raspberrypi`, Pi 5 (aarch64), Debian 12 Bookworm |
| SSH | `ssh skiff-pi` — Host entry in `~/.ssh/config`, key `skiff/id_ed25519_pi`, user `pi`, key-only auth, NOPASSWD sudo |
| Deploy dir on Pi | `/home/pi/skiff` |
| Skiff service | `skiff.service`, port `18081`, binds `0.0.0.0` |
| Signal K | `signalk.service`, already enabled; UI/REST `:3000`, TCP `:8375`, NMEA0183 `:10110` |
| Skiff → Signal K | `SIGNALK_HOST=http://127.0.0.1:3000` env var; skiff streams deltas over WebSocket to `/signalk/v1/stream?subscribe=none` (HTTP POST to `/signalk/v1/api/` does **not** exist in signalk-server — returns 404) |
| Pi toolchain | Node v24 preinstalled; Rust installed via rustup (step 1) |

Source of truth is the **local working tree** at
`C:\Users\kordl\Code\DeepBlueDynamics\skiff` (tar-over-ssh, no GitHub deploy
key on the Pi). The web client is built **on the Pi** (the npm lockfile is
Windows-pinned — use `npm install`, never `npm ci`, per the Dockerfile note).

## 1. One-time Pi provisioning

Skip if `ssh skiff-pi 'cargo --version'` already works.

```bash
ssh skiff-pi 'sudo apt-get update -qq && sudo apt-get install -y -qq build-essential pkg-config git curl'
ssh skiff-pi 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable'
ssh skiff-pi '. ~/.cargo/env && cargo --version'   # expect: cargo 1.8x+
```

## 2. Ship the source

Run from the skiff repo root on the workstation. Excludes build outputs,
node_modules, the 128 MB Blender `models/`, zips, and — **do not remove these
excludes** — the SSH keys that live in the repo root.

```bash
cd /c/Users/kordl/Code/DeepBlueDynamics/skiff
ssh skiff-pi 'mkdir -p ~/skiff'
tar czf - \
  --exclude=./target --exclude=./.git \
  --exclude=./web/node_modules --exclude=./web/node_modules.broken-optional \
  --exclude=./web/dist \
  --exclude=./models --exclude=./media --exclude=./reports \
  --exclude='./*.zip' \
  --exclude='./id_ed25519*' \
  . | ssh skiff-pi 'tar xzf - -C ~/skiff'
```

~92 MB (dominated by `web/public/*.glb`); under a minute on LAN.

## 3. Build on the Pi

```bash
ssh skiff-pi 'cd ~/skiff/web && npm install --no-audit --no-fund && npm run build'
# Detached build: survives a dropped ssh session. Poll build.done for the result.
ssh skiff-pi 'cd ~/skiff && . ~/.cargo/env && rm -f build.done && (nohup bash -c "cargo build --release --bin skiff > build.log 2>&1; echo exit=\$? > build.done" >/dev/null 2>&1 &)'
ssh skiff-pi 'until [ -f ~/skiff/build.done ]; do sleep 5; done; cat ~/skiff/build.done; tail -3 ~/skiff/build.log'
```

Clean release build is ~2.5 min on the Pi 5 (measured); incremental rebuilds
faster. Success = `exit=0` in `build.done`, `web/dist/index.html` exists, and
`target/release/skiff` exists.

## 4. Install the systemd service

```bash
ssh skiff-pi 'sudo tee /etc/systemd/system/skiff.service > /dev/null' <<'EOF'
[Unit]
Description=Skiff sailing sim server
After=network-online.target signalk.service
Wants=network-online.target

[Service]
Type=simple
User=pi
Group=pi
WorkingDirectory=/home/pi/skiff
ExecStart=/home/pi/skiff/target/release/skiff
Environment=SKIFF_PORT=18081
Environment=SIGNALK_HOST=http://127.0.0.1:3000
Environment=RUST_LOG=info
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
ssh skiff-pi 'sudo systemctl daemon-reload && sudo systemctl enable --now skiff'
```

`WorkingDirectory` matters: the server serves static files from the relative
path `web/dist`.

## 5. Verify

```bash
# service up
ssh skiff-pi 'systemctl is-active skiff'                      # → active
# API answers (from workstation, over LAN)
curl -s http://192.168.68.29:18081/v1/sim/state | head -c 300 # → JSON sim state
# web UI: open http://192.168.68.29:18081 in a browser
# Signal K is receiving skiff deltas:
curl -s http://192.168.68.29:3000/signalk/v1/api/vessels/self | head -c 500
# → should contain navigation/environment paths sourced from skiff
# no delta errors in the log:
ssh skiff-pi 'journalctl -u skiff -n 30 --no-pager'
```

## 6. Redeploy (code change)

```bash
cd /c/Users/kordl/Code/DeepBlueDynamics/skiff
tar czf - --exclude=./target --exclude=./.git \
  --exclude=./web/node_modules --exclude=./web/node_modules.broken-optional \
  --exclude=./web/dist --exclude=./models --exclude=./media \
  --exclude=./reports --exclude='./*.zip' --exclude='./id_ed25519*' \
  . | ssh skiff-pi 'tar xzf - -C ~/skiff'
ssh skiff-pi '. ~/.cargo/env && cd ~/skiff && cargo build --release --bin skiff'
# only if web/ changed:
ssh skiff-pi 'cd ~/skiff/web && npm install --no-audit --no-fund && npm run build'
ssh skiff-pi 'sudo systemctl restart skiff && systemctl is-active skiff'
```

## Troubleshooting

- **Service fails to start** → `ssh skiff-pi 'journalctl -u skiff -n 50 --no-pager'`.
  Port already taken: check `ss -tlnp | grep 18081`.
- **`404 Cannot POST /signalk/v1/api/` in the skiff log** → the binary predates
  the WebSocket Signal K client (old code POSTed to a nonexistent endpoint).
  Re-ship and rebuild (§6); `src/signalk.rs` must be the tokio-tungstenite
  version.
- **Signal K rejects deltas (401/403)** in the skiff log → Signal K security is
  enabled. Create an access token in the Signal K admin UI
  (`http://192.168.68.29:3000` → Security → Access Requests / Tokens) and add
  `Environment=SIGNALK_TOKEN=<token>` to the unit, then
  `sudo systemctl daemon-reload && sudo systemctl restart skiff`.
- **UI loads but no boat model** → `web/dist` missing the GLBs; rerun the web
  build (step 3) and confirm `~/skiff/web/public/lagoon-450s.glb` shipped.
- **`npm ci` EBADPLATFORM** → you used `npm ci`; the lockfile pins a Windows
  rollup binary. Use `npm install`.
- **Out-of-date sim after redeploy** → browsers cache aggressively;
  hard-reload (Ctrl+Shift+R).
