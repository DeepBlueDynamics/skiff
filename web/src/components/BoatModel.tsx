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
    return { 
      formattedScene: wrapper, 
      rudderPortNode: rudderPort, 
      rudderStbdNode: rudderStbd, 
      propPortNode: propPort, 
      propStbdNode: propStbd,
      sailMainNode: sailMain,
      sailJibNode: sailJib,
      steeringWheelNode: steeringWheel,
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

useGLTF.preload('/lagoon-450s.glb');
useGLTF.preload('/sail-jib.glb');
