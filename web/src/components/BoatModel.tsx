import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useSimulator } from '../sim/store';
import { degToRad, getWaveHeight } from '../sim/math';
import { SpinnakerSail } from './SpinnakerSail';

const AXIS_Y = new THREE.Vector3(0, 1, 0);

// PBR skin sets exported from Substance (models/Lagoon_450S, downscaled to 2K
// in web/public/skins), keyed by the GLB material names they dress. The GLB
// sail materials are skipped — sails are hidden and the cloth jib paints its
// own force-colored material.
const SKIN_BY_MATERIAL: Record<string, { prefix: string; normalYFlip: boolean; hasOpacity?: boolean }> = {
  'LAGOON  450-S Body': { prefix: 'body', normalYFlip: true },
  'LAGOON  450-S Body 2': { prefix: 'body2', normalYFlip: true, hasOpacity: true },
  'LAGOON  450-S Body 3': { prefix: 'body3', normalYFlip: true },
  'Brig Dingo D285': { prefix: 'dingo', normalYFlip: false },
};

const skinTextureCache = new Map<string, THREE.Texture>();
function skinTexture(file: string, srgb: boolean): THREE.Texture {
  let tex = skinTextureCache.get(file);
  if (!tex) {
    tex = new THREE.TextureLoader().load(`/skins/${file}`);
    tex.flipY = false; // glTF UV convention
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    skinTextureCache.set(file, tex);
  }
  return tex;
}

function applySkin(mat: THREE.Material) {
  const skin = SKIN_BY_MATERIAL[mat.name];
  if (!skin || !(mat instanceof THREE.MeshStandardMaterial)) return;
  const p = skin.prefix;
  mat.map = skinTexture(`${p}_basecolor.jpg`, true);
  mat.roughnessMap = skinTexture(`${p}_roughness.jpg`, false);
  mat.metalnessMap = skinTexture(`${p}_metallic.jpg`, false);
  mat.aoMap = skinTexture(`${p}_ao.jpg`, false);
  mat.normalMap = skinTexture(`${p}_normal_${skin.normalYFlip ? 'dx' : 'gl'}.png`, false);
  // DirectX-convention normal maps have Y inverted vs what three expects.
  mat.normalScale.set(1, skin.normalYFlip ? -1 : 1);
  if (skin.hasOpacity) {
    mat.alphaMap = skinTexture(`${p}_opacity.png`, false);
    mat.transparent = true;
  }
  // Authored scalar factors MULTIPLY the maps; an authored 0 would zero them out.
  mat.metalness = 1.0;
  mat.roughness = 1.0;
  // Base color factor tints the map the same way; reset to white.
  mat.color.set(0xffffff);
  mat.needsUpdate = true;
}

