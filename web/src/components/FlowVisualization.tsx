import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimulator } from '../sim/store';
import { degToRad, getWaveHeight } from '../sim/math';

interface FlowParticle {
  x: number;
  y: number; // horizontal northing coordinate
  z: number; // vertical height off water surface
  age: number;
  maxAge: number;
  speedScale: number;
  zOffset?: number; // Custom air height for wind particles
}


export function FlowVisualization() {
  const settings = useSimulator((state) => state.settings);
  const boat = useSimulator((state) => state.boat);

  const windMeshRef = useRef<THREE.InstancedMesh>(null);
  const currentMeshRef = useRef<THREE.InstancedMesh>(null);

  const count = 350; // Increased particle count for denser, richer flow visualization
  const boundary = 30; // Coverage radius in meters around the boat

  // Initialize wind and current particles at random offsets relative to the boat
  const { windParticles, currentParticles } = useMemo(() => {
    const wind: FlowParticle[] = [];
    const curr: FlowParticle[] = [];
    for (let i = 0; i < count; i++) {
      wind.push({
        x: (Math.random() - 0.5) * boundary * 2,
        y: (Math.random() - 0.5) * boundary * 2,
        z: 0,
        age: Math.random() * 2.5,
        maxAge: 1.5 + Math.random() * 1.5,
        speedScale: 0.85 + Math.random() * 0.3,
        zOffset: 1.2 + Math.random() * 3.8, // Float between 1.2m and 5.0m in the air
      });
      curr.push({
        x: (Math.random() - 0.5) * boundary * 2,
        y: (Math.random() - 0.5) * boundary * 2,
        z: 0,
        age: Math.random() * 3.5,
        maxAge: 2.5 + Math.random() * 2.0,
        speedScale: 0.85 + Math.random() * 0.3,
      });
    }
    return { windParticles: wind, currentParticles: curr };
  }, []);

  // Helper object for instancing matrices
  const tempObject = useMemo(() => new THREE.Object3D(), []);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05);
    
    // Boat world coordinates
    const bx = boat.position.x;
    const by = boat.position.y;

    // 1. Calculate Wind Flow Vector relative to the boat (Apparent Wind)
    const windSpeed = settings.windSpeedMps;
    const windAngleRad = degToRad(settings.windToDeg);
    const windVx = windSpeed * Math.sin(windAngleRad);
    const windVy = -windSpeed * Math.cos(windAngleRad);

    const windVx_rel = windVx - (boat.velocityGround?.x ?? 0);
    const windVy_rel = windVy - (boat.velocityGround?.y ?? 0);
    const relWindAngleRad = Math.atan2(windVx_rel, windVy_rel);

    // 2. Calculate Current Flow Vector relative to the boat (Water flow past hull)
    const currentSpeed = settings.currentSpeedMps;
    const currentAngleRad = degToRad(settings.currentToDeg);
    const currentVx = currentSpeed * Math.sin(currentAngleRad);
    const currentVy = -currentSpeed * Math.cos(currentAngleRad);

    const currentVx_rel = currentVx - (boat.velocityWater?.x ?? 0);
    const currentVy_rel = currentVy - (boat.velocityWater?.y ?? 0);
    const relCurrentAngleRad = Math.atan2(currentVx_rel, currentVy_rel);


    // 4. Update & Render Wind Particles (Tiny golden squares floating in the air)
    if (windMeshRef.current && settings.showVectors) {
      const mesh = windMeshRef.current;
      for (let i = 0; i < count; i++) {
        const p = windParticles[i];
        p.age += dt;

        // Move particle locally relative to the boat (using apparent wind velocity)
        p.x += windVx_rel * p.speedScale * dt;
        p.y += windVy_rel * p.speedScale * dt;


        // Wrap particles around local space (boundaries relative to boat center at 0)
        if (p.x > boundary) p.x -= boundary * 2;
        else if (p.x < -boundary) p.x += boundary * 2;
        if (p.y > boundary) p.y -= boundary * 2;
        else if (p.y < -boundary) p.y += boundary * 2;

        // Reset expired particles
        if (p.age > p.maxAge) {
          p.age = 0;
          p.x = (Math.random() - 0.5) * boundary * 2;
          p.y = (Math.random() - 0.5) * boundary * 2;
          p.maxAge = 1.5 + Math.random() * 1.5;
        }

        p.z = p.zOffset || 1.5;

        // Compute organic fade factor
        const fade = Math.sin((p.age / p.maxAge) * Math.PI);

        tempObject.position.set(p.x, p.z, -p.y);
        tempObject.rotation.set(0, relWindAngleRad, 0);
        // Scale: Keep it square (tiny golden squares drifting in the air)
        tempObject.scale.set(fade * 1.2, fade * 1.2, fade * 1.2);
        tempObject.updateMatrix();

        mesh.setMatrixAt(i, tempObject.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // 5. Update & Render Current Particles (Cyan squares sliding on water surface)
    if (currentMeshRef.current && settings.showCurrent) {
      const mesh = currentMeshRef.current;
      for (let i = 0; i < count; i++) {
        const p = currentParticles[i];
        p.age += dt;

        // Move particle locally relative to the boat (using relative water velocity)
        p.x += currentVx_rel * p.speedScale * dt;
        p.y += currentVy_rel * p.speedScale * dt;

        // Wrap around local space (boundaries relative to boat center at 0)
        if (p.x > boundary) p.x -= boundary * 2;
        else if (p.x < -boundary) p.x += boundary * 2;
        if (p.y > boundary) p.y -= boundary * 2;
        else if (p.y < -boundary) p.y += boundary * 2;

        // Reset expired
        if (p.age > p.maxAge) {
          p.age = 0;
          p.x = (Math.random() - 0.5) * boundary * 2;
          p.y = (Math.random() - 0.5) * boundary * 2;
          p.maxAge = 2.5 + Math.random() * 2.0;
        }

        p.z = 0.03; // Sit 3cm above flat water surface to prevent z-fighting

        // Fade factor
        const fade = Math.sin((p.age / p.maxAge) * Math.PI);

        tempObject.position.set(p.x, p.z, -p.y);
        tempObject.rotation.set(0, relCurrentAngleRad, 0);
        // Scale: Keep it square (small cyan squares on surface)
        tempObject.scale.set(fade * 1.8, fade * 0.8, fade * 1.8);
        tempObject.updateMatrix();

        mesh.setMatrixAt(i, tempObject.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group position={[boat.position.x, 0, -boat.position.y]}>
      {/* Wind Flow Particles (Tiny golden squares in the air) */}
      {settings.showVectors && (
        <instancedMesh ref={windMeshRef} args={[null as any, null as any, count]} castShadow={false} receiveShadow={false}>
          <boxGeometry args={[0.07, 0.07, 0.07]} />
          <meshBasicMaterial
            color="#ffd700" // Golden / Gold
            transparent
            opacity={0.88}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </instancedMesh>
      )}

      {/* Current Flow Particles (Small cyan squares on the water surface) */}
      {settings.showCurrent && (
        <instancedMesh ref={currentMeshRef} args={[null as any, null as any, count]} castShadow={false} receiveShadow={false}>
          <boxGeometry args={[0.15, 0.01, 0.15]} />
          <meshBasicMaterial
            color="#00f0ff" // Bright Cyan / Teal
            transparent
            opacity={0.80}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </instancedMesh>
      )}
    </group>
  );
}
