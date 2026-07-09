import { useEffect } from 'react';
import { useSimulator } from '../sim/store';

const pressed = new Set<string>();

export function KeyboardControls() {
  const setInput = useSimulator((state) => state.setInput);
  const setSetting = useSimulator((state) => state.setSetting);
  const settings = useSimulator((state) => state.settings);
  const resetBoat = useSimulator((state) => state.resetBoat);

  useEffect(() => {
    const sync = () => {
      const left = pressed.has('arrowleft') || pressed.has('a');
      const right = pressed.has('arrowright') || pressed.has('d');
      const trimIn = pressed.has('w');
      const trimOut = pressed.has('s');
      const reefIn = pressed.has('q');
      const reefOut = pressed.has('e');
      setInput({
        helm: (left ? 1 : 0) + (right ? -1 : 0),
        trimDelta: (trimIn ? 1 : 0) + (trimOut ? -1 : 0),
        reefDelta: (reefIn ? 1 : 0) + (reefOut ? -1 : 0),
      });
    };

    const keydown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      pressed.add(key);
      if (key === 'r') resetBoat();
      if (key === 'c') setSetting('showCurrent', !settings.showCurrent);
      if (key === '.') setSetting('windSpeedMps', Math.min(18, settings.windSpeedMps + 0.5));
      if (key === ',') setSetting('windSpeedMps', Math.max(0, settings.windSpeedMps - 0.5));
      if (key === 'a' || key === 'd' || key === 'arrowleft' || key === 'arrowright') {
        setSetting('autopilotEnabled', false);
      }
      sync();
    };
    const keyup = (event: KeyboardEvent) => {
      pressed.delete(event.key.toLowerCase());
      sync();
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
  }, [resetBoat, setInput, setSetting, settings.showCurrent, settings.windSpeedMps]);

  return null;
}
