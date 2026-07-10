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
const K_BEND = 0.15;
const K_FOLD_BARRIER = 0.25;
const K_COMPRESS = 0.35;
const K_TAPE2 = 0.35;
const TAPE_REST_FACTOR = 0.998;

const WELD_EPS = 1e-3;
const COLLISION_DISTANCE = 0.10;
const COLLISION_DISTANCE_SQ = COLLISION_DISTANCE * COLLISION_DISTANCE;

// Rig attachment points (glTF frame, boat-local — verified against lagoon-450s.glb)
const TACK_ANCHOR = new THREE.Vector3(-0.041, 2.028, 7.321); // Object.541 tack ring on the bowsprit
// Object.122 traveler track ends (mirrored port/starboard), near the helm.
// In this frame +x is PORT, and -x is STARBOARD.
const SHEET_LEAD_PORT = new THREE.Vector3(2.459, 2.108, -4.033); // +x = PORT sheet lead
const SHEET_LEAD_STARBOARD = new THREE.Vector3(-2.459, 2.108, -4.033); // -x = STARBOARD sheet lead

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

type SpringKind = 'cloth' | 'tape' | 'bend' | 'tape2' | 'rope';
type Spring = [number, number, number, SpringKind, number];
// [partA, partB, restLen, kind, baseLen]

