import { create } from 'zustand';
import { createInitialBoatState } from './boatPhysics';
import type { BoatState, SimSettings } from './types';

type SimulatorStore = {
  boat: BoatState;
  settings: SimSettings;
  input: {
    helm: number;
    trimDelta: number;
    reefDelta: number;
    thrustPort: number;
    thrustStbd: number;
  };
  elapsed: number;
  sailForces: {
    f_body: [number, number, number];
    tau_body: [number, number, number];
  };
  setBoat: (boat: BoatState) => void;
  setElapsed: (elapsed: number) => void;
  resetBoat: () => void;
  setInput: (input: Partial<SimulatorStore['input']>) => void;
  setSetting: <K extends keyof SimSettings>(key: K, value: SimSettings[K]) => void;
  toggleCastOffMode: () => void;
  setSailForces: (forces: SimulatorStore['sailForces']) => void;
};

export const useSimulator = create<SimulatorStore>((set) => ({
  boat: createInitialBoatState(),
  settings: {
    windSpeedMps: 5,
    windToDeg: 150,
    currentSpeedMps: 0.55,
    currentToDeg: 85,
    waveHeightM: 0.0,
    wavePeriodS: 7,
    waveToDeg: 290,
    showCurrent: true,
    showVectors: true,
    dataSource: 'simulated',
    gpsLat: 25.0,
    gpsLon: -80.0,
    autopilotEnabled: false,
    targetHeading: 20,
    sailFullness: 1.0,
    spinnakerTackSlack: 1.05,
    spinnakerClewSlack: 1.0,
    luffPinned: true,
    showForceArrows: true,
    pressureShading: true,
    showRigPoints: false,
  },
  input: {
    helm: 0,
    trimDelta: 0,
    reefDelta: 0,
    thrustPort: 0,
    thrustStbd: 0,
  },
  elapsed: 0,
  sailForces: {
    f_body: [0, 0, 0],
    tau_body: [0, 0, 0],
  },
  setBoat: (boat) => set({ boat }),
  setElapsed: (elapsed) => set({ elapsed }),
  resetBoat: () => {
    fetch('/v1/sim/reset', { method: 'POST' }).catch(console.error);
    set({ boat: createInitialBoatState(), elapsed: 0 });
  },
  setInput: (input) => set((state) => ({ input: { ...state.input, ...input } })),
  setSetting: (key, value) => set((state) => ({ settings: { ...state.settings, [key]: value } })),
  toggleCastOffMode: () =>
    set((state) => ({ boat: { ...state.boat, castOffHeadToWind: !state.boat.castOffHeadToWind } })),
  setSailForces: (sailForces) => set({ sailForces }),
}));

if (typeof window !== 'undefined') {
  (window as any).__useSimulator = useSimulator;
}
