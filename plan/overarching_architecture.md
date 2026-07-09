# Skiff — Overarching Architecture

**Status:** authoritative. If this document disagrees with code, the code is wrong or this file must be amended in the same change.
**Sources:** synthesizes `plan/fixingthesim.md.txt` (system review) and `plan/fixingthesim_implementation.md` (attachment + wrench plan). Where they conflict, the implementation doc's decisions win (they are newer and owner-approved).
**Audience:** any agent (Grok / Antigravity / Codex / Claude) picking up a work package below. Each WP is self-contained; read §1–§3 before touching anything.

---

## 1. What skiff is

A sim-grade sailing simulator + isochrone weather router for a Lagoon 450S catamaran.

- **Server-authoritative physics.** The Rust backend owns all boat state. The browser is a viewer and input device, never a physics authority.
- **Two sail models, one truth.** The backend runs a coefficient (lift/drag vs AoA) sail at the center of effort — always on, headless-capable. The frontend cloth sim is a visual refinement that can *override* the coefficient sail's wrench when a browser is connected, and must decay back to the coefficient model when it isn't. The boat must sail with no browser open.
- **Validation target:** steady-state polar sweeps of the physical model must reproduce the `PolarProfile` tables used by the router (`src/boat/polar.rs`).

```
Blender (source of truth for geometry)
   │  GLB exports: lagoon-450s.glb (hull+rig), sail-jib.glb (per-sail rest shape)
   ▼
web/ (React 19 + react-three-fiber, Vite)          src/ (Rust, axum, 20 Hz physics)
  SimulatorScene ──POST /v1/sim/control──────────►  main.rs sim loop
  SpinnakerSail  ──POST /v1/sim/sail_wrench──────►  cat_physics::cat_forces (6-DOF)
  (cloth, visual)◄─GET  /v1/sim/state (poll)─────   env providers / SignalK out
```

Server: `cargo run --bin skiff`, binds `0.0.0.0:${SKIFF_PORT:-18081}`, serves `web/dist` statically. Frontend production flow: `cd web && npm run build`, then restart the server process.

---

## 2. Authoritative conventions (the contract)

Violating this section is how force signs flip and boats sail backwards. All new code cites it; all reviews check against it.

### 2.1 Coordinate frames

| Frame | Axes | Where |
|---|---|---|
| **Body / CONTRACT (API)** | +X forward, +Y starboard, +Z down (NED-ish). This is the frame `/v1/sim/sail_wrench` accepts and `gltf_vec_to_body` targets | wire format of `f_body`/`tau_body` |
| **Engine (integrator)** | **y-MIRROR of the contract frame** (lateral axis flipped; MEASURED 2026-07-09 via `cloth_positive_*` frame-probe tests: +f_y drifts the boat to display-PORT, +τ_z yaws the bow to display-PORT). The legacy readout negations (`heading = −ψ`, `cog = atan2(−E,N)`, `leeway = atan2(−v,u)`) all compensate for this same mirror. External wrenches cross the boundary through `contract_wrench_to_engine`: `F → [fx, −fy, fz]`, `τ → [−τx, τy, −τz]` (torque is a pseudovector). NEVER inject a contract-frame force/torque into `cat_step`/`cat_forces` without it — an un-mirrored lee-helm torque drives the bow INTO the wind (shipped once: 28° rudder AP fight, wake on the wrong side) | `cat_physics.rs` `eta`/`nu` |
| **Sail/glTF (frontend)** | **+X PORT**, +Y up, +Z toward bow (tack ring at z≈+7.32). Right-handed: x = up×bow = port. (CORRECTED 2026-07-09 — this table previously said "+X starboard", which seeded a mirrored wrench map; see `plan/sail-fixes-round2.md`) | raw GLB coords; `SpinnakerSail` operates here |
| **Scene (frontend)** | three.js world; boat group applies `rotation=[pitch, -heading, heel]`; the GLB and the sail sim both sit inside an extra `rotation=[0, π, 0]` wrapper | `BoatModel.tsx` |

