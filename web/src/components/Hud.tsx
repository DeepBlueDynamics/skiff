import { Anchor, Fuel, Gauge, Navigation, Sailboat, Waves, Wind, MapPin } from 'lucide-react';
import { MPS_TO_KNOT, vectorFromToDeg, vectorMagnitude, vectorToDeg, windOverWater } from '../sim/math';
import { useSimulator } from '../sim/store';

export function Hud() {
  const boat = useSimulator((state) => state.boat);
  const settings = useSimulator((state) => state.settings);
  const current = vectorFromToDeg(settings.currentSpeedMps, settings.currentToDeg);
  const windGround = vectorFromToDeg(settings.windSpeedMps, settings.windToDeg);
  const windWater = windOverWater(windGround, current);

  // Motoring range at CURRENT burn and CURRENT speed over ground.
  const burnFrac = (t: number) => Math.pow(Math.min(1, Math.abs(t) / 3000), 1.5);
  const burnLph =
    (settings.fuelBurnMaxLph ?? 9) * (burnFrac(boat.thrustPort ?? 0) + burnFrac(boat.thrustStbd ?? 0));
  const fuelTotal = (boat.fuelPortL ?? 275) + (boat.fuelStbdL ?? 275);
  const sogKt = boat.sogMps * MPS_TO_KNOT;
  const rangeValue =
    burnLph > 0.05 ? `${((fuelTotal / burnLph) * sogKt).toFixed(0)} nm` : '∞ (sail)';

  return (
    <section className="hud">
      <Metric icon={<MapPin size={17} />} label="GPS" value={boat.gps ? `${Math.abs(boat.gps.lat).toFixed(4)}°${boat.gps.lat >= 0 ? 'N' : 'S'}, ${Math.abs(boat.gps.lon).toFixed(4)}°${boat.gps.lon >= 0 ? 'E' : 'W'}` : 'Acquiring...'} />
      <Metric icon={<Sailboat size={17} />} label="HDG" value={`${boat.headingDeg.toFixed(0)}°`} />
      <Metric icon={<Navigation size={17} />} label="COG" value={`${boat.cogDeg.toFixed(0)}°`} />
      <Metric icon={<Gauge size={17} />} label="STW" value={`${(boat.stwMps * MPS_TO_KNOT).toFixed(1)} kt`} />
      <Metric icon={<Gauge size={17} />} label="SOG" value={`${(boat.sogMps * MPS_TO_KNOT).toFixed(1)} kt`} />
      <Metric icon={<Wind size={17} />} label="TWS" value={`${(boat.twsMps * MPS_TO_KNOT).toFixed(1)} kt`} />
      <Metric icon={<Wind size={17} />} label="TWA" value={`${boat.twaDeg.toFixed(0)}°`} />
      <Metric icon={<Wind size={17} />} label="Wind water" value={`${(vectorMagnitude(windWater) * MPS_TO_KNOT).toFixed(1)} kt @ ${vectorToDeg(windWater).toFixed(0)}°`} />
      <Metric icon={<Anchor size={17} />} label="Current" value={`${(vectorMagnitude(current) * MPS_TO_KNOT).toFixed(1)} kt @ ${settings.currentToDeg.toFixed(0)}°`} />
      <Metric icon={<Gauge size={17} />} label="Heel" value={`${(boat.heelDeg ?? 0).toFixed(1)}°`} />
      <Metric icon={<Gauge size={17} />} label="Pitch" value={`${(boat.pitchDeg ?? 0).toFixed(1)}°`} />
      <Metric icon={<Gauge size={17} />} label="Port Eng" value={`${(boat.thrustPort ?? 0).toFixed(0)} N`} />
      <Metric icon={<Gauge size={17} />} label="Stbd Eng" value={`${(boat.thrustStbd ?? 0).toFixed(0)} N`} />
      <Metric icon={<Fuel size={17} />} label="Fuel P/S" value={`${(boat.fuelPortL ?? 275).toFixed(0)} / ${(boat.fuelStbdL ?? 275).toFixed(0)} L`} />
      <Metric icon={<Fuel size={17} />} label="Range" value={rangeValue} />
      <Metric
        icon={<Waves size={17} />}
        label="Depth (keel)"
        value={
          boat.depthOverKeelM != null
            ? `${boat.depthOverKeelM < 99 ? boat.depthOverKeelM.toFixed(1) : boat.depthOverKeelM.toFixed(0)} m`
            : '—'
        }
      />
      <Metric icon={<Waves size={17} />} label="Waves" value={`${settings.waveHeightM.toFixed(1)} m / ${settings.wavePeriodS.toFixed(0)} s`} />
      <Metric icon={<Sailboat size={17} />} label="Course" value={boat.course.replaceAll('-', ' ')} />
    </section>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
