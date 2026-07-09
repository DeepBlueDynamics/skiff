# Sails As Data (WP-E)

Status: work-package specification. This implements `plan/overarching_architecture.md` section 4.5 without changing the frame contract in section 2.

Goal: one per-sail data source drives both frontend cloth and backend coefficient forces. No hardcoded sail GLB paths, corner heuristics, anchor vectors, or backend-only CE constants.

## 1. Sail Plan Config

Store the first version as JSON in `web/public/sailplan.lagoon-450s.json`. The backend should load the same file at startup (or receive the same JSON from a future `/v1/rig/sailplan` endpoint). Keep values in runtime sail/glTF coordinates unless a field says otherwise.

### Schema

```json
{
  "vessel": "lagoon-450s",
  "version": 1,
  "frame": "sail-gltf: +X starboard, +Y up, +Z bow",
  "wrench_reference": {
    "point": "gltf_origin",
    "backend_shift": "derived_from_cg_locator"
  },
  "coefficient_sets": {
    "<coefficient-set-id>": {
      "area_m2": 0.0,
      "aspect_ratio": 0.0,
      "cd0": 0.0,
      "stall_deg": 0.0,
      "oswald": 0.0
    }
  },
  "sails": [
    {
      "id": "jib",
      "display_name": "Jib",
      "enabled_by_default": true,
      "glb_path": "/sail-jib.glb",
      "mesh_name": "sail.jib",
      "corners": {
        "head": "head.jib",
        "tack": "tack.jib",
        "clew": "clew.jib"
      },
      "anchors": {
        "head": "anchor.halyard.jib",
        "tack": "anchor.ring.tack",
        "sheet_port": "anchor.sheet.port",
        "sheet_starboard": "anchor.sheet.starboard"
      },
      "active_sheet": "starboard",
      "center_of_effort": "ce.jib",
      "coefficient_set": "jib.lagoon450s.v1",
      "controls": {
        "sheet": {
          "binding": "control.sail_trim",
          "min_deg": 85.0,
          "max_deg": 6.0
        },
        "reefable": false,
        "furlable": true
      },
      "cloth": {
        "enabled": true,
        "head_mode": "pin_to_anchor",
        "tack_mode": "rope_to_anchor",
        "clew_mode": "rope_to_anchor",
        "luff_mode": "pinned_chord",
        "tackline_slack_binding": "settings.spinnakerTackSlack",
        "sheet_slack_binding": "settings.spinnakerClewSlack",
        "fullness_binding": "settings.sailFullness"
      }
    }
  ]
}
```

Rules:

- `id` is stable and lowercase. Use it in object names and telemetry.
- `glb_path` is browser-visible and rooted at `web/public`.
- `mesh_name` is the mesh/object containing the exported sail cloth rest shape.
- `corners.*` are locator empty names exported in the sail GLB. They replace highest/nearest/farthest geometric heuristics.
- `anchors.*` are locator empty names exported in the boat rig GLB. `sheet_port` / `sheet_starboard` may be unused by the current cloth solver, but the names must exist for future sheet constraints and line loads.
- `active_sheet` selects the sheet lead for sails with port and starboard sheet anchors: `"port"`, `"starboard"`, or `"auto_leeward"`. V1 uses explicit `"starboard"` for the current jib because the real lead is the starboard traveller end near the helm (`Object.122` in Blender).
- `center_of_effort` is an exported boat rig locator. Backend converts its glTF position to body frame via section 2.1 and then shifts relative to CG as needed for `Foil.r`.
- `controls.sheet.min_deg` is loose sheet angle at `control.sail_trim = 0`; `max_deg` is hard sheet angle at `control.sail_trim = 1`. This matches the current backend convention of eased ~85 deg to hard ~6 deg.
- `reefable` gates whether `control.reef` changes area/visual scale for this sail.
- `furlable` reserves a future 0..1 furl state. It does not replace `reefable`.
- `tack_mode` / `clew_mode` allowed values: `"pin_to_anchor"`, `"rope_to_anchor"`, `"free"`, `"sheet_constraint"`. Current owner-approved rig uses `head_mode = "pin_to_anchor"`, `tack_mode = "rope_to_anchor"`, `clew_mode = "rope_to_anchor"`.
- `luff_mode` allowed values: `"pinned_chord"` or `"free"`. `"pinned_chord"` keeps the luff chord stabilized by pinning the shortest head-to-tack mesh path during projection.
- `fullness_binding` replaces the older `edge_tension_binding` name. It points to `settings.sailFullness`.

