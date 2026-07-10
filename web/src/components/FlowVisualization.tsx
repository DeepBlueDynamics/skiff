import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimulator } from '../sim/store';
import { degToRad, waveElevation } from '../sim/math';

interface FlowParticle {
  x: number;
  y: number; // horizontal northing coordinate
  z: number; // vertical height off water surface
  age: number;
  maxAge: number;
  speedScale: number;
  zOffset?: number; // fixed height/depth for wind & 3D current particles
  vx?: number; // per-particle extra velocity (wake spread)
  vy?: number;
  size?: number;
}

export function FlowVisualization() {
  const settings = useSimulator((state) => state.settings);
  const boat = useSimulator((state) => state.boat);

  const windMeshRef = useRef<THREE.InstancedMesh>(null);
  const currentMeshRef = useRef<THREE.InstancedMesh>(null);
  const surfaceMeshRef = useRef<THREE.InstancedMesh>(null);
  const wakeMeshRef = useRef<THREE.InstancedMesh>(null);
  const propMeshRef = useRef<THREE.InstancedMesh>(null);
  const propCursor = useRef(0);

  // Wind: half the visual density of the old field, spread over 4x the area
  // and a full-3D vertical band reaching ~2x masthead (42m).
  const windCount = 700;
  const windBoundary = 60;
  const WIND_Z_MIN = 0.5;
  const WIND_Z_MAX = 42;

  // Current SET indicator (instrument, not physics): water moving relative to
  // the boat can never reveal the current's direction — the water IS the
  // current. These cyan markers drift in the current's true world direction
  // at its true speed, floating just above the surface so the water plane
  // can't swallow them. They respond instantly to the current sliders.
  const currentCount = 200;
  const currentBoundary = 45;
  const CURR_Z_MIN = -0.1; // 10cm below the surface — renderOrder keeps them visible
  const CURR_Z_MAX = -0.1;

  // Surface water flow (deep purple): shows the water sliding past the hull
  // at the surface.
  const surfaceCount = 260;
  const surfaceBoundary = 45;

  // Wake: white foam spawned at the bows (streaks sweeping aft along the
  // hulls) and at the sterns (trailing turbulent band). Pool-based. Long
  // stern lifetimes so the trail extends 30-50m behind the boat at speed.
  const wakeCount = 2400; // sized for doubled trail lifetimes at max spawn rate

  // Prop wash: tight underwater bubble columns from the actual prop positions
  // measured in lagoon-450s.glb: fore-aft -6.18m, beam ±2.671m, depth -0.51m.
  const propCount = 300;
  const PROP_FWD = -6.18;
  const PROP_BEAM = 2.671;
  const PROP_DEPTH = -0.51;

  const { windParticles, currentParticles, surfaceParticles, wakeParticles, propParticles } = useMemo(() => {
    const wind: FlowParticle[] = [];
    const curr: FlowParticle[] = [];
    const surf: FlowParticle[] = [];
    const wake: FlowParticle[] = [];
    for (let i = 0; i < windCount; i++) {
      wind.push({
        x: (Math.random() - 0.5) * windBoundary * 2,
        y: (Math.random() - 0.5) * windBoundary * 2,
        z: 0,
        age: Math.random() * 2.5,
        maxAge: 1.5 + Math.random() * 1.5,
        speedScale: 0.85 + Math.random() * 0.3,
        zOffset: WIND_Z_MIN + Math.random() * (WIND_Z_MAX - WIND_Z_MIN),
      });
    }
    for (let i = 0; i < currentCount; i++) {
      curr.push({
        x: (Math.random() - 0.5) * currentBoundary * 2,
        y: (Math.random() - 0.5) * currentBoundary * 2,
        z: 0,
        age: Math.random() * 3.5,
        maxAge: 2.5 + Math.random() * 2.0,
        speedScale: 0.9 + Math.random() * 0.2,
        zOffset: CURR_Z_MIN + Math.random() * (CURR_Z_MAX - CURR_Z_MIN),
      });
    }
    for (let i = 0; i < surfaceCount; i++) {
      surf.push({
        x: (Math.random() - 0.5) * surfaceBoundary * 2,
        y: (Math.random() - 0.5) * surfaceBoundary * 2,
        z: 0,
        age: Math.random() * 4,
        maxAge: 3.0 + Math.random() * 2.5,
        speedScale: 0.9 + Math.random() * 0.2,
      });
    }
    for (let i = 0; i < wakeCount; i++) {
      // Dead pool at start: age past maxAge so slots are recycled on demand
      wake.push({ x: 0, y: 0, z: 0.06, age: 99, maxAge: 1, speedScale: 1, vx: 0, vy: 0, size: 0 });
    }
    const prop: FlowParticle[] = [];
    for (let i = 0; i < propCount; i++) {
      prop.push({ x: 0, y: 0, z: PROP_DEPTH, age: 99, maxAge: 1, speedScale: 1, vx: 0, vy: 0, size: 0 });
    }
    return { windParticles: wind, currentParticles: curr, surfaceParticles: surf, wakeParticles: wake, propParticles: prop };
  }, []);

  // Flat circle for prop-wash bubbles
  const bubbleGeometry = useMemo(() => {
    const geo = new THREE.CircleGeometry(0.5, 10);
    geo.rotateX(-Math.PI / 2); // face up
    return geo;
  }, []);

  const tempObject = useMemo(() => new THREE.Object3D(), []);
  const propWashAccPort = useRef(0);
  const propWashAccStbd = useRef(0);

  // Flat 2D chevron ">" for the current-set indicators, lying on the water,
  // tip pointing toward -Z (north at zero rotation, same convention as the
  // boat model's -heading rotation).
  const chevronGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.4, -0.3);
    shape.lineTo(0, 0.5);
    shape.lineTo(0.4, -0.3);
    shape.lineTo(0.28, -0.38);
    shape.lineTo(0, 0.12);
    shape.lineTo(-0.28, -0.38);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2); // lay flat: shape +Y becomes world -Z (forward)
    return geo;
  }, []);
  const wakeCursor = useRef(0);
  const wakeSpawnAcc = useRef(0);
  // Wave phase on the backend clock (same pattern as Water.tsx) so surface
  // particles ride the SAME wave the mesh renders and the hull feels.
  const waveClock = useRef({ t: 0, lastSample: -1 });

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05);

    const wc = waveClock.current;
    wc.t += Math.min(delta, 0.2);
    if (boat.simTimeS !== undefined && boat.simTimeS !== wc.lastSample) {
      wc.t = boat.simTimeS;
      wc.lastSample = boat.simTimeS;
    }
    // Local sea-surface elevation (display east/north). Particles store
    // SURFACE-RELATIVE heights in p.z; add η at render so foam sits on the
    // moving sea, not on flat-water level.
    const seaEta =
      settings.waveHeightM > 0.001
        ? (east: number, north: number) =>
            waveElevation(east, north, wc.t, settings.waveHeightM, settings.wavePeriodS, settings.waveToDeg)
        : () => 0;

    // 1. Apparent wind flow (air) relative to the boat
    const windSpeed = settings.windSpeedMps;
    const windAngleRad = degToRad(settings.windToDeg);
    // TO-convention compass vector: east = sin, north = +cos (p.y IS northing;
    // the render mapping (-p.y -> three Z) handles the north/-Z flip).
    const windVx = windSpeed * Math.sin(windAngleRad);
    const windVy = windSpeed * Math.cos(windAngleRad);
    const windVx_rel = windVx - (boat.velocityGround?.x ?? 0);
    const windVy_rel = windVy - (boat.velocityGround?.y ?? 0);
    const relWindAngleRad = Math.atan2(windVx_rel, windVy_rel);

    // 2. Water flow past the hull. Water parcels ride the current, so from
    // the boat's frame ALL water moves at exactly minus the through-water
    // velocity: an anchored boat sees the current stream by; a sailing boat
    // sees water going by at STW. (The old `current − velocityWater` form
    // double-counted the current and visually locked the field to the boat.)
    const waterVx_rel = -(boat.velocityWater?.x ?? 0);
    const waterVy_rel = -(boat.velocityWater?.y ?? 0);
    const relWaterAngleRad = Math.atan2(waterVx_rel, waterVy_rel);
    const stw = Math.hypot(waterVx_rel, waterVy_rel);

    // Boat axes in world (east/north) for wake spawn points
    const hRad = degToRad(boat.headingDeg);
    const fwdE = Math.sin(hRad);
    const fwdN = Math.cos(hRad);
    const stbE = Math.cos(hRad);
    const stbN = -Math.sin(hRad);

    // 3. Wind particles (golden, 3D air band)
    if (windMeshRef.current && settings.showVectors) {
      const mesh = windMeshRef.current;
      for (let i = 0; i < windCount; i++) {
        const p = windParticles[i];
        p.age += dt;
        p.x += windVx_rel * p.speedScale * dt;
        p.y += windVy_rel * p.speedScale * dt;
        if (p.x > windBoundary) p.x -= windBoundary * 2;
        else if (p.x < -windBoundary) p.x += windBoundary * 2;
        if (p.y > windBoundary) p.y -= windBoundary * 2;
        else if (p.y < -windBoundary) p.y += windBoundary * 2;
        if (p.age > p.maxAge) {
          p.age = 0;
          p.x = (Math.random() - 0.5) * windBoundary * 2;
          p.y = (Math.random() - 0.5) * windBoundary * 2;
          p.maxAge = 1.5 + Math.random() * 1.5;
        }
        p.z = p.zOffset || 1.5;
        const fade = Math.sin((p.age / p.maxAge) * Math.PI);
        tempObject.position.set(p.x, p.z, -p.y);
        tempObject.rotation.set(0, relWindAngleRad, 0);
        tempObject.scale.set(fade * 1.2, fade * 1.2, fade * 1.2);
        tempObject.updateMatrix();
        mesh.setMatrixAt(i, tempObject.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Current SET vector in world frame (instrument overlay)
    const setSpeed = settings.currentSpeedMps;
    const setAngleRad = degToRad(settings.currentToDeg);
    const setVx = setSpeed * Math.sin(setAngleRad);
    const setVy = setSpeed * Math.cos(setAngleRad);

    // 4. Current SET indicators (cyan, instrument): drift with the current's
    // true world vector so changing the current sliders is instantly visible.
    if (currentMeshRef.current && settings.showCurrent) {
      const mesh = currentMeshRef.current;
      for (let i = 0; i < currentCount; i++) {
        const p = currentParticles[i];
        p.age += dt;
        p.x += setVx * p.speedScale * dt;
        p.y += setVy * p.speedScale * dt;
        if (p.x > currentBoundary) p.x -= currentBoundary * 2;
        else if (p.x < -currentBoundary) p.x += currentBoundary * 2;
        if (p.y > currentBoundary) p.y -= currentBoundary * 2;
        else if (p.y < -currentBoundary) p.y += currentBoundary * 2;
        if (p.age > p.maxAge) {
          p.age = 0;
          p.x = (Math.random() - 0.5) * currentBoundary * 2;
          p.y = (Math.random() - 0.5) * currentBoundary * 2;
          p.maxAge = 2.5 + Math.random() * 2.0;
        }
        p.z = p.zOffset ?? -0.1;
        const fade = Math.sin((p.age / p.maxAge) * Math.PI);
        tempObject.position.set(p.x, seaEta(p.x, p.y) + p.z, -p.y);
        // -angle: chevron forward is -Z, same convention as the boat's -heading
        tempObject.rotation.set(0, -setAngleRad, 0);
        tempObject.scale.set(fade * 0.225 + 0.001, 1, fade * 0.225 + 0.001);
        tempObject.updateMatrix();
        mesh.setMatrixAt(i, tempObject.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // 5. Surface water flow (deep purple) — the water going by
    if (surfaceMeshRef.current && settings.showCurrent) {
      const mesh = surfaceMeshRef.current;
      for (let i = 0; i < surfaceCount; i++) {
        const p = surfaceParticles[i];
        p.age += dt;
        p.x += waterVx_rel * p.speedScale * dt;
        p.y += waterVy_rel * p.speedScale * dt;
        if (p.x > surfaceBoundary) p.x -= surfaceBoundary * 2;
        else if (p.x < -surfaceBoundary) p.x += surfaceBoundary * 2;
        if (p.y > surfaceBoundary) p.y -= surfaceBoundary * 2;
        else if (p.y < -surfaceBoundary) p.y += surfaceBoundary * 2;
        if (p.age > p.maxAge) {
          p.age = 0;
          p.x = (Math.random() - 0.5) * surfaceBoundary * 2;
          p.y = (Math.random() - 0.5) * surfaceBoundary * 2;
          p.maxAge = 3.0 + Math.random() * 2.5;
        }
        p.z = 0.05;
        const fade = Math.sin((p.age / p.maxAge) * Math.PI);
        tempObject.position.set(p.x, seaEta(p.x, p.y) + p.z, -p.y);
        tempObject.rotation.set(0, relWaterAngleRad, 0);
        tempObject.scale.set(fade * 1.5, fade * 0.6, fade * 1.5);
        tempObject.updateMatrix();
        mesh.setMatrixAt(i, tempObject.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // 6. Wake — white foam, physically advected with the water.
    // Bow streaks: spawn at each bow when the boat has way on, sweeping aft
    // with a slight outward (Kelvin-ish) spread. Stern band: spawn behind
    // each transom, longer-lived, spreading wider. Spawn rate scales with STW.
    if (wakeMeshRef.current) {
      const mesh = wakeMeshRef.current;

      // EMERGENT hull wake: foam is born along the keel line INSIDE each
      // nacelle (measured centerlines ±2.67m, forefoot +6.0 to transom -6.9,
      // keel depth ~-0.7m). It carries NO directional ejection velocity —
      // only the water advection moves it, so under way it streams out of the
      // stern, and under leeway it emerges through the leeward side of the
      // hull, entirely emergently. The opaque hull occludes foam until the
      // relative flow carries it clear. Do not add hardcoded lateral pushes.
      const spawnWake = (fwd: number, side: number, life: number, size: number) => {
        const p = wakeParticles[wakeCursor.current];
        wakeCursor.current = (wakeCursor.current + 1) % wakeCount;
        p.x = fwd * fwdE + side * stbE + (Math.random() - 0.5) * 0.4;
        p.y = fwd * fwdN + side * stbN + (Math.random() - 0.5) * 0.4;
        p.z = -0.75 + Math.random() * 0.3; // keel-line depth band
        p.age = 0;
        p.maxAge = life;
        p.speedScale = 0.95 + Math.random() * 0.1;
        // isotropic micro-turbulence only — no directional bias
        p.vx = (Math.random() - 0.5) * 0.12;
        p.vy = (Math.random() - 0.5) * 0.12;
        p.size = size;
      };

      if (stw > 0.3) {
        wakeSpawnAcc.current += Math.min(stw * 24, 120) * dt;
        while (wakeSpawnAcc.current >= 1) {
          wakeSpawnAcc.current -= 1;
          const side = Math.random() < 0.5 ? -2.67 : 2.67;
          const along = 6.0 - Math.random() * 12.9; // forefoot..transom
          const life = 4 + Math.random() * 24; // mixed: near foam + long trail
          const size = (0.7 + Math.random() * 0.9);
          spawnWake(along, side, life, size);
        }
      }

      for (let i = 0; i < wakeCount; i++) {
        const p = wakeParticles[i];
        p.age += dt;
        if (p.age >= p.maxAge) {
          tempObject.position.set(0, -50, 0); // park dead particles underwater
          tempObject.scale.set(0.0001, 0.0001, 0.0001);
          tempObject.updateMatrix();
          mesh.setMatrixAt(i, tempObject.matrix);
          continue;
        }
        // Foam rides the water: young foam carries its ejection spread, but it
        // decays with age so old foam moves exactly with the water particles
        // (the purple surface flow).
        const lifeT = p.age / p.maxAge;
        const spreadDecay = Math.max(0, 1 - lifeT);
        p.x += (waterVx_rel * p.speedScale + (p.vx ?? 0) * spreadDecay) * dt;
        p.y += (waterVy_rel * p.speedScale + (p.vy ?? 0) * spreadDecay) * dt;
        // Buoyant rise from the keel-depth birth line toward the surface —
        // foam becomes visible as it clears the hull and floats up.
        p.z = Math.min(p.z + 0.35 * dt, -0.04);
        const fade = Math.sin(Math.min(lifeT, 1) * Math.PI);
        const grow = 1 + lifeT * 1.6; // foam patch spreads as it ages
        // Real vertical thickness so foam still reads at grazing camera
        // angles — a flat quad projects to nothing edge-on.
        tempObject.position.set(p.x, seaEta(p.x, p.y) + p.z, -p.y);
        tempObject.rotation.set(0, relWaterAngleRad, 0);
        const s = (p.size ?? 0.5) * grow * 0.93; // 7% smaller overall
        tempObject.scale.set(s * fade + 0.001, s * fade * 0.22 + 0.001, s * fade + 0.001);
        tempObject.updateMatrix();
        mesh.setMatrixAt(i, tempObject.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // 7. Prop wash: tight underwater bubble columns from the ACTUAL prop
    // positions, jetted opposite thrust, rising slowly toward the surface.
    if (propMeshRef.current) {
      const mesh = propMeshRef.current;

      const spawnProp = (acc: { current: number }, thrust: number, side: number) => {
        const mag = Math.abs(thrust);
        if (mag < 50) return;
        acc.current += Math.min((mag / 3000) * 30, 30) * dt;
        while (acc.current >= 1) {
          acc.current -= 1;
          const p = propParticles[propCursor.current];
          propCursor.current = (propCursor.current + 1) % propCount;
          // Tight column: only a few cm of jitter around the prop hub
          p.x = PROP_FWD * fwdE + side * stbE + (Math.random() - 0.5) * 0.12;
          p.y = PROP_FWD * fwdN + side * stbN + (Math.random() - 0.5) * 0.12;
          p.z = PROP_DEPTH + (Math.random() - 0.5) * 0.15;
          p.age = 0;
          p.maxAge = 1.6 + Math.random() * 1.2;
          p.speedScale = 1;
          const jet = -(thrust / 3000) * 3.0; // aft jet ahead, fwd jet in reverse
          p.vx = fwdE * jet + (Math.random() - 0.5) * 0.15;
          p.vy = fwdN * jet + (Math.random() - 0.5) * 0.15;
          p.size = 0.12 + Math.random() * 0.12; // much smaller than wake foam
        }
      };
      // Node "prop.port" (driven by thrustPort) sits on the visual starboard
      // side in this mirrored-label model — wash must come from the prop that
      // visibly spins.
      spawnProp(propWashAccPort, boat.thrustPort ?? 0, PROP_BEAM);
      spawnProp(propWashAccStbd, boat.thrustStbd ?? 0, -PROP_BEAM);

      for (let i = 0; i < propCount; i++) {
        const p = propParticles[i];
        p.age += dt;
        if (p.age >= p.maxAge) {
          tempObject.position.set(0, -50, 0);
          tempObject.scale.set(0.0001, 0.0001, 0.0001);
          tempObject.updateMatrix();
          mesh.setMatrixAt(i, tempObject.matrix);
          continue;
        }
        const lifeT = p.age / p.maxAge;
        const decay = Math.max(0, 1 - lifeT);
        p.x += (waterVx_rel + (p.vx ?? 0) * decay) * dt;
        p.y += (waterVy_rel + (p.vy ?? 0) * decay) * dt;
        p.z = Math.min(p.z + 0.2 * dt, -0.06); // bubbles rise, stay submerged
        const fade = Math.sin(Math.min(lifeT, 1) * Math.PI);
        const s = (p.size ?? 0.15) * (1 + lifeT * 0.8);
        tempObject.position.set(p.x, seaEta(p.x, p.y) + p.z, -p.y);
        tempObject.rotation.set(0, 0, 0);
        tempObject.scale.set(s * fade + 0.001, 1, s * fade + 0.001);
        tempObject.updateMatrix();
        mesh.setMatrixAt(i, tempObject.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group position={[boat.position.x, 0, -boat.position.y]}>
      {/* Wind Flow Particles (Tiny golden squares in the air) */}
      {/* renderOrder keeps every particle layer drawing AFTER the water plane —
          otherwise the transparent sort flips with camera angle and the water
          washes the particles out (same failure class as the sail clipping). */}
      {settings.showVectors && (
        <instancedMesh ref={windMeshRef} args={[null as any, null as any, windCount]} renderOrder={3} frustumCulled={false} castShadow={false} receiveShadow={false}>
          <boxGeometry args={[0.07, 0.07, 0.07]} />
          <meshBasicMaterial
            color="#ffd700"
            transparent
            opacity={0.88}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </instancedMesh>
      )}

      {/* Current SET indicators (cyan instrument, floats just above surface) */}
      {settings.showCurrent && (
        <instancedMesh ref={currentMeshRef} args={[null as any, null as any, currentCount]} renderOrder={2} frustumCulled={false} castShadow={false} receiveShadow={false}>
          <primitive object={chevronGeometry} attach="geometry" />
          <meshBasicMaterial
            color="#00f0ff"
            transparent
            opacity={0.35}
            depthWrite={false}
            side={THREE.DoubleSide}
            blending={THREE.AdditiveBlending}
          />
        </instancedMesh>
      )}

      {/* Surface water flow (deep purple squares riding the surface) */}
      {settings.showCurrent && (
        <instancedMesh ref={surfaceMeshRef} args={[null as any, null as any, surfaceCount]} renderOrder={2} frustumCulled={false} castShadow={false} receiveShadow={false}>
          <boxGeometry args={[0.18, 0.012, 0.18]} />
          <meshBasicMaterial
            color="#7c3aed"
            transparent
            opacity={0.85}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </instancedMesh>
      )}

      {/* Wake foam (bow streaks + stern band) — original subtle look. The
          hard angle-disappearance was NEVER blending: the whole InstancedMesh
          was frustum-culled via its 1m base-geometry bounds at the boat
          origin; frustumCulled={false} is the fix. */}
      <instancedMesh ref={wakeMeshRef} args={[null as any, null as any, wakeCount]} renderOrder={4} frustumCulled={false} castShadow={false} receiveShadow={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.11}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>

      {/* Prop wash bubbles (small flat circles, underwater, per spinning prop) */}
      <instancedMesh ref={propMeshRef} args={[null as any, null as any, propCount]} renderOrder={4} frustumCulled={false} castShadow={false} receiveShadow={false}>
        <primitive object={bubbleGeometry} attach="geometry" />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.3}
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>
    </group>
  );
}
