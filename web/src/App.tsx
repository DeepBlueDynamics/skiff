import { AuthButton } from './components/AuthButton';
import { ControlsPanel } from './components/ControlsPanel';
import { Hud } from './components/Hud';
import { KeyboardControls } from './components/KeyboardControls';
import { SailTelemetryPanel } from './components/SailTelemetryPanel';
import { SimulatorScene } from './components/SimulatorScene';

export default function App() {
  return (
    <main className="app-shell">
      <KeyboardControls />
      <SimulatorScene />
      <Hud />
      <AuthButton />
      <ControlsPanel />
      <SailTelemetryPanel />
    </main>
  );
}