**Frame map (sail/glTF → body), for forces and torques alike — must be a proper rotation (det = +1):**

```
v_body = [ v_gltf.z,  -v_gltf.x,  -v_gltf.y ]      // stbd = −port
```

Required unit tests: bow → +surge; **port → −starboard**; up → −down; and the mapping matrix determinant is **+1** (a det = −1 map is a reflection and mirrors every side force, heel, and yaw moment — this exact bug shipped once).

Backend quirks (self-consistent, keep, do not "fix" silently): `heading_true_deg = (−ψ)·180/π mod 360`; `cog = atan2(−E, N)`; `leeway_deg = atan2(−v, u)` (positive = drifting to starboard). These are not arbitrary — they are the readout half of the engine's y-mirror (see table above). Removing any single one, or injecting an external force without `contract_wrench_to_engine`, reintroduces the mirror bug on that one path while everything else still looks right.

### 2.2 Wind

- Vectors named `*_to_*` point **toward** where the flow goes (`Vec2Mps::from_speed_to_deg`). Meteorological sources (Open-Meteo `wind_direction_10m`) report **from**-direction: convert at ingestion (`from = to ± 180°`), and name ingestion fields `wind_from_deg`.
- **Apparent vs true is a type distinction, not a comment.** Fields carrying apparent wind are named `aws_mps` / `awa_deg`; true wind `tws_mps` / `twa_deg`. SignalK: apparent → `environment.wind.speedApparent` / `angleApparent` (boat-relative rad); true → `speedTrue` + `directionTrue` (true-north FROM direction, rad). **D3 fixed:** `FullSimState` carries both pairs; true uses wind-over-water; SignalK publishes all four paths.
- Sails consume **apparent** wind (including ω×r at the attachment height). Hydro foils consume **through-water** velocity (−ν). Air foils consume wind minus **ground** velocity.

### 2.3 Units & constants

SI internally (m, s, kg, N, rad); knots/degrees only at UI/serialization edges (`core/units.rs`). Air ρ = 1.225 kg/m³, water ρ = 1025 kg/m³. Aerodynamic pressure is written explicitly `0.5 * 1.225 * v² * C` — no gain fudge factors baked into constants (retire `WIND_GAIN`).

### 2.4 Sail attachment scheme (owner decision — REVISED 2026-07-09, supersedes the implementation doc's pin/free scheme)

Owner adopted the reference rig from `plan/sail-force-rig.html` after testing:

- **Head:** pinned at its rest position (halyard).
- **Tack:** tack-line **rope** to the bowsprit ring `Object.541`, glTF `(-0.041, 2.028, 7.321)`; slack slider 0.9–1.6.
- **Clew:** sheet **rope** to the active sheet lead — the traveler track ends (`Object.122`), port/starboard selectable via the `sheetSide` setting; slack slider 0.55–1.8.
- **Luff:** pin-to-chord toggle (`luffPinned`, default on).
- Rope constraints use adaptive segmentation (~25 cm/segment, min 1) so short spans stay above the solver epsilon.
- Rig attachment points ultimately come from **named objects/empties in the Blender rig** (§5 / `plan/sails_as_data.md`), not hardcoded vectors; the vectors above are the verified interim values.

---

## 3. Known defects (fix before/while building on top)

