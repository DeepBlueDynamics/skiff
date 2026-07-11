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
  /** Backend physics clock (elapsed_s) — wave phase must use THIS, not a
   *  local accumulator, or the water surface drifts out of sync with the
   *  boat's backend-computed heave/pitch/roll. */
  simTimeS?: number;
  /** True while live Meridian environment data is flowing into the backend. */
  envLive?: boolean;
  /** Diesel remaining, port/starboard tanks (liters; 275 L capacity each). */
  fuelPortL?: number;
  fuelStbdL?: number;
  /** Water depth (m) and depth over keel (m) from the bathymetry grid. */
  depthM?: number | null;
  depthOverKeelM?: number | null;
  /** OpenCPN route guidance via SignalK; ageS derived from elapsed clocks. */
  routeGuidance?: {
    bearingTrueDeg?: number | null;
    xteM?: number | null;
    ageS: number;
  } | null;
  /** Backend course-hold heading (MCP set_course). Non-null = an agent has
   *  the helm; manual steering is overridden until released. */
  apHeadingDeg?: number | null;
  /** Backend engine override (MCP set_engines). Non-null = an agent runs the
   *  engines; the throttle sliders are overridden until released. */
  apThrustN?: number | null;
};

export type SimSettings = {
  windSpeedMps: number;
  windToDeg: number;
  currentSpeedMps: number;
  currentToDeg: number;
  waveHeightM: number;
  wavePeriodS: number;
  waveToDeg: number;
  /** Boat displacement as % of stock (100 = as-built Lagoon 450S). */
  massScalePct: number;
  /** Mainsheet traveler car: −100 full port … 0 centered … +100 full stbd. */
  travelerPct: number;
  showCurrent: boolean;
  showVectors: boolean;
  dataSource: 'real' | 'simulated';
  gpsLat: number;
  gpsLon: number;
  autopilotEnabled: boolean;
  targetHeading: number;
  sailFullness: number;
  spinnakerTackSlack: number;
  spinnakerClewSlack: number;
  luffPinned: boolean;
  sheetSide: 'port' | 'starboard';
  /** Which headsail is bent on. The current cloth mesh is the code zero. */
  headsailType: 'codezero';
  /** Boom vang tension (%): 100 = bar-taut mainsheet line, 0 = slack sag. */
  vangPct: number;
  /** Full-throttle fuel burn per engine (L/h) for the consumption estimate. */
  fuelBurnMaxLph: number;
  showForceArrows: boolean;
  pressureShading: boolean;
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
