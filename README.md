# Skiff

**Sim-grade sailing simulator + isochrone weather router** for a **Lagoon 450S** catamaran.

Server-authoritative physics in Rust; a React Three Fiber browser client for visualization, helm, and (optionally) cloth-sail force feedback. The boat is designed to sail headless — the browser is a viewer and input device, not a physics authority.

| | |
|---|---|
| **License** | MIT |
| **Rust edition** | 2024 |
| **Default API / UI port** | `18081` (`SKIFF_PORT`) |
| **Frontend package** | `web/` — Vite + React 19 + R3F + Three.js + Zustand |

---

## Table of contents

1. [What it does](#what-it-does)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Prerequisites](#prerequisites)
5. [Quick start](#quick-start)
6. [Development workflow](#development-workflow)
7. [HTTP API](#http-api)
8. [CLI (`skiff-cli`)](#cli-skiff-cli)
9. [Environment variables](#environment-variables)
10. [Frontend controls](#frontend-controls)
11. [Physics & coordinate conventions](#physics--coordinate-conventions)
12. [Sails: coefficient vs cloth](#sails-coefficient-vs-cloth)
13. [Validation & monitoring](#validation--monitoring)
14. [Planning docs (`plan/`)](#planning-docs-plan)
15. [Known defects (D1–D8)](#known-defects-d1d8)
16. [Work packages](#work-packages)
17. [License](#license)

---

## What it does

- **6-DOF catamaran dynamics** (`src/cat_physics.rs`) — surge, sway, heave, roll, pitch, yaw with skegs, rudders, engines, sail foil, stability states (upright / knockdown / capsized), and bridgedeck slam warning.
- **Real-time sim server** (`cargo run --bin skiff`) — ~20 Hz physics loop, axum HTTP API, static serve of the built web client, optional Signal K streaming and Meridian / NUTS metocean providers.
- **3D cockpit** (`web/`) — Lagoon 450S GLB model, water, vectors, trail, HUD, controls panel, keyboard helm, Verlet **headsail cloth** (`SpinnakerSail.tsx`).
- **Isochrone weather routing** (`src/route/`) and polar / cast-off boat profiles (`src/boat/`) via the library and `skiff-cli`.
- **Environment field** sampling — constant test fields, HTTP providers, caching/interpolation (`src/env/`).

---

## Architecture

```
Blender (geometry source of truth)
   │  GLB: web/public/lagoon-450s.glb  (+ optional sail meshes)
   ▼
web/  (React 19 + react-three-fiber, Vite)         src/  (Rust, axum)
  SimulatorScene ──POST /v1/sim/control──────────►  main.rs physics loop
  SpinnakerSail  ──POST /v1/sim/sail_wrench──────►  cat_physics::cat_forces
  (cloth, visual)◄─GET  /v1/sim/state (poll)─────   env providers / Signal K
```

**Rule of authority**

| Concern | Owner |
|---|---|
| Boat pose, velocity, stability, environment integration | Rust server |
| Helm, trim, reef, thrust, env overrides (UI) | Browser → `POST /v1/sim/control` / environment |
| Visual sail shape | Browser cloth sim |
| Sail force on the hull | Coefficient sail on server **or** fresh cloth wrench if browser posts within ~500 ms; otherwise decay back to coefficients |

Production path: build the frontend into `web/dist`, run `skiff`, open `http://localhost:18081/`.

Authoritative design notes: [`plan/overarching_architecture.md`](plan/overarching_architecture.md).

---

## Repository layout

```
skiff/
├── Cargo.toml              # workspace package: lib + bins skiff, skiff-cli
├── src/
│   ├── main.rs             # sim HTTP server, physics tick, Signal K
│   ├── cli.rs              # skiff-cli: route + profile-test
│   ├── lib.rs              # library crate root
│   ├── cat_physics.rs      # Lagoon 450S 6-DOF forces & integration
│   ├── signalk.rs          # Signal K client / deltas
│   ├── dto.rs              # shared DTO helpers
│   ├── boat/               # polar, cast-off profile, leeway, wave penalty
│   ├── core/               # geo, units, time, Vec2, errors
│   ├── env/                # metocean providers, cache, interpolation
│   ├── route/              # isochrone router
│   └── sim/                # headless step integrator / boat state
├── web/
│   ├── package.json        # 3d-boat-simulator (private)
│   ├── vite.config.ts      # dev proxy → :18081 for /v1 and /healthz
│   ├── monitor_sim.py      # terminal dashboard against /v1/sim/state
│   ├── public/             # lagoon-450s.glb, manifest, textures
│   └── src/
│       ├── App.tsx
│       ├── components/     # scene, boat, sail, HUD, controls, water…
│       └── sim/            # zustand store, types, env fetch helpers
└── plan/                   # multi-agent contract (see Planning docs)
    ├── overarching_architecture.md   # authoritative conventions, D1–D8, WPs
    ├── fixingthesim_implementation.md
    ├── fixingthesim.md.txt           # original system review
    └── sail-force-rig.html           # standalone force-extraction prototype
```

---

## Prerequisites

- **Rust** toolchain (edition 2024 — recent stable `rustc` / `cargo`)
- **Node.js** 18+ and npm (for `web/`)
- Optional: Signal K server, Meridian/NUTS credentials for live weather

---

## Quick start

### 1. Build the web client

```bash
cd web
npm install
npm run build          # tsc -b && vite build → web/dist
cd ..
```

### 2. Run the sim server

```bash
cargo run --bin skiff
# listens on 0.0.0.0:18081 (override with SKIFF_PORT)
```

Open **http://localhost:18081/** for the 3D simulator. Health check: **http://localhost:18081/healthz** → `ok`.

### 3. (Dev) Hot-reload frontend against the server

Terminal A:

```bash
cargo run --bin skiff
```

Terminal B:

```bash
cd web && npm run dev   # Vite on :5173, proxies /v1 → :18081
```

Open **http://localhost:5173/**. Control and state still hit the Rust process.

---

## Development workflow

| Task | Command |
|---|---|
| Library / physics tests | `cargo test` |
| Typecheck web | `cd web && npx tsc -b` |
| Production web bundle | `cd web && npm run build` |
| Serve built UI | `cargo run --bin skiff` (serves `web/dist` or `skiff/web/dist`) |
| Headless state monitor | `python web/monitor_sim.py` (reads `SKIFF_PORT`) |
| CLI routing | `cargo run --bin skiff-cli -- route --help` |

**After visual/frontend changes that you want on `:18081`:** rebuild `web` (`npm run build` → `web/dist`). `tower-http` `ServeDir` reads static files from disk **per request**, so a rebuilt `web/dist` is picked up **without** restarting the skiff process. Restart is only needed when the **Rust binary** changes.

---

## HTTP API

Base URL: `http://localhost:${SKIFF_PORT:-18081}`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness (`ok`) |
| `GET` | `/v1/sim/state` | Full sim snapshot (pose, env, control, trail, stability, cat state) |
| `POST` | `/v1/sim/control` | Set helm, sail_trim, reef, thrust_port, thrust_stbd |
| `POST` | `/v1/sim/environment` | Manual wind / current / waves; sets `manual_env_override` |
| `POST` | `/v1/sim/position` | Teleport lat/lon |
| `POST` | `/v1/sim/reset` | Reset sim |
| `POST` | `/v1/sim/sail_wrench` | Cloth-derived body force/torque (freshness + blend back to coefficients) |
| `*` | fallback | Static files from `web/dist` |

### Control body (JSON)

```json
{
  "helm": 0.0,
  "sail_trim": 1.0,
  "reef": 0.0,
  "thrust_port": 0.0,
  "thrust_stbd": 0.0
}
```

- `helm`: −1 port … +1 starboard  
- `sail_trim` / `reef`: 0…1  
- thrust: roughly −3000…+3000 N per engine  

### Environment body (JSON)

```json
{
  "wind_speed_mps": 5.0,
  "wind_to_deg": 150.0,
  "current_speed_mps": 0.55,
  "current_to_deg": 85.0,
  "wave_height_m": 0.0,
  "wave_period_s": 7.0,
  "wave_to_deg": 290.0
}
```

Wind/current directions are **to**-direction (direction the flow goes), not meteorological “from”.

### Sail wrench body (JSON)

```json
{
  "seq": 123,
  "f_body": [fx, fy, fz],
  "tau_body": [tx, ty, tz]
}
```

Body frame: **+X forward, +Y starboard, +Z down**. Server uses a wrench younger than ~0.5 s; older values blend out over ~1 s toward the coefficient sail model.

CORS is open for GET/POST (local multi-origin dev).

---

## CLI (`skiff-cli`)

Binary entry: `src/cli.rs` (`cargo run --bin skiff-cli -- <subcommand>`).

### `route`

Isochrone weather route between lat/lon points.

```bash
cargo run --bin skiff-cli -- route \
  --origin "25.0,-80.0" \
  --dest "25.5,-79.5" \
  --depart 2026-07-01T12:00:00Z \
  --profile castoff-compatible \
  --step 900 \
  --horizon 72h \
  --out route.json
```

### `profile-test`

Predict boat performance for a wind/current/wave sample.

```bash
cargo run --bin skiff-cli -- profile-test \
  --profile castoff-compatible \
  --wind 10kt \
  --current 0kt@0 \
  --waves 1.0m@7s@90
```

---

## Environment variables

| Variable | Default | Role |
|---|---|---|
| `SKIFF_PORT` | `18081` | HTTP bind port |
| `SIGNALK_HOST` | unset | If set, stream deltas to Signal K |
| `SIGNALK_TOKEN` | unset | Auth for Signal K |
| `MERIDIAN_URL` | `https://meridian.deepbluedynamics.com` | Metocean API base |
| `MERIDIAN_CLIENT_ID` / `MERIDIAN_CLIENT_SECRET` | unset | Meridian OAuth |
| `NUTS_AUTH_URL` | `https://auth.nuts.services/auth` | NUTS auth endpoint |
| `RUST_LOG` | (tracing default) | e.g. `info`, `skiff=debug` |

---

## Frontend controls

### Keyboard

| Key | Action |
|---|---|
| `A` / `←` | Helm port |
| `D` / `→` | Helm starboard |
| `W` / `S` | Trim in / out |
| `Q` / `E` | Reef in / out |
| `R` | Reset boat |
| `C` | Toggle current visualization |
| `,` / `.` | Decrease / increase wind speed (simulated) |

### UI (Controls panel)

- Wind, current, waves (simulated data source or overrides)
- Sail trim / reef, drop mainsail
- Spinnaker cloth param (Edge Tension rest-length scale)
- Engines (port/stbd thrust)
- GPS position set, cast-off mode, debug rig points, vectors

State lives in Zustand (`web/src/sim/store.ts`); the scene posts control/environment to the server and polls `/v1/sim/state`.

### 3D assets

- `web/public/lagoon-450s.glb` — hull + rig  
- `web/public/sail-jib.glb` — asymmetric jib mesh from Blender; loaded by `SpinnakerSail.tsx` as the cloth rest shape  
- `web/public/lagoon-450s.manifest.json` — component / locator names (sail.jib, ce.jib, masthead, etc.)  
- Water textures under `web/public/textures/`

---

## Physics & coordinate conventions

These conventions are load-bearing. Breaking them flips force signs and “sails the boat backwards.” **Authoritative source:** [`plan/overarching_architecture.md`](plan/overarching_architecture.md) §2.

### Coordinate frames

| Frame | Axes | Where |
|---|---|---|
| **Body (backend)** | +X forward, +Y starboard, +Z down (NED-ish). Euler φ heel, θ pitch, ψ yaw | `cat_physics.rs` `eta` / `nu` |
| **Sail / glTF (frontend)** | +X starboard, +Y up, +Z toward bow (tack ring ≈ z +7.32) | raw GLB; `SpinnakerSail` |
| **Scene (three.js)** | Boat group `rotation=[pitch, -heading, heel]`; GLB + sail inside extra `rotation=[0, π, 0]` wrapper | `BoatModel.tsx` |

**Frame map (sail/glTF → body)** — forces and torques alike:

```text
v_body = [ v_gltf.z,  v_gltf.x,  -v_gltf.y ]
```

Required unit test: pure `+z_gltf` force → positive surge (`tau[0] > 0`).

**Backend quirks (self-consistent — do not “fix” silently):**

- `heading_true_deg = (−ψ) · 180/π mod 360`
- `cog = atan2(−E, N)`

### Wind conventions

- Fields named `*_to_*` point **toward** where the flow goes (`Vec2Mps::from_speed_to_deg`).
- Meteorological sources (e.g. Open-Meteo `wind_direction_10m`) report **from**-direction: convert at ingestion (`from = to ± 180°`); prefer field names like `wind_from_deg` at the ingestion boundary.
- **Apparent vs true is a type distinction:** `aws_mps` / `awa_deg` vs `tws_mps` / `twa_deg`.
  - Signal K apparent → `environment.wind.speedApparent` / `angleApparent` (boat-relative rad)
  - Signal K true → `speedTrue` + `directionTrue` (true-north **from** direction, rad)
- Sails consume **apparent** wind (including ω×r at attachment height). Hydro foils use through-water velocity (−ν). Air foils use wind minus **ground** velocity.

### Units & constants

- SI internally (m, s, kg, N, rad); knots/degrees only at UI/serialization edges (`src/core/units.rs`).
- Air ρ = 1.225 kg/m³, water ρ = 1025 kg/m³.
- Aerodynamic pressure should be explicit `0.5 * 1.225 * v² * C` — no baked gain fudge factors (retire `WIND_GAIN` per plan).

---

## Sails: coefficient vs cloth

### Two models, one truth

| Path | Where | Role |
|---|---|---|
| **Coefficient sail** | `cat_forces` / `foil_force_2d` at CE | Always on; headless; baseline polar |
| **Cloth sail** | `SpinnakerSail.tsx` Verlet + projection | Visual + optional wrench override |
| **Decay** | `main.rs` (~500 ms fresh, ~1 s blend) | Browser gone → coefficient; never freeze stale wrench; never zero force |

### Target attachment scheme (owner decision)

From [`plan/fixingthesim_implementation.md`](plan/fixingthesim_implementation.md) / architecture §2.4:

| Corner | Target behavior |
|---|---|
| **Head** | Pinned at rest position (halyard) |
| **Tack** | Pinned **directly** to bowsprit ring (`Object.541`), interim glTF `(-0.041, 2.028, 7.321)` — **no tack rope** |
| **Clew** | Free-flying — **no clew rope**, no rendered sheet lines |

Rationale: the mesh rest tack already sits on the ring (~3 mm); a 25-node rope collapses and destabilizes. Long-term, anchors come from **named Blender empties**, not hardcoded vectors.

### Cloth → boat wrench (do not use pin reactions)

PBD has no Lagrange multipliers to read. Sum triangle aero forces instead:

```text
f_tri  = n̂ · (n̂ · f_wind) · A_tri          # total force, not /3 per vertex for the wrench
τ_tri  = (centroid − r_ref) × f_tri
f_aero = Σ f_tri
τ_aero = Σ τ_tri
```

Low-pass (substep average + few-Hz filter), map through the frame transform, then:

```json
{ "seq": 123, "f_body": [fx, fy, fz], "tau_body": [tx, ty, tz] }
```

`POST /v1/sim/sail_wrench` — server uses wrench while fresher than ~500 ms, else blends back to coefficients over ~1 s.

### Coefficient sail (backend skeleton)

Pieces exist in `cat_physics` / `main` telemetry; target integration sketch:

```rust
// apparent wind at CE (ground-relative air velocity)
let h = -p.sail.r[2];
let v_ce = [ground_lin[0] - omega[1] * h, ground_lin[1] + omega[0] * h];
let inflow = [wind_body[0] - v_ce[0], wind_body[1] - v_ce[1]];
let boom = /* sheet from ctrl.sail_trim; leeward sign; weathervane clamp */;
let f = foil_force_2d(inflow, [boom.cos(), boom.sin()], &p.sail, 1.225);
let f_tau = apply_at(f, p.sail.r);
// also feeds m_heel / m_pitch for moment-based stability
```

Also planned: hull/rig **windage** (flat-plate drag), reef as area scale, optional `flat` CL multiplier.

### Trim unification

One value: `control.sail_trim` (0–1) drives **both** backend sheet angle (placeholder 0–15°) and any future visual sheet rest length. Separate UI sliders that shadow “trim” with unrelated knobs are defects.

### Multi-sail end state (sails as data)

- Blender: named empties/vertex groups — `head` / `tack` / `clew` per sail; anchors `ring.tack`, sheet leads; `ce.<sail>` (e.g. `ce.jib` already in manifest).
- Per-sail config (JSON/TOML): GLB path, corner/anchor names, coefficient-set id, control bindings.
- One cloth instance per active sail; **name lookup**, not highest/nearest/farthest heuristics.
- Backend `CatParams.sails: Vec<Foil>` for helm balance (per-sail yaw moments).

### Cloth solver notes (from system review)

- Jakobsen-style Verlet + projection; Blender mesh as rest shape (weld seams → particles, edges → springs).
- Force clamp `MASS*40` saturates ~5 kt apparent — **must go** (stabilize with substeps/ITER, not load clamps). Keep `MAX_VEL` as explosion guard only.
- Timestep must use `useFrame` **delta** + fixed-step accumulator (not hardcoded 60 Hz) so 144 Hz monitors don’t run 2.4× fast.
- Gravity must be world-down rotated by heel/pitch, not boat-local −Y.
- Per-line tension readouts need XPBD later; spring elongation in PBD is iteration-dependent.

---

## Validation & monitoring

```bash
# Automated
cargo test
cd web && npx tsc -b

# Live telemetry dashboard (stability, slam, speeds, attitude)
python web/monitor_sim.py

# Polar / profile sanity via CLI
cargo run --bin skiff-cli -- profile-test --wind 12kt
```

### Release gate (architecture §6)

1. `cargo test` green (rotation, frame-map, wind-convention tests).
2. **Headless:** server alone; boat beam-reaches under coefficient sail; moment-based knockdown reachable under forced overload (`monitor_sim.py`).
3. **Browser:** cloth sane 0–30 kt; drives boat via wrench; HUD correct AWA/AWS + TWA/TWS.
4. **Kill browser:** boat keeps sailing (decay path), no state jump.
5. Polar sweep report exists and roughly tracks 450S table shape (calibration later).
6. Signal K consumer shows correct paths/conventions.

**Validation target for physics:** steady-state polar sweeps should reproduce `PolarProfile` tables in `src/boat/polar.rs` (used by the isochrone router).

---

## Planning docs (`plan/`)

The `plan/` directory is the multi-agent contract for this repo. **If plan and code disagree, either the code is wrong or the plan must be amended in the same change.**

| Document | Status / role |
|---|---|
| [`plan/overarching_architecture.md`](plan/overarching_architecture.md) | **Authoritative.** Conventions (§2), defects D1–D8 (§3), target architecture (§4), work packages (§5), validation gate (§6). Synthesizes the two docs below; where they conflict, the **implementation** doc wins. |
| [`plan/fixingthesim_implementation.md`](plan/fixingthesim_implementation.md) | Owner-approved **how**: attachment refinement (pin tack, free clew, drop ropes), wrench sum math, frame map, `POST /v1/sim/sail_wrench` + staleness, rotation matrix fix, Open-Meteo/telemetry renames, force coupling into `tau`. |
| [`plan/fixingthesim.md.txt`](plan/fixingthesim.md.txt) | Original **system review** (why): Fossen 6-DOF / foil notes, rotation-matrix typo with heel mask, wind 180° bug, AWA misnamed as TWA, cloth clamp/timestep analysis, “sum wrench not pins”, wire coefficient sail first, multi-sail data model, smaller nits (dead `stepBoat`, leeway vectors, weld hash, terminal capsize, heavy `DRAG`). |
| [`plan/sail-force-rig.html`](plan/sail-force-rig.html) | Standalone browser prototype: **fixed rig · swept wind · extracted wrench**. Open the file directly in a browser (no build). UI for wind speed/direction, direction sweep, gusts, sheet/tack/fullness, force readouts, attachment bars (halyard/tack/sheet/luff), polar view, CSV export. Useful for tuning force extraction independent of the full sim. |

### Document precedence

```text
overarching_architecture.md  ← daily source of truth for agents
        ↑ synthesizes
fixingthesim_implementation.md  (newer, owner-approved decisions)
fixingthesim.md.txt             (review narrative / rationale)
sail-force-rig.html              (interactive experiment, not product UI)
```

### Agent / contributor rules (from architecture §5)

- **Rust:** `cargo test` and `cargo run --bin skiff` must start clean after a WP.
- **Web:** `cd web && npx tsc -b` must pass.
- Visual changes: `npm run build` → new assets under `web/dist` are served immediately (`ServeDir` per-request). Restart skiff only when the Rust binary itself must change.
- Repo is under git ([DeepBlueDynamics/skiff](https://github.com/DeepBlueDynamics/skiff), branch `main`). `git status` / `git diff` work; **commits happen at integration points by the orchestrator** — agents should not commit unless asked.
- Do not touch `web/src/sim/boatPhysics.ts` except cleanup WP-D7 (`stepBoat` delete).
- If you change a contract (frames, wind naming, attachment), update architecture §2 / §3 in the same change.

### Transport roadmap

Two HTTP round-trips per frame (control POST + state GET) are acceptable on localhost today. Next: fold control+state into one POST; eventual WebSocket once forces flow. Not a current work package.

---

## Known defects (D1–D8)

Tracked in [`plan/overarching_architecture.md`](plan/overarching_architecture.md) §3. Fix these before/while building on top.

| ID | Defect | Where | Fix |
|---|---|---|---|
| **D1** | Rotation matrix element (2,3) typo: uses `cphi*sphi` instead of `cpsi*sphi`. Masked at heel≈0; corrupts body↔world transforms once sails produce heel | `cat_physics.rs` `rotation_body_to_world` row 2 | Correct term + tests `R·Rᵀ=I` and round-trip at φ=20°, θ=5°, ψ=137° |
| **D2** | Open-Meteo `wind_direction_10m` (FROM) assigned into TO-convention field → real-weather wind 180° reversed | frontend `fetchRealTimeData` (`SimulatorScene`) | Convert at ingestion per wind conventions |
| **D3** | Apparent wind stored/published as true (`tws_mps`/`twa_deg`); Signal K `directionTrue` gets boat-relative apparent angle | `main.rs` telemetry + `signalk.rs` + HUD | Rename fields; publish AWA/AWS and TWA/TWS correctly |
| **D4** | Cloth per-particle force clamp `MASS*40` saturates above ~5 kt apparent — shape and extracted force stop scaling with wind | `SpinnakerSail.tsx` | Remove force clamp; more substeps/iterations if needed; keep `MAX_VEL` only |
| **D5** | Cloth timestep hardcoded to 60 Hz display (`H=(1/60)/8` in `useFrame`) → 2.4× fast on 144 Hz monitors | `SpinnakerSail.tsx` | Fixed-step accumulator from `useFrame` delta, clamped |
| **D6** | Sail gravity along boat-local −Y; tilts with heel/pitch | `SpinnakerSail.tsx` | Rotate world-down into boat frame using `heelDeg`/`pitchDeg` |
| **D7** | `web/src/sim/boatPhysics.ts` `stepBoat` is dead code inviting divergent client physics | frontend | Delete `stepBoat` (keep `createInitialBoatState` if still referenced) |
| **D8** | `velocityWater` reconstructed without `leeway_deg` → vectors overlay draws leeway-free track | `SimulatorScene` | Include leeway in reconstruction |

**Smaller / fix-on-contact** (from review + architecture):

- `ROPE_SLACK` becomes dead after ropes removed / first frame overwrite by sliders
- Spatial-hash weld can miss epsilon pairs across cell boundaries — probe neighbors
- Capsized states are **terminal** by design in `update_stability` — document, don’t “fix” without a righting model
- `DRAG=0.994` per substep is heavy (~5.6% velocity retained per second at 480 substeps/s) — revisit when flogging dynamics matter

---

## Work packages

Priority: **A1 → A2 → A3 → B1 → B2**, then C1 / D / E. A1+A2 transform the system into a boat that actually sails; everything after refines it.

| WP | Scope | Primary files | Depends | Done when |
|---|---|---|---|---|
| **A1** | Fix D1 rotation matrix + frame unit tests (R·Rᵀ=I, round-trip, §2.1 surge scaffold) | `cat_physics.rs` | — | `cargo test` green with new tests |
| **A2** | Coefficient sail in `cat_forces` + windage + stability moments live | `cat_physics.rs`, `main.rs` | A1 | Headless: `/v1/sim/state` nonzero `stw`; heel responds to trim/reef; `monitor_sim.py` can show knockdown when overpowered |
| **A3** | Wind conventions + naming: D2, D3 (fields, Signal K, HUD) | `main.rs`, `signalk.rs`, SimulatorScene, Hud | — | AWA/AWS vs TWA/TWS end-to-end; Signal K paths correct |
| **B1** | Cloth: attachment §2.4, D4 clamp removal, D5 fixed timestep, D6 gravity, slider cleanup | `SpinnakerSail.tsx`, store/types, ControlsPanel | — | Sail stable 0–30 kt; no ropes rendered; shape scales with wind; same behavior at 60/144 Hz |
| **B2** | Wrench extraction + filter + frame map + `POST /v1/sim/sail_wrench`; backend staleness decay; explicit `0.5ρv²` | `SpinnakerSail.tsx`, `main.rs` | A2, B1 | Browser open → cloth drives boat; browser closed → decays to coefficient within ~1 s; surge unit test passes |
| **C1** | Polar validation harness: sweep TWA/TWS to steady state headlessly vs `PolarProfile` | new `src/bin/` or tests | A2 | Polar plot/table diff; gross deviations flagged |
| **D** | Cleanups: D7, D8, neighbor-cell weld, terminal-capsize comments | frontend | — | `tsc` green; vectors overlay shows leeway |
| **E** | Sails-as-data: Blender named empties, per-sail config, name-based corners, `Vec<Foil>` backend | Blender + both sides | A2, B1 | Second sail (main) instantiable from config without code changes |

Implementation sequence for the cloth/wrench track is expanded in [`plan/fixingthesim_implementation.md`](plan/fixingthesim_implementation.md) §§1–5 (attachments → wrench sum → frame map → endpoint → physics integration).

---

## License

MIT — see `Cargo.toml` package metadata.