export function BoatModel() {
  const boat = useSimulator((state) => state.boat);
  const settings = useSimulator((state) => state.settings);

  // Group reference for the root boat object
  const groupRef = useRef<THREE.Group>(null);

  // Keep track of accumulated propeller angles to ensure smooth rotation
  const propPortAngle = useRef(0);
  const propStbdAngle = useRef(0);

  // Load the GLB file from the public directory
  const { scene } = useGLTF('/lagoon-450s.glb');
  
  // Cache and prepare the scene. Find steering and prop nodes.
  const {
    formattedScene,
    rudderPortNode,
    rudderStbdNode,
    propPortNode,
    propStbdNode,
    sailMainNode,
    sailJibNode,
    steeringWheelNode,
    travelerCarNode,
    travelerCarRestY,
    travelerCarQuat,
    travelerShackleNode,
    travelerShackleRestY,
    travelerShackleQuat,
    travelerSwivels,
    mainsheetLine,
    initialWheelQuaternion,
  } = useMemo(() => {
    const clone = scene.clone();

    // Enable shadows on all child meshes, make materials double-sided, and hide sails
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        
        if (child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((mat) => {
            applySkin(mat);
            mat.side = THREE.DoubleSide;
            // glTF BLEND materials import with depthWrite=false; the transparent
            // water then draws over them when sort order flips at distance. Keep
            // any blend look but always write depth so above-water parts of the
            // boat can never be painted over by the water plane.
            if (mat.transparent) {
              mat.depthWrite = true;
            }
          });
        }

        // Hide sails from the simulator display
        if (child.name && child.name.toLowerCase().includes('sail')) {
          child.visible = false;
        }
        // Hidden export leftovers: orphaned rope stubs (515, 113) and the
        // arch clutter Kord culled (080/081 frame pieces, 056/024/076/025/103
        // fittings) — replaced by the track copy added below.
        if (child.name) {
          const clean = child.name.replace(/[\._]/g, '').toLowerCase();
          const HIDDEN = new Set([
            'object515', 'object113', 'object540',
            'object080', 'object056', 'object024', 'object076',
            'object081', 'object025', 'object103',
            // Mainsheet rework: baked rope (105) and the duplicate upper
            // block (074) replaced by a live line tied to Object.077.
            'object105', 'object074',
          ]);
          if (HIDDEN.has(clean)) {
            child.visible = false;
          }
        }
      }
    });

    // Helper function to find node by name robustly (ignoring dots, underscores, and case)
    const findNode = (name: string): THREE.Object3D | null => {
      const target = name.replace(/[\._]/g, '').toLowerCase();
      let found: THREE.Object3D | null = null;
      clone.traverse((child) => {
        if (child.name) {
          const cleanName = child.name.replace(/[\._]/g, '').toLowerCase();
          if (cleanName === target || cleanName.includes(target)) {
            found = child;
          }
        }
      });
      return found;
    };

    // Locate separated interactive nodes from Blender (swapped to correct for model orientation)
    const rudderPort = findNode('foil.rudder.port');
    const rudderStbd = findNode('foil.rudder.stbd');
    const propPort = findNode('prop.port');
    const propStbd = findNode('prop.stbd');
    const sailMain = findNode('sail.main');
    const sailJib = findNode('sail.jib');
    const steeringWheel = findNode('steering.wheel');
    // Traveler car on the arch (Object.104, rest centered at x=0, y≈3.27),
    // plus the shackled mainsheet block riding it (Object.078).
    const travelerCar = findNode('object.104');
    const travelerShackle = findNode('object.078');

    // Arch winch: Object.122 is a PAIR of winches — split it and mount ONE
    // copy on the arch at the 076/103 midpoint. (The original pair stays
    // where it is on deck.)
    {
      const winchSrc = findNode('object.122');
      let winchMesh: THREE.Mesh | null = null;
      winchSrc?.traverse((c) => {
        if (c instanceof THREE.Mesh && !winchMesh) winchMesh = c;
      });
      if (winchMesh) {
        const wm = winchMesh as THREE.Mesh;
        clone.updateMatrixWorld(true);
        const baked = wm.geometry.clone();
        baked.applyMatrix4(wm.matrixWorld);
        const islands = splitConnectedComponents(baked, 4);
        if (islands.length > 0) {
          const winch = islands[0]; // largest island = one winch
          winch.computeBoundingBox();
          const bb = winch.boundingBox!;
          winch.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
          const m = new THREE.Mesh(winch, wm.material);
          m.castShadow = true;
          m.name = 'winch.arch';
          m.position.set(-0.001, 3.247, -4.358);
          clone.add(m);
        }
      }
    }

    // Object.076's fittings, separated into connected components and
    // remounted as SWIVELS: pivot at each piece's bottom center, riding the
    // traveler and free to yaw toward the load.
    const travelerSwivels: THREE.Group[] = [];
    {
      const fittingSrc = findNode('object.076');
      let fittingMesh: THREE.Mesh | null = null;
      fittingSrc?.traverse((c) => {
        if (c instanceof THREE.Mesh && !fittingMesh) fittingMesh = c;
      });
      if (fittingMesh) {
        const fm = fittingMesh as THREE.Mesh;
        clone.updateMatrixWorld(true);
        const baked = fm.geometry.clone();
        baked.applyMatrix4(fm.matrixWorld);
        for (const part of splitConnectedComponents(baked, 8)) {
          part.computeBoundingBox();
          const bb = part.boundingBox!;
          const cx = (bb.min.x + bb.max.x) / 2;
          const cz = (bb.min.z + bb.max.z) / 2;
          // Pivot (swivel axis) at the piece's bottom center.
          part.translate(-cx, -bb.min.y, -cz);
          const m = new THREE.Mesh(part, fm.material);
          m.castShadow = true;
          const pivot = new THREE.Group();
          pivot.name = `traveler.swivel.${travelerSwivels.length}`;
          pivot.add(m);
          clone.add(pivot);
          travelerSwivels.push(pivot);
        }
      }
    }

    // Live mainsheet: one line TIED to Object.077 (the boom-end block at
    // (0, 4.44, −4.73)), other end following the traveler shackle. Replaces
    // the baked Object.105 rope (hidden above).
    const mainsheetLine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0x24272d, roughness: 0.85 })
    );
    mainsheetLine.name = 'mainsheet.line';
    mainsheetLine.castShadow = true;
    clone.add(mainsheetLine);
 
    // Log the found nodes for debugging
    console.log('Catamaran rigged nodes lookup:', {
      rudderPort: !!rudderPort,
      rudderStbd: !!rudderStbd,
      propPort: !!propPort,
      propStbd: !!propStbd,
      sailMain: !!sailMain,
      sailJib: !!sailJib,
      steeringWheel: !!steeringWheel,
    });

    // Center geometry of propellers and offset their nodes to make them spin on their geometric axle
    const centerAndOffsetNode = (node: THREE.Object3D | null) => {
      if (!node) return;
      
      let mesh: THREE.Mesh | null = null;
      if (node instanceof THREE.Mesh) {
        mesh = node;
      } else {
        node.traverse((child) => {
          if (child instanceof THREE.Mesh && !mesh) {
            mesh = child;
          }
        });
      }
      
      if (mesh) {
        const geom = mesh.geometry.clone();
        mesh.geometry = geom;
        
        geom.computeBoundingBox();
        const box = geom.boundingBox;
        if (box) {
          const center = new THREE.Vector3();
          box.getCenter(center);
          geom.center();
          node.position.add(center);
        }
      }
    };

    // Propellers already have correct origins set in Blender, do not offset them in code

    // No scale or position offset needed since the Lagoon 450S is centered and 1:1 scale
    clone.scale.setScalar(1.0);
    clone.position.set(0, 0, 0);
    clone.rotation.set(0, Math.PI, 0);

    const wrapper = new THREE.Group();
    wrapper.add(clone);
    const initialWheelQuaternion = steeringWheel ? steeringWheel.quaternion.clone() : new THREE.Quaternion();
    const travelerCarQuat = travelerCar ? travelerCar.quaternion.clone() : new THREE.Quaternion();
    const travelerShackleQuat = travelerShackle ? travelerShackle.quaternion.clone() : new THREE.Quaternion();
    return { 
      formattedScene: wrapper, 
      rudderPortNode: rudderPort, 
      rudderStbdNode: rudderStbd, 
      propPortNode: propPort, 
      propStbdNode: propStbd,
      sailMainNode: sailMain,
      sailJibNode: sailJib,
      steeringWheelNode: steeringWheel,
      travelerCarNode: travelerCar,
      travelerCarRestY: travelerCar ? travelerCar.position.y : 3.273,
      travelerCarQuat,
      travelerShackleNode: travelerShackle,
      travelerShackleRestY: travelerShackle ? travelerShackle.position.y : 3.378,
      travelerShackleQuat,
      travelerSwivels,
      mainsheetLine,
      initialWheelQuaternion
    };
  }, [scene]);

  // Update position, orientation, sails trim, and rudder angle at 60fps
  useFrame((state, delta) => {
    if (!groupRef.current) return;

    const dt = Math.min(delta, 0.1);

    // Set position and rotation directly from the simulator backend's calculations
    groupRef.current.position.set(boat.position.x, boat.bobM, -boat.position.y);
    groupRef.current.rotation.set(
      degToRad(boat.pitchDeg),
      -degToRad(boat.headingDeg),
      degToRad(boat.heelDeg)
    );

    // 2. Animate Port & Starboard Rudders
    if (rudderPortNode) {
      rudderPortNode.rotation.y = -degToRad(boat.rudderDeg);
    }
    if (rudderStbdNode) {
      rudderStbdNode.rotation.y = -degToRad(boat.rudderDeg);
    }

    // 2.5. Animate Steering Wheel (rotating 10x rudder angle to simulate helm turning)
    if (steeringWheelNode && initialWheelQuaternion) {
      steeringWheelNode.quaternion.copy(initialWheelQuaternion);
      steeringWheelNode.rotateOnAxis(AXIS_Y, degToRad(boat.rudderDeg * 10));
    }

    // 2.6. Slide the traveler assembly along the arch track.
    // glTF +X = PORT, so +traveler% (car to starboard) drives x negative.
    {
      const pct = useSimulator.getState().settings.travelerPct ?? 0;
      const t = Math.max(-1, Math.min(1, pct / 100));
      const carX = -t * TRAVELER_TRACK_HALF_M;
      // The arch top (Object.095) is cambered: y sags −0.0108·x² off center
      // (measured fit). The whole assembly follows the curve.
      const sag = ARCH_SAG_PER_X2 * carX * carX;
      // Tip the whole assembly tangent to the rail curve: slope dy/dx = 2ax,
      // rolled about the fore-aft (glTF z/bow) axis on top of each node's
      // authored orientation.
      const tilt = Math.atan(2 * ARCH_SAG_PER_X2 * carX);
      _tiltQuat.setFromAxisAngle(TILT_AXIS_Z, tilt);
      if (travelerCarNode) {
        travelerCarNode.position.x = carX;
        travelerCarNode.position.y = travelerCarRestY + sag;
        travelerCarNode.quaternion.copy(_tiltQuat).multiply(travelerCarQuat);
      }
      // The mainsheet block shackled onto the car (Object.078) rides along.
      if (travelerShackleNode) {
        travelerShackleNode.position.x = carX;
        travelerShackleNode.position.y = travelerShackleRestY + sag;
        travelerShackleNode.quaternion.copy(_tiltQuat).multiply(travelerShackleQuat);
      }
      // Separated Object.076 fittings (shackle + ring): each swivels on its
      // bottom pivot, mounted ON the car (same z), yawing toward the load,
      // tipping with the rail.
      if (travelerSwivels.length > 0) {
        const n = travelerSwivels.length;
        for (let i = 0; i < n; i++) {
          const sv = travelerSwivels[i];
          const side = (i - (n - 1) / 2) * 0.12;
          const x = carX + side;
          sv.position.set(x, travelerCarRestY + 0.035 + sag, -4.689);
          _yawQuat.setFromAxisAngle(AXIS_Y_LOCAL, Math.atan2(-x, 0.09));
          sv.quaternion.copy(_tiltQuat).multiply(_yawQuat);
        }
      }
      // Live mainsheet line: tied to Object.077's block (0, 4.34, −4.73) at
      // the top, following the traveler shackle at the bottom.
      if (mainsheetLine) {
        const topX = -0.002, topY = 4.34, topZ = -4.731;
        const botX = carX, botY = travelerCarRestY + 0.09 + sag, botZ = -4.689;
        const dx = topX - botX, dy = topY - botY, dz = topZ - botZ;
        const len = Math.max(0.05, Math.hypot(dx, dy, dz));
        mainsheetLine.position.set((topX + botX) / 2, (topY + botY) / 2, (topZ + botZ) / 2);
        mainsheetLine.scale.set(1, len, 1);
        _ropeDir.set(dx / len, dy / len, dz / len);
        mainsheetLine.quaternion.setFromUnitVectors(AXIS_Y_LOCAL, _ropeDir);
      }
    }

    // 3. Spin Propellers based on actual engine power/thrust (thrustPort & thrustStbd in Newtons)
    // Scale factor maps 3000 Newtons to ~15 rad/sec (~143 RPM)
    const speedFactor = 0.005;
    const thrustPort = boat.thrustPort ?? 0;
    const thrustStbd = boat.thrustStbd ?? 0;

    propPortAngle.current += thrustPort * speedFactor * dt;
    propStbdAngle.current += thrustStbd * speedFactor * dt;

    if (propPortNode) {
      propPortNode.rotation.z = propPortAngle.current; // Z-rotation is along shaft in local space (Y-up glTF)
    }
    if (propStbdNode) {
      propStbdNode.rotation.z = propStbdAngle.current;
    }

    // 4. Animate Mainsail angle based on sheet trim and apparent wind angle (twa)
    if (sailMainNode) {
      sailMainNode.visible = false; // Force hidden in display
      if (boat.mainDropped) {
        sailMainNode.visible = false;
      } else {
        sailMainNode.visible = false; // Force hidden in display
        const maxBoomAngle = (1.0 - boat.sailTrim) * 85;
        const twa = boat.twaDeg;
        let mainAngle = twa;
        if (Math.abs(twa) > maxBoomAngle) {
          mainAngle = Math.sign(twa) * maxBoomAngle;
        }
        sailMainNode.rotation.y = degToRad(mainAngle);

        // Scale main sail to simulate reefing (vertical scale)
        const reefScale = 1.0 - boat.reef * 0.55;
        sailMainNode.scale.set(1, reefScale, 1);
      }
    }

    // 5. Animate Jib angle (spinnaker / headsail)
    if (sailJibNode) {
      sailJibNode.visible = false; // Force hidden in display
      const maxJibAngle = (1.0 - boat.sailTrim) * 85 * 0.8;
      const twa = boat.twaDeg;
      let jibAngle = twa;
      if (Math.abs(twa) > maxJibAngle) {
        jibAngle = Math.sign(twa) * maxJibAngle;
      }
      sailJibNode.rotation.y = degToRad(jibAngle);
      
      // Ensure spinnaker / headsail scale remains at default 1.0 (cannot be reefed)
      sailJibNode.scale.set(1, 1, 1);
    }
  });

  return (
    <group
      ref={groupRef}
      scale={1.0}
      position={[boat.position.x, boat.bobM, -boat.position.y]}
      rotation={[degToRad(boat.pitchDeg), -degToRad(boat.headingDeg), degToRad(boat.heelDeg)]}
    >
      {/* 1. Rigged glTF Catamaran Model from Blender */}
      <primitive object={formattedScene} />

      {/* 2. Asymmetric jib: Blender mesh as cloth-sim rest shape, tacked to the bowsprit ring */}
      <group rotation={[0, Math.PI, 0]}>
        <SpinnakerSail />
      </group>
    </group>
  );
}

