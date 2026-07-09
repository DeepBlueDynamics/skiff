import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useSimulator } from '../sim/store';

// Physics constants
const SUBSTEPS = 8;
const H = (1 / 60) / SUBSTEPS;
const H2 = H * H;
const DRAG = 0.994;
const ITER = 4;
const MAX_VEL = 0.4;
const SAIL_MASS_TOTAL = 25; // kg, spread over all particles

const WELD_EPS = 1e-3;

// Rig attachment points (glTF frame, boat-local — verified against lagoon-450s.glb)
const TACK_ANCHOR = new THREE.Vector3(-0.041, 2.028, 7.321); // Object.541 tack ring on the bowsprit
const CLEW_ANCHOR = new THREE.Vector3(-3.9, 0.68, -6.8); // port-quarter sheet lead

class Particle {
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  rest: THREE.Vector3;
  force: THREE.Vector3;
  pinned: boolean;
  target: THREE.Vector3;

  constructor(p: THREE.Vector3) {
    this.pos = p.clone();
    this.prev = p.clone();
    this.rest = p.clone();
    this.force = new THREE.Vector3();
    this.pinned = false;
    this.target = p.clone();
  }
}

type Spring = [number, number, number, boolean, number];
// [partA, partB, restLen, isRope, baseLen]

