import { vectorFromToDeg } from './math';
import type { EnvironmentProvider, EnvironmentSample, SimSettings, Vec2 } from './types';

export class ManualEnvironmentProvider implements EnvironmentProvider {
  constructor(private getSettings: () => SimSettings) {}

  async sample(_position: Vec2, _timeMs: number): Promise<EnvironmentSample> {
    const settings = this.getSettings();
    return {
      windGround: vectorFromToDeg(settings.windSpeedMps, settings.windToDeg),
      currentGround: vectorFromToDeg(settings.currentSpeedMps, settings.currentToDeg),
      waveHeightM: settings.waveHeightM,
      wavePeriodS: settings.wavePeriodS,
      waveToDeg: settings.waveToDeg,
      source: 'manual',
      ageSecs: 0,
    };
  }
}
