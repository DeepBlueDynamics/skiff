import * as THREE from 'three';
import { useSimulator } from '../sim/store';
import { vectorFromToDeg, vectorMagnitude, vectorToDeg, windOverWater } from '../sim/math';

export function Vectors() {
  const boat = useSimulator((state) => state.boat);
  const settings = useSimulator((state) => state.settings);
  if (!settings.showVectors) return null;

  const windGround = vectorFromToDeg(settings.windSpeedMps, settings.windToDeg);
  const current = vectorFromToDeg(settings.currentSpeedMps, settings.currentToDeg);
  const windWater = windOverWater(windGround, current);

  return (
    <group position={[boat.position.x, 0.35, -boat.position.y]}>
      <Arrow directionDeg={boat.headingDeg} length={5} color="#f4f7f7" y={0.25} />
      <Arrow directionDeg={boat.cogDeg} length={Math.max(2, boat.sogMps * 2.2)} color="#ffcf5a" y={0.45} />
      <Arrow directionDeg={vectorToDeg(windGround)} length={Math.max(2.5, vectorMagnitude(windGround) * 0.55)} color="#7dd3fc" y={0.7} />
      <Arrow directionDeg={vectorToDeg(windWater)} length={Math.max(2.5, vectorMagnitude(windWater) * 0.55)} color="#38bdf8" y={0.95} />
      {settings.showCurrent && (
        <Arrow directionDeg={settings.currentToDeg} length={Math.max(1.5, settings.currentSpeedMps * 3.5)} color="#6ee7b7" y={1.2} />
      )}
    </group>
  );
}

function Arrow({ directionDeg, length, color, y }: { directionDeg: number; length: number; color: string; y: number }) {
  const dir = new THREE.Vector3(Math.sin((directionDeg * Math.PI) / 180), 0, -Math.cos((directionDeg * Math.PI) / 180));
  const origin = new THREE.Vector3(0, y, 0);
  return <arrowHelper args={[dir, origin, length, color, length * 0.18, length * 0.08]} />;
}
