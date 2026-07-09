# Sail fixes, round 2 — mirrored frame map + wrapping. Brief for the coding agent

Two root causes identified by review. Apply in this order. Do not improvise
alternative fixes; the analysis below is verified against the code.

---

## Fix 1 — The wrench frame map is a reflection (causes the yaw inversion)

### Root cause
The sail's local frame is right-handed (three.js; the `rotation=[0, Math.PI, 0]`
wrapper is a rotation and preserves handedness), with +Y up and +Z forward
(tack ring at z=+7.32 on the bowsprit). Therefore x = y×z = up×forward =
**PORT**, not starboard. The legacy comment "port-quarter sheet lead" on the
x=−3.9 anchor was mislabeled (that lead is the STARBOARD quarter); plan §2.1
inherited "+X starboard" from it.

The implemented map `v_body = [v.z, v.x, -v.y]` therefore feeds the PORT
component into body +Y (starboard). Check: its matrix
rows (0,0,1),(1,0,0),(0,−1,0) has **det = −1** — a reflection. A map between
two right-handed frames must have det = +1. Result: side force, heel, and yaw
all mirror; the on-screen arrow (drawn scene-side, pre-mapping) still looks
correct.

### Patch (frontend — the single mapping owner)
`web/src/components/SpinnakerSail.tsx` (~lines 762–774):

```ts
// Sail-local frame is (+X port, +Y up, +Z bow) — right-handed.
// Body frame is (+X fwd, +Y stbd, +Z down). Proper rotation, det = +1:
const f_body = [
  filteredForce.current.z,
  -filteredForce.current.x,   // stbd = −port  ← the fix
  -filteredForce.current.y
] as [number, number, number];

const tau_body = [
  filteredTorque.current.z,
  -filteredTorque.current.x,  // same matrix — torques map identically
  -filteredTorque.current.y
] as [number, number, number];
```

### Patch (backend helper + doc + test)
`src/cat_physics.rs`:

```rust
/// Map a vector from sail-local frame (+X PORT, +Y up, +Z bow — right-handed)
/// into body frame (+X fwd, +Y stbd, +Z down). Proper rotation, det = +1.
pub fn gltf_vec_to_body(v_gltf: [f64; 3]) -> [f64; 3] {
    [v_gltf[2], -v_gltf[0], -v_gltf[1]]
}
```

Extend `frame_map_pure_z_gltf_force_is_positive_surge` — it only tests the
z→surge axis, which is identical in the wrong and right mappings (that is why
the suite stayed green). Required assertions:

```rust
assert_eq!(gltf_vec_to_body([0.0, 0.0, 1.0]), [1.0,  0.0,  0.0]); // bow → surge
assert_eq!(gltf_vec_to_body([1.0, 0.0, 0.0]), [0.0, -1.0,  0.0]); // PORT → −stbd
assert_eq!(gltf_vec_to_body([0.0, 1.0, 0.0]), [0.0,  0.0, -1.0]); // up → −down
// determinant of the mapping matrix must be +1 (proper rotation)
```

Also fix the "port-quarter" comment on the clew anchor (it is the starboard
quarter) and update plan §2.1 — leaving the wrong frame doc in place will
re-seed this bug.

### Verification
1. Re-run the Step-1 empirical probe from the previous brief (hardcoded
   [0, 1000, 0] N at [5, 0, 0]); must still pass — it validates the backend
   path independently of this mapping.
2. Runtime invariant (log or debug assert while blend = 1): the mapped cloth
   side force must point AWAY from the apparent wind (leeward), i.e.
   `f_body[1] * inflow_body_y < 0` when the sail is drawing.
3. Cross-check log: when blend = 1, also evaluate `coefficient_sail_wrench`
   and log the angle between the two force vectors. Post-fix they should agree
   in sign on every component and typically within ~30–50° in direction;
   sustained > 90° disagreement = regression alarm.