### Concrete Config

```json
{
  "vessel": "lagoon-450s",
  "version": 1,
  "frame": "sail-gltf: +X starboard, +Y up, +Z bow",
  "wrench_reference": {
    "point": "gltf_origin",
    "backend_shift": "derived_from_cg_locator"
  },
  "coefficient_sets": {
    "jib.lagoon450s.v1": {
      "area_m2": 38.0,
      "aspect_ratio": 4.2,
      "cd0": 0.06,
      "stall_deg": 20.0,
      "oswald": 0.85
    },
    "main.lagoon450s.v1": {
      "area_m2": 56.0,
      "aspect_ratio": 3.0,
      "cd0": 0.08,
      "stall_deg": 18.0,
      "oswald": 0.80
    }
  },
  "sails": [
    {
      "id": "jib",
      "display_name": "Jib",
      "enabled_by_default": true,
      "glb_path": "/sail-jib.glb",
      "mesh_name": "sail.jib",
      "corners": {
        "head": "head.jib",
        "tack": "tack.jib",
        "clew": "clew.jib"
      },
      "anchors": {
        "head": "anchor.halyard.jib",
        "tack": "anchor.ring.tack",
        "sheet_port": "anchor.sheet.port",
        "sheet_starboard": "anchor.sheet.starboard"
      },
      "active_sheet": "starboard",
      "center_of_effort": "ce.jib",
      "coefficient_set": "jib.lagoon450s.v1",
      "controls": {
        "sheet": {
          "binding": "control.sail_trim",
          "min_deg": 85.0,
          "max_deg": 6.0
        },
        "reefable": false,
        "furlable": true
      },
      "cloth": {
        "enabled": true,
        "head_mode": "pin_to_anchor",
        "tack_mode": "rope_to_anchor",
        "clew_mode": "rope_to_anchor",
        "luff_mode": "pinned_chord",
        "tackline_slack_binding": "settings.spinnakerTackSlack",
        "sheet_slack_binding": "settings.spinnakerClewSlack",
        "fullness_binding": "settings.sailFullness"
      }
    },
    {
      "id": "main",
      "display_name": "Mainsail",
      "enabled_by_default": true,
      "glb_path": "/sail-main.glb",
      "mesh_name": "sail.main",
      "corners": {
        "head": "head.main",
        "tack": "tack.main",
        "clew": "clew.main"
      },
      "anchors": {
        "head": "anchor.halyard.main",
        "tack": "anchor.gooseneck.main",
        "sheet_port": "anchor.traveller.port",
        "sheet_starboard": "anchor.traveller.starboard"
      },
      "active_sheet": "auto_leeward",
      "center_of_effort": "ce.main",
      "coefficient_set": "main.lagoon450s.v1",
      "controls": {
        "sheet": {
          "binding": "control.sail_trim",
          "min_deg": 75.0,
          "max_deg": 5.0
        },
        "reefable": true,
        "furlable": false
      },
      "cloth": {
        "enabled": false,
        "head_mode": "pin_to_anchor",
        "tack_mode": "pin_to_anchor",
        "clew_mode": "sheet_constraint",
        "luff_mode": "free",
        "tackline_slack_binding": null,
        "sheet_slack_binding": null,
        "fullness_binding": null
      }
    }
  ]
}
```

