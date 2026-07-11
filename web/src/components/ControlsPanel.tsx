import { useState } from 'react';
import { Anchor, ChevronDown, ChevronRight, RotateCcw, Sailboat, SlidersHorizontal, Waves, Wind, MapPin, Compass, Gauge } from 'lucide-react';
import { useSimulator } from '../sim/store';
import { signIn, storedToken } from '../sim/auth';

export function ControlsPanel() {
  const settings = useSimulator((state) => state.settings);
  const boat = useSimulator((state) => state.boat);
  const input = useSimulator((state) => state.input);
  const setSetting = useSimulator((state) => state.setSetting);
  const resetBoat = useSimulator((state) => state.resetBoat);
  const setBoat = useSimulator((state) => state.setBoat);
  const setInput = useSimulator((state) => state.setInput);

  const [latInput, setLatInput] = useState(settings.gpsLat.toString());
  const [lonInput, setLonInput] = useState(settings.gpsLon.toString());
  const [showOverrides, setShowOverrides] = useState(false);

  const syncEnvironment = async (overrides: any) => {
    const s = { ...settings, ...overrides };
    try {
      await fetch('/v1/sim/environment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wind_speed_mps: s.windSpeedMps,
          wind_to_deg: s.windToDeg,
          current_speed_mps: s.currentSpeedMps,
          current_to_deg: s.currentToDeg,
          wave_height_m: s.waveHeightM,
          wave_period_s: s.wavePeriodS,
          wave_to_deg: s.waveToDeg,
        }),
      });
    } catch (e) {
      console.error('Failed to sync environment settings with Rust backend:', e);
    }
  };

  const showSliders = settings.dataSource === 'simulated' || showOverrides;

  return (
    <aside className="controls">
      <style>{`
        @keyframes pulse {
          0% { opacity: 0.5; }
          100% { opacity: 1; }
        }
      `}</style>
      <div className="control-header">
        <Sailboat size={20} />
        <span>3D Boat Simulator</span>
        <button className="icon-button" onClick={resetBoat} aria-label="Reset boat" title="Reset boat">
          <RotateCcw size={18} />
        </button>
      </div>

      {boat.stabilityState === 'capsized' && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.3)',
          border: '2px solid #ef4444',
          color: '#fca5a5',
          padding: '10px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 'bold',
          marginBottom: '12px',
          animation: 'pulse 0.4s infinite alternate',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          boxShadow: '0 0 15px rgba(239, 68, 68, 0.4)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
            CRITICAL: BOAT WOULD FLIP!
          </div>
          <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', fontWeight: 'normal' }}>
            Transverse heel stability limits exceeded. A real catamaran would capsize here.
          </span>
        </div>
      )}

      {boat.slamWarning && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.25)',
          border: '1px solid #ef4444',
          color: '#fca5a5',
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 'bold',
          marginBottom: '12px',
          animation: 'pulse 0.5s infinite alternate',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
          WARNING: Bridgedeck Slamming!
        </div>
      )}

      {boat.stabilityState === 'knockdown' && (
        <div style={{
          background: 'rgba(245, 158, 11, 0.25)',
          border: '1px solid #f59e0b',
          color: '#fde047',
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 'bold',
          marginBottom: '12px',
          animation: 'pulse 0.8s infinite alternate',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
          ALERT: Windward Hull Flying!
        </div>
      )}

      {(boat.apHeadingDeg != null || boat.apThrustN != null || (boat.routeGuidance && boat.routeGuidance.ageS < 15)) && (
        <div style={{
          background: 'rgba(168, 85, 247, 0.18)',
          border: '1px solid rgba(168, 85, 247, 0.55)',
          borderRadius: '6px',
          padding: '8px 10px',
          fontSize: '12px',
          fontWeight: 'bold',
          color: '#e9d5ff',
          marginBottom: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#a855f7', display: 'inline-block' }} />
            {boat.routeGuidance && boat.routeGuidance.ageS < 15
              ? `ROUTE STEERING — brg ${boat.routeGuidance.bearingTrueDeg?.toFixed(0) ?? '—'}°`
              : boat.apHeadingDeg != null
              ? `AGENT AT HELM — holding ${boat.apHeadingDeg?.toFixed(0)}°`
              : 'AGENT AT ENGINES'}
            {boat.apThrustN != null ? ` · eng ${(boat.apThrustN / 1000).toFixed(1)} kN` : ''}
          </div>
          <button
            onClick={async () => {
              try {
                await fetch('/v1/sim/course', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                });
              } catch (e) {
                console.error('Take helm failed:', e);
              }
            }}
            style={{
              padding: '5px 10px',
              background: 'rgba(255,255,255,0.14)',
              border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: '4px',
              color: '#fff',
              fontSize: '11px',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            ⎈ TAKE HELM (release to manual)
          </button>
        </div>
      )}

      <Section title="Environment" icon={<Wind size={15} />} storageKey="skiff.section.env">
      <ControlGroup icon={<MapPin size={16} />} title="GPS / Data Source">
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <button
            onClick={() => {
              // Real data needs a Meridian login — kick off the flow if the
              // user isn't signed in yet; the callback returns to this page.
              if (!storedToken()) {
                signIn();
                return;
              }
              setSetting('dataSource', 'real');
            }}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: '11px',
              background: settings.dataSource === 'real' ? '#0ea5e9' : 'rgba(255, 255, 255, 0.05)',
              color: 'white',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              transition: 'background 0.2s',
            }}
          >
            Real GPS
          </button>
          <button
            onClick={() => setSetting('dataSource', 'simulated')}
            style={{
              flex: 1,
              padding: '6px 8px',
              fontSize: '11px',
              background: settings.dataSource === 'simulated' ? '#0ea5e9' : 'rgba(255, 255, 255, 0.05)',
              color: 'white',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              transition: 'background 0.2s',
            }}
          >
            Simulated
          </button>
        </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
          <label style={{ flex: 1, fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '2px', color: 'rgba(255,255,255,0.7)' }}>
            Lat
            <input
              type="number"
              value={latInput}
              onChange={(e) => setLatInput(e.target.value)}
              style={{
                padding: '4px 6px',
                borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(0,0,0,0.3)',
                color: 'white',
                fontSize: '11px',
                width: '100%',
                boxSizing: 'border-box'
              }}
              step="0.0001"
            />
          </label>
          <label style={{ flex: 1, fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '2px', color: 'rgba(255,255,255,0.7)' }}>
            Lon
            <input
              type="number"
              value={lonInput}
              onChange={(e) => setLonInput(e.target.value)}
              style={{
                padding: '4px 6px',
                borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(0,0,0,0.3)',
                color: 'white',
                fontSize: '11px',
                width: '100%',
                boxSizing: 'border-box'
              }}
              step="0.0001"
            />
          </label>
          <button
            onClick={async () => {
              const lat = parseFloat(latInput);
              const lon = parseFloat(lonInput);
              if (!isNaN(lat) && !isNaN(lon)) {
                setSetting('gpsLat', lat);
                setSetting('gpsLon', lon);
                // Push explicitly — the automatic position sync only runs in
                // 'real' GPS mode, so Set must do its own POST. The backend
                // snaps on-land targets to the nearest water.
                try {
                  await fetch('/v1/sim/position', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lat_deg: lat, lon_deg: lon }),
                  });
                } catch (e) {
                  console.error('Failed to set position:', e);
                }
              }
            }}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              background: '#0ea5e9',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold',
              height: '24px',
            }}
          >
            Set
          </button>
        </div>

        {settings.dataSource === 'real' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '11px', marginTop: '8px', color: 'rgba(255,255,255,0.8)' }}>
            <input
              type="checkbox"
              checked={showOverrides}
              onChange={(e) => setShowOverrides(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Show Manual Overrides
          </label>
        )}
      </ControlGroup>

      {showSliders && (
        <>
          <ControlGroup icon={<Wind size={16} />} title="Wind">
            <Slider label="Speed" value={settings.windSpeedMps} min={0} max={18} step={0.1} unit="m/s" onChange={(v) => { setSetting('windSpeedMps', v); syncEnvironment({ windSpeedMps: v }); }} />
            <Slider label="To" value={settings.windToDeg} min={0} max={359} step={1} unit="°" onChange={(v) => { setSetting('windToDeg', v); syncEnvironment({ windToDeg: v }); }} />
          </ControlGroup>
          <ControlGroup icon={<Anchor size={16} />} title="Current">
            <Slider label="Speed" value={settings.currentSpeedMps} min={0} max={3.5} step={0.05} unit="m/s" onChange={(v) => { setSetting('currentSpeedMps', v); syncEnvironment({ currentSpeedMps: v }); }} />
            <Slider label="Set" value={settings.currentToDeg} min={0} max={359} step={1} unit="°" onChange={(v) => { setSetting('currentToDeg', v); syncEnvironment({ currentToDeg: v }); }} />
          </ControlGroup>
          <ControlGroup icon={<Waves size={16} />} title="Waves">
            <Slider label="Height" value={settings.waveHeightM} min={0} max={4} step={0.05} unit="m" onChange={(v) => { setSetting('waveHeightM', v); syncEnvironment({ waveHeightM: v }); }} />
            <Slider label="Period" value={settings.wavePeriodS} min={2} max={16} step={0.25} unit="s" onChange={(v) => { setSetting('wavePeriodS', v); syncEnvironment({ wavePeriodS: v }); }} />
            <Slider label="To" value={settings.waveToDeg} min={0} max={359} step={1} unit="°" onChange={(v) => { setSetting('waveToDeg', v); syncEnvironment({ waveToDeg: v }); }} />
          </ControlGroup>
        </>
      )}
      <div className="toggle-row">
        <label>
          <input type="checkbox" checked={settings.showVectors} onChange={(e) => setSetting('showVectors', e.target.checked)} />
          Vectors
        </label>
        <label>
          <input type="checkbox" checked={settings.showCurrent} onChange={(e) => setSetting('showCurrent', e.target.checked)} />
          Current
        </label>
        <label>
          <input type="checkbox" checked={settings.showForceArrows} onChange={(e) => setSetting('showForceArrows', e.target.checked)} />
          Force arrows
        </label>
      </div>
      </Section>

      <Section title="Sails" icon={<Sailboat size={15} />} storageKey="skiff.section.sails">
      <ControlGroup icon={<SlidersHorizontal size={16} />} title="Sail">
        <Slider label="Trim" value={boat.sailTrim} min={0} max={1} step={0.01} unit="" onChange={(v) => setBoat({ ...boat, sailTrim: v })} />
        {/* Traveler car: negative = port, positive = starboard; rotates the
            boom up to ±22° (track geometry, Object.122 ends ±2.46 m) */}
        <Slider label="Traveler" value={settings.travelerPct} min={-100} max={100} step={5} unit="%" onChange={(v) => setSetting('travelerPct', v)} />
        <Slider label="Vang" value={settings.vangPct} min={0} max={100} step={5} unit="%" onChange={(v) => setSetting('vangPct', v)} />
        <Slider label="Reef" value={boat.reef} min={0} max={1} step={0.01} unit="" onChange={(v) => setBoat({ ...boat, reef: v })} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', marginTop: '6px', color: 'var(--ink)' }}>
          <input
            type="checkbox"
            checked={boat.mainDropped || false}
            onChange={(e) => {
              const dropped = e.target.checked;
              setBoat({
                ...boat,
                mainDropped: dropped,
                reef: dropped ? 1.0 : boat.reef,
              });
            }}
          />
          Drop Mainsail
        </label>
        <hr style={{ border: '0', borderTop: '1px solid rgba(255,255,255,0.08)', margin: '10px 0' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', marginTop: '6px', color: 'var(--ink)' }}>
          <input
            type="checkbox"
            checked={settings.showRigPoints}
            onChange={(e) => setSetting('showRigPoints', e.target.checked)}
          />
          Show Rig Points
        </label>
      </ControlGroup>

      <ControlGroup icon={<Sailboat size={16} />} title="Sail Rig">
        {/* Headsail: which side she's sheeted (flipping gybes the live sail)
            and which sail is hoisted. The current cloth is the code zero:
            122 m² flown, 4.2 m camber, masthead to the bowsprit ring. */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--ink)', marginBottom: '6px' }}>
          <span style={{ marginRight: 'auto', fontWeight: 600 }}>Headsail</span>
          <SideToggle
            value={settings.sheetSide}
            onChange={(side) => setSetting('sheetSide', side)}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--ink)', marginBottom: '10px' }}>
          <span style={{ marginRight: 'auto' }}>Type</span>
          <select
            value={settings.headsailType}
            onChange={(e) => {
              const t = e.target.value as any;
              setSetting('headsailType', t);
              // 'None' furls it: hide the cloth AND tell the backend to zero
              // the sail force (so it's depowered headless too).
              fetch('/v1/sim/sail', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ furled: t === 'none' }),
              }).catch(() => {});
            }}
            style={{
              background: 'rgba(0,0,0,0.35)',
              color: 'var(--ink)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '5px',
              padding: '3px 8px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            <option value="codezero">Code Zero</option>
            <option value="none">None (furled)</option>
          </select>
        </label>
        <Slider
          label="Sheet"
          value={settings.spinnakerClewSlack}
          min={0.55}
          max={1.8}
          step={0.01}
          unit=""
          onChange={(v) => setSetting('spinnakerClewSlack', v)}
        />
        <Slider
          label="Tack line"
          value={settings.spinnakerTackSlack}
          min={0.9}
          max={1.6}
          step={0.01}
          unit=""
          onChange={(v) => setSetting('spinnakerTackSlack', v)}
        />
        <Slider
          label="Fullness"
          value={settings.sailFullness}
          min={0.97}
          max={1.12}
          step={0.005}
          unit=""
          onChange={(v) => setSetting('sailFullness', v)}
        />
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', color: 'var(--ink)' }}>
            <input
              type="checkbox"
              checked={settings.luffPinned}
              onChange={(e) => setSetting('luffPinned', e.target.checked)}
            />
            Luff pin
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px', color: 'var(--ink)' }}>
            <input
              type="checkbox"
              checked={settings.pressureShading}
              onChange={(e) => setSetting('pressureShading', e.target.checked)}
            />
            Shading
          </label>
        </div>

        {/* Sail Form + Aerodynamic Wrench moved to SailTelemetryPanel (bottom-left, collapsible) */}
      </ControlGroup>
      </Section>

      <Section title="Boat" icon={<Gauge size={15} />} storageKey="skiff.section.boat2">
      <ControlGroup icon={<Compass size={16} />} title="Steering">
        {(() => {
          const agentDriving =
            boat.apHeadingDeg != null ||
            boat.apThrustN != null ||
            !!(boat.routeGuidance && boat.routeGuidance.ageS < 15);
          return (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', marginBottom: '8px', color: 'var(--ink)' }}>
              <input
                type="checkbox"
                checked={settings.autopilotEnabled || agentDriving}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setSetting('autopilotEnabled', enabled);
                  if (enabled) {
                    setSetting('targetHeading', Math.round(boat.headingDeg));
                  } else if (agentDriving) {
                    // Unchecking while an agent is driving = TAKE BACK CONTROL:
                    // release the backend rudder + engine overrides.
                    try {
                      await fetch('/v1/sim/course', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({}),
                      });
                    } catch {}
                  }
                }}
              />
              {/* Live blinker: pulses purple while an agent holds the boat. */}
              <span
                style={{
                  width: '9px',
                  height: '9px',
                  borderRadius: '50%',
                  background: agentDriving ? '#a855f7' : 'rgba(255,255,255,0.18)',
                  boxShadow: agentDriving ? '0 0 8px #a855f7' : 'none',
                  animation: agentDriving ? 'pulse 0.7s infinite alternate' : 'none',
                  flexShrink: 0,
                }}
              />
              {agentDriving ? 'Agent controlling' : 'Enable Autopilot'}
            </label>
          );
        })()}
        {/* Autopilot mode: heading-hold vs track-hold (corrects set/drift). */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '12px', marginBottom: '8px', color: 'var(--ink)' }}>
          <input
            type="checkbox"
            checked={!!boat.apTrackHold}
            onChange={(e) => {
              fetch('/v1/sim/course', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track_hold: e.target.checked }),
              }).catch(() => {});
            }}
          />
          Track hold <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: '11px' }}>(correct set/drift)</span>
        </label>
        {boat.routeGuidance && boat.routeGuidance.ageS < 15 && (
          <div style={{
            background: 'rgba(14, 165, 233, 0.12)',
            border: '1px solid rgba(14, 165, 233, 0.35)',
            borderRadius: '4px',
            padding: '6px 8px',
            fontSize: '11px',
            color: '#7dd3fc',
            marginBottom: '8px',
            fontFamily: 'monospace',
          }}>
            ⛵ OpenCPN route: brg {boat.routeGuidance.bearingTrueDeg?.toFixed(0) ?? '—'}°
            {boat.routeGuidance.xteM != null ? ` · XTE ${boat.routeGuidance.xteM.toFixed(0)} m` : ''}
            {settings.autopilotEnabled ? ' · following' : ' · enable AP to follow'}
          </div>
        )}
        <Slider
          label="Rudder"
          value={Math.round(-input.helm * 32)}
          min={-32}
          max={32}
          step={1}
          unit="°"
          onChange={(v) => {
            setInput({ helm: -v / 32 });
            if (settings.autopilotEnabled) {
              setSetting('autopilotEnabled', false);
            }
          }}
        />
        {settings.autopilotEnabled && (
          <Slider
            label="Heading"
            value={settings.targetHeading}
            min={0}
            max={359}
            step={1}
            unit="°"
            onChange={(v) => setSetting('targetHeading', v)}
          />
        )}
      </ControlGroup>
      <ControlGroup icon={<Gauge size={16} />} title="Twin Engines">
        {boat.apThrustN != null && (
          <div style={{
            background: 'rgba(168, 85, 247, 0.14)',
            border: '1px solid rgba(168, 85, 247, 0.4)',
            borderRadius: '4px',
            padding: '5px 8px',
            fontSize: '11px',
            color: '#e9d5ff',
            marginBottom: '8px',
            fontFamily: 'monospace',
          }}>
            ⚙ Agent running engines · {(boat.apThrustN / 1000).toFixed(1)} kN both
          </div>
        )}
        {/* Sliders show the AGENT's commanded thrust while it holds the
            engines, so the readout always matches reality. */}
        <Slider
          label="Starboard"
          value={boat.apThrustN != null ? boat.apThrustN : input.thrustPort}
          min={-3000}
          max={3000}
          step={100}
          unit=" N"
          onChange={(v) => setInput({ thrustPort: v })}
        />
        <Slider
          label="Port"
          value={boat.apThrustN != null ? boat.apThrustN : input.thrustStbd}
          min={-3000}
          max={3000}
          step={100}
          unit=" N"
          onChange={(v) => setInput({ thrustStbd: v })}
        />
        <button
          onClick={() => setInput({ thrustPort: 0, thrustStbd: 0 })}
          style={{
            width: '100%',
            padding: '6px 10px',
            marginTop: '8px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '4px',
            color: '#fca5a5',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: 'pointer',
            textAlign: 'center',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.22)';
            e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)';
            e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
          }}
        >
          NEUTRAL (0 N)
        </button>

        <hr style={{ border: '0', borderTop: '1px solid rgba(255,255,255,0.08)', margin: '10px 0 8px' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--ink)', marginTop: '4px', fontFamily: 'monospace' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'sans-serif' }}>Est. consumption</span>
          <strong>
            {(() => {
              const f = (t: number) => Math.pow(Math.min(1, Math.abs(t) / 3000), 1.5);
              const tp = boat.apThrustN ?? input.thrustPort;
              const ts = boat.apThrustN ?? input.thrustStbd;
              const lph = settings.fuelBurnMaxLph * (f(tp) + f(ts));
              return `${lph.toFixed(1)} L/h · ${(lph * 0.2642).toFixed(1)} gal/h`;
            })()}
          </strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--ink)', marginTop: '2px', fontFamily: 'monospace' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'sans-serif' }}>Tanks P / S</span>
          <strong>{`${(boat.fuelPortL ?? 275).toFixed(0)} / ${(boat.fuelStbdL ?? 275).toFixed(0)} L`}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--ink)', marginTop: '2px', fontFamily: 'monospace' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'sans-serif' }}>Endurance / Range</span>
          <strong>
            {(() => {
              const f = (t: number) => Math.pow(Math.min(1, Math.abs(t) / 3000), 1.5);
              const tp = boat.apThrustN ?? input.thrustPort;
              const ts = boat.apThrustN ?? input.thrustStbd;
              const lph = settings.fuelBurnMaxLph * (f(tp) + f(ts));
              if (lph <= 0.05) return '∞ (sailing)';
              const fuel = (boat.fuelPortL ?? 275) + (boat.fuelStbdL ?? 275);
              const hours = fuel / lph;
              const sogKt = boat.sogMps * 1.9438;
              return `${hours.toFixed(1)} h · ${(hours * sogKt).toFixed(0)} nm @ ${sogKt.toFixed(1)} kt`;
            })()}
          </strong>
        </div>
        <button
          onClick={async () => {
            try {
              await fetch('/v1/sim/refuel', { method: 'POST' });
            } catch (e) {
              console.error('Refuel failed:', e);
            }
          }}
          style={{
            width: '100%',
            padding: '6px 10px',
            marginTop: '8px',
            background: 'rgba(63, 185, 80, 0.12)',
            border: '1px solid rgba(63, 185, 80, 0.35)',
            borderRadius: '4px',
            color: '#7ee2a8',
            fontSize: '11px',
            fontWeight: 'bold',
            cursor: 'pointer',
            textAlign: 'center',
          }}
        >
          FILL TANKS (2 × 275 L)
        </button>
      </ControlGroup>

      <ControlGroup icon={<SlidersHorizontal size={16} />} title="Config">
        {/* Displacement multiplier — backend scales mass + rotational inertias */}
        <Slider
          label="Mass"
          value={settings.massScalePct}
          min={50}
          max={250}
          step={5}
          unit="%"
          onChange={(v) => setSetting('massScalePct', v)}
        />
        {/* Full-throttle burn per engine (Yanmar 4JH45 ≈ 9 L/h) */}
        <Slider
          label="Burn @ max"
          value={settings.fuelBurnMaxLph}
          min={2}
          max={15}
          step={0.5}
          unit=" L/h"
          onChange={(v) => setSetting('fuelBurnMaxLph', v)}
        />
      </ControlGroup>
      </Section>
      <div className="keys">
        <span>A/D steer</span>
        <span>W/S trim</span>
        <span>Q/E reef</span>
        <span>R reset</span>
      </div>
    </aside>
  );
}