export interface SailFormTelemetry {
  meanStrain: number;
  normalCoherence: number;
  foldEdgeCount: number;
  maxRestDeviation: number;
  luffSagM: number;
  camberM: number;
  restCamberM: number;
}

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

    // Preserve the authored 3D flown shape as the physical rest shape.
    const pHead = parts[headI].rest.clone();
    const pTack = parts[tackI].rest.clone();
    const pClew = parts[clewI].rest.clone();
    const uVec = new THREE.Vector3().subVectors(pTack, pHead);
    const wVec = new THREE.Vector3().subVectors(pClew, pHead);
    const planeNormal = new THREE.Vector3().crossVectors(uVec, wVec).normalize();
    let restCamberM = 0;
    for (const p of parts) {
      const diff = new THREE.Vector3().subVectors(p.rest, pHead);
      restCamberM = Math.max(restCamberM, Math.abs(diff.dot(planeNormal)));
    }

    // Build welded triangles and edge topology. Boundary count-1 edges become
    // snug tapes; shared edges also provide opposite-vertex bend springs.
    const index = geometry.index!;
    const triangles: number[] = [];
    const springs: Spring[] = [];
    const getEdgeKey = (a: number, b: number) => a < b ? `${a}_${b}` : `${b}_${a}`;
    const edgeTopology = new Map<string, { a: number; b: number; opposites: number[] }>();
    const recordEdge = (a: number, b: number, opposite: number) => {
      const key = getEdgeKey(a, b);
      const edge = edgeTopology.get(key);
      if (edge) {
        edge.opposites.push(opposite);
      } else {
        edgeTopology.set(key, { a, b, opposites: [opposite] });
      }
    };
    for (let t = 0; t < index.count; t += 3) {
      const a = weldMap[index.getX(t)];
      const b = weldMap[index.getX(t + 1)];
      const c = weldMap[index.getX(t + 2)];
      if (a === b || b === c || a === c) continue;
      triangles.push(a, b, c);
      recordEdge(a, b, c);
      recordEdge(b, c, a);
      recordEdge(c, a, b);
    }

    const boundaryAdj = new Map<number, number[]>();
    for (const edge of edgeTopology.values()) {
      const baseLen = parts[edge.a].rest.distanceTo(parts[edge.b].rest);
      const isBoundary = edge.opposites.length === 1;
      springs.push([edge.a, edge.b, baseLen, isBoundary ? 'tape' : 'cloth', baseLen]);
      if (isBoundary) {
        if (!boundaryAdj.has(edge.a)) boundaryAdj.set(edge.a, []);
        if (!boundaryAdj.has(edge.b)) boundaryAdj.set(edge.b, []);
        boundaryAdj.get(edge.a)!.push(edge.b);
        boundaryAdj.get(edge.b)!.push(edge.a);
      }
    }

    for (const edge of edgeTopology.values()) {
      if (edge.opposites.length !== 2) continue;
      const [a, b] = edge.opposites;
      if (a === b) continue;
      const baseLen = parts[a].rest.distanceTo(parts[b].rest);
      springs.push([a, b, baseLen, 'bend', baseLen]);
    }

    const findBoundaryPath = (start: number, end: number, blocked: number) => {
      const visited = new Set<number>([start, blocked]);
      const queue: number[][] = [[start]];
      while (queue.length > 0) {
        const path = queue.shift()!;
        const current = path[path.length - 1];
        if (current === end) return path;
        for (const neighbor of boundaryAdj.get(current) ?? []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push([...path, neighbor]);
          }
        }
      }
      return [];
    };

    const luffNodes = findBoundaryPath(headI, tackI, clewI);
    const leechNodes = findBoundaryPath(headI, clewI, tackI);
    const footNodes = findBoundaryPath(tackI, clewI, headI);
    for (const tapeNodes of [luffNodes, leechNodes, footNodes]) {
      for (let i = 1; i < tapeNodes.length - 1; i++) {
        const a = tapeNodes[i - 1];
        const b = tapeNodes[i + 1];
        const baseLen = parts[a].rest.distanceTo(parts[b].rest);
        springs.push([a, b, baseLen, 'tape2', baseLen]);
      }
    }
    const clothSpringCount = springs.length;

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
        springs.push([a, b, baseLen, 'rope', baseLen]);
        springIndices.push(springs.length - 1);
      }
      const baseSegLen = corner.distanceTo(anchorPos) / ROPE_SEG;
      return { nodes, anchorIdx, springIndices, baseSegLen };
    };

    const tackRope = buildRope(tackI, TACK_ANCHOR);
    const clewRope = buildRope(clewI, CLEW_ANCHOR);

    const headAnchor = parts[headI].rest;
    const mastBase = new THREE.Vector3(headAnchor.x, 2.0, headAnchor.z);
    const rigCapsules = [
      { a: mastBase, b: headAnchor, r: 0.16 },
      { a: headAnchor, b: TACK_ANCHOR, r: 0.06 },
    ];
    const capsuleExemptions = rigCapsules.map(() => new Uint8Array(parts.length));
    for (let capsuleIndex = 0; capsuleIndex < rigCapsules.length; capsuleIndex++) {
      const capsule = rigCapsules[capsuleIndex];
      const segment = new THREE.Vector3().subVectors(capsule.b, capsule.a);
      const segmentLengthSq = segment.lengthSq();
      for (let particleIndex = 0; particleIndex < parts.length; particleIndex++) {
        const fromStart = new THREE.Vector3().subVectors(parts[particleIndex].rest, capsule.a);
        const t = segmentLengthSq > 1e-9
          ? Math.max(0, Math.min(1, fromStart.dot(segment) / segmentLengthSq))
          : 0;
        const closest = new THREE.Vector3().copy(capsule.a).addScaledVector(segment, t);
        if (parts[particleIndex].rest.distanceTo(closest) <= capsule.r + COLLISION_DISTANCE) {
          capsuleExemptions[capsuleIndex][particleIndex] = 1;
        }
      }
    }

    const material = (Array.isArray(src.material) ? src.material[0] : src.material).clone();
    material.side = THREE.DoubleSide;
    material.vertexColors = true;
    // glTF BLEND materials import with depthWrite=false — the transparent water
    // then paints over the sail whenever draw order flips at distance. Sailcloth
    // is effectively opaque: force opaque + depth write so occlusion is per-pixel.
    material.transparent = false;
    material.opacity = 1.0;
    material.depthWrite = true;

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
    const sharedEdgeVerticesList: number[] = [];
    const sharedEdgeOppositesList: number[] = [];
    for (const [edgeKey, list] of edgeTriangles.entries()) {
      if (list.length === 2) {
        sharedEdgesList.push(list[0], list[1]);
        const [a, b] = edgeKey.split('_').map(Number);
        sharedEdgeVerticesList.push(a, b);
        sharedEdgeOppositesList.push(...edgeTopology.get(edgeKey)!.opposites);
      }
    }
    const sharedEdgeCount = sharedEdgesList.length / 2;
    const sharedEdgesArray = new Int32Array(sharedEdgesList);
    const sharedEdgeVerticesArray = new Int32Array(sharedEdgeVerticesList);
    const sharedEdgeOppositesArray = new Int32Array(sharedEdgeOppositesList);

    // Preallocated arrays for self-collision spatial hash & normal coherence
    const HASH_SIZE = 1024;
    const collisionHead = new Int32Array(HASH_SIZE);
    const collisionNext = new Int32Array(clothCount);
    const neighborMatrix = new Uint8Array(clothCount * clothCount);
    const triNormals = new Float32Array((triangles.length / 3) * 3);

    // Only mesh-edge neighbors are collision-exempt. Bend/tape2 constraints
    // span the cloth and must not disable collision for the vertices they brace.
    for (const edge of edgeTopology.values()) {
      neighborMatrix[edge.a * clothCount + edge.b] = 1;
      neighborMatrix[edge.b * clothCount + edge.a] = 1;
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
      // Mutable — the sheet-side toggle re-points it to the other winch.
      clewAnchor: CLEW_ANCHOR.clone(),
      geometry,
      material,
      sharedEdgesArray,
      sharedEdgeVerticesArray,
      sharedEdgeOppositesArray,
      sharedEdgeCount,
      collisionHead,
      collisionNext,
      neighborMatrix,
      triNormals,
      restCamberM,
      rigCapsules,
      capsuleExemptions,
    };
    // NOTE: sheetSide is intentionally NOT a dependency — a side change must
    // NOT rebuild (reset) the sail. The effect below gybes the live cloth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jibScene]);

  // Sheet-side toggle: gybe the LIVE sail instead of resetting it. Mirroring
  // every particle across the centerline (x → −x in glTF coords) is an
  // isometry — all spring/bend rest lengths hold exactly — so the solver
  // accepts the flipped state as-is and the wind takes over on the new side.
  const lastSheetSide = useRef(sheetSide);
  useEffect(() => {
    if (lastSheetSide.current === sheetSide) return;
    lastSheetSide.current = sheetSide;
    sim.clewAnchor.copy(sheetSide === 'port' ? SHEET_LEAD_PORT : SHEET_LEAD_STARBOARD);
    for (const p of sim.parts) {
      p.pos.x = -p.pos.x;
      p.prev.x = -p.prev.x;
    }
  }, [sheetSide, sim]);

  const accumulator = useRef(0);
  const filteredForce = useRef(new THREE.Vector3());
  const filteredTorque = useRef(new THREE.Vector3());
  const filteredCentroid = useRef(new THREE.Vector3());
  
  const timeSinceLastPost = useRef(0);
  const timeSinceLastDebug = useRef(0);
  const timeSinceLastStoreUpdate = useRef(0);
  const seqRef = useRef(0);
  const hasLoggedCrumpled = useRef(false);
  const tangleTimer = useRef(0);
  const watchdogResetCount = useRef(0);

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

  // The old mount-time "align the boat downwind" reset is GONE: it fired on
  // any page load while the backend was <10 s old — i.e. every Cloud Run
  // cold start and every local restart — silently teleporting the boat out
  // of the Prickly Bay anchorage. The cloth initializes fine from any
  // heading now (proven by the shape-gate endurance runs), and the backend
  // owns the spawn.
  const alignedReady = useRef(true);

  // Update physics at 60fps
  useFrame((state, delta) => {
    if (!alignedReady.current) return;
    const { parts, springs, clothSpringCount, triangles, clothCount, weldMap, MASS, headI, tackI, clewI, luffNodes, tackRope, clewRope, geometry, sharedEdgesArray, sharedEdgeVerticesArray, sharedEdgeOppositesArray, sharedEdgeCount, collisionHead, collisionNext, neighborMatrix, triNormals, rigCapsules, capsuleExemptions } = sim;

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

    // Compute local apparent wind angle (attack angle) relative to sail mean plane
    const uCurr = new THREE.Vector3().subVectors(parts[tackI].pos, parts[headI].pos);
    const vCurr = new THREE.Vector3().subVectors(parts[clewI].pos, parts[headI].pos);
    const meanNormal = new THREE.Vector3().crossVectors(uCurr, vCurr).normalize();

    let luffFactor = 1.0;
    const windSpeedLocal = windVelocity.length();
    if (windSpeedLocal > 1e-4) {
      const windNorm = windVelocity.clone().normalize();
      const sinAttack = Math.abs(windNorm.dot(meanNormal));
      const attackAngle = Math.asin(Math.min(1.0, sinAttack)) * 180 / Math.PI;

      if (attackAngle < 10) {
        luffFactor = 0.15;
      } else if (attackAngle < 30) {
        const t = (attackAngle - 10) / 20;
        luffFactor = 0.15 + 0.85 * t;
      }
    } else {
      luffFactor = 0.15;
    }

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

    // Fullness belongs to the interior. Boundary tapes and their second-neighbor
    // braces remain slightly snug so the perimeter cannot accumulate slack.
    for (let i = 0; i < clothSpringCount; i++) {
      const spring = springs[i];
      spring[2] = spring[3] === 'tape' || spring[3] === 'tape2'
        ? spring[4] * TAPE_REST_FACTOR
        : spring[4] * sailFullnessFactor;
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
    let lastMeanStretch = 0;
    let publishFormTelemetry = false;

    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const hingeEdge = new THREE.Vector3();
    const hingeMidpoint = new THREE.Vector3();
    const hingeA = new THREE.Vector3();
    const hingeB = new THREE.Vector3();
    const hingeCommon = new THREE.Vector3();

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
            const kind = s[3];
            if (kind === 'rope' && d <= rest) continue; // rope only pulls
            const m1 = p1.pinned ? 0 : 1;
            const m2 = p2.pinned ? 0 : 1;
            const sum = m1 + m2;
            if (sum === 0) continue;
            let stiffness = 1;
            if (kind === 'bend') stiffness = K_BEND;
            else if (kind === 'tape2') stiffness = K_TAPE2;
            else if (kind !== 'rope' && d < rest) stiffness = K_COMPRESS;
            const f = (1 - rest / d) * stiffness / sum;
            if (m1) p1.pos.addScaledVector(tmp, f);
            if (m2) p2.pos.addScaledVector(tmp, -f);
          }

          // Distance-only cross springs have a mirrored hinge solution. Once
          // opposite vertices cross to the same side of their shared edge,
          // remove the common perpendicular component to unfold the hinge.
          for (let i = 0; i < sharedEdgeCount; i++) {
            const edgeA = parts[sharedEdgeVerticesArray[i * 2]];
            const edgeB = parts[sharedEdgeVerticesArray[i * 2 + 1]];
            const oppositeA = parts[sharedEdgeOppositesArray[i * 2]];
            const oppositeB = parts[sharedEdgeOppositesArray[i * 2 + 1]];
            hingeEdge.subVectors(edgeB.pos, edgeA.pos);
            const edgeLengthSq = hingeEdge.lengthSq();
            if (edgeLengthSq < 1e-8) continue;
            hingeMidpoint.addVectors(edgeA.pos, edgeB.pos).multiplyScalar(0.5);
            hingeA.subVectors(oppositeA.pos, hingeMidpoint);
            hingeA.addScaledVector(hingeEdge, -hingeA.dot(hingeEdge) / edgeLengthSq);
            hingeB.subVectors(oppositeB.pos, hingeMidpoint);
            hingeB.addScaledVector(hingeEdge, -hingeB.dot(hingeEdge) / edgeLengthSq);
            if (hingeA.dot(hingeB) < 0) continue;

            const wa = edgeA.pinned ? 0 : 1;
            const wb = edgeB.pinned ? 0 : 1;
            const wp = oppositeA.pinned ? 0 : 1;
            const wq = oppositeB.pinned ? 0 : 1;
            const weightSum = wa + wb + wp + wq;
            if (weightSum === 0) continue;
            hingeCommon.addVectors(hingeA, hingeB).multiplyScalar(0.5);
            const correctionScale = 2 * K_FOLD_BARRIER / weightSum;
            if (wa) edgeA.pos.addScaledVector(hingeCommon, wa * correctionScale);
            if (wb) edgeB.pos.addScaledVector(hingeCommon, wb * correctionScale);
            if (wp) oppositeA.pos.addScaledVector(hingeCommon, -wp * correctionScale);
            if (wq) oppositeB.pos.addScaledVector(hingeCommon, -wq * correctionScale);
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
          const gx = Math.floor(p.pos.x / COLLISION_DISTANCE);
          const gy = Math.floor(p.pos.y / COLLISION_DISTANCE);
          const gz = Math.floor(p.pos.z / COLLISION_DISTANCE);
          const hashIdx = (Math.abs(gx * 73856093 ^ gy * 19349663 ^ gz * 83492791)) % HASH_SIZE;
          collisionNext[i] = collisionHead[hashIdx];
          collisionHead[hashIdx] = i;
        }

        // 2. Resolve self-collisions for particles that were separated in the rest shape.
        for (let i = 0; i < clothCount; i++) {
          const p1 = parts[i];
          const gx = Math.floor(p1.pos.x / COLLISION_DISTANCE);
          const gy = Math.floor(p1.pos.y / COLLISION_DISTANCE);
          const gz = Math.floor(p1.pos.z / COLLISION_DISTANCE);

          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dz = -1; dz <= 1; dz++) {
                const hashIdx = (Math.abs((gx + dx) * 73856093 ^ (gy + dy) * 19349663 ^ (gz + dz) * 83492791)) % HASH_SIZE;
                let j = collisionHead[hashIdx];
                while (j !== -1) {
                  if (j > i) {
                    const restSeparationSq = p1.rest.distanceToSquared(parts[j].rest);
                    if (neighborMatrix[i * clothCount + j] === 0 && restSeparationSq >= COLLISION_DISTANCE_SQ) {
                      const p2 = parts[j];
                      const dx_val = p2.pos.x - p1.pos.x;
                      const dy_val = p2.pos.y - p1.pos.y;
                      const dz_val = p2.pos.z - p1.pos.z;
                      const distSq = dx_val * dx_val + dy_val * dy_val + dz_val * dz_val;
                      if (distSq < COLLISION_DISTANCE_SQ && distSq > 1e-8) {
                        const dist = Math.sqrt(distSq);
                        const overlap = COLLISION_DISTANCE - dist;
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

        // 3. Rig collision capsules (mast & forestay)
        const abSeg = new THREE.Vector3();
        const ap = new THREE.Vector3();
        const cp = new THREE.Vector3();
        const dVec = new THREE.Vector3();

        for (let particleIndex = 0; particleIndex < parts.length; particleIndex++) {
          const p = parts[particleIndex];
          if (p.pinned) continue;
          for (let capsuleIndex = 0; capsuleIndex < rigCapsules.length; capsuleIndex++) {
            if (capsuleExemptions[capsuleIndex][particleIndex]) continue;
            const c = rigCapsules[capsuleIndex];
            abSeg.subVectors(c.b, c.a);
            const l2 = abSeg.lengthSq();
            let t = 0;
            if (l2 > 1e-6) {
              ap.subVectors(p.pos, c.a);
              t = Math.max(0, Math.min(1, ap.dot(abSeg) / l2));
            }
            cp.copy(c.a).addScaledVector(abSeg, t);
            dVec.subVectors(p.pos, cp);
            const dist = dVec.length();
            if (dist < c.r) {
              if (dist > 1e-4) {
                p.pos.copy(cp).addScaledVector(dVec, c.r / dist);
              } else {
                p.pos.copy(cp).x += c.r;
              }
            }
          }
        }

        // 4. Ensure pinned nodes stay perfectly target-aligned
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

      // Sail-local frame is (+X port, +Y up, +Z bow) — right-handed.
      // Body frame is (+X fwd, +Y stbd, +Z down). Proper rotation, det = +1:
      const f_body = [
        filteredForce.current.z,
        -filteredForce.current.x,
        -filteredForce.current.y
      ] as [number, number, number];
      
      const tau_body = [
        filteredTorque.current.z,
        -filteredTorque.current.x,
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

      // Form telemetry is published after the render-side normal pass below.
      timeSinceLastDebug.current += FRAME_TIME;
      if (timeSinceLastDebug.current >= 0.5) {
        timeSinceLastDebug.current %= 0.5;
        publishFormTelemetry = true;
      }

      // Tangle metric: mean over cloth springs of max(0, L/rest - 1).
      // NOTE: a hard-drawing sail carries steady residual stretch (PBD with
      // finite iterations never fully converges under kN loads), so stretch
      // alone must NOT trigger the reset — the decision is reconciled with
      // normal coherence in the per-frame crumple check below.
      let springStretchSum = 0;
      for (let i = 0; i < clothSpringCount; i++) {
        const s = springs[i];
        const p1 = parts[s[0]];
        const p2 = parts[s[1]];
        const rest = s[2];
        const d = p1.pos.distanceTo(p2.pos);
        springStretchSum += Math.max(0, d / rest - 1);
      }
      lastMeanStretch = clothSpringCount > 0 ? springStretchSum / clothSpringCount : 0;

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
      let foldEdgeCount = 0;
      for (let i = 0; i < sharedEdgeCount; i++) {
        const t1 = sharedEdgesArray[i * 2];
        const t2 = sharedEdgesArray[i * 2 + 1];
        const n1x = triNormals[t1 * 3];
        const n1y = triNormals[t1 * 3 + 1];
        const n1z = triNormals[t1 * 3 + 2];
        const n2x = triNormals[t2 * 3];
        const n2y = triNormals[t2 * 3 + 1];
        const n2z = triNormals[t2 * 3 + 2];
        const normalDot = n1x * n2x + n1y * n2y + n1z * n2z;
        dotSum += normalDot;
        if (normalDot < 0) foldEdgeCount++;
      }
      const meanCoherence = sharedEdgeCount > 0 ? dotSum / sharedEdgeCount : 1.0;

      if (publishFormTelemetry) {
        let strainSum = 0;
        for (let i = 0; i < clothSpringCount; i++) {
          const spring = springs[i];
          const restLength = spring[2];
          if (restLength > 1e-9) {
            const length = parts[spring[0]].pos.distanceTo(parts[spring[1]].pos);
            strainSum += Math.abs(length / restLength - 1);
          }
        }

        let maxRestDeviation = 0;
        for (let i = 0; i < clothCount; i++) {
          maxRestDeviation = Math.max(maxRestDeviation, parts[i].pos.distanceTo(parts[i].rest));
        }

        const chord = new THREE.Vector3().subVectors(parts[tackI].pos, parts[headI].pos);
        const chordLength = chord.length();
        let luffSagM = 0;
        if (chordLength > 1e-9) {
          for (const node of luffNodes) {
            const fromHead = new THREE.Vector3().subVectors(parts[node].pos, parts[headI].pos);
            luffSagM = Math.max(
              luffSagM,
              new THREE.Vector3().crossVectors(fromHead, chord).length() / chordLength
            );
          }
        }

        const currentU = new THREE.Vector3().subVectors(parts[tackI].pos, parts[headI].pos);
        const currentV = new THREE.Vector3().subVectors(parts[clewI].pos, parts[headI].pos);
        const currentPlaneNormal = new THREE.Vector3().crossVectors(currentU, currentV);
        let camberM = 0;
        if (currentPlaneNormal.lengthSq() > 1e-12) {
          currentPlaneNormal.normalize();
          for (let i = 0; i < clothCount; i++) {
            const fromHead = new THREE.Vector3().subVectors(parts[i].pos, parts[headI].pos);
            camberM = Math.max(camberM, Math.abs(fromHead.dot(currentPlaneNormal)));
          }
        }

        const form: SailFormTelemetry = {
          meanStrain: clothSpringCount > 0 ? strainSum / clothSpringCount : 0,
          normalCoherence: meanCoherence,
          foldEdgeCount,
          maxRestDeviation,
          luffSagM,
          camberM,
          restCamberM: sim.restCamberM,
        };
        const debugForce = [
          filteredForce.current.z,
          -filteredForce.current.x,
          -filteredForce.current.y,
        ];
        const debugTorque = [
          filteredTorque.current.z,
          -filteredTorque.current.x,
          -filteredTorque.current.y,
        ];
        (window as any).__sailDebug = {
          awsMps: windVelocity.length(),
          awaDeg: currentSimState.boat.twaDeg || 0,
          stepHz: 1 / delta,
          fBody: debugForce,
          tauBody: debugTorque,
          tackDist: parts[tackI].pos.distanceTo(TACK_ANCHOR),
          clewDist: parts[clewI].pos.distanceTo(sim.clewAnchor),
          windLocal: [windVelocity.x, windVelocity.y, windVelocity.z],
          windWorldDeg,
          watchdogResetCount: watchdogResetCount.current,
          form,
        };
        window.dispatchEvent(new CustomEvent<SailFormTelemetry>('sail-form', { detail: form }));
      }

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

      // Reconciled tangle watchdog: a TANGLE is high spring stretch AND
      // incoherent normals together. A drawing sail is stretched but its
      // adjacent triangle normals stay aligned (coherence near 1), so it
      // must never trip this. Sustained 2s of both signals -> reset.
      if (lastMeanStretch > 0.25 && meanCoherence < 0.5) {
        tangleTimer.current += Math.min(delta, 0.1);
        if (tangleTimer.current >= 2.0) {
          console.warn(
            `[Sail Watchdog] Tangled state confirmed (stretch ${(lastMeanStretch * 100).toFixed(0)}%, coherence ${meanCoherence.toFixed(2)}) — resetting to rest shape`
          );
          tangleTimer.current = 0;
          watchdogResetCount.current++;
          for (const p of parts) {
            p.pos.copy(p.rest);
            p.prev.copy(p.rest);
            p.force.set(0, 0, 0);
          }
          filteredForce.current.set(0, 0, 0);
          filteredTorque.current.set(0, 0, 0);
          filteredCentroid.current.set(0, 0, 0);
        }
      } else {
        tangleTimer.current = 0;
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
