import {
  add,
  angleDiffDeg,
  boatOverGround,
  clamp,
  lerp,
  normalize360,
  scale,
  vectorFromToDeg,
  vectorMagnitude,
  vectorToDeg,
  windOverWater,
} from './math';
import type { BoatState, EnvironmentSample, Vec2, WindCourse } from './types';

export function createInitialBoatState(): BoatState {
  return {
    position: { x: 0, y: 0 },
    gps: { lat: 25.0, lon: -80.0 },
    headingDeg: 20,
    cogDeg: 20,
    stwMps: 0,
    sogMps: 0,
    velocityWater: { x: 0, y: 0 },
    velocityGround: { x: 0, y: 0 },
    rudderDeg: 0,
    sailTrim: 0.76,
    reef: 0,
    heelDeg: 0,
    pitchDeg: 0,
    bobM: 0,
    twaDeg: 0,
    twsMps: 0,
    course: 'head-to-wind',
    castOffHeadToWind: false,
    trail: [{ x: 0, y: 0 }],
    mainDropped: false,
  };
}

export function stepBoat(
  state: BoatState,
  env: EnvironmentSample,
  dt: number,
  input: { helm: number; trimDelta: number; reefDelta: number },
  elapsed: number,
): BoatState {
  const rudderTarget = clamp(input.helm * 32, -32, 32);
  const rudderDeg = lerp(state.rudderDeg, rudderTarget, 1 - Math.exp(-dt * 7));
  const sailTrim = clamp(state.sailTrim + input.trimDelta * dt * 0.35, 0, 1);
  const reef = clamp(state.reef + input.reefDelta * dt * 0.25, 0, 1);

  const windWater = windOverWater(env.windGround, env.currentGround);
  const twsMps = vectorMagnitude(windWater);
  const windToDeg = vectorToDeg(windWater);
  const twaDeg = angleDiffDeg(state.headingDeg, windToDeg);
  const course = classifyCourse(twaDeg);
  const waveFactor = waveSpeedFactor(state.headingDeg, env);
  const targetStw = targetSpeedThroughWater(twsMps, twaDeg, course, sailTrim, reef, state.castOffHeadToWind) * waveFactor;
  const stwMps = lerp(state.stwMps, targetStw, 1 - Math.exp(-dt * 0.55));
  const turnRate = rudderDeg * stwMps * 0.72;
  const headingDeg = normalize360(state.headingDeg - turnRate * dt);
  const leewayDeg = computeLeeway(twaDeg, stwMps);
  const velocityWater = vectorFromToDeg(stwMps, headingDeg + leewayDeg);
  const velocityGround = boatOverGround(velocityWater, env.currentGround);
  const position = add(state.position, scale(velocityGround, dt));
  const sogMps = vectorMagnitude(velocityGround);
  const cogDeg = vectorToDeg(velocityGround);
  const wave = sampleWave(position, env, elapsed);
  const heelDeg = clamp(-Math.sin((twaDeg * Math.PI) / 180) * twsMps * sailTrim * (1 - reef) * 1.7, -24, 24);
  const pitchDeg = clamp(wave.pitchDeg + (stwMps - state.stwMps) * 2.5, -9, 9);

  const trail = [...state.trail, position];
  while (trail.length > 260) trail.shift();

  return {
    ...state,
    position,
    headingDeg,
    cogDeg,
    stwMps,
    sogMps,
    velocityWater,
    velocityGround,
    rudderDeg,
    sailTrim,
    reef,
    heelDeg: lerp(state.heelDeg, heelDeg, 1 - Math.exp(-dt * 2.2)),
    pitchDeg: lerp(state.pitchDeg, pitchDeg, 1 - Math.exp(-dt * 2.8)),
    bobM: lerp(state.bobM, wave.height, 1 - Math.exp(-dt * 6)),
    twaDeg,
    twsMps,
    course,
    trail,
  };
}

export function classifyCourse(twaDeg: number): WindCourse {
  const a = Math.abs(twaDeg);
  if (a > 15 && a <= 60) return 'close-hauled';
  if (a > 60 && a <= 110) return 'crossing-wind';
  if (a > 110 && a <= 160) return 'broad-reach';
  if (a > 160 && a <= 180) return 'wind-right-aft';
  return 'head-to-wind';
}

function targetSpeedThroughWater(
  twsMps: number,
  twaDeg: number,
  course: WindCourse,
  trim: number,
  reef: number,
  castOffHeadToWind: boolean,
): number {
  const multiplier = courseMultiplier(course);
  const noGo = !castOffHeadToWind && Math.abs(twaDeg) < 35 ? 0 : 1;
  const trimEfficiency = 0.38 + 0.62 * trim;
  const reefEfficiency = 1 - reef * 0.72;
  const raw = twsMps * 0.42 * multiplier * trimEfficiency * reefEfficiency * noGo;
  return clamp(raw, 0, 4.2);
}

function courseMultiplier(course: WindCourse): number {
  switch (course) {
    case 'head-to-wind':
      return 0.3;
    case 'close-hauled':
      return 0.8;
    case 'crossing-wind':
      return 1.0;
    case 'broad-reach':
      return 1.1;
    case 'wind-right-aft':
      return 1.2;
  }
}

function computeLeeway(twaDeg: number, stwMps: number): number {
  if (stwMps < 0.1) return 0;
  const upwind = clamp(1 - Math.abs(twaDeg) / 70, 0, 1);
  return Math.sign(twaDeg) * upwind * 5.5;
}

function waveSpeedFactor(headingDeg: number, env: EnvironmentSample): number {
  const headSea = Math.abs(angleDiffDeg(headingDeg, env.waveToDeg + 180)) / 180;
  const shortPeriod = env.wavePeriodS < 5 ? (5 - env.wavePeriodS) / 5 : 0;
  const penalty = env.waveHeightM * 0.035 + shortPeriod * 0.08 + headSea * 0.06;
  return clamp(1 - penalty, 0.55, 1.05);
}

export function sampleWave(position: Vec2, env: EnvironmentSample, elapsed: number): { height: number; pitchDeg: number; rollDeg: number } {
  const waveRad = (env.waveToDeg * Math.PI) / 180;
  const along = position.x * Math.sin(waveRad) + position.y * Math.cos(waveRad);
  const period = Math.max(1, env.wavePeriodS);
  const phase = along * 0.08 - (elapsed / period) * Math.PI * 2;
  const height = Math.sin(phase) * env.waveHeightM * 0.36 + Math.sin(phase * 1.7 + 0.8) * env.waveHeightM * 0.09;
  return {
    height,
    pitchDeg: Math.cos(phase) * env.waveHeightM * 1.4,
    rollDeg: Math.sin(phase * 0.7) * env.waveHeightM * 1.1,
  };
}
