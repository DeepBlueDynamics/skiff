import { useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useSimulator } from '../sim/store';
import { vectorFromToDeg, vectorMagnitude, vectorToDeg, windOverWater } from '../sim/math';

const MPS_TO_KNOT = 1.9438;

export function Vectors() {
  const boat = useSimulator((state) => state.boat);
  const settings = useSimulator((state) => state.settings);

  const windGround = vectorFromToDeg(settings.windSpeedMps, settings.windToDeg);
  const current = vectorFromToDeg(settings.currentSpeedMps, settings.currentToDeg);
  const windWater = windOverWater(windGround, current);

  // Wind arrows always show (wind is primary situational awareness); the
  // Vectors toggle only hides the boat-motion + current arrows.
  const showBoatVectors = settings.showVectors;

  // Arrows stacked in the band above the coachroof and below/around the boom,
  // riding the hull's heave. Hover an arrow HEAD for its name + magnitude.
  return (
    <group position={[boat.position.x, boat.bobM, -boat.position.y]}>
      {/* Boat-motion arrows — hidden by the Vectors toggle */}
      {showBoatVectors && (
        <>
          <Arrow
            directionDeg={boat.headingDeg}
            length={5}
            color="#f4f7f7"
            y={3.5}
            label="Heading"
            value={`${boat.headingDeg.toFixed(0)}°`}
          />
          <Arrow
            directionDeg={boat.cogDeg}
            length={Math.max(2, boat.sogMps * 2.2)}
            color="#ffcf5a"
            y={3.75}
            label="Course over ground"
            value={`${(boat.sogMps * MPS_TO_KNOT).toFixed(1)} kt @ ${boat.cogDeg.toFixed(0)}°`}
          />
        </>
      )}
      {/* Wind arrows ALWAYS show (primary situational awareness) */}
      <Arrow
        directionDeg={vectorToDeg(windGround)}
        length={Math.max(2.5, vectorMagnitude(windGround) * 0.55)}
        color="#7dd3fc"
        y={4.0}
        label="Wind over ground"
        value={`${(vectorMagnitude(windGround) * MPS_TO_KNOT).toFixed(1)} kt → ${vectorToDeg(windGround).toFixed(0)}°`}
      />
      <Arrow
        directionDeg={vectorToDeg(windWater)}
        length={Math.max(2.5, vectorMagnitude(windWater) * 0.55)}
        color="#38bdf8"
        y={4.5}
        label="Wind over water"
        value={`${(vectorMagnitude(windWater) * MPS_TO_KNOT).toFixed(1)} kt → ${vectorToDeg(windWater).toFixed(0)}°`}
      />
      {showBoatVectors && settings.showCurrent && (
        <Arrow
          directionDeg={settings.currentToDeg}
          length={Math.max(1.5, settings.currentSpeedMps * 3.5)}
          color="#6ee7b7"
          y={4.25}
          label="Current set"
          value={`${(settings.currentSpeedMps * MPS_TO_KNOT).toFixed(1)} kt → ${settings.currentToDeg.toFixed(0)}°`}
        />
      )}
    </group>
  );
}

function Arrow({
  directionDeg,
  length,
  color,
  y,
  label,
  value,
}: {
  directionDeg: number;
  length: number;
  color: string;
  y: number;
  label: string;
  value: string;
}) {
  const [hover, setHover] = useState(false);
  const dir = new THREE.Vector3(
    Math.sin((directionDeg * Math.PI) / 180),
    0,
    -Math.cos((directionDeg * Math.PI) / 180)
  );
  const head = dir.clone().multiplyScalar(length).add(new THREE.Vector3(0, y, 0));
  return (
    <>
      <arrowHelper args={[dir, new THREE.Vector3(0, y, 0), length, color, length * 0.18, length * 0.08]} />
      {/* invisible hit target on the arrow head for hover */}
      <mesh
        position={head}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHover(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <sphereGeometry args={[Math.max(0.35, length * 0.1), 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {hover && (
        <Html position={head} center style={{ pointerEvents: 'none' }}>
          <div
            style={{
              background: 'rgba(8, 22, 32, 0.92)',
              border: `1px solid ${color}`,
              borderRadius: '8px',
              padding: '6px 10px',
              color: '#eef6f9',
              fontSize: '12px',
              whiteSpace: 'nowrap',
              transform: 'translateY(-26px)',
              boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
              fontFamily: 'sans-serif',
            }}
          >
            <div style={{ fontWeight: 700, color, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {label}
            </div>
            <div style={{ fontFamily: 'monospace' }}>{value}</div>
          </div>
        </Html>
      )}
    </>
  );
}
