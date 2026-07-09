import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useSimulator } from '../sim/store';

// Physics constants
const SUBSTEPS = 8;
const H = (1 / 60) / SUBSTEPS;
const H2 = H * H;
const DRAG = 0.998;
const ITER = 6;
const MAX_VEL = 0.4;
const SAIL_MASS_TOTAL = 25; // kg, spread over all particles

const WELD_EPS = 1e-3;

// Rig attachment points (glTF frame, boat-local — verified against lagoon-450s.glb)
const TACK_ANCHOR = new THREE.Vector3(-0.041, 2.028, 7.321); // Object.541 tack ring on the bowsprit
// Object.122 traveler track ends (mirrored port/starboard), near the helm.
// In this frame +x renders on the visual PORT side of the boat.
const SHEET_LEAD_PORT = new THREE.Vector3(2.459, 2.108, -4.033);
const SHEET_LEAD_STARBOARD = new THREE.Vector3(-2.459, 2.108, -4.033);

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
  const setSailForces = useSimulator((state) => state.setSailForces);
  const sheetSide = useSimulator((state) => state.settings.sheetSide);

  // The real asymmetric sail exported from Blender — used as the cloth rest shape.
  const { scene: jibScene } = useGLTF('/sail-jib.glb');

  const sim = useMemo(() => {
    const CLEW_ANCHOR = sheetSide === 'port' ? SHEET_LEAD_PORT : SHEET_LEAD_STARBOARD;
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
    const getGridCoords = (val: number) => Math.round(val / WELD_EPS);
    const keyOfCoords = (gx: number, gy: number, gz: number) => `${gx},${gy},${gz}`;
    const v = new THREE.Vector3();
    for (let i = 0; i < vertCount; i++) {
      v.fromBufferAttribute(posAttr, i);
      const gx = getGridCoords(v.x);
      const gy = getGridCoords(v.y);
      const gz = getGridCoords(v.z);
      let found = -1;
      // Probe all 27 neighboring cells
      for (let dx = -1; dx <= 1 && found < 0; dx++) {
        for (let dy = -1; dy <= 1 && found < 0; dy++) {
          for (let dz = -1; dz <= 1 && found < 0; dz++) {
            const key = keyOfCoords(gx + dx, gy + dy, gz + dz);
            const bucket = cells.get(key);
            if (bucket) {
              for (const pi of bucket) {
                if (parts[pi].rest.distanceToSquared(v) < WELD_EPS * WELD_EPS) {
                  found = pi;
                  break;
                }
              }
            }
          }
        }
      }
      if (found < 0) {
        found = parts.length;
        parts.push(new Particle(v));
        const key = keyOfCoords(gx, gy, gz);
        const bucket = cells.get(key);
        if (bucket) {
          bucket.push(found);
        } else {
          cells.set(key, [found]);
        }
      }
      weldMap[i] = found;
    }
    const clothCount = parts.length;
    const MASS = SAIL_MASS_TOTAL / clothCount;

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

    // Flatten all particles' rest positions onto the plane defined by head, tack, and clew
    const pHead = parts[headI].rest.clone();
    const pTack = parts[tackI].rest.clone();
    const pClew = parts[clewI].rest.clone();

    const uVec = new THREE.Vector3().subVectors(pTack, pHead);
    const wVec = new THREE.Vector3().subVectors(pClew, pHead);
    const planeNormal = new THREE.Vector3().crossVectors(uVec, wVec).normalize();

    for (const p of parts) {
      const diff = new THREE.Vector3().subVectors(p.rest, pHead);
      const dotVal = diff.dot(planeNormal);
      p.rest.addScaledVector(planeNormal, -dotVal);
      p.pos.copy(p.rest);
      p.prev.copy(p.rest);
      p.target.copy(p.rest);
    }

    // Unique triangles + unique edge springs from mesh topology (using flattened rest)
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

    // Topological luff edge identification
    const edgeCounts = new Map<string, { a: number; b: number; count: number }>();
    const getEdgeKey = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;
    
    for (let t = 0; t < triangles.length; t += 3) {
      const ta = triangles[t];
      const tb = triangles[t + 1];
      const tc = triangles[t + 2];
      
      const edges = [
        [ta, tb],
        [tb, tc],
        [tc, ta]
      ];
      
      for (const [ea, eb] of edges) {
        const key = getEdgeKey(ea, eb);
        const entry = edgeCounts.get(key);
        if (entry) {
          entry.count++;
        } else {
          edgeCounts.set(key, { a: ea, b: eb, count: 1 });
        }
      }
    }
    
    const boundaryAdj = new Map<number, number[]>();
    for (const { a, b, count } of edgeCounts.values()) {
      if (count === 1) {
        if (!boundaryAdj.has(a)) boundaryAdj.set(a, []);
        if (!boundaryAdj.has(b)) boundaryAdj.set(b, []);
        boundaryAdj.get(a)!.push(b);
        boundaryAdj.get(b)!.push(a);
      }
    }
    
    const visited = new Set<number>();
    visited.add(clewI);
    visited.add(headI);
    
    const queue: number[][] = [[headI]];
    let luffNodes: number[] = [];
    
    while (queue.length > 0) {
      const path = queue.shift()!;
      const curr = path[path.length - 1];
      if (curr === tackI) {
        luffNodes = path;
        break;
      }
      const neighbors = boundaryAdj.get(curr) || [];
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push([...path, n]);
        }
      }
    }

    // Setup color attribute on geometry for pressure shading
    const colors = new Float32Array(geometry.getAttribute('position').count * 3).fill(0.92);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Pin the head at the halyard sheave
    parts[headI].pinned = true;
    parts[headI].target.copy(parts[headI].rest);

    // Build tack and clew ropes
    const buildRope = (cornerIdx: number, anchorPos: THREE.Vector3) => {
      const corner = parts[cornerIdx].pos.clone();
      const nodes = [cornerIdx];
      // Segment length must stay well above the solver's 1e-4 epsilon or every
      // rope constraint is skipped (a ~3mm tack line split 15 ways is invisible
      // to the solver and the corner drifts free). ~25cm per segment, min 1.
      const span = corner.distanceTo(anchorPos);
      const ROPE_SEG = Math.max(1, Math.min(15, Math.floor(span / 0.25)));
      for (let k = 1; k <= ROPE_SEG; k++) {
        parts.push(new Particle(corner.clone().lerp(anchorPos, k / ROPE_SEG)));
        nodes.push(parts.length - 1);
      }
      const anchorIdx = nodes[nodes.length - 1];
      parts[anchorIdx].pinned = true;
      parts[anchorIdx].target.copy(anchorPos);

      const springIndices: number[] = [];
      for (let k = 0; k < nodes.length - 1; k++) {
        const a = nodes[k];
        const b = nodes[k + 1];
        const baseLen = parts[a].pos.distanceTo(parts[b].pos);
        springs.push([a, b, baseLen, true, baseLen]);
        springIndices.push(springs.length - 1);
      }
      const baseSegLen = corner.distanceTo(anchorPos) / ROPE_SEG;
      return { nodes, anchorIdx, springIndices, baseSegLen };
    };

    const tackRope = buildRope(tackI, TACK_ANCHOR);
    const clewRope = buildRope(clewI, CLEW_ANCHOR);

    const material = (Array.isArray(src.material) ? src.material[0] : src.material).clone();
    material.side = THREE.DoubleSide;
    material.vertexColors = true;

    // Precompute shared edges list for crumple normal coherence check
    const edgeTriangles = new Map<string, number[]>();
    for (let t = 0; t < triangles.length; t += 3) {
      const tIdx = t / 3;
      const edges = [
        getEdgeKey(triangles[t], triangles[t + 1]),
        getEdgeKey(triangles[t + 1], triangles[t + 2]),
        getEdgeKey(triangles[t + 2], triangles[t])
      ];
      for (const edge of edges) {
        let list = edgeTriangles.get(edge);
        if (!list) {
          list = [];
          edgeTriangles.set(edge, list);
        }
        list.push(tIdx);
      }
    }

    const sharedEdgesList: number[] = [];
    for (const list of edgeTriangles.values()) {
      if (list.length === 2) {
        sharedEdgesList.push(list[0], list[1]);
      }
    }
    const sharedEdgeCount = sharedEdgesList.length / 2;
    const sharedEdgesArray = new Int32Array(sharedEdgesList);

    // Preallocated arrays for self-collision spatial hash & normal coherence
    const HASH_SIZE = 1024;
    const collisionHead = new Int32Array(HASH_SIZE);
    const collisionNext = new Int32Array(clothCount);
    const neighborMatrix = new Uint8Array(clothCount * clothCount);
    const triNormals = new Float32Array((triangles.length / 3) * 3);

    // Build neighbor matrix from cloth springs
    for (let i = 0; i < clothSpringCount; i++) {
      const s = springs[i];
      if (s[0] < clothCount && s[1] < clothCount) {
        neighborMatrix[s[0] * clothCount + s[1]] = 1;
        neighborMatrix[s[1] * clothCount + s[0]] = 1;
      }
    }

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
      luffNodes,
      tackRope,
      clewRope,
      clewAnchor: CLEW_ANCHOR,
      geometry,
      material,
      sharedEdgesArray,
      sharedEdgeCount,
      collisionHead,
      collisionNext,
      neighborMatrix,
      triNormals,
    };
  }, [jibScene, sheetSide]);

  const accumulator = useRef(0);
  const filteredForce = useRef(new THREE.Vector3());
  const filteredTorque = useRef(new THREE.Vector3());
  const filteredCentroid = useRef(new THREE.Vector3());
  
  const timeSinceLastPost = useRef(0);
  const timeSinceLastDebug = useRef(0);
  const timeSinceLastStoreUpdate = useRef(0);
  const seqRef = useRef(0);
  const hasLoggedCrumpled = useRef(false);

  const tackLineMesh = useMemo(() => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x7ce0a0 })), []);
  const clewLineMesh = useMemo(() => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd166 })), []);

  const forceArrow = useMemo(() => {
    return new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      1,
      0xdce8f2,
      0.8,
      0.4
    );
  }, []);

  // Cleanup debug object on unmount
  useEffect(() => {
    return () => {
      delete (window as any).__sailDebug;
    };
  }, []);

  // Update physics at 60fps
  useFrame((state, delta) => {
    const { parts, springs, clothSpringCount, triangles, clothCount, weldMap, MASS, headI, tackI, clewI, luffNodes, tackRope, clewRope, geometry, sharedEdgesArray, sharedEdgeCount, collisionHead, collisionNext, neighborMatrix, triNormals } = sim;

    const currentSimState = useSimulator.getState();
    const currentSettings = currentSimState.settings;

    const windSpeed = currentSettings.windSpeedMps || 0;
    const windAngleRad = (currentSettings.windToDeg || 0) * Math.PI / 180;

    // 1. Wind velocity in Three.js world frame (X: East, Z: South/neg-North)
    const wind_world = new THREE.Vector3(
      windSpeed * Math.sin(windAngleRad),
      0,
      -windSpeed * Math.cos(windAngleRad)
    );

    // 2. Boat velocity in Three.js world frame
    const cogRad = (currentSimState.boat.cogDeg || 0) * Math.PI / 180;
    const v_boat_world = new THREE.Vector3(
      (currentSimState.boat.sogMps || 0) * Math.sin(cogRad),
      0,
      -(currentSimState.boat.sogMps || 0) * Math.cos(cogRad)
    );

    // 3. Apparent wind in world frame (AW = wind - v_boat)
    const AW_world = new THREE.Vector3().subVectors(wind_world, v_boat_world);

    // 4. Transform AW_world to local sail frame using exact inverse of BoatModel group rotations
    const q_boat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        (currentSimState.boat.pitchDeg || 0) * Math.PI / 180,
        -(currentSimState.boat.headingDeg || 0) * Math.PI / 180,
        (currentSimState.boat.heelDeg || 0) * Math.PI / 180,
        'XYZ'
      )
    );
    const q_sail = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, Math.PI, 0, 'XYZ')
    );
    const q_cumulative = new THREE.Quaternion().multiplyQuaternions(q_boat, q_sail);
    const q_inv = q_cumulative.clone().invert();

    const windVelocity = AW_world.clone().applyQuaternion(q_inv);
    const windWorldDeg = (Math.atan2(AW_world.x, -AW_world.z) * 180 / Math.PI + 360) % 360;

    // Rotate gravity world-down (0, -9.8, 0) into the heeled/pitched boat local frame,
    // and then apply the Math.PI rotation around Y for the sail's coordinate system wrapper.
    const pitchRad = (currentSimState.boat.pitchDeg || 0) * Math.PI / 180;
    const heelRad = (currentSimState.boat.heelDeg || 0) * Math.PI / 180;
    const gravityLocal = new THREE.Vector3(0, -9.8, 0);
    const boatEuler = new THREE.Euler(pitchRad, 0, heelRad, 'XYZ');
    const boatQuat = new THREE.Quaternion().setFromEuler(boatEuler);
    gravityLocal.applyQuaternion(boatQuat.invert());
    gravityLocal.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    // Gravity force applied to particles
    const gravityForce = gravityLocal.clone().multiplyScalar(MASS);

    // Dynamic settings
    const tackSlackFactor = currentSettings.spinnakerTackSlack ?? 1.05;
    const clewSlackFactor = currentSettings.spinnakerClewSlack ?? 1.0;
    const sailFullnessFactor = currentSettings.sailFullness ?? 1.03;

    // Update rope slacks
    tackRope.springIndices.forEach((idx) => {
      springs[idx][2] = tackRope.baseSegLen * tackSlackFactor;
    });
    clewRope.springIndices.forEach((idx) => {
      springs[idx][2] = clewRope.baseSegLen * clewSlackFactor;
    });

    // Update cloth fullness rest lengths
    for (let i = 0; i < clothSpringCount; i++) {
      springs[i][2] = springs[i][4] * sailFullnessFactor;
    }

    // Dynamic forestay luff pinning
    const luffOn = currentSettings.luffPinned;
    for (const idx of luffNodes) {
      if (luffOn) {
        parts[idx].pinned = true;
        parts[idx].target.copy(parts[idx].rest);
      } else {
        if (idx === headI) {
          parts[idx].pinned = true;
        } else {
          parts[idx].pinned = false;
        }
      }
    }

    // Anchor points are always pinned
    parts[headI].pinned = true;
    parts[headI].target.copy(parts[headI].rest);
    parts[tackRope.anchorIdx].pinned = true;
    parts[tackRope.anchorIdx].target.copy(TACK_ANCHOR);
    parts[clewRope.anchorIdx].pinned = true;
    parts[clewRope.anchorIdx].target.copy(sim.clewAnchor);

    // Accumulator for fixed-timestep execution
    accumulator.current += Math.min(delta, 0.1);
    const FRAME_TIME = 1 / 60;
    
    let stepped = false;

    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const nrm = new THREE.Vector3();

    // Particle pressures for vertex shading
    const particlePressure = new Float32Array(clothCount);
    let stepAccumulated = 0;

    while (accumulator.current >= FRAME_TIME) {
      const totalStepForce = new THREE.Vector3();
      const totalStepTorque = new THREE.Vector3();
      const centroidAccum = new THREE.Vector3();
      let totalForceWeight = 0;

      for (let sub = 0; sub < SUBSTEPS; sub++) {
        // Initialize forces (gravity + windage)
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          const m = i < clothCount ? MASS : 0.05; // rope nodes are 0.05kg in the reference
          p.force.copy(gravityLocal).multiplyScalar(m);
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

            // Centroid accumulation for CE marker
            const fm = fTri.length();
            centroidAccum.addScaledVector(centroid, fm);
            totalForceWeight += fm;

            // Apply 1/3 of the force to each particle
            tmp2.copy(fTri).multiplyScalar(1 / 3);
            parts[ia].force.add(tmp2);
            parts[ib].force.add(tmp2);
            parts[ic].force.add(tmp2);

            // For pressure shading (accumulated per particle)
            particlePressure[ia] += fm;
            particlePressure[ib] += fm;
            particlePressure[ic] += fm;
          }
        }

        totalStepForce.add(substepForce);
        totalStepTorque.add(substepTorque);

        // Verlet integration step (no force clamps, only MAX_VEL explosion guard)
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p.pinned) continue;
          const m = i < clothCount ? MASS : 0.05;
          let vx = (p.pos.x - p.prev.x) * DRAG + (p.force.x / m) * H2;
          let vy = (p.pos.y - p.prev.y) * DRAG + (p.force.y / m) * H2;
          let vz = (p.pos.z - p.prev.z) * DRAG + (p.force.z / m) * H2;
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
        for (const p of parts) {
          if (p.pinned) {
            p.pos.copy(p.target);
            p.prev.copy(p.target);
          }
        }

        // Spring constraint relaxation (Gauss-Seidel PBD solver)
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
          for (const p of parts) {
            if (p.pinned) p.pos.copy(p.target);
          }
        }

        // Particle-level self-collision projection
        const HASH_SIZE = 1024;
        collisionHead.fill(-1);

        // 1. Build spatial hash over cloth particles each substep
        for (let i = 0; i < clothCount; i++) {
          const p = parts[i];
          const gx = Math.floor(p.pos.x / 0.10);
          const gy = Math.floor(p.pos.y / 0.10);
          const gz = Math.floor(p.pos.z / 0.10);
          const hashIdx = (Math.abs(gx * 73856093 ^ gy * 19349663 ^ gz * 83492791)) % HASH_SIZE;
          collisionNext[i] = collisionHead[hashIdx];
          collisionHead[hashIdx] = i;
        }

        // 2. Resolve self-collisions for particles within 0.10m that are not topological neighbors
        for (let i = 0; i < clothCount; i++) {
          const p1 = parts[i];
          const gx = Math.floor(p1.pos.x / 0.10);
          const gy = Math.floor(p1.pos.y / 0.10);
          const gz = Math.floor(p1.pos.z / 0.10);

          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dz = -1; dz <= 1; dz++) {
                const hashIdx = (Math.abs((gx + dx) * 73856093 ^ (gy + dy) * 19349663 ^ (gz + dz) * 83492791)) % HASH_SIZE;
                let j = collisionHead[hashIdx];
                while (j !== -1) {
                  if (j > i) {
                    if (neighborMatrix[i * clothCount + j] === 0) {
                      const p2 = parts[j];
                      const dx_val = p2.pos.x - p1.pos.x;
                      const dy_val = p2.pos.y - p1.pos.y;
                      const dz_val = p2.pos.z - p1.pos.z;
                      const distSq = dx_val * dx_val + dy_val * dy_val + dz_val * dz_val;
                      if (distSq < 0.01 && distSq > 1e-8) {
                        const dist = Math.sqrt(distSq);
                        const overlap = 0.10 - dist;
                        const m1 = p1.pinned ? 0 : 1;
                        const m2 = p2.pinned ? 0 : 1;
                        const sum = m1 + m2;
                        if (sum > 0) {
                          const pushX = (dx_val / dist) * overlap / sum;
                          const pushY = (dy_val / dist) * overlap / sum;
                          const pushZ = (dz_val / dist) * overlap / sum;
                          if (m1) {
                            p1.pos.x -= pushX;
                            p1.pos.y -= pushY;
                            p1.pos.z -= pushZ;
                          }
                          if (m2) {
                            p2.pos.x += pushX;
                            p2.pos.y += pushY;
                            p2.pos.z += pushZ;
                          }
                        }
                      }
                    }
                  }
                  j = collisionNext[j];
                }
              }
            }
          }
        }

        // 3. Ensure pinned nodes stay perfectly target-aligned
        for (const p of parts) {
          if (p.pinned) p.pos.copy(p.target);
        }
      }

      stepAccumulated += SUBSTEPS;

      const avgStepForce = totalStepForce.multiplyScalar(1 / SUBSTEPS);
      const avgStepTorque = totalStepTorque.multiplyScalar(1 / SUBSTEPS);
      const avgCentroid = totalForceWeight > 1e-9 ? centroidAccum.multiplyScalar(1 / totalForceWeight) : new THREE.Vector3();

      // Low-pass EMA (applied once per simulated step)
      const EMA_TAU = 0.15;
      const emaAlpha = 1 - Math.exp(-FRAME_TIME / EMA_TAU);
      filteredForce.current.lerp(avgStepForce, emaAlpha);
      filteredTorque.current.lerp(avgStepTorque, emaAlpha);
      filteredCentroid.current.lerp(avgCentroid, emaAlpha);

      // Map to body coordinate frame: v_body = [v.z, v.x, -v.y]
      const f_body = [
        filteredForce.current.z,
        filteredForce.current.x,
        -filteredForce.current.y
      ] as [number, number, number];
      
      const tau_body = [
        filteredTorque.current.z,
        filteredTorque.current.x,
        -filteredTorque.current.y
      ] as [number, number, number];

      // Update the Zustand store
      timeSinceLastStoreUpdate.current += FRAME_TIME;
      if (timeSinceLastStoreUpdate.current >= 0.1) { // 10 Hz
        timeSinceLastStoreUpdate.current = 0;
        setSailForces({ f_body, tau_body });
      }

      // POST to backend at 15 Hz in simulated time
      timeSinceLastPost.current += FRAME_TIME;
      if (timeSinceLastPost.current >= 1 / 15) {
        timeSinceLastPost.current = 0;
        const seq = seqRef.current++;
        fetch('/v1/sim/sail_wrench', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seq, f_body, tau_body })
        }).catch(() => {
          // Silent catch
        });
      }

      // Expose console debug verification hook updated every ~0.5s
      timeSinceLastDebug.current += FRAME_TIME;
      if (timeSinceLastDebug.current >= 0.5) {
        timeSinceLastDebug.current = 0;
        (window as any).__sailDebug = {
          awsMps: windVelocity.length(),
          awaDeg: currentSimState.boat.twaDeg || 0,
          stepHz: 1 / delta,
          fBody: f_body,
          tauBody: tau_body,
          tackDist: parts[tackI].pos.distanceTo(TACK_ANCHOR),
          clewDist: parts[clewI].pos.distanceTo(sim.clewAnchor),
          windLocal: [windVelocity.x, windVelocity.y, windVelocity.z],
          windWorldDeg: windWorldDeg,
        };
      }

      accumulator.current -= FRAME_TIME;
      stepped = true;
    }

    // NaN guard: reset to rest shape
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
      filteredCentroid.current.set(0, 0, 0);
    }

    if (stepped) {
      // Push particle positions back into render geometry
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i < weldMap.length; i++) {
        const p = parts[weldMap[i]].pos;
        arr[i * 3] = p.x;
        arr[i * 3 + 1] = p.y;
        arr[i * 3 + 2] = p.z;
      }
      posAttr.needsUpdate = true;

      // Update pressure shading vertex colors
      const colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
      if (colorAttr) {
        const arrColor = colorAttr.array as Float32Array;
        if (currentSettings.pressureShading) {
          let maxP = 1e-4;
          for (let i = 0; i < clothCount; i++) {
            const pVal = particlePressure[i] / (stepAccumulated || 1);
            maxP = Math.max(maxP, pVal);
          }
          for (let i = 0; i < weldMap.length; i++) {
            const pIdx = weldMap[i];
            const pVal = particlePressure[pIdx] / (stepAccumulated || 1);
            const t = Math.min(1, pVal / maxP);
            // navy -> cyan -> amber -> red
            arrColor[i * 3]     = t < 0.5 ? 0.15 + t * 1.2 : 0.75 + (t - 0.5) * 0.5;
            arrColor[i * 3 + 1] = t < 0.6 ? 0.35 + t * 0.9 : 0.89 - (t - 0.6) * 1.6;
            arrColor[i * 3 + 2] = t < 0.4 ? 0.55 + t * 0.8 : 0.87 - (t - 0.4) * 1.3;
          }
        } else {
          // Off-white
          for (let i = 0; i < weldMap.length * 3; i++) {
            arrColor[i] = 0.92;
          }
        }
        colorAttr.needsUpdate = true;
      }

      geometry.computeVertexNormals();

      // Crumple detection (recovery affordance check)
      // 1. Calculate triangle unit normals
      for (let t = 0; t < triangles.length; t += 3) {
        const ia = triangles[t];
        const ib = triangles[t + 1];
        const ic = triangles[t + 2];
        ab.subVectors(parts[ib].pos, parts[ia].pos);
        ac.subVectors(parts[ic].pos, parts[ia].pos);
        nrm.crossVectors(ab, ac).normalize();
        const tIdx = t / 3;
        triNormals[tIdx * 3] = nrm.x;
        triNormals[tIdx * 3 + 1] = nrm.y;
        triNormals[tIdx * 3 + 2] = nrm.z;
      }

      // 2. Compute mean coherence over shared edges
      let dotSum = 0;
      for (let i = 0; i < sharedEdgeCount; i++) {
        const t1 = sharedEdgesArray[i * 2];
        const t2 = sharedEdgesArray[i * 2 + 1];
        const n1x = triNormals[t1 * 3];
        const n1y = triNormals[t1 * 3 + 1];
        const n1z = triNormals[t1 * 3 + 2];
        const n2x = triNormals[t2 * 3];
        const n2y = triNormals[t2 * 3 + 1];
        const n2z = triNormals[t2 * 3 + 2];
        dotSum += n1x * n2x + n1y * n2y + n1z * n2z;
      }
      const meanCoherence = sharedEdgeCount > 0 ? dotSum / sharedEdgeCount : 1.0;

      // 3. Compute mean cloth particle velocity
      let velSum = 0;
      for (let i = 0; i < clothCount; i++) {
        const p = parts[i];
        const vx = (p.pos.x - p.prev.x) / FRAME_TIME;
        const vy = (p.pos.y - p.prev.y) / FRAME_TIME;
        const vz = (p.pos.z - p.prev.z) / FRAME_TIME;
        velSum += Math.sqrt(vx * vx + vy * vy + vz * vz);
      }
      const meanVelocity = velSum / clothCount;

      // 4. Log alert if velocity is low but normals are decoherent (crumpled)
      if (meanVelocity < 0.05 && meanCoherence < 0.5) {
        if (!hasLoggedCrumpled.current) {
          console.warn(
            `[Sail Physics Alert] Sail detected in heavily crumpled/tangled state! Mean velocity: ${meanVelocity.toFixed(4)} m/s, Normal coherence: ${meanCoherence.toFixed(4)}`
          );
          hasLoggedCrumpled.current = true;
        }
      } else {
        hasLoggedCrumpled.current = false;
      }

      // Update tack line mesh
      if (tackLineMesh.geometry) {
        const positions: number[] = [];
        for (const idx of tackRope.nodes) {
          positions.push(parts[idx].pos.x, parts[idx].pos.y, parts[idx].pos.z);
        }
        tackLineMesh.geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(positions, 3)
        );
        tackLineMesh.geometry.attributes.position.needsUpdate = true;
      }

      // Update clew/sheet line mesh
      if (clewLineMesh.geometry) {
        const positions: number[] = [];
        for (const idx of clewRope.nodes) {
          positions.push(parts[idx].pos.x, parts[idx].pos.y, parts[idx].pos.z);
        }
        clewLineMesh.geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(positions, 3)
        );
        clewLineMesh.geometry.attributes.position.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      {/* Sail cloth mesh */}
      <mesh castShadow receiveShadow>
        <primitive object={sim.geometry} attach="geometry" />
        <primitive object={sim.material} attach="material" />
      </mesh>

      {/* Tack line segment */}
      <primitive object={tackLineMesh} />

      {/* Sheet rope segment */}
      <primitive object={clewLineMesh} />

      {/* Debug anchor spheres (visible when showRigPoints is toggled) */}
      {settings.showRigPoints && (
        <>
          <mesh position={TACK_ANCHOR}>
            <sphereGeometry args={[0.35, 16, 16]} />
            <meshStandardMaterial color="#7ce0a0" emissive="#3aa06a" emissiveIntensity={0.2} />
          </mesh>
          <mesh position={sim.clewAnchor}>
            <sphereGeometry args={[0.35, 16, 16]} />
            <meshStandardMaterial color="#7ce0a0" emissive="#3aa06a" emissiveIntensity={0.2} />
          </mesh>
        </>
      )}

      {/* Resultant force arrow helper at the centroid */}
      {settings.showForceArrows && (
        <primitive object={forceArrow} />
      )}
    </group>
  );
}

useGLTF.preload('/sail-jib.glb');