The coefficient numbers above are v1 placeholders. Use measured sail areas and tune against polar validation before treating them as physical constants.

## 2. Blender Naming Convention

All names are exact, lowercase, dot-separated, and stable across exports.

### Boat Rig GLB (`lagoon-450s.glb`)

Required locator empties:

- `cg` - center of gravity / body origin reference.
- `ce.<sail>` - coefficient center of effort for each sail. Current manifest already includes `ce.jib` and `ce.main`.
- `anchor.ring.tack` - bowsprit tack ring; current interim glTF value is `(-0.041, 2.028, 7.321)`.
- `anchor.halyard.<sail>` - halyard sheave / head pin target.
- `anchor.sheet.port` - port sheet lead for headsails.
- `anchor.sheet.starboard` - starboard sheet lead for headsails. For the current jib this is the real lead near the helm, `Object.122` in Blender.
- `anchor.gooseneck.main` - mainsail tack / boom gooseneck.
- `anchor.traveller.port` - port end or effective lead of main traveller.
- `anchor.traveller.starboard` - starboard end or effective lead of main traveller.

Keep existing object names:

- `sail.jib`
- `sail.main`
- `ce.jib`
- `ce.main`
- `masthead.wind`

### Per-Sail GLB (`sail-<id>.glb`)

Required objects:

- `sail.<id>` - cloth mesh/rest shape.
- `head.<id>` - locator empty exactly on the head corner.
- `tack.<id>` - locator empty exactly on the tack corner.
- `clew.<id>` - locator empty exactly on the clew corner.

Recommended authoring vertex groups:

- `vg.head.<id>`
- `vg.tack.<id>`
- `vg.clew.<id>`

The runtime lookup must use exported locator empties. Vertex groups are for Blender authoring and validation because glTF/Three.js does not reliably expose Blender vertex groups as named runtime entities.

### Export Checklist

1. Apply transforms on hull, rig, sail meshes, and locator empties.
2. Confirm runtime glTF frame remains section 2.1: `+X starboard`, `+Y up`, `+Z bow`.
3. Export locator empties with names preserved.
4. Export each sail mesh with object name `sail.<id>`.
5. Keep sail corner locator empties in the same GLB as the sail mesh.
6. Keep boat anchor and CE locator empties in `lagoon-450s.glb`.
7. Update `web/public/lagoon-450s.manifest.json` `locators` with every new `anchor.*`, `head.*`, `tack.*`, `clew.*`, and `ce.*` name that ships in the rig GLB.
8. Run a locator sanity script or manual GLB inspection and record:
   - `anchor.ring.tack` is within 1 cm of `(-0.041, 2.028, 7.321)` for the current jib.
   - `head.<sail>`, `tack.<sail>`, and `clew.<sail>` each resolve to a mesh vertex within 1 cm.
   - `ce.<sail>` is above the deck and inside the sail plan envelope.
   - `cg` resolves and produces a backend shift within tolerance of the current provisional `GLTF_ORIGIN_IN_BODY = [0, 0, 0.86]`.
   - Verify `ce.main` actually exists in `web/public/lagoon-450s.manifest.json` before any backend migration step relies on it.
9. Export `sail-jib.glb` and `sail-main.glb` separately from the hull rig unless product size or load timing requires packing them later.

## 3. Frontend Cloth Instantiation

Replace the single hardcoded `SpinnakerSail` path with `SailClothInstance(config, rigLocators)`.

Implementation requirements:

1. Load `sailplan.lagoon-450s.json` before rendering sails.
2. Load `lagoon-450s.glb` and build a locator map by object name:
   - `Map<string, THREE.Object3D>`
   - fail fast if any configured `anchors.*` or `center_of_effort` name is missing.
