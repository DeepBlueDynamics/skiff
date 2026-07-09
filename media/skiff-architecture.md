# Skiff: separating the sail from the hull — and closing the loop

Most sailing simulators pick one of two compromises. Either the sail is theater — a rigid mesh (or a baked animation) driven by polar tables and a few sliders — or cloth and rigid-body dynamics live in the same engine, so a stiff spring, a bad timestep, or a force clamp on the sail immediately corrupts the boat. We wanted something else: a vessel that can be *validated* against published performance data without a GPU, and that, when a browser is open, lets what you *see* of the sail be what actually pushes the hull.

Skiff is that experiment. The boat is a **Lagoon 450S**. The purpose is not a game: **Meridian**, our isochrone weather-routing service, needs a realistic test vessel. Skiff is that boat — a sim-grade 6-DOF model plus a routing stack, with an optional browser client that both renders the headsail and feeds aerodynamic forces back into the server.

## The usual choices, and why they fail for us

**Polar-driven visuals** are honest about what they are. A VPP or a lookup table says “at this TWS and TWA you make 7.2 kn.” The hull kinematics follow that number; the sail is drawn to look plausible. For routing research that can be enough. It fails when you care about *how* the load is generated: heel from a high center of effort, weather helm from an aft CE, knockdown when moment exceeds righting, bare-poles drift, or a sail that luffs and collapses instead of producing infinite force in irons. The table has already averaged those effects away.

**Monolithic cloth+rigid engines** look more physical. One solver owns particles and hull. In practice, numerical convenience on the cloth side (load clamps, display-rate timesteps, heavy damping) becomes the boat’s force law. We saw this path in our own early client: a per-particle force clamp saturated above roughly five knots apparent, so shape and any extracted load stopped scaling with wind. Fixing the cloth by clamping forces would have “stabilized” the sail by lying to the hull.

We split the problem instead.

## Two simulations, one boat

```
                    ┌─────────────────────────────┐
                    │  Rust server (~20 Hz RK4)   │
  control/trim ───► │  6-DOF catamaran (Fossen)   │
                    │  foils · added mass · GZ    │
                    │  coefficient sail (always)  │
                    │  optional cloth wrench      │
                    └───────────┬─────────────────┘
                                │ state (pose, ν, wind…)
                                ▼
                    ┌─────────────────────────────┐
                    │  Browser (R3F / Three.js)   │
                    │  Lagoon GLB · HUD · helm    │
                    │  Verlet cloth from sail GLB │
                    │  per-triangle aero → wrench │
                    └───────────┬─────────────────┘
                                │ POST /v1/sim/sail_wrench
                                └──────── (when fresh) ──► replaces
                                                           coefficient
                                                           sail load
```

**The server owns truth.** Pose, velocity, stability (upright / knockdown / capsized), environment integration, and the generalized force vector live in Rust. The model is Fossen-style 6-DOF: mass and added-mass diagonals, Coriolis, linear/quadratic damping, catamaran restoring (GZ), hydro foils for skegs and rudders, engines, hull/rig windage. Integration is RK4 at about 20 Hz. Nothing in the browser is allowed to author boat state; it POSTs control and polls `/v1/sim/state`.

**The coefficient sail is the always-on path.** Lift/drag versus angle of attack at a center of effort, apparent wind including ω×r at height, sheet angle from a single trim control, soft-cloth behavior when aback (flogging collapse rather than backed multi-kilonewton reverse thrust). That model runs headless forever: polar sweeps, routing validation, `monitor_sim.py`, Signal K — no browser, no GPU.

**The cloth is a second sail model, not a skin.** Rest shape comes from the Blender-exported sail mesh (welded vertices → particles, edges → springs). Verlet integration plus constraint projection, attachment scheme from the rig, per-triangle wind pressure with explicit `½ ρ v²`. The same loop that deforms the mesh for the camera accumulates:

```
F  = Σ f_tri
τ  = Σ (c_tri − r_ref) × f_tri
```