4. Acceptance test from the previous brief (beam wind, rudder 0): boat heels
   LEEWARD, accelerates, drifts DOWNWIND (lee helm), mirrors when wind mirrors.

---

## Fix 2 — Delete the flogging noise injector and the luffFactor pressure hack
(causes the wrapping/tangling)

### Root cause
`noiseMag = 28.0 * (1.0 - luffFactor) * windVelocity.length()` injects random
per-particle force with acceleration amplitude ±0.5·28·(1−lf)·V. At lf = 0.15
and V = 7 m/s that is ≈ ±83 m/s² — 8.5 g of random shake — applied whenever
the GLOBAL mean-plane (head/tack/clew) attack angle reads < 30°. That
condition holds at startup, during any luff, and PERMANENTLY once the sail
tangles (a balled-up sail has a meaningless mean plane), creating a positive
feedback loop: shake → tangle → heuristic reads "luffing" → more shake.

The relative-velocity pressure model already produces luffing collapse and
flutter locally and physically — that was the purpose of v_rel. The global
heuristic is redundant and destructive.

### Patch
In `SpinnakerSail.tsx`:
- Delete the noise block (`noiseMag`, the three `p.force.* += (Math.random()…`
  lines).
- Delete the `luffFactor` multiplier from `q = 0.5 * 1.225 * Cp * vn *
  Math.abs(vn) * luffFactor` → drop `* luffFactor`.
- The `luffFactor` / mean-plane attack-angle computation can be kept ONLY for
  HUD display; it must not touch forces. If a visual flutter garnish is ever
  wanted, cap injected acceleration at ≤ 0.5 m/s² — but ship without it first.

---

## Fix 3 — Rig collision capsules (prevents wrap-through)

Self-collision exists (spatial hash); the rig does not. Add analytic capsule
constraints, applied to ALL particles (cloth + rope nodes) after the spring
iterations, inside every substep:

```ts
// Sail-local coordinates. Radii include cloth-thickness margin.
const CAPSULES = [
  { a: mastBase,  b: mastTop,     r: 0.16 },  // mast (read heights from model/anchors)
  { a: headAnchor, b: tackAnchor, r: 0.06 },  // forestay
];
// Optional: deck plane clamp — if (|x| < halfBeam && z within hull) y = max(y, deckY)

for (const p of parts) {
  if (p.pinned) continue;
  for (const c of CAPSULES) {
    // closest point on segment ab to p.pos → cp; d = p.pos − cp
    // if |d| < c.r: p.pos = cp + d.normalize() * c.r
  }
}
```

Position projection is sufficient in a PBD solver (no velocity handling
needed; Verlet absorbs it). Cost: ~2 capsules × ~1k particles × 480 Hz —
negligible.

## Fix 4 — Tangle watchdog

Metric per frame: `mean over cloth springs of max(0, L/rest − 1)`. If it
exceeds 0.15 continuously for 2 s, reset the cloth to rest shape (reuse the
NaN-reset machinery) and log it. This converts any residual pathological
state into a one-frame blip instead of a permanent wrap.

---

## Acceptance suite (add as automated scenarios)
1. Mapping tests (Fix 1) green; det = +1.
2. Startup at wind-from = 45/90/135/180/225/270/315°, 7 m/s: sail fills on
   the leeward side within 5 s; no capsule penetration; spring violation < 5%.
3. Forced crash-jibe (drive the boat through the wind under autopilot): sail
   blows through, refills on the new side, never lodges in the rig; watchdog
   does not fire.
4. Previous brief's lee-helm acceptance test passes and mirrors port/stbd.

## Prohibitions
- The frontend remains the ONLY mapping site. Do not add a compensating
  negation in the backend path; `gltf_vec_to_body` is corrected for tests/
  future use only.
- Do not re-tune the noise instead of deleting it.
- Do not fix wrapping with force or velocity clamps — clamps were removed
  deliberately because they corrupt the extracted wrench.
