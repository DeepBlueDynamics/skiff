export type Vec2 = {
  x: number;
  y: number;
};

export type EnvironmentSample = {
  windGround: Vec2;
  currentGround: Vec2;
  waveHeightM: number;
  wavePeriodS: number;
  waveToDeg: number;
  source?: string;
  ageSecs?: number;
};

export type BoatState = {
  position: Vec2;
  gps: { lat: number; lon: number };
  headingDeg: number;
  cogDeg: number;
  stwMps: number;
  sogMps: number;
  velocityWater: Vec2;
  velocityGround: Vec2;
  rudderDeg: number;
  sailTrim: number;
  reef: number;
  heelDeg: number;
  pitchDeg: number;
  bobM: number;
  twaDeg: number;
  twsMps: number;
  course: WindCourse;
  castOffHeadToWind: boolean;
  trail: Vec2[];
  mainDropped?: boolean;
  thrustPort?: number;
  thrustStbd?: number;
  stabilityState?: string;
  slamWarning?: boolean;
};

export type SimSettings = {
  windSpeedMps: number;
  windToDeg: number;
  currentSpeedMps: number;
  currentToDeg: number;
  waveHeightM: number;
  wavePeriodS: number;
  waveToDeg: number;
  showCurrent: boolean;
  showVectors: boolean;
  dataSource: 'real' | 'simulated';
  gpsLat: number;
  gpsLon: number;
  autopilotEnabled: boolean;
  targetHeading: number;
  spinnakerEdgeTension: number;
  showRigPoints: boolean;
};

export type WindCourse =
  | 'head-to-wind'
  | 'close-hauled'
  | 'crossing-wind'
  | 'broad-reach'
  | 'wind-right-aft';

export type EnvironmentProvider = {
  sample(position: Vec2, timeMs: number): Promise<EnvironmentSample>;
};
