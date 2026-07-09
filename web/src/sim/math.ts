import type { Vec2 } from './types';

export const KNOT_TO_MPS = 0.514444;
export const MPS_TO_KNOT = 1 / KNOT_TO_MPS;

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function normalize360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function normalize180(deg: number): number {
  const value = ((deg + 180) % 360 + 360) % 360 - 180;
  return value === -180 ? 180 : value;
}

export function angleDiffDeg(a: number, b: number): number {
  return normalize180(a - b);
}

export function vectorFromToDeg(speed: number, toDeg: number): Vec2 {
  const rad = degToRad(toDeg);
  return {
    x: speed * Math.sin(rad),
    y: speed * Math.cos(rad),
  };
}

export function vectorMagnitude(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function vectorToDeg(v: Vec2): number {
  if (vectorMagnitude(v) < 0.000001) return 0;
  return normalize360(radToDeg(Math.atan2(v.x, v.y)));
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, factor: number): Vec2 {
  return { x: v.x * factor, y: v.y * factor };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

export function windOverWater(windGround: Vec2, currentGround: Vec2): Vec2 {
  return sub(windGround, currentGround);
}

export function boatOverGround(boatWater: Vec2, currentGround: Vec2): Vec2 {
  return add(boatWater, currentGround);
}

/**
 * Canonical wave elevation (metres, up-positive) at a display-frame position.
 * MUST stay in lockstep with the backend physics loop (src/main.rs wave pose
 * + bridgedeck slam) — the backend drives the boat's heave/pitch/roll from
 * this exact field, so any formula drift makes the boat float above or
 * tunnel through the rendered surface. `t` is the BACKEND clock (elapsed_s).
 */
export function waveElevation(
  east: number,
  north: number,
  t: number,
  waveHeightM: number,
  wavePeriodS: number,
  waveToDeg: number
): number {
  if (waveHeightM <= 0.001) return 0;
  const dir = degToRad(waveToDeg);
  const along = east * Math.sin(dir) + north * Math.cos(dir);
  const ph = 0.08 * along - (t / Math.max(1, wavePeriodS)) * Math.PI * 2;
  return waveHeightM * (0.36 * Math.sin(ph) + 0.09 * Math.sin(1.7 * ph + 0.8));
}

/** Scene-coordinate wrapper (scene x = east, scene z = −north). */
export function getWaveHeight(
  x: number,
  z: number,
  t: number,
  waveHeightM: number,
  wavePeriodS: number,
  waveToDeg: number
): number {
  return waveElevation(x, -z, t, waveHeightM, wavePeriodS, waveToDeg);
}
