import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useSimulator } from '../sim/store';

export function Water() {
  const meshRef = useRef<THREE.Mesh>(null);
  const boat = useSimulator((state) => state.boat);

  const geometry = useMemo(() => new THREE.PlaneGeometry(1000, 1000), []);

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

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.position.set(boat.position.x, 0, -boat.position.y);
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
