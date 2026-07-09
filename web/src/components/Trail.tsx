import { useMemo } from 'react';
import * as THREE from 'three';
import { useSimulator } from '../sim/store';

export function Trail() {
  const trail = useSimulator((state) => state.boat.trail);
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.LineBasicMaterial({ color: '#ffcf5a', transparent: true, opacity: 0.8 });
    return new THREE.Line(geometry, material);
  }, []);

  line.geometry.setFromPoints(trail.map((p) => new THREE.Vector3(p.x, 0.08, -p.y)));

  return <primitive object={line} />;
}
