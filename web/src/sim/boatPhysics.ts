import type { BoatState } from './types';

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
