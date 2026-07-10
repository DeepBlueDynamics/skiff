import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useSimulator } from '../sim/store';

// GPU Gerstner ocean.
//
// Wave components C0 and C1 are the CANONICAL physics field and MUST stay in
// lockstep with src/main.rs (wave_pose + slam) and sim/math.ts waveElevation:
//   ph = 0.08·along − (2π/T)·t,  along = E·sin(dir) + N·cos(dir)
//   η  = H·(0.36·sin(ph) + 0.09·sin(1.7·ph + 0.8))
// The backend drives the hull's heave/roll/pitch from that exact field, so the
// vertical part of C0/C1 here is identical — the boat sits on the rendered
// swell. Components C2+ are visual chop with wavelengths shorter than the
// hull (≤ 24 m): the hull legitimately averages those out, so they carry no
// physics and only sculpt the surface.
//
// Gerstner form per component: vertical A·sin(ph), horizontal Q·A·cos(ph)
// along the travel direction — circles crest-forward, sharpening crests and
// flattening troughs. Normals are analytic (summed derivatives), so specular
// shape survives without CPU normal recomputation.

const PLANE_SIZE = 1000;
const SEGMENTS = 320; // ~3.1 m spacing — resolves the shortest chop (λ 7.5 m)
const GRID_SNAP_M = PLANE_SIZE / SEGMENTS;

const OCEAN_VERTEX_PARS = /* glsl */ `
uniform float uTime;
uniform float uWaveHeight;
uniform float uWavePeriod;
uniform float uWaveDir; // radians, display compass TO-direction
varying float vCrest;

// One Gerstner component: accumulates displacement and elevation gradient.
// dirEN = unit (east, north); k rad/m; amp m; omega rad/s; q steepness 0..1.
void gerstner(
  vec2 en, vec2 dirEN, float k, float amp, float omega, float phase0, float q,
  inout vec3 disp, inout vec2 grad
) {
  float ph = k * dot(en, dirEN) - omega * uTime + phase0;
  float s = sin(ph);
  float c = cos(ph);
  disp.z += amp * s;                 // vertical (up)
  disp.xy += dirEN * (q * amp * c);  // horizontal, crest-forward (east, north)
  grad += dirEN * (amp * k * c);     // ∂η/∂(east,north)
}
`;

// Runs right after beginnormal_vertex — BEFORE defaultnormal_vertex and
// begin_vertex in three's template — so both the analytic normal and the
// later position displacement can use the same computation. The locals
// (oceanDisp/oceanGrad) stay in scope for the whole of main().
const OCEAN_COMPUTE = /* glsl */ `
// Local plane coords → display frame: local x = east, local y = north
// (mesh is rotated -π/2 about X and grid-snapped; the snap offset arrives
// via uniforms so the wave field stays world-fixed).
vec2 enPos = position.xy + vec2(uOffsetEast, uOffsetNorth);

vec3 oceanDisp = vec3(0.0);
vec2 oceanGrad = vec2(0.0);

float waveH = uWaveHeight;
if (waveH > 0.001) {
  float w0 = 6.28318530718 / uWavePeriod;
  // Deep-water dispersion: k = ω²/g (in lockstep with backend + math.ts).
  // Render-side λ floor (~8 m): the 3.1 m vertex grid can't draw shorter —
  // and the backend's hull averaging means the boat ignores them anyway.
  float k0 = min(w0 * w0 / 9.81, 0.8);
  float k1 = min((1.7 * w0) * (1.7 * w0) / 9.81, 1.2);
  vec2 d0 = vec2(sin(uWaveDir), cos(uWaveDir));
  // C0/C1 — canonical physics components (vertical part MUST match backend).
  gerstner(enPos, d0, k0, 0.36 * waveH, w0, 0.0, 0.30, oceanDisp, oceanGrad);
  gerstner(enPos, d0, k1, 0.09 * waveH, 1.7 * w0, 0.8, 0.40, oceanDisp, oceanGrad);
  // C2+ — visual chop, deep-water dispersion ω = sqrt(g·k), sub-hull λ.
  vec2 d1 = vec2(sin(uWaveDir + 0.55), cos(uWaveDir + 0.55));
  vec2 d2 = vec2(sin(uWaveDir - 0.72), cos(uWaveDir - 0.72));
  vec2 d3 = vec2(sin(uWaveDir + 1.15), cos(uWaveDir + 1.15));
  gerstner(enPos, d1, 0.262, 0.050 * waveH, sqrt(9.81 * 0.262), 1.7, 0.55, oceanDisp, oceanGrad); // λ 24 m
  gerstner(enPos, d2, 0.483, 0.030 * waveH, sqrt(9.81 * 0.483), 4.1, 0.62, oceanDisp, oceanGrad); // λ 13 m
  gerstner(enPos, d3, 0.838, 0.018 * waveH, sqrt(9.81 * 0.838), 2.6, 0.70, oceanDisp, oceanGrad); // λ 7.5 m
}

// Analytic surface normal (local frame: x east, y north, z up). With H = 0
// the gradient is zero and this is exactly the flat plane normal.
objectNormal = normalize(vec3(-oceanGrad.x, -oceanGrad.y, 1.0));
`;