| ID | Defect | Where | Fix |
|---|---|---|---|
| **D1** | Rotation matrix element (2,3) typo: `spsi*sth*cphi − cphi*sphi` should be `spsi*sth*cphi − cpsi*sphi`. Masked while heel≈0; corrupts every body↔world transform once sails heel the boat | `cat_physics.rs` `rotation_body_to_world` row 2 | Correct term + unit tests: `R·Rᵀ=I` and vector round-trip at φ=20°, θ=5°, ψ=137° |
| **D2** | Open-Meteo `wind_direction_10m` (FROM) assigned to a TO-convention field → real-weather wind reversed 180° | frontend `fetchRealTimeData` (SimulatorScene) | Convert at ingestion per §2.2 |
| **D3** | ~~Apparent wind stored/published as true wind~~ **FIXED** | `main.rs` telemetry + SignalK | `aws_mps`/`awa_deg` + true `tws_mps`/`twa_deg`; SignalK apparent + true paths |
| **D4** | Cloth per-particle force clamp `MASS*40` saturates above ~5 kt apparent — sail shape and any extracted force stop scaling with wind | `SpinnakerSail.tsx` | Remove force clamp; stabilize with substeps/iterations if needed, never load clamping. Keep `MAX_VEL` as explosion guard |
| **D5** | Cloth timestep hardcoded to 60 Hz display (`H=(1/60)/8` inside `useFrame`) → 2.4× fast on 144 Hz monitors | `SpinnakerSail.tsx` | Fixed-step accumulator driven by `useFrame` delta, clamped |
| **D6** | Sail gravity applied in boat-local −Y; tilts with heel/pitch | `SpinnakerSail.tsx` | Rotate world-down into boat frame using received `heelDeg`/`pitchDeg` |
| **D7** | `web/src/sim/boatPhysics.ts` `stepBoat` is dead code inviting divergent physics | frontend | Delete (keep `createInitialBoatState` if still referenced) |
| **D8** | `velocityWater` reconstructed without `leeway_deg` → vectors overlay draws leeway-free track | SimulatorScene | Use leeway in reconstruction |

Smaller, fix-on-contact: `ROPE_SLACK` dead after ropes removed; weld hash can miss epsilon-pairs across cell boundaries (probe neighbor cells); capsized states are terminal by design (add comment); `DRAG=0.994` per substep is heavy damping — revisit when flogging dynamics matter.

---

## 4. Target architecture by component

### 4.1 Backend sail force (authoritative path)

In `cat_forces` (`cat_physics.rs`), replace the disabled sail block with the coefficient model — the pieces all exist:

```rust
// 3. Sail — coefficient model at the CE (skip when inverted)
let h = -p.sail.r[2];                          // CE height above CG
let v_ce = [ground_lin[0] - omega[1] * h,
            ground_lin[1] + omega[0] * h];     // ground-relative velocity at CE
let inflow = [wind_body[0] - v_ce[0], wind_body[1] - v_ce[1]];   // apparent wind
let boom = /* sheet angle from ctrl.sail_trim; sign toward leeward; weathervane clamp when |AWA| < trim */;
let f = foil_force_2d(inflow, [boom.cos(), boom.sin()], &p.sail, 1.225);
let f_tau = apply_at(f, p.sail.r);
for i in 0..6 { tau[i] += f_tau[i]; }
let m_heel  = f_tau[3].abs();
let m_pitch = f_tau[4].abs();                  // feeds update_stability — currently dead code
```

Notes:
- `foil_force_2d` is symmetric-foil; acceptable for v1. A cambered, one-sided variant (nonzero CL at α=0, luffing collapse on the wrong side) is a follow-up (WP-B2).
- Add hull/rig **windage**: flat-plate drag per axis on projected areas — makes bare-poles drift and capsized states behave.
- Depowering: `ctrl.reef` scales area (exists); add `flat` (CL multiplier) alongside when tuning.
- **CE location (provisional):** `p.sail.r = [-0.25, 0, -8]` m body (0.25 m **aft** of CG, 8 m above). Mild weather-helm lever (`Mz = r_x F_y`); −0.5 m was enough to park free neutral-helm in irons before power-up. Refine from Blender `ce.*` later.
- **Sail force model:** soft-cloth path separate from hydro foils — chord is **luff→leech** `(-cos φ, sin φ)` (aft–leeward), no chord flip, weathervane boom `φ* = sign(AWA)·(π−|AWA|)` clamped by sheet, aback/|α|>90° **flogs** to residual drag (prevents reverse-thrust lock-in that caused free-sail sternway).
- **Sheet map:** `control.sail_trim` 0..1 → boom max angle **85° → 6°** via `sail_trim_to_sheet_rad` (trim=1 hard-sheeted ~6°, trim=0 fully eased ~85°). Weathervane clamp keeps `|boom| ≤ |AWA|`.