export function SpinnakerSail() {
  const settings = useSimulator((state) => state.settings);

  // The real asymmetric sail exported from Blender — used as the cloth rest shape.
  const { scene: jibScene } = useGLTF('/sail-jib.glb');

  const sim = useMemo(() => {
    jibScene.updateMatrixWorld(true);
    let srcMesh: THREE.Mesh | null = null;
    jibScene.traverse((child) => {
      if (child instanceof THREE.Mesh && !srcMesh) srcMesh = child;
    });
    if (!srcMesh) throw new Error('sail-jib.glb contains no mesh');
    const src = srcMesh as THREE.Mesh;

    // Bake the node's world transform so positions are in the boat-local glTF frame
    const geometry = src.geometry.clone();
    geometry.applyMatrix4(src.matrixWorld);
    if (!geometry.index) {
      const seq = new Uint32Array(geometry.getAttribute('position').count);
      for (let i = 0; i < seq.length; i++) seq[i] = i;
      geometry.setIndex(new THREE.BufferAttribute(seq, 1));
    }

    const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const vertCount = posAttr.count;

    // Weld render vertices (split by UV/normal seams) into unique physics particles
    const weldMap = new Int32Array(vertCount); // render vertex -> particle index
    const parts: Particle[] = [];
    const cells = new Map<string, number[]>();
    const keyOf = (x: number, y: number, z: number) =>
      `${Math.round(x / WELD_EPS)},${Math.round(y / WELD_EPS)},${Math.round(z / WELD_EPS)}`;
    const v = new THREE.Vector3();
    for (let i = 0; i < vertCount; i++) {
      v.fromBufferAttribute(posAttr, i);
      const key = keyOf(v.x, v.y, v.z);
      let found = -1;
      const bucket = cells.get(key);
      if (bucket) {
        for (const pi of bucket) {
          if (parts[pi].rest.distanceToSquared(v) < WELD_EPS * WELD_EPS) {
            found = pi;
            break;
          }
        }
      }
      if (found < 0) {
        found = parts.length;
        parts.push(new Particle(v));
        if (bucket) bucket.push(found);
        else cells.set(key, [found]);
      }
      weldMap[i] = found;
    }
    const clothCount = parts.length;
    const MASS = SAIL_MASS_TOTAL / clothCount;

    // Unique triangles + unique edge springs from mesh topology
    const index = geometry.index!;
    const triangles: number[] = [];
    const springs: Spring[] = [];
    const edgeSeen = new Set<number>();
    const addSpring = (a: number, b: number) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const ek = lo * clothCount + hi;
      if (edgeSeen.has(ek)) return;
      edgeSeen.add(ek);
      const baseLen = parts[a].rest.distanceTo(parts[b].rest);
      springs.push([a, b, baseLen, false, baseLen]);
    };
    for (let t = 0; t < index.count; t += 3) {
      const a = weldMap[index.getX(t)];
      const b = weldMap[index.getX(t + 1)];
      const c = weldMap[index.getX(t + 2)];
      if (a === b || b === c || a === c) continue;
      triangles.push(a, b, c);
      addSpring(a, b);
      addSpring(b, c);
      addSpring(c, a);
    }
    const clothSpringCount = springs.length;

    // Corners: head = highest, tack = nearest the ring, clew = farthest from both
    let headI = 0;
    let tackI = 0;
    let bestTack = Infinity;
    for (let i = 0; i < clothCount; i++) {
      if (parts[i].rest.y > parts[headI].rest.y) headI = i;
      const d = parts[i].rest.distanceToSquared(TACK_ANCHOR);
      if (d < bestTack) {
        bestTack = d;
        tackI = i;
      }
    }
    let clewI = 0;
    let bestClew = -Infinity;
    for (let i = 0; i < clothCount; i++) {
      const d = parts[i].rest.distanceTo(parts[headI].rest) + parts[i].rest.distanceTo(parts[tackI].rest);
      if (d > bestClew) {
        bestClew = d;
        clewI = i;
      }
    }

    // Pin the head at the halyard; tack is pinned directly to the bowsprit ring
    parts[headI].pinned = true;
    parts[headI].target.copy(parts[headI].rest);

    parts[tackI].pinned = true;
    parts[tackI].target.copy(TACK_ANCHOR);

    // Clew is left free-flying

    const material = (Array.isArray(src.material) ? src.material[0] : src.material).clone();
    material.side = THREE.DoubleSide;

    return {
      parts,
      springs,
      clothSpringCount,
      triangles,
      clothCount,
      weldMap,
      MASS,
      headI,
      tackI,
      clewI,
      geometry,
      material,
    };
  }, [jibScene]);

  const accumulator = useRef(0);
  const filteredForce = useRef(new THREE.Vector3());
  const filteredTorque = useRef(new THREE.Vector3());
  const timeSinceLastPost = useRef(0);
  const seqRef = useRef(0);

  // Update physics at 60fps
  useFrame((state, delta) => {
    const { parts, springs, clothSpringCount, triangles, clothCount, weldMap, MASS, headI, tackI, clewI, geometry } = sim;

    const currentSimState = useSimulator.getState();
    const ws = currentSimState.boat.twsMps || 0;
    const wa = (currentSimState.boat.twaDeg || 0) * Math.PI / 180;
    const currentSettings = currentSimState.settings;

    // Apparent wind velocity vector in boat's local frame
    const windVelocity = new THREE.Vector3(-Math.sin(wa), -0.05, -Math.cos(wa)).normalize().multiplyScalar(ws);

    // Rotate gravity world-down (0, -9.8, 0) into the heeled/pitched boat local frame,
    // and then apply the Math.PI rotation around Y for the sail's coordinate system wrapper.
    const pitchRad = (currentSimState.boat.pitchDeg || 0) * Math.PI / 180;
    const heelRad = (currentSimState.boat.heelDeg || 0) * Math.PI / 180;
    const gravityLocal = new THREE.Vector3(0, -9.8, 0);
    const boatEuler = new THREE.Euler(pitchRad, 0, heelRad, 'XYZ');
    const boatQuat = new THREE.Quaternion().setFromEuler(boatEuler);
    gravityLocal.applyQuaternion(boatQuat.invert());
    gravityLocal.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    const gravityForce = gravityLocal.clone().multiplyScalar(MASS);

    // Slider parameters: edge tension scales the cloth rest lengths
    const edgeTensionFactor = currentSettings.spinnakerEdgeTension ?? 1.0;

    for (let i = 0; i < clothSpringCount; i++) {
      springs[i][2] = springs[i][4] * edgeTensionFactor;
    }

    // Accumulator for fixed-timestep display-rate-independent execution
    accumulator.current += Math.min(delta, 0.1);
    const FRAME_TIME = 1 / 60;
    
    let stepped = false;
    
    // Accumulators for the wrench (averaged over simulated time)
    const totalFrameForce = new THREE.Vector3();
    const totalFrameTorque = new THREE.Vector3();
    let stepCount = 0;

    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const nrm = new THREE.Vector3();

    while (accumulator.current >= FRAME_TIME) {
      // In each 60Hz physics frame, run SUBSTEPS integration steps
      const totalStepForce = new THREE.Vector3();
      const totalStepTorque = new THREE.Vector3();

      for (let sub = 0; sub < SUBSTEPS; sub++) {
        for (const p of parts) {
          p.force.copy(gravityForce);
        }

        const substepForce = new THREE.Vector3();
        const substepTorque = new THREE.Vector3();

        // Wind pressure per triangle (relative flow: windVelocity - clothVelocity)
        const Cp = 1.2;
        for (let t = 0; t < triangles.length; t += 3) {
          const ia = triangles[t];
          const ib = triangles[t + 1];
          const ic = triangles[t + 2];
          
          ab.subVectors(parts[ib].pos, parts[ia].pos);
          ac.subVectors(parts[ic].pos, parts[ia].pos);
          nrm.crossVectors(ab, ac);
          const area = nrm.length() * 0.5;
          if (area > 1e-9) {
            nrm.normalize();
            
            // Cloth velocity at triangle centroid
            const vax = (parts[ia].pos.x - parts[ia].prev.x) / H;
            const vay = (parts[ia].pos.y - parts[ia].prev.y) / H;
            const vaz = (parts[ia].pos.z - parts[ia].prev.z) / H;
            
            const vbx = (parts[ib].pos.x - parts[ib].prev.x) / H;
            const vby = (parts[ib].pos.y - parts[ib].prev.y) / H;
            const vbz = (parts[ib].pos.z - parts[ib].prev.z) / H;
            
            const vcx = (parts[ic].pos.x - parts[ic].prev.x) / H;
            const vcy = (parts[ic].pos.y - parts[ic].prev.y) / H;
            const vcz = (parts[ic].pos.z - parts[ic].prev.z) / H;
            
            const vx = (vax + vbx + vcx) / 3;
            const vy = (vay + vby + vcy) / 3;
            const vz = (vaz + vbz + vcz) / 3;
            
            const rx = windVelocity.x - vx;
            const ry = windVelocity.y - vy;
            const rz = windVelocity.z - vz;
            
            const vn = rx * nrm.x + ry * nrm.y + rz * nrm.z;
            const q = 0.5 * 1.225 * Cp * vn * Math.abs(vn);
            
            // Total aerodynamic force vector on the triangle (not divided by 3)
            const fTri = nrm.clone().multiplyScalar(q * area);
            substepForce.add(fTri);
            
            // Centroid about mast base (origin)
            const cx = (parts[ia].pos.x + parts[ib].pos.x + parts[ic].pos.x) / 3;
            const cy = (parts[ia].pos.y + parts[ib].pos.y + parts[ic].pos.y) / 3;
            const cz = (parts[ia].pos.z + parts[ib].pos.z + parts[ic].pos.z) / 3;
            const centroid = new THREE.Vector3(cx, cy, cz);
            
            const tauTri = centroid.cross(fTri);
            substepTorque.add(tauTri);

            // Apply 1/3 of the force to each particle
            tmp2.copy(fTri).multiplyScalar(1 / 3);
            parts[ia].force.add(tmp2);
            parts[ib].force.add(tmp2);
            parts[ic].force.add(tmp2);
          }
        }

        totalStepForce.add(substepForce);
        totalStepTorque.add(substepTorque);

        // Verlet step with per-node velocity clamps (D4 force clamp removed)
        for (const p of parts) {
          if (p.pinned) continue;
          let vx = (p.pos.x - p.prev.x) * DRAG + (p.force.x / MASS) * H2;
          let vy = (p.pos.y - p.prev.y) * DRAG + (p.force.y / MASS) * H2;
          let vz = (p.pos.z - p.prev.z) * DRAG + (p.force.z / MASS) * H2;
          const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (speed > MAX_VEL) {
            const s = MAX_VEL / speed;
            vx *= s;
            vy *= s;
            vz *= s;
          }
          p.prev.copy(p.pos);
          p.pos.set(p.pos.x + vx, p.pos.y + vy, p.pos.z + vz);
        }

        // Snap pinned nodes to targets
        parts[headI].pos.copy(parts[headI].target);
        parts[headI].prev.copy(parts[headI].target);
        parts[tackI].pos.copy(parts[tackI].target);
        parts[tackI].prev.copy(parts[tackI].target);

        // Spring constraint relaxation
        for (let k = 0; k < ITER; k++) {
          for (const s of springs) {
            const p1 = parts[s[0]];
            const p2 = parts[s[1]];
            const rest = s[2];
            tmp.subVectors(p2.pos, p1.pos);
            const d = tmp.length();
            if (d < 1e-4) continue;
            if (s[3] && d <= rest) continue; // rope only pulls
            const m1 = p1.pinned ? 0 : 1;
            const m2 = p2.pinned ? 0 : 1;
            const sum = m1 + m2;
            if (sum === 0) continue;
            const f = (1 - rest / d) / sum;
            if (m1) p1.pos.addScaledVector(tmp, f);
            if (m2) p2.pos.addScaledVector(tmp, -f);
          }
          parts[headI].pos.copy(parts[headI].target);
          parts[tackI].pos.copy(parts[tackI].target);
        }
      }

      totalFrameForce.add(totalStepForce.multiplyScalar(1 / SUBSTEPS));
      totalFrameTorque.add(totalStepTorque.multiplyScalar(1 / SUBSTEPS));
      stepCount++;

      accumulator.current -= FRAME_TIME;
      stepped = true;
    }

    if (stepped && stepCount > 0) {
      const avgForce = totalFrameForce.multiplyScalar(1 / stepCount);
      const avgTorque = totalFrameTorque.multiplyScalar(1 / stepCount);

      // Low-pass EMA (cutoff frequency ~1.6Hz with 0.15s time constant)
      const EMA_TAU = 0.15; // seconds
      const emaAlpha = 1 - Math.exp(-FRAME_TIME / EMA_TAU);
      filteredForce.current.lerp(avgForce, emaAlpha);
      filteredTorque.current.lerp(avgTorque, emaAlpha);

      // POST to backend at ~15 Hz
      timeSinceLastPost.current += FRAME_TIME * stepCount;
      if (timeSinceLastPost.current >= 1 / 15) {
        timeSinceLastPost.current = 0;
        
        // Map to body coordinate frame: v_body = [v.z, v.x, -v.y]
        const f_body = [
          filteredForce.current.z,
          filteredForce.current.x,
          -filteredForce.current.y
        ];
        const tau_body = [
          filteredTorque.current.z,
          filteredTorque.current.x,
          -filteredTorque.current.y
        ];
        const seq = seqRef.current++;

        fetch('/v1/sim/sail_wrench', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seq, f_body, tau_body })
        }).catch(() => {
          // Fire-and-forget: stay silent on error/404
        });
      }
    }

    // NaN guard: reset to the Blender rest shape
    let hasNan = false;
    for (const p of parts) {
      if (!isFinite(p.pos.x) || !isFinite(p.pos.y) || !isFinite(p.pos.z)) {
        hasNan = true;
        break;
      }
    }
    if (hasNan) {
      console.warn('Sail simulation NaN detected — resetting to rest shape');
      for (const p of parts) {
        p.pos.copy(p.rest);
        p.prev.copy(p.rest);
        p.force.set(0, 0, 0);
      }
      filteredForce.current.set(0, 0, 0);
      filteredTorque.current.set(0, 0, 0);
    }

    if (stepped) {
      // Push particle positions back into the render geometry via the weld map
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i < weldMap.length; i++) {
        const p = parts[weldMap[i]].pos;
        arr[i * 3] = p.x;
        arr[i * 3 + 1] = p.y;
        arr[i * 3 + 2] = p.z;
      }
      posAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    }
  });

  return (
    <group>
      <mesh castShadow receiveShadow>
        <primitive object={sim.geometry} attach="geometry" />
        <primitive object={sim.material} attach="material" />
      </mesh>

      {/* Debug anchor spheres (visible when showRigPoints is toggled) */}
      {settings.showRigPoints && (
        <>
          <mesh position={TACK_ANCHOR}>
            <sphereGeometry args={[0.35, 16, 16]} />
            <meshStandardMaterial color="#7ce0a0" emissive="#3aa06a" emissiveIntensity={0.2} />
          </mesh>
          <mesh position={CLEW_ANCHOR}>
            <sphereGeometry args={[0.35, 16, 16]} />
            <meshStandardMaterial color="#7ce0a0" emissive="#3aa06a" emissiveIntensity={0.2} />
          </mesh>
        </>
      )}
    </group>
  );
}

useGLTF.preload('/sail-jib.glb');
