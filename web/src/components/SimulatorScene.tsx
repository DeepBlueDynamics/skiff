import { Environment, OrbitControls, Stars } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, Suspense } from 'react';
import * as THREE from 'three';
import { BoatModel } from './BoatModel';
import { FlowVisualization } from './FlowVisualization';
import { Island } from './Island';
import { Trail } from './Trail';
import { Vectors } from './Vectors';
import { Water } from './Water';
import { useSimulator } from '../sim/store';

export function SimulatorScene() {
  const controlsRef = useRef<any>(null);
  const settings = useSimulator((state) => state.settings);

  // Restore right-click context menu by intercepting it in the capture phase
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.stopPropagation();
    };
    window.addEventListener('contextmenu', handleContextMenu, true);
    return () => {
      window.removeEventListener('contextmenu', handleContextMenu, true);
    };
  }, []);

  return (
    <Canvas
      shadows
      camera={{ position: [9, 6.2, 10], fov: 45, near: 0.5, far: 45000 }}
      // logarithmicDepthBuffer: with far=45km the standard depth buffer's
      // precision at ~2km collapses below the wave-surface/far-field-quad
      // separation and the water z-fights (severe flashing in the troughs).
      // Log depth keeps precision ~uniform across the whole range.
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, logarithmicDepthBuffer: true }}
    >
      <color attach="background" args={['#8fb6c9']} />
      {/* Distance haze: blends the far-field sea + islands into the horizon */}
      <fog attach="fog" args={['#8fb6c9', 9000, 42000]} />
      <ambientLight intensity={0.55} />
      <directionalLight
        castShadow
        position={[42, 60, 25]}
        intensity={0.45}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
      />
      <Stars radius={100} depth={50} count={1200} factor={4} saturation={0.5} fade speed={1} />
      <Environment preset="sunset" environmentIntensity={0.12} />
      <Suspense fallback={null}>
        <BoatModel />
        <Water />
      </Suspense>
      <Island />
      <FlowVisualization />
      <Trail />
      {settings.showVectors && <Vectors />}
      <SimulationLoop controlsRef={controlsRef} />
      <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI * 0.48} />
    </Canvas>
  );
}

function mapCourseName(course: string): any {
  if (course === "CloseHauled") return "close-hauled";
  if (course === "CrossingWind") return "crossing-wind";
  if (course === "BroadReach") return "broad-reach";
  if (course === "WindRightAft") return "wind-right-aft";
  return "head-to-wind";
}

