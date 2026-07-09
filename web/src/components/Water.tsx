import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useSimulator } from '../sim/store';
import { waveElevation } from '../sim/math';

// 10 m vertex grid over the 1000 m plane — smooth for the ~78 m primary
// wavelength (k = 0.08) while keeping per-frame displacement cheap.
const WATER_SEGMENTS = 100;
const GRID_SNAP_M = 1000 / WATER_SEGMENTS;

export function Water() {
  const meshRef = useRef<THREE.Mesh>(null);
  const boat = useSimulator((state) => state.boat);
  const settings = useSimulator((state) => state.settings);

  const geometry = useMemo(
    () => new THREE.PlaneGeometry(1000, 1000, WATER_SEGMENTS, WATER_SEGMENTS),
    []
  );
  // Wave phase runs on the BACKEND clock: snap to elapsed_s whenever a fresh
  // poll sample lands, advance with local frame time in between. Using a
  // purely local clock would drift the surface out of phase with the boat's
  // backend-computed heave/pitch/roll.
  const waveClock = useRef({ t: 0, lastSample: -1 });
  const wasFlat = useRef(true);

  // Generate a procedural water bump map canvas texture
  const bumpTexture = useMemo(() => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const idx = (y * size + x) * 4;
          const nx = x / size;
          const ny = y / size;
          
          // Overlapping wave frequencies to simulate ocean ripple patterns
          const w1 = Math.sin(nx * Math.PI * 4 + ny * Math.PI * 2);
          const w2 = Math.sin(ny * Math.PI * 6 - nx * Math.PI * 2);
          const w3 = Math.cos((nx - ny) * Math.PI * 8);
          const w4 = Math.sin(Math.hypot(nx - 0.5, ny - 0.5) * Math.PI * 12);
          
          const val = (w1 + w2 + w3 * 0.5 + w4 * 0.3 + 2.8) / 5.6;
          const grey = Math.floor(val * 255);
          
          imgData.data[idx] = grey;
          imgData.data[idx + 1] = grey;
          imgData.data[idx + 2] = grey;
          imgData.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(400, 400); // Dense wave repetition across the 1000m plane
    return texture;
  }, []);

  useFrame((state, delta) => {
    // Snap the plane to the vertex grid so following the boat doesn't make
    // the displaced vertices swim.
    const snapX = Math.round(boat.position.x / GRID_SNAP_M) * GRID_SNAP_M;
    const snapZ = Math.round(-boat.position.y / GRID_SNAP_M) * GRID_SNAP_M;
    if (meshRef.current) {
      meshRef.current.position.set(snapX, 0, snapZ);
    }

    const clock = waveClock.current;
    clock.t += Math.min(delta, 0.2);
    const sample = boat.simTimeS;
    if (sample !== undefined && sample !== clock.lastSample) {
      clock.t = sample;
      clock.lastSample = sample;
    }

    const { waveHeightM, wavePeriodS, waveToDeg } = settings;
    const pos = geometry.attributes.position;
    if (waveHeightM > 0.001) {
      // Plane is rotated -π/2 about X: local x → world x (east), local y →
      // world −z, local z (displacement) → world y (up). So for vertex i:
      // east = snapX + x_i, north = −worldZ = y_i − snapZ.
      for (let i = 0; i < pos.count; i++) {
        const east = snapX + pos.getX(i);
        const north = pos.getY(i) - snapZ;
        pos.setZ(i, waveElevation(east, north, clock.t, waveHeightM, wavePeriodS, waveToDeg));
      }
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
      wasFlat.current = false;
    } else if (!wasFlat.current) {
      for (let i = 0; i < pos.count; i++) pos.setZ(i, 0);
      pos.needsUpdate = true;
      geometry.computeVertexNormals();
      wasFlat.current = true;
    }

    if (bumpTexture) {
      // Gently drift the ripples over time
      const time = state.clock.getElapsedTime();
      bumpTexture.offset.x = time * 0.005;
      bumpTexture.offset.y = time * 0.003;
    }
  });

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        color="#205370" // Lightened ocean teal/blue
        roughness={0.22} // Lower roughness to catch shiny sun highlights
        metalness={0.1}
        transparent
        opacity={0.93} // Less transparent (previously 0.8)
        depthWrite={false} // transparent surface must not occlude what's beneath —
        // sub-surface particles draw after it (renderOrder) and blend through
        bumpMap={bumpTexture}
        bumpScale={0.02} // Very slight bump map depth
      />
    </mesh>
  );
}