3. For each enabled sail with `cloth.enabled = true`, load `config.glb_path`.
4. Find `mesh_name` exactly. Do not pick the first mesh.
5. Find `head.<sail>`, `tack.<sail>`, and `clew.<sail>` locator empties exactly.
6. Convert each locator position to the sail mesh local/rest coordinate frame.
7. Weld render vertices as today.
8. Resolve corner particles by nearest welded particle to the named locator. Enforce max distance:
   - warn at `> 0.01 m`
   - fail at `> 0.05 m`
9. Project physics rest positions onto the flat plane defined by the named `head`, `tack`, and `clew` particles. The raw mesh remains the render surface; physics particles and spring rest lengths use the projected rest positions. This is required for the current cloth solver and must happen after welding/corner lookup and before spring construction.
10. Build springs from mesh topology using the projected rest positions.
11. Compute the luff path as the shortest mesh-edge path from head to tack. If `luff_mode = "pinned_chord"`, pin or chord-stabilize that path according to the current luff-pin implementation; if `luff_mode = "free"`, leave it unconstrained.
12. Apply pin/rope/constraint modes from config:
    - `pin_to_anchor`: particle target is the named rig anchor position in sail/glTF frame.
    - `pin_to_rest`: particle target is its rest position.
    - `rope_to_anchor`: build a unilateral rope from corner particle to the selected anchor and drive rest length from the corresponding slack binding.
    - `free`: no constraint.
    - `sheet_constraint`: future XPBD/unilateral sheet constraint; not required to land the data model.
13. Resolve the active sheet anchor:
    - `"port"` -> `anchors.sheet_port`
    - `"starboard"` -> `anchors.sheet_starboard`
    - `"auto_leeward"` -> select the leeward side from current apparent wind; if unresolved, keep the last active side.
14. Compute aerodynamic force/wrench per triangle as today.
15. Sum cloth wrench about glTF origin `(0,0,0)` and POST body-frame force/torque. Do not shift to CG in frontend.
16. Tag each wrench with `sail_id` when backend supports multi-sail cloth overrides. Until then, sum all cloth sail forces in the frontend and POST the existing single `f_body` / `tau_body` payload.

Frontend validation:

- A missing locator name is a startup error, not a silent heuristic fallback.
- The current jib must reproduce the owner-approved rig using only config and named locators: head pinned, tack rope to `anchor.ring.tack`, clew sheet rope to the active sheet lead, and `luff_mode` respected.
- Removing highest/nearest/farthest corner heuristics is part of done.

## 4. Backend Sail Construction

Backend should deserialize the same `sailplan.lagoon-450s.json` into a Rust config type and build `CatParams.sails: Vec<Foil>`. It must resolve `web/public` paths from both supported cwd layouts, matching `ServeDir`: `skiff/web/public/...` when launched from a parent checkout, otherwise `web/public/...`.

Mapping:

- `coefficient_sets[set_id].area_m2` -> `Foil.area`
- `aspect_ratio` -> `Foil.aspect_ratio`
- `cd0` -> `Foil.cd0`
- `stall_deg` -> `Foil.stall_deg`
- `oswald` -> `Foil.oswald`
- `id` -> `Foil.name`
- `center_of_effort` locator position -> `Foil.r`
- `reefable` -> sail area scales by `1.0 - control.reef` for that sail only
- `sheet.min_deg/max_deg` -> sheet angle mapping for that sail

Frame conversion:

1. Read `cg` and `ce.<sail>` in glTF coordinates.
2. Convert `cg` to body axes with section 2.1 and derive `GLTF_ORIGIN_IN_BODY` from that locator at config load. This replaces the provisional cg-height-derived constant.
3. Convert `ce.<sail>` to body axes with section 2.1:
   - `v_body = [v_gltf.z, v_gltf.x, -v_gltf.y]`
4. Convert from glTF origin reference to backend CG reference:
   - `r_body_cg = v_body - GLTF_ORIGIN_IN_BODY`
5. Store `r_body_cg` in `Foil.r`.

Force application:

- Replace `CatParams.sail: Foil` with `CatParams.sails: Vec<Foil>`.
- In `cat_forces`, iterate active sails and sum `coefficient_sail_wrench`.
- Use the per-sail sheet mapping. The current global `control.sail_trim` may drive all sails for v1; the config still carries per-sail ranges.
- If a fresh cloth override exists for a sail, replace/blend that sail's coefficient wrench only. If the transport remains a single summed cloth wrench for v1, blend the summed cloth wrench against the summed coefficient wrench.

Backend validation:

- Unit test `ce.jib` conversion maps a known `+z_gltf` offset to positive body surge.
- Unit test every configured `center_of_effort` resolves.
- Unit test the `cg` locator-derived `GLTF_ORIGIN_IN_BODY` is within tolerance of the current value `[0.0, 0.0, 0.86]` until the model-origin/CG calibration is intentionally changed.
- Unit test `GLTF_ORIGIN_IN_BODY` shift is applied once, not in both frontend and backend.
- Headless server still sails with no browser open.

## 5. Migration Steps

Smallest-first sequence:

1. Add `web/public/sailplan.lagoon-450s.json` with the concrete config above, using current jib values and placeholder main values.
2. Add missing Blender/export locators:
   - `head.jib`, `tack.jib`, `clew.jib`
   - `anchor.ring.tack`
   - `anchor.halyard.jib`
   - `anchor.sheet.starboard` mapped to the current real lead near the helm (`Object.122`)
   - `anchor.sheet.port`
   - confirm existing `cg` and `ce.jib`
3. Update `lagoon-450s.manifest.json` to list all new locators.
4. In frontend, load the JSON and use it only to find the current jib GLB path. Keep current hardcoded corner detection for this step.
5. Switch current jib corner detection to named locator lookup. Delete highest/nearest/farthest heuristics after this passes.
6. Add flat rest projection from named head/tack/clew before spring construction. Verify rendered mesh still uses the raw mesh positions while physics uses projected rest positions.
7. Switch current jib anchors to named rig locators. Delete `TACK_ANCHOR` and any remaining sheet/clew hardcoded vectors after this passes.
8. Drive tack-line slack, sheet slack, and fullness from `tackline_slack_binding`, `sheet_slack_binding`, and `fullness_binding`. Rename the UI setting behind edge tension to `settings.sailFullness` when this lands.
9. Keep current single-sail `SpinnakerSail` component behavior but rename internally to generic `SailClothInstance`.
10. Instantiate enabled cloth sails by iterating config. Initially only `jib.cloth.enabled = true`.
11. Backend: deserialize the same config and build one `Foil` for `jib` from `coefficient_sets` + `ce.jib`. Keep old `CatParams.sail` in parallel for one commit if needed for comparison.
12. Backend: derive `GLTF_ORIGIN_IN_BODY` from `cg` at config load and add the tolerance test against `[0.0, 0.0, 0.86]`.
13. Replace `CatParams.sail` with `CatParams.sails: Vec<Foil>` and sum coefficient wrenches.
14. Verify `ce.main` exists in `web/public/lagoon-450s.manifest.json`; only then add `main` coefficient sail from config with `cloth.enabled = false`.
15. Add per-sail sheet angle ranges and reef handling. `reef` affects `main` only until a reefable headsail is configured.
16. Extend cloth wrench transport to carry `sail_id` or an array of sail wrenches. Until that lands, summed frontend cloth wrench remains acceptable for the single enabled cloth sail.
17. Add `sail-main.glb`, `head.main`, `tack.main`, `clew.main`, `ce.main`, and main anchors. Turn on `main.cloth.enabled` only after locator validation and visual stability pass.

Done when:

- Current jib can be rendered and simulated with no hardcoded GLB path, corner heuristic, or anchor vector in `SpinnakerSail`.
- Backend coefficient sails are built from config, not from a single hardcoded `p.sail`.
- A disabled hypothetical main can exist in config without frontend or backend code changes.
- Enabling a second coefficient sail requires only config + exported locators.