async function fetchRealTimeData(lat: number, lon: number) {
  try {
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;
    const weatherRes = await fetch(weatherUrl);
    let windSpeedMps = 5.0;
    let windToDeg = 150.0;
    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      if (weatherData.current) {
        windSpeedMps = weatherData.current.wind_speed_10m ?? 5.0;
        const windFromDeg = weatherData.current.wind_direction_10m ?? 150.0;
        // Open-Meteo reports meteorological FROM-direction. Convert to TO-convention.
        windToDeg = (windFromDeg + 180) % 360;
      }
    }

    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_period,wave_direction`;
    const marineRes = await fetch(marineUrl);
    let waveHeightM = 0.8;
    let wavePeriodS = 7.0;
    let waveToDeg = 290.0;
    if (marineRes.ok) {
      const marineData = await marineRes.json();
      if (marineData.current) {
        waveHeightM = marineData.current.wave_height ?? 0.8;
        wavePeriodS = marineData.current.wave_period ?? 7.0;
        waveToDeg = marineData.current.wave_direction ?? 290.0;
      }
    }

    return { windSpeedMps, windToDeg, waveHeightM, wavePeriodS, waveToDeg };
  } catch (e) {
    console.error('Failed to fetch real-time weather from Open-Meteo:', e);
    return null;
  }
}

function SimulationLoop({ controlsRef }: { controlsRef: React.RefObject<any> }) {
  const input = useSimulator((state) => state.input);
  const setInput = useSimulator((state) => state.setInput);
  const boat = useSimulator((state) => state.boat);
  const setBoat = useSimulator((state) => state.setBoat);
  const setElapsed = useSimulator((state) => state.setElapsed);
  const elapsed = useSimulator((state) => state.elapsed);
  const setSetting = useSimulator((state) => state.setSetting);
  const settings = useSimulator((state) => state.settings);

  useEffect(() => {
    const syncGpsAndWeather = async () => {
      // Position is pushed ONLY in 'real' GPS mode. In simulated mode the
      // backend owns the spawn (Prickly Bay, Grenada) — an unconditional push
      // here used to teleport the boat to the default settings coordinates on
      // every page load, stranding it 2,450 km from the rendered island.
      if (settings.dataSource === 'real') {
        try {
          await fetch('/v1/sim/position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat_deg: settings.gpsLat, lon_deg: settings.gpsLon }),
          });
        } catch (e) {
          console.error('Failed to sync starting position with backend:', e);
        }
        const weather = await fetchRealTimeData(settings.gpsLat, settings.gpsLon);
        if (weather) {
          setSetting('windSpeedMps', weather.windSpeedMps);
          setSetting('windToDeg', weather.windToDeg);
          setSetting('waveHeightM', weather.waveHeightM);
          setSetting('wavePeriodS', weather.wavePeriodS);
          setSetting('waveToDeg', weather.waveToDeg);

          try {
            await fetch('/v1/sim/environment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                wind_speed_mps: weather.windSpeedMps,
                wind_to_deg: weather.windToDeg,
                current_speed_mps: settings.currentSpeedMps,
                current_to_deg: settings.currentToDeg,
                wave_height_m: weather.waveHeightM,
                wave_period_s: weather.wavePeriodS,
                wave_to_deg: weather.waveToDeg,
                manual: false,
              }),
            });
          } catch (e) {
            console.error('Failed to sync environment to backend:', e);
          }
        }
      }
    };

    syncGpsAndWeather();

    let intervalId: any = null;
    if (settings.dataSource === 'real') {
      intervalId = setInterval(async () => {
        const currentLat = useSimulator.getState().boat.gps?.lat ?? settings.gpsLat;
        const currentLon = useSimulator.getState().boat.gps?.lon ?? settings.gpsLon;
        const weather = await fetchRealTimeData(currentLat, currentLon);
        if (weather) {
          setSetting('windSpeedMps', weather.windSpeedMps);
          setSetting('windToDeg', weather.windToDeg);
          setSetting('waveHeightM', weather.waveHeightM);
          setSetting('wavePeriodS', weather.wavePeriodS);
          setSetting('waveToDeg', weather.waveToDeg);

          try {
            await fetch('/v1/sim/environment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                wind_speed_mps: weather.windSpeedMps,
                wind_to_deg: weather.windToDeg,
                current_speed_mps: settings.currentSpeedMps,
                current_to_deg: settings.currentToDeg,
                wave_height_m: weather.waveHeightM,
                wave_period_s: weather.wavePeriodS,
                wave_to_deg: weather.waveToDeg,
                manual: false,
              }),
            });
          } catch (e) {}
        }
      }, 60000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [settings.dataSource, settings.gpsLat, settings.gpsLon]);

  const accumulated = useRef({
    sailTrim: 0.76,
    reef: 0,
  });

  const lastBoatPos = useRef<{ x: number; y: number } | null>(null);
  const syncInProgress = useRef(false);

  useFrame(async (state, delta) => {
    const dt = Math.min(delta, 0.05);
    const nextElapsed = elapsed + dt;
    setElapsed(nextElapsed);

    // Sync local accumulation with external store updates (e.g. from sliders or checkboxes)
    if (Math.abs(boat.sailTrim - accumulated.current.sailTrim) > 0.001) {
      accumulated.current.sailTrim = boat.sailTrim;
    }
    if (Math.abs(boat.reef - accumulated.current.reef) > 0.001) {
      accumulated.current.reef = boat.reef;
    }

    // Accumulate sail trim and reef locally
    accumulated.current.sailTrim = Math.min(1, Math.max(0, accumulated.current.sailTrim + input.trimDelta * dt * 0.35));
    accumulated.current.reef = Math.min(1, Math.max(0, accumulated.current.reef + input.reefDelta * dt * 0.25));

    // Autopilot control loop. When OpenCPN route guidance is flowing (via
    // SignalK, fresh within 15 s), the route's bearing to the next waypoint
    // IS the autopilot target — update the route in OpenCPN and the boat
    // follows. Manual target heading applies otherwise.
    let currentHelm = input.helm;
    if (settings.autopilotEnabled) {
      const rg = boat.routeGuidance;
      const apTarget =
        rg && rg.bearingTrueDeg != null && rg.ageS < 15
          ? rg.bearingTrueDeg
          : settings.targetHeading;
      let error = apTarget - boat.headingDeg;
      error = ((error + 180) % 360 + 360) % 360 - 180; // normalize to [-180, 180]
      const Kp = 0.06;
      const targetHelm = Math.max(-1.0, Math.min(1.0, -error * Kp));
      if (Math.abs(input.helm - targetHelm) > 0.01) {
        setInput({ helm: targetHelm });
      }
      currentHelm = targetHelm;
    }

    // Smooth camera tracking based on direct boat displacement
    if (controlsRef.current) {
      const targetX = boat.position.x;
      const targetY = boat.position.y;
      
      if (lastBoatPos.current === null) {
        // First frame: position camera at default offset relative to the boat
        state.camera.position.set(targetX + 9, 6.2, -targetY + 10);
        controlsRef.current.target.set(targetX, 0.3, -targetY);
      } else {
        const dx = targetX - lastBoatPos.current.x;
        const dy = targetY - lastBoatPos.current.y;

        state.camera.position.x += dx;
        state.camera.position.z -= dy;

        // Shift the orbit controls target with the boat, preserving user manual panning (ctrl+pan, etc.)
        controlsRef.current.target.x += dx;
        controlsRef.current.target.z -= dy;
      }
      
      controlsRef.current.update();
      lastBoatPos.current = { x: targetX, y: targetY };
    }

    // Prevent concurrent backend fetches from freezing the browser network queue
    if (syncInProgress.current) return;
    syncInProgress.current = true;

    try {
      // 1. Post inputs to Rust backend
      await fetch('/v1/sim/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          helm: currentHelm,
          sail_trim: accumulated.current.sailTrim,
          reef: boat.mainDropped ? 1.0 : accumulated.current.reef,
          thrust_port: input.thrustPort,
          thrust_stbd: input.thrustStbd,
          mass_scale: (settings.massScalePct ?? 100) / 100,
          traveler: (settings.travelerPct ?? 0) / 100,
          fuel_burn_max_lph: settings.fuelBurnMaxLph ?? 9,
        }),
      });

      // 2. Fetch the state from Rust backend
      const res = await fetch('/v1/sim/state');
      if (res.ok) {
        const data = await res.json();
        
        // Sync weather settings from backend to frontend store so vectors, dials are correct
        setSetting('windSpeedMps', Math.hypot(data.env.wind_ground_mps.east, data.env.wind_ground_mps.north));
        setSetting('windToDeg', Math.atan2(data.env.wind_ground_mps.east, data.env.wind_ground_mps.north) * 180 / Math.PI);
        setSetting('currentSpeedMps', Math.hypot(data.env.current_ground_mps.east, data.env.current_ground_mps.north));
        setSetting('currentToDeg', Math.atan2(data.env.current_ground_mps.east, data.env.current_ground_mps.north) * 180 / Math.PI);
        if (data.env.wave_height_m !== null) setSetting('waveHeightM', data.env.wave_height_m);
        if (data.env.wave_period_s !== null) setSetting('wavePeriodS', data.env.wave_period_s);
        if (data.env.wave_to_deg !== null) setSetting('waveToDeg', data.env.wave_to_deg);

        // Update the boat state
        setBoat({
          position: { x: data.local_pos_m.east, y: data.local_pos_m.north },
          gps: { lat: data.pos.lat_deg, lon: data.pos.lon_deg },
          headingDeg: data.heading_true_deg,
          cogDeg: data.cog_true_deg,
          stwMps: data.stw_mps,
          sogMps: data.sog_mps,
          velocityWater: {
            x: data.stw_mps * Math.sin((data.heading_true_deg + (data.leeway_deg || 0)) * Math.PI / 180),
            y: data.stw_mps * Math.cos((data.heading_true_deg + (data.leeway_deg || 0)) * Math.PI / 180)
          },
          velocityGround: {
            x: data.sog_mps * Math.sin(data.cog_true_deg * Math.PI / 180),
            y: data.sog_mps * Math.cos(data.cog_true_deg * Math.PI / 180)
          },
          rudderDeg: data.rudder_deg,
          sailTrim: data.control.sail_trim,
          reef: data.control.reef,
          heelDeg: data.heel_deg,
          pitchDeg: data.pitch_deg,
          bobM: data.bob_m,
          twaDeg: data.twa_deg,
          twsMps: data.tws_mps,
          course: mapCourseName(data.course),
          castOffHeadToWind: false,
          mainDropped: boat.mainDropped, // preserve UI checkbox state
          trail: data.trail.map((t: any) => ({ x: t.east, y: t.north })),
          thrustPort: data.control.thrust_port,
          thrustStbd: data.control.thrust_stbd,
          stabilityState: data.stability_state,
          slamWarning: data.slam_warning,
          simTimeS: data.elapsed_s,
          envLive: data.env_live,
          fuelPortL: data.fuel_port_l,
          fuelStbdL: data.fuel_stbd_l,
          depthM: data.depth_m,
          depthOverKeelM: data.depth_over_keel_m,
          routeGuidance:
            data.route_guidance && data.route_guidance_at_s != null
              ? {
                  bearingTrueDeg: data.route_guidance.bearing_true_deg,
                  xteM: data.route_guidance.xte_m,
                  ageS: Math.max(0, data.elapsed_s - data.route_guidance_at_s),
                }
              : null,
        });
      }
    } catch (e) {
      console.error('Failed to sync simulation state with Rust backend:', e);
    } finally {
      syncInProgress.current = false;
    }
  });

  return null;
}