### 4.2 Cloth wrench channel (refinement path)

Frontend accumulates the aerodynamic wrench in the wind loop it already runs, per triangle:

```
f_tri  = n̂ · (n̂·f_wind) · A_tri                 (total, not /3)
τ_tri  = (centroid − r_ref) × f_tri
```

Average across substeps + low-pass (a few Hz), map through §2.1, and `POST /v1/sim/sail_wrench`:

```json
{ "seq": 123, "f_body": [fx, fy, fz], "tau_body": [tx, ty, tz] }
```

Backend stores `(wrench, Instant)` in `AppState`. In the physics loop: if fresher than 500 ms, use it **instead of** the coefficient sail; otherwise decay smoothly back to the coefficient model — never hold a stale value, never drop to zero-force. Do not read PBD pin reactions — at quasi-steady state attachment reactions equal −(aero + gravity); the summed wrench is the solver-independent answer. Per-line tensions (halyard/sheet readouts) require XPBD later and are out of scope here.

**Wrench reference point:** the frontend sums forces/torques about the **glTF hull origin** `(0,0,0)` (model origin; assumed waterline centerline). The backend expresses all generalized moments about the **body CG** (where foil `r` vectors are anchored). On ingest, the backend shifts: `τ_cg = τ_received + r_gltf_origin × f_body` with `r_gltf_origin = GLTF_ORIGIN_IN_BODY` in `cat_physics.rs` (`[0, 0, +cg_height]` under the waterline/CG assumptions above). The frontend stays dumb — no CG knowledge required.

### 4.3 Frontend cloth (visual)

Current pattern is correct and stays: load the sail's **Blender-exported mesh as the cloth rest shape** (weld seam vertices → particles, mesh edges → springs, per-triangle wind pressure, Verlet + projection). Changes: attachment scheme per §2.4 (pin tack, drop both ropes and rope rendering), D4/D5/D6 fixes, wrench extraction (§4.2). Sliders: retire tack/clew slack; `spinnakerEdgeTension` remains as rest-length scale.

### 4.4 Trim unification

One trim value drives both models. `control.sail_trim` (0–1) is the single source: backend maps it via `sail_trim_to_sheet_rad` to sheet angle **~85° (eased) … ~6° (hard)** (was 0–15° — too narrow; stalled reverse thrust). Frontend maps the same 0–1 value to the visual trim it needs (when a sheet constraint returns, its rest length; until then, nothing diverging). UI sliders that shadow trim with unrelated values are defects.

### 4.5 Sails as data (multi-sail end state)

- Blender rig carries **named empties/vertex groups**: per sail `head`, `tack`, `clew` corners; per boat the anchor points (`ring.tack`, sheet leads); `ce.<sail>` empties for CE (already exists: `ce.jib`).
- A per-sail config (JSON/TOML in `web/public` or served by backend) references: GLB path, corner names, anchor names, coefficient-set id, control bindings (sheet range, reefable).
- One cloth instance per active sail; corner detection by name lookup, not geometric heuristics (current highest/nearest/farthest heuristics misfire on square-top mains and symmetric kites).
- Backend `CatParams` grows `sails: Vec<Foil>` with per-sail CE (`r`), enabling helm-balance (per-sail yaw moments) — the thing VPPs don't model and interactive sims need.

### 4.6 Transport

Two serialized HTTP round-trips per rendered frame is acceptable on localhost for now. Next step when forces flow: fold control+state into one POST; eventual: WebSocket. Not a current WP.

### 4.7 Routing notes

Explicit design decisions for the isochrone / polar stack (code comments at the sites match):

