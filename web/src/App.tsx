import { ControlsPanel } from './components/ControlsPanel';
import { Hud } from './components/Hud';
import { KeyboardControls } from './components/KeyboardControls';
import { SimulatorScene } from './components/SimulatorScene';

export default function App() {
  return (
    <main className="app-shell">
      <KeyboardControls />
      <SimulatorScene />
      <Hud />
      <ControlsPanel />
    </main>
  );
}