/** Top-level pull-down section (Environment / Boat): collapsible group of
 *  control groups, open state persisted per section. */
function Section({
  title,
  icon,
  storageKey,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  storageKey: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    // Default COLLAPSED; remembers whatever the user last chose.
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(storageKey) === '1';
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(storageKey, o ? '0' : '1');
      } catch {}
      return !o;
    });
  };
  return (
    <div style={{ marginBottom: '10px' }}>
      <button
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '7px 10px',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '8px',
          color: 'var(--ink)',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        {title}
      </button>
      {open && <div style={{ marginTop: '8px' }}>{children}</div>}
    </div>
  );
}

function ControlGroup({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="control-group">
      <div className="control-group-title">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

/** Modern pill toggle for the sheet side: knob slides left (PORT, red) or
 *  right (STBD, green — nautical colors). Flipping it gybes the live sail. */
function SideToggle({
  value,
  onChange,
}: {
  value: 'port' | 'starboard';
  onChange: (side: 'port' | 'starboard') => void;
}) {
  const stbd = value === 'starboard';
  return (
    <button
      onClick={() => onChange(stbd ? 'port' : 'starboard')}
      title="Flip the sheet (gybes the sail) to the other side"
      style={{
        position: 'relative',
        width: '64px',
        height: '22px',
        borderRadius: '11px',
        border: '1px solid rgba(255,255,255,0.15)',
        background: stbd ? 'rgba(63,185,80,0.22)' : 'rgba(240,102,110,0.22)',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 0.2s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '2px',
          left: stbd ? '32px' : '2px',
          width: '28px',
          height: '16px',
          borderRadius: '9px',
          background: stbd ? '#3fb950' : '#f0666e',
          color: '#0b1016',
          fontSize: '9px',
          fontWeight: 700,
          letterSpacing: '0.04em',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'left 0.18s ease, background 0.2s',
        }}
      >
        {stbd ? 'STBD' : 'PORT'}
      </span>
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  invertDisplay,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  invertDisplay?: boolean;
}) {
  const displayValue = invertDisplay ? -value : value;
  const decimalPlaces = step.toString().split('.')[1]?.length || 0;
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
      <strong>{displayValue.toFixed(decimalPlaces)}{unit}</strong>
    </label>
  );
}