We deliberately do **not** read pin reactions. In PBD, pins absorb load without Lagrange multipliers; at quasi-steady state the attachment sum is −(aero + gravity) anyway. The aerodynamic wrench is the solver-independent answer.

## Closing the loop: the renderer as a sensor

When the browser is connected, that wrench is low-pass filtered, mapped into the body frame, and posted as `{ seq, f_body, tau_body }`. The server stores `(wrench, Instant)`. In the physics loop:

- **Fresher than ~500 ms** → cloth wrench **replaces** the coefficient sail load (moments shifted from glTF origin to CG on the backend).
- **Stale** → blend smoothly back to coefficients over about a second.
- **Never** hold a frozen last value; **never** drop to zero force when the tab closes.

So the cloth is not only a visual. While the tab is alive and the wrench is fresh, the hull feels the integrated pressure on the mesh you are looking at. When the tab dies, the boat keeps sailing under coefficients. Headless and headed share one rigid-body core; only the sail force channel switches.

```
  [no browser]     coefficient sail ──► τ ──► 6-DOF
  [browser live]   cloth wrench     ──► τ ──► 6-DOF
  [tab closed]     blend coeff ←── (decay, not freeze)
```

## Why the split is worth the glue

**Visual behavior and boat feel cannot diverge by design when the wrench path is live.** A luffing sail that loses projected area and pressure produces a smaller wrench; a full draw on a beam reach produces drive and leeward side force; a gybe that dumps the sail dumps the load. That is a stronger consistency guarantee than “animate the mesh to match a polar.”

**Validation does not depend on the cloth.** Meridian’s router consumes polar / cast-off profiles. We sweep TWS×TWA headlessly, lock heading, optimize trim, and compare steady STW to the Lagoon-facing tables. That harness is a first-class citizen of the repo, not a demo afterthought. If cloth numerics misbehave, the coefficient path and polar gate still tell us whether the *hull* model is in the right neighborhood.

**Failure modes stay local.** Cloth timestep bugs, tangle watchdogs, or a bad substep rate should not rewrite mass or hydro coefficients. Conversely, a rotation-matrix typo in body↔world transforms does not require rewriting the Verlet integrator — though it will absolutely corrupt wind and heel once moments exist (we fixed one such typo that was masked while heel was zero).

## Contracts, honesty, and loops

The price of a closed loop is **contracts**. Body frame is +X forward, +Y starboard, +Z down. Sail-local frame is +X **port**, +Y up, +Z bow — right-handed. The map between them must be a proper rotation (determinant +1). We once shipped `v_body = [z, x, −y]`, det = −1: a reflection. Every side force, heel, and yaw mirrored while the on-screen arrow (drawn pre-map) still looked fine. That class of bug is why frame conventions live in a written architecture doc and unit tests, not in tribal knowledge.

We also learned to prefer **physically honest fixes over clamps**. Saturating force “for stability” destroys the scaling law you need for a meaningful wrench. Prefer substeps, flogging collapse when the sail is aback, and residual drag — not silent load ceilings. When free response parked the boat in sternway, the diagnosis was reverse thrust from a wrong sail chord convention and missing flog behavior, not “add thrust gain.”

Around that sits a validation culture: rotation orthonormality tests, frame-map det = +1, free-sail no-sternway gates, cloth-versus-coefficient force-angle alarms when the browser wrench is fully blended in, and polar aggregates as a regression signal after sail-model changes.

## What skiff is for

Skiff is not trying to be every sailing title on Steam. It is a **Lagoon 450S** that Meridian can trust enough to route with, instrument over Signal K, and occasionally open in a browser to see the headsail fill, luff, and load the hull for real. The architecture that makes that possible is simple to state and expensive to get right: **separate the sail simulation from the rigid-body engine, then wire them as a feedback loop with a headless fallback that never depends on the view.**

The browser is optional. The physics is not. When both are present, the view is part of the physics.
