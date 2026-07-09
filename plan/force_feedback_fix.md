# Force Feedback & Crinkle Fix Plan

**Status:** PLAN ONLY — no code changes until owner approves.
**Inputs:** owner's live observation (boat turns into the current, not the wind, with sail loaded and rudder centered); owner-supplied crinkle post-mortem; reference `plan/sail-force-rig.html` v2 (updated 2026-07-09 11:39, on disk uncommitted) containing the tape/bending fixes.

---

## 1. Primary diagnosis: the cloth wrench is mirrored left-right

**The shipped frame map is not a rotation.** `SpinnakerSail.tsx:762-772` maps sail→body as `v_body = [v.z, v.x, -v.y]`. As a matrix its determinant is **−1** — a reflection. Two right-handed frames can only be related by a proper rotation (det +1), so exactly one axis has the wrong sign.

**Which axis is empirically settled.** glTF's convention (+Y up, +Z forward, right-handed) makes **+X the port side**, and the owner independently observed exactly that on screen (the +2.459 sheet lead rendered to visual port, Object.122). The architecture doc §2.1 asserts "+X starboard" — that assertion is wrong and poisoned everything derived from it.

**Correct map:** `v_body = [v.z, −v.x, −v.y]` (det = +1).

**What the mirror explains:**
- Side force from the sail pushes the hull the wrong way; yaw torque turns it the wrong way. The boat's response decorrelates from the wind, so the only *coherent* influence left on the hull is the water current acting on skegs/hull — which is precisely "the boat turns into the current."
- Heel torque is also mirrored (boat heels to windward under cloth override) — unnoticed because heel is small at current wind.
- Why no test caught it: the only end-to-end frame test is surge (`+z_gltf → +x body`), and z/x-forward are the two components the reflection leaves intact. The wrench-to-CG equivalence test operates entirely in body frame, downstream of the map.

**Blast radius audit (what is NOT affected):**
- The backend coefficient sail: `p.sail.r` and its forces are authored natively in body frame — unaffected.
- `GLTF_ORIGIN_IN_BODY`: derived vertical-only — the mirror doesn't touch z; unaffected, but see §3.
- The cloth's own wind/billow behavior: self-consistent inside the glTF frame (owner confirms the sail itself looks right) — unaffected.
- The visual overlays (arrows/particles): world-frame, independent path — unaffected.

## 2. Secondary audit items (same review, cheap to check while in there)

- **Luffing gate wind source:** `__sailDebug.awaDeg` reads `boat.twaDeg`, which since the D3 split is TRUE wind. If the new luffing/flogging factor gates on that instead of apparent wind derived from `windLocal`, the flogging regime triggers at wrong angles. Verify and, if wrong, gate on `windLocal`-derived AWA.
- **CG fore-aft position:** the wrench torque shift assumes the glTF origin sits at the CG fore-aft. A fore-aft error biases yaw response from side force. Measure the real CG (the `cg` empty per `sails_as_data.md`) in Blender and extend `GLTF_ORIGIN_IN_BODY` to 3 components.
- **Expected behavior after fix (owner's physical check):** sail loaded, rudder centered → side force forward of the hull's lateral center → bow turns toward the wind (round-up). This becomes the live acceptance test.

## 3. Crinkle fixes — port reference v2 into SpinnakerSail

From the owner-supplied analysis: a membrane can't carry compression; fullness over-lengthens *boundary* edges; unloaded boundary cloth sheds slack as one-element sawtooth folds (leech/foot worst); vertex-normal shading amplifies it visually. Reference v2 fixed it with sailmaker hardware equivalents, verified (flogging RMS 321→77 mm, v² scaling 3.90 intact). Port all five techniques onto the welded Blender mesh:

1. **Fullness on interior edges only.** Boundary edges become snug "tapes" at 0.998× flat length (tabling + leech line). We already do boundary-edge classification (count-1 edges, used for the luff walk) — extend to classify the full boundary into luff/leech/foot chains.
2. **Cross-spring bending constraints** between opposite vertices of every shared interior edge, soft (k≈0.15) — makes element-scale folds expensive, barely resists large-radius camber.
3. **Second-neighbor straightness springs along each boundary tape** (batten/leech-line effect targeting the boundary fold mode directly).
4. **Compression response softening (0.35):** springs shorter than rest push back at 35% stiffness so slack regions drape instead of sawtoothing.
5. **Shading fix:** neighbor-average the pressure field before writing vertex colors (kills boundary striping from fewer incident triangles).

Owner-acknowledged physics caveat: max fullness against a tight perimeter still wrinkles — real, not artifact.

## 4. Execution phases (each gated, nothing merged un-verified)

| Phase | What | Who | Gate |
|---|---|---|---|
| **P0** | Confirm the mirror by injection before changing anything: headless server, POST a hand-crafted wrench (pure +stbd side force at bow height), observe yaw sign; repeat with the cloth live on one tack | me | Observed yaw opposite to physical expectation confirms diagnosis |
| **P1** | Frame-map fix: `[z, −x, −y]` in SpinnakerSail POST + §2.1 rewritten (+X is PORT, map, det note); backend unit tests added: determinant-is-+1 test on the documented map, lateral sign test (+x_gltf → −y body), yaw sign test (side force forward of CG → correct-sign yaw) | Grok (backend tests) + me (frontend map + doc) | `cargo test` green; live: rudder centered, sail loaded → bow rounds up toward wind on both tacks (sheet-side toggle exercised both ways) |
| **P2** | Crinkle port (items 1–5 above) into SpinnakerSail; keep self-collision and luffing regime intact | Antigravity | tsc green; v² force-scaling ratio preserved (~4× for 2× wind via `__sailDebug`); visual: no sawtooth at fullness ≤1.05; flogging still works |
| **P3** | Luffing-gate wind-source audit/fix; CG fore-aft from Blender `cg` empty → 3-component `GLTF_ORIGIN_IN_BODY` + tolerance test | Antigravity (gate) / Grok (CG) | Unit tests; luffing fires only near true head-to-wind in live check |
| **P4** | Full regression: 30+ cargo tests, polar sweep aggregate (expect ≈−10% or better; the mirror never affected headless, so no polar change expected), browser-open free-sail gate (stw positive 120 s), then commit+push | me | All gates green; owner flies it |

Reviews: Codex re-verifies P1 sign work (it caught the torque-origin issue last time); GLM fresh-clone pass after the commit.

## 5. Non-goals in this plan

Rope-vs-cloth collision (deferred by owner), polar close-hauled/heavy-air calibration (C-phase), sails-as-data migration (WP-E, separate).