- **Unimplemented land/depth constraints:** `IsochroneRequest.avoid_land` and `min_depth_m` are accepted on the request type but not implemented. The router **returns an error** if either is set, rather than silently ignoring them (safety).
- **Polar port/starboard symmetry:** boat speed from polars / cast-off course buckets uses `abs(TWA)` for now — intentional; asymmetric tables and tack-aware polars are future work.
- **Wave penalty double-influence:** `wave_speed_factor` reduces STW in the boat profile (physics) **and** `(1 − wave_penalty)` feeds comfort cost in the isochrone scorer (preference). Both paths are intentional; do not “dedupe” without revisiting routing weights.
- **Light-air polar extrapolation:** TWS below the first polar table row scales STW linearly toward 0 at 0 kt (does not clamp to the first row).
- **Calm-sea wave gate:** wave height ≈ 0 skips the entire wave penalty (including short-period), so flat water never invents a sea-state slowdown.
- **Heading fan:** always includes the direct destination bearing, independent of `heading_resolution_deg`.

---

## 5. Work packages

Rules for every WP: Rust — `cargo test && cargo run --bin skiff` must start clean; Web — `cd web && npx tsc -b` must pass; a change that affects visuals requires `npm run build` to be visible on :18081 (ServeDir reads `web/dist` per-request — no server restart needed; restart only when the Rust binary changes). **No commits** (repo intentionally uncommitted). Don't touch `web/src/sim/boatPhysics.ts` except WP-D7. Update this file's §2/§3 if your change alters a contract.

| WP | Scope | Files | Depends on | Done when |
|---|---|---|---|---|
| **A1** | Fix D1 rotation matrix + frame unit tests (R·Rᵀ=I, round-trip, §2.1 surge test scaffold) | `cat_physics.rs` | — | `cargo test` green with new tests |
| **A2** | Coefficient sail in `cat_forces` + windage + stability moments live (§4.1) | `cat_physics.rs`, `main.rs` | A1 | Headless boat sails: `/v1/sim/state` shows nonzero `stw`, heel responds to trim/reef; `monitor_sim.py` shows knockdown when grossly overpowered |
| **A3** | Wind conventions + naming: D2, D3 (fields, SignalK, HUD) | `main.rs`, `signalk.rs`, SimulatorScene, Hud | — | AWA/AWS vs TWA/TWS separated end-to-end; SignalK paths per §2.2 |
| **B1** | Cloth: attachment scheme §2.4, D4 clamp removal, D5 fixed timestep, D6 gravity, slider cleanup | `SpinnakerSail.tsx`, store/types, ControlsPanel | — | Sail stable 0–30 kt, no ropes rendered, shape scales with wind, identical behavior at 60/144 Hz |
| **B2** | Wrench extraction + filter + frame map + `POST /v1/sim/sail_wrench`; backend staleness decay (§4.2); explicit `0.5ρv²` | `SpinnakerSail.tsx`, `main.rs` | A2, B1 | Browser open: boat driven by cloth wrench; browser closed: decays to coefficient sail within ~1 s; surge unit test passes |
| **C1** | Polar validation harness: sweep TWA/TWS to steady state headlessly, compare against `PolarProfile`, emit report | new `src/bin/` or test | A2 | Polar plot/table diff produced; gross deviations flagged |
| **D** | Cleanups: D7, D8, neighbor-cell weld, comments on terminal capsize | frontend | — | tsc green, overlay shows leeway |
| **E** | Sails-as-data (§4.5): named empties in Blender export, per-sail config, name-based corner lookup, `Vec<Foil>` backend | Blender + both sides | A2, B1 | Second sail (main) instantiable from config without code changes |

Priority order: **A1 → A2 → A3 → B1 → B2**, then C1/D/E. A1+A2 transform what the system is (a boat that actually sails); everything after refines it.

---

## 6. Validation checklist (release gate for this phase)

1. `cargo test` green (rotation, frame-map, wind-convention unit tests).
2. Headless: server alone, boat beam-reaches under coefficient sail; capsize logic reachable (moment-based knockdown fires in a forced test).
3. Browser: cloth sail visually sane 0–30 kt, drives the boat via wrench, HUD shows correct AWA/AWS + TWA/TWS.
4. Kill the browser: boat keeps sailing (decay path), no state jump.
5. Polar sweep report exists and roughly tracks the 450S table (shape match; calibration comes later).
6. SignalK consumer (or logged deltas) shows correct paths/conventions.
