import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useSimulator } from '../sim/store';

// Grenada + everything within ~20 nm, from OSM coastline data (ODbL) baked by
// the world build script into /world/grenada.geojson. Rendering approach per
// meridian's land-polygon pattern: extruded coastline rings, world-fixed.
//
// Projection MUST match the backend (src/core/geo.rs move_latlon): sphere of
// radius 6,371,000 m, east = R·cos(lat)·Δlon, north = R·Δlat.
const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;

type WorldData = {
  ref: { lat: number; lon: number };
  geometry: THREE.ExtrudeGeometry;
};

const LAND_HEIGHT_M = 3; // low plateau; real DEM elevation is a follow-up

export function Island() {
  const boat = useSimulator((state) => state.boat);
  const groupRef = useRef<THREE.Group>(null);
  const [world, setWorld] = useState<WorldData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/world/grenada.geojson');
        if (!res.ok) return;
        const fc = await res.json();
        const ref = fc.properties?.ref ?? { lat: 12.001, lon: -61.764 };
        const mLat = EARTH_RADIUS_M * DEG;
        const mLon = EARTH_RADIUS_M * Math.cos(ref.lat * DEG) * DEG;
        const shapes: THREE.Shape[] = [];
        for (const f of fc.features ?? []) {
          const ring: [number, number][] = f.geometry?.coordinates?.[0];
          if (!ring || ring.length < 4) continue;
          const shape = new THREE.Shape();
          ring.forEach(([lon, lat], i) => {
            const east = (lon - ref.lon) * mLon;
            const north = (lat - ref.lat) * mLat;
            if (i === 0) shape.moveTo(east, north);
            else shape.lineTo(east, north);
          });
          shapes.push(shape);
        }
        if (cancelled || shapes.length === 0) return;
        const geometry = new THREE.ExtrudeGeometry(shapes, {
          depth: LAND_HEIGHT_M,
          bevelEnabled: false,
        });
        setWorld({ ref, geometry });
      } catch (e) {
        console.error('Failed to load world coastline:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#41603c', // tropical scrub green
        roughness: 0.96,
        metalness: 0.0,
      }),
    []
  );

  useFrame(() => {
    if (!groupRef.current || !world) return;
    // The scene origin floats (local_pos resets on teleports), so pin the
    // island to the world each frame: sceneLand = boatScene − metersFromRef(gps).
    const mLat = EARTH_RADIUS_M * DEG;
    const mLon = EARTH_RADIUS_M * Math.cos(world.ref.lat * DEG) * DEG;
    const eastOff = (boat.gps.lon - world.ref.lon) * mLon;
    const northOff = (boat.gps.lat - world.ref.lat) * mLat;
    groupRef.current.position.set(
      boat.position.x - eastOff,
      0,
      -(boat.position.y - northOff)
    );
  });

  if (!world) return null;
  return (
    <group ref={groupRef}>
      {/* shape XY = (east, north); rotate -π/2 so north → −z, extrude → up */}
      <mesh
        geometry={world.geometry}
        material={material}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
      />
    </group>
  );
}