// Traveler car = Object.104 in the export (rest centered, on the arch track).
// Travel trimmed twice per Kord: raw ±2.2 m → ±1.65 → ±1.24 (each pass 25%
// shorter outboard) to keep the car on the usable rail.
const TRAVELER_TRACK_HALF_M = 1.24;
const TILT_AXIS_Z = new THREE.Vector3(0, 0, 1);
const _tiltQuat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();
const AXIS_Y_LOCAL = new THREE.Vector3(0, 1, 0);
const _ropeDir = new THREE.Vector3();
// Arch-top camber measured across the FULL arch (Object.003 + neighbors,
// 8.7k surface points): y(x) = y0 − 0.0265·x² — 13 cm of drop at the track
// ends. (First fit used only the small Object.095 segment and undershot.)
const ARCH_SAG_PER_X2 = -0.0265;

/// Split a (baked, world-space) geometry into its connected mesh islands.
/// Vertices are welded by quantized position for connectivity only; each
/// island comes back as an independent non-indexed BufferGeometry.
function splitConnectedComponents(geo: THREE.BufferGeometry, maxParts: number): THREE.BufferGeometry[] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const index = geo.index;
  const triCount = index ? index.count / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);

  // Weld by quantized position (1 mm) so seam-split vertices connect.
  const weld = new Map<string, number>();
  const weldOf = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
    let w = weld.get(key);
    if (w === undefined) {
      w = weld.size;
      weld.set(key, w);
    }
    weldOf[i] = w;
  }

  // Union-find over welded ids.
  const parent = new Int32Array(weld.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t < triCount; t++) {
    union(weldOf[vi(t, 0)], weldOf[vi(t, 1)]);
    union(weldOf[vi(t, 0)], weldOf[vi(t, 2)]);
  }

  // Bucket triangles by component root.
  const buckets = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const root = find(weldOf[vi(t, 0)]);
    let arr = buckets.get(root);
    if (!arr) {
      arr = [];
      buckets.set(root, arr);
    }
    arr.push(t);
  }

  const parts: THREE.BufferGeometry[] = [];
  const sorted = [...buckets.values()].sort((a, b) => b.length - a.length).slice(0, maxParts);
  for (const tris of sorted) {
    const out = new Float32Array(tris.length * 9);
    let o = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const v = vi(t, k);
        out[o++] = pos.getX(v);
        out[o++] = pos.getY(v);
        out[o++] = pos.getZ(v);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  return parts;
}

useGLTF.preload('/lagoon-450s.glb');
useGLTF.preload('/sail-jib.glb');
