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

export function getWaveHeight(
  x: number,
  z: number,
  t: number,
  waveHeightM: number,
  wavePeriodS: number,
  waveToDeg: number
): number {
  const dir = degToRad(waveToDeg);
  const sx = Math.sin(dir);
  const sz = Math.cos(dir);
  const amp = waveHeightM * 0.42;
  const period = Math.max(1, wavePeriodS);
  const along = x * sx + z * sz;
  return (
    Math.sin(along * 0.08 - (t / period) * Math.PI * 2) * amp +
    Math.sin(x * 0.035 + z * 0.052 - t * 0.65) * amp * 0.22
  );
}