const OCEAN_DISPLACE = /* glsl */ `
// local: x = east, y = north, z = up
transformed += oceanDisp;
vCrest = clamp(oceanDisp.z / max(0.45 * uWaveHeight, 0.001), -1.0, 1.0);
`;

const OCEAN_FRAGMENT_PARS = /* glsl */ `
varying float vCrest;
`;

const OCEAN_FRAGMENT_TINT = /* glsl */ `
// Subtle sea-state shading: crests lighten toward green-white, troughs
// deepen. Zero-centered so flat calm keeps the base color exactly.
vec3 crestTint = vec3(0.55, 0.80, 0.78);
vec3 troughTint = vec3(0.05, 0.14, 0.22);
float ct = smoothstep(0.15, 0.95, vCrest);
float tt = smoothstep(0.15, 0.95, -vCrest);
diffuseColor.rgb = mix(diffuseColor.rgb, crestTint, ct * 0.22);
diffuseColor.rgb = mix(diffuseColor.rgb, troughTint, tt * 0.30);
`;

export function Water() {
  const meshRef = useRef<THREE.Mesh>(null);
  const boat = useSimulator((state) => state.boat);
  const settings = useSimulator((state) => state.settings);

  const geometry = useMemo(
    () => new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, SEGMENTS, SEGMENTS),
    []
  );

  // Wave phase runs on the BACKEND clock: snap to elapsed_s whenever a fresh
  // poll sample lands, advance with local frame time in between. A purely
  // local clock would drift the surface out of phase with the boat's
  // backend-computed heave/roll/pitch.
  const waveClock = useRef({ t: 0, lastSample: -1 });

  // Shared uniform objects — mutated per frame, read by the injected shader.
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uWaveHeight: { value: 0 },
      uWavePeriod: { value: 7 },
      uWaveDir: { value: 0 },
      uOffsetEast: { value: 0 },
      uOffsetNorth: { value: 0 },
    }),
    []
  );

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

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: '#205370', // Lightened ocean teal/blue
      roughness: 0.22, // Lower roughness to catch shiny sun highlights
      metalness: 0.1,
      transparent: true,
      opacity: 0.93,
      // transparent surface must not occlude what's beneath — sub-surface
      // particles draw after it (renderOrder) and blend through
      depthWrite: false,
      bumpMap: bumpTexture,
      bumpScale: 0.02, // micro-ripple detail on top of the analytic normal
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uOffsetEast;\nuniform float uOffsetNorth;\n' +
            OCEAN_VERTEX_PARS
        )
        // beginnormal_vertex runs BEFORE defaultnormal_vertex and begin_vertex
        // in the template — compute everything there, displace later.
        .replace(
          '#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\n' + OCEAN_COMPUTE
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + OCEAN_DISPLACE);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + OCEAN_FRAGMENT_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + OCEAN_FRAGMENT_TINT);
    };
    return mat;
  }, [bumpTexture, uniforms]);

  useFrame((state, delta) => {
    // Snap the plane to the vertex grid; the offset uniforms carry the snap
    // into the shader so the wave field stays world-fixed.
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

    uniforms.uTime.value = clock.t;
    uniforms.uWaveHeight.value = settings.waveHeightM;
    uniforms.uWavePeriod.value = Math.max(1, settings.wavePeriodS);
    uniforms.uWaveDir.value = (settings.waveToDeg * Math.PI) / 180;
    uniforms.uOffsetEast.value = snapX;
    // local y = north; world z = −north ⇒ north offset = −snapZ
    uniforms.uOffsetNorth.value = -snapZ;

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
      <primitive object={material} attach="material" />
    </mesh>
  );
}
