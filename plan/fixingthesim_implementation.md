# Implementation Plan: Fixing the Sail Simulation and Boat Coupling

This document outlines the step-by-step plan to fix the sail cloth attachments, sum the aerodynamic wrench in the frontend, and pass it to the backend simulation as described in `plan/fixingthesim.md.txt`.

---

## 1. Sail Attachment Refinement (Frontend)

* **Current Issue**: The tack of the sail is connected to the bowsprit ring via a 25-node rope. However, the rest position of the tack corner in the geometry is already directly on top of the bowsprit ring (3.2 mm separation). This causes the rope to collapse into a single point, resulting in simulation instability. The clew has a line but no physical sheet lead or winch attachment.
* **Refined Attachment Plan**:
  * **Head**: Pinned directly to its rest position at the masthead.
  * **Tack**: Shackled **directly** to the ring on the bowsprit. We will set `parts[tackI].pinned = true` and target it directly to `TACK_ANCHOR = (-0.041, 2.028, 7.321)`.
  * **Clew**: Left **free-floating** as requested. We will disable the sheet rope simulation (`clewRope`) and its line rendering in the frontend.
  * **Rope Cleanups**: Eliminate the tack/clew rope calculations and rendering from `SpinnakerSail.tsx` since the tack is directly pinned and the clew is free-floating.

---

## 2. Summing the Aerodynamic Wrench (Frontend)

* **Goal**: Instead of using reaction forces on PBD constraint pins, we will integrate the total aerodynamic pressure force and moment acting on the sail triangles.
* **Mathematical Approach**:
  * For each triangle in the cloth mesh:
    * Compute the aerodynamic force:
      $$\mathbf{f}_{\text{tri}} = \mathbf{n} \cdot (\mathbf{n} \cdot \mathbf{f}_{\text{wind}}) \cdot A_{\text{tri}}$$
    * Compute the centroid of the triangle:
      $$\mathbf{c}_{\text{tri}} = \frac{\mathbf{p}_a + \mathbf{p}_b + \mathbf{p}_c}{3}$$
    * Compute the torque/moment relative to the boat's center of gravity or pivot point $\mathbf{r}_{\text{ref}}$:
      $$\boldsymbol{\tau}_{\text{tri}} = (\mathbf{c}_{\text{tri}} - \mathbf{r}_{\text{ref}}) \times \mathbf{f}_{\text{tri}}$$
  * Accumulate the forces and torques:
    * $\mathbf{f}_{\text{aero}} = \sum \mathbf{f}_{\text{tri}}$
    * $\boldsymbol{\tau}_{\text{aero}} = \sum \boldsymbol{\tau}_{\text{tri}}$
  * **Low-Pass Filtering**: Apply a low-pass filter (or average across physics substeps and frames) to smooth the raw aerodynamic loads before sending them to the backend.

---

## 3. Coordinate Frame Mapping (Frontend to Backend)

* **Transformation**:
  * The frontend cloth simulation is defined in Three.js coordinates (local to the boat group: +X starboard, +Y up, +Z forward).
  * The backend body frame uses a standard NED-ish orientation (+X forward, +Y starboard, +Z down).
  * Therefore, the mapping for both forces and torques from Three.js local space to backend body-fixed space is:
    $$\mathbf{v}_{\text{body}} = \begin{bmatrix} v_{\text{gltf}, z} \\ v_{\text{gltf}, x} \\ -v_{\text{gltf}, y} \end{bmatrix}$$
  * A unit test will be created to verify that positive forward surge results when a force is applied along the sail's forward axis.

---

## 4. Backend Wrench Endpoint (Rust Backend)

* **Endpoint**: Implement a new route `POST /v1/sim/sail_wrench` in `src/main.rs`.
* **Payload**:
  ```json
  {
    "f_body": [fx, fy, fz],
    "tau_body": [tx, ty, tz]
  }
  ```
* **Staleness Handling**:
  * Store the received wrench in `AppState` along with a timestamp.
  * In the physics thread (`src/main.rs`), if a wrench has not been received within a staleness timeout (e.g., 500ms), decay the external wrench back to the coefficient-based sail model or zero. This ensures the simulation remains stable and headlessly runnable if the frontend page is closed.

---

## 5. Backend Physics Integration & Rotation Correction

* **Matrix Typo Fix**:
  * In `src/cat_physics.rs` inside `rotation_body_to_world`, correct element (2,3) to:
    `spsi * sth * cphi - cpsi * sphi`
  * Add a unit test to verify $R \cdot R^T = I$ and ensure the round-trip vector check passes at non-zero pitch/heel.
* **Wind Direction Real-Weather Inversion**:
  * Map Open-Meteo's `wind_direction_10m` (wind *from*) to `wind_from_deg` and correctly invert it by 180 degrees at ingestion.
* **Telemetry Naming**:
  * Rename telemetry fields to clearly distinguish True Wind (TWS/TWA) from Apparent Wind (AWS/AWA) on SignalK and the HUD to prevent downstream instrument errors.
* **Force Coupling**:
  * Inside `cat_forces` in `src/cat_physics.rs`, wire the external sail wrench into the rigid body forces/moments vector `tau`.
