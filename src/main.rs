use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::Method;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tracing_subscriber::EnvFilter;

use skiff::boat::classify_course;
use skiff::core::{LatLon, Vec2Mps, move_latlon, true_wind_angle_deg};
use skiff::env::{
    ConstantEnvironment, EnvBatchRequest, EnvQueryPoint, EnvironmentProvider, HttpEnvironmentProvider,
    MetOcean, NutsAuthClient, test_env, wind_over_water,
};
use skiff::cat_physics;
use skiff::signalk::{SignalKClient, SignalKDelta, SignalKUpdate, SignalKSource, SignalKPathValue};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimControlInput {
    pub helm: f64,       // -1.0 (port) to 1.0 (starboard)
    pub sail_trim: f64,  // 0.0 to 1.0
    pub reef: f64,       // 0.0 to 1.0
    #[serde(default)]
    pub thrust_port: f64, // -3000N to +3000N
    #[serde(default)]
    pub thrust_stbd: f64, // -3000N to +3000N
    /// Displacement multiplier (1.0 = stock Lagoon 450S). Scales mass and the
    /// rotational inertias together (loading the boat); hydrodynamic added
    /// mass and hull geometry are unchanged.
    #[serde(default = "default_mass_scale")]
    pub mass_scale: f64,
    /// Mainsheet traveler car: −1 full port, 0 centered, +1 full starboard.
    #[serde(default)]
    pub traveler: f64,
}

fn default_mass_scale() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetEnvironmentInput {
    pub wind_speed_mps: f64,
    pub wind_to_deg: f64,
    pub current_speed_mps: f64,
    pub current_to_deg: f64,
    pub wave_height_m: Option<f64>,
    pub wave_period_s: Option<f64>,
    pub wave_to_deg: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetPositionInput {
    pub lat_deg: f64,
    pub lon_deg: f64,
}

fn default_cat_state() -> cat_physics::CatState {
    let initial_heading_rad = 20.0f64.to_radians();
    cat_physics::CatState {
        eta: [0.0, 0.0, 0.0, 0.0, 0.0, initial_heading_rad],
        nu: [0.0; 6],
        rudder: 0.0,
        stability: cat_physics::StabilityState::Upright,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullSimState {
    pub at: DateTime<Utc>,
    pub elapsed_s: f64,
    pub pos: LatLon,
    pub local_pos_m: Vec2Mps,
    pub heading_true_deg: f64,
    pub rudder_deg: f64,
    pub stw_mps: f64,
    pub sog_mps: f64,
    pub cog_true_deg: f64,
    pub leeway_deg: f64,
    pub heel_deg: f64,
    pub pitch_deg: f64,
    pub bob_m: f64,
    /// True wind angle (deg): heading vs wind **from** over water (`true_wind_angle_deg`).
    pub twa_deg: f64,
    /// True wind speed (m/s) over water.
    pub tws_mps: f64,
    /// Apparent wind angle (deg, boat-relative; same sign convention as legacy HUD).
    #[serde(default)]
    pub awa_deg: f64,
    /// Apparent wind speed (m/s).
    #[serde(default)]
    pub aws_mps: f64,
    pub course: String,
    pub control: SimControlInput,
    pub env: MetOcean,
    pub trail: Vec<Vec2Mps>,
    #[serde(default)]
    pub stability_state: String, // upright | knockdown | capsized
    #[serde(default)]
    pub slam_warning: bool,
    #[serde(default = "default_cat_state")]
    pub cat_state: cat_physics::CatState,
    #[serde(default)]
    pub manual_env_override: bool,
    /// Applied cloth sail force (body frame, N). Zeros while the coefficient
    /// sail is active (no fresh cloth wrench).
    #[serde(default)]
    pub sail_f_body: [f64; 3],
    /// Applied cloth sail torque about the CG (body frame, N·m).
    /// Index 2 is yaw: POSITIVE = bow pushed to STARBOARD.
    #[serde(default)]
    pub sail_tau_cg: [f64; 3],
    /// 1 = pure cloth wrench, 0 = pure coefficient model.
    #[serde(default)]
    pub sail_blend: f64,
    /// True while the hull is against the land mask: position frozen, way off.
    #[serde(default)]
    pub aground: bool,
}

/// Fresh cloth wrench is used while younger than this; then blended out over
/// [`SAIL_WRENCH_BLEND_S`] back to the coefficient model (plan §4.2).
const SAIL_WRENCH_FRESH_S: f64 = 0.5;
const SAIL_WRENCH_BLEND_S: f64 = 1.0;

#[derive(Debug, Clone)]
struct StoredSailWrench {
    f_body: [f64; 3],
    tau_body: [f64; 3],
    /// Client sequence number (ordering / debug; not used by physics yet).
    #[allow(dead_code)]
    seq: u64,
    received_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SailWrenchInput {
    pub seq: u64,
    pub f_body: [f64; 3],
    pub tau_body: [f64; 3],
}

#[derive(Clone)]
struct AppState {
    sim_state: Arc<RwLock<FullSimState>>,
    sail_wrench: Arc<RwLock<Option<StoredSailWrench>>>,
    land_mask: Arc<Option<skiff::world::LandMask>>,
}

/// Map stored wrench age → optional override for `cat_step`.
/// - age < 500 ms: pure cloth wrench
/// - 500 ms … 1.5 s: linear blend cloth → coefficient
/// - older / missing: pure coefficient (None)
fn sail_override_from_store(
    stored: &Option<StoredSailWrench>,
    now: Instant,
) -> Option<cat_physics::SailWrenchOverride> {
    let w = stored.as_ref()?;
    let age = now.duration_since(w.received_at).as_secs_f64();
    if age < SAIL_WRENCH_FRESH_S {
        Some(cat_physics::SailWrenchOverride {
            f_body: w.f_body,
            tau_body: w.tau_body,
            blend: 1.0,
        })
    } else if age < SAIL_WRENCH_FRESH_S + SAIL_WRENCH_BLEND_S {
        let t = (age - SAIL_WRENCH_FRESH_S) / SAIL_WRENCH_BLEND_S;
        Some(cat_physics::SailWrenchOverride {
            f_body: w.f_body,
            tau_body: w.tau_body,
            blend: 1.0 - t,
        })
    } else {
        None
    }
}

fn create_initial_state() -> FullSimState {
    let mut env = test_env();
    env.wind_ground_mps = Vec2Mps::from_speed_to_deg(7.2, 150.0); // 14 knots from 150 deg
    env.current_ground_mps = Vec2Mps::from_speed_to_deg(0.55, 85.0); // ~1 knot from 85 deg
    env.wave_height_m = Some(0.0);
    env.wave_period_s = Some(7.0);
    env.wave_to_deg = Some(290.0);

    // Spawn: Prickly Bay anchorage, ~380 m south of the Spice Island Marine
    // docks, Grenada. 142 m clearance to the nearest shore in the land mask;
    // heading 185° points down the bay's exit channel to open water.
    let initial_heading_rad = 185.0f64.to_radians();
    let cat_state = cat_physics::CatState {
        // Display heading = (−ψ) mod 360 (same convention as post_reset).
        eta: [0.0, 0.0, 0.0, 0.0, 0.0, -initial_heading_rad],
        nu: [0.0; 6],
        rudder: 0.0,
        stability: cat_physics::StabilityState::Upright,
    };

    FullSimState {
        at: Utc::now(),
        elapsed_s: 0.0,
        pos: LatLon {
            lat_deg: 12.0010,
            lon_deg: -61.7640,
        },
        local_pos_m: Vec2Mps::ZERO,
        heading_true_deg: 185.0,
        rudder_deg: 0.0,
        stw_mps: 0.0,
        sog_mps: 0.0,
        cog_true_deg: 185.0,
        leeway_deg: 0.0,
        heel_deg: 0.0,
        pitch_deg: 0.0,
        bob_m: 0.0,
        twa_deg: 0.0,
        tws_mps: 0.0,
        awa_deg: 0.0,
        aws_mps: 0.0,
        course: "HeadToWind".to_string(),
        control: SimControlInput {
            helm: 0.0,
            sail_trim: 0.76,
            reef: 0.0,
            thrust_port: 0.0,
            thrust_stbd: 0.0,
            mass_scale: 1.0,
            traveler: 0.0,
        },
        env,
        trail: vec![Vec2Mps::ZERO],
        stability_state: "upright".to_string(),
        slam_warning: false,
        cat_state,
        manual_env_override: false,
        sail_f_body: [0.0; 3],
        sail_tau_cg: [0.0; 3],
        sail_blend: 0.0,
        aground: false,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    // Read config from environment variables
    let sk_host = std::env::var("SIGNALK_HOST").ok();
    let sk_token = std::env::var("SIGNALK_TOKEN").ok();
    let meridian_url = std::env::var("MERIDIAN_URL").unwrap_or_else(|_| "https://meridian.deepbluedynamics.com".to_string());
    let meridian_client_id = std::env::var("MERIDIAN_CLIENT_ID").ok();
    let meridian_client_secret = std::env::var("MERIDIAN_CLIENT_SECRET").ok();
    let auth_url = std::env::var("NUTS_AUTH_URL").unwrap_or_else(|_| "https://auth.nuts.services/auth".to_string());

    tracing::info!("Starting Sailing Simulator Backend...");
    tracing::info!("Meridian Service URL: {meridian_url}");
    if let Some(ref host) = sk_host {
        tracing::info!("Signal K server configured: {host}");
    } else {
        tracing::warn!("SIGNALK_HOST not configured. Delta updates will not be sent.");
    }

    let shared_state = Arc::new(RwLock::new(create_initial_state()));
    let shared_sail_wrench: Arc<RwLock<Option<StoredSailWrench>>> = Arc::new(RwLock::new(None));

    // Instantiate environment provider
    let env_provider: Arc<dyn EnvironmentProvider> = if let (Some(client_id), Some(client_secret)) = (meridian_client_id, meridian_client_secret) {
        tracing::info!("Authenticating Meridian API via Nuts Auth: {auth_url}");
        let auth = NutsAuthClient::new(client_id, client_secret, auth_url);
        Arc::new(HttpEnvironmentProvider::new(meridian_url, Some(auth)))
    } else {
        tracing::warn!("Meridian API credentials missing. Falling back to constant environment.");
        let mut initial_env = test_env();
        initial_env.wind_ground_mps = Vec2Mps::from_speed_to_deg(7.2, 150.0);
        initial_env.current_ground_mps = Vec2Mps::from_speed_to_deg(0.55, 85.0);
        initial_env.wave_height_m = Some(0.0);
        initial_env.wave_period_s = Some(7.0);
        initial_env.wave_to_deg = Some(290.0);
        Arc::new(ConstantEnvironment { sample: initial_env })
    };

    // Instantiate Signal K Client
    let sk_client = sk_host.map(|host| SignalKClient::new(host, sk_token));

    // Background Thread: Weather Fetching Loop (Every 30 seconds)
    let state_for_weather = shared_state.clone();
    let env_provider_for_weather = env_provider.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let (current_pos, is_overridden) = {
                let state = state_for_weather.read().unwrap();
                (state.pos, state.manual_env_override)
            };
            if is_overridden {
                continue;
            }

            tracing::info!("Querying Meridian Environment at Lat: {}, Lon: {}", current_pos.lat_deg, current_pos.lon_deg);
            let req = EnvBatchRequest {
                points: vec![EnvQueryPoint {
                    at: Utc::now(),
                    pos: current_pos,
                }],
            };

            match env_provider_for_weather.sample_many(req).await {
                Ok(mut samples) => {
                    if let Some(sample) = samples.pop() {
                        tracing::info!("Successfully fetched environment updates. Wind: {} m/s, Current: {} m/s", sample.wind_ground_mps.magnitude(), sample.current_ground_mps.magnitude());
                        let mut state = state_for_weather.write().unwrap();
                        state.env = sample;
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to fetch environment updates from Meridian Service: {e}");
                }
            }
        }
    });

    // Background Thread: Physics Simulation Loop (20Hz - every 50ms)
    let state_for_physics = shared_state.clone();
    let wrench_for_physics = shared_sail_wrench.clone();
    // Grenada land mask (grounding). None = open-ocean behavior everywhere.
    let land_mask = std::sync::Arc::new(skiff::world::LandMask::load());
    let land_mask_physics = land_mask.clone();
    tokio::spawn(async move {
        let mut last_tick = tokio::time::Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let now = tokio::time::Instant::now();
            let dt = (now - last_tick).as_secs_f64();
            last_tick = now;

            let sail_override = {
                let stored = wrench_for_physics.read().unwrap();
                sail_override_from_store(&stored, Instant::now())
            };

            let mut state = state_for_physics.write().unwrap();
            state.elapsed_s += dt;
            state.at = Utc::now();

            // Applied-sail-wrench telemetry: what the cloth (when fresh) is
            // actually injecting, with torque shifted to the CG exactly as the
            // physics sees it. sail_tau_cg[2] positive = bow to starboard.
            if let Some(ov) = sail_override {
                let w = cat_physics::cloth_wrench_to_cg(ov.f_body, ov.tau_body);
                state.sail_f_body = ov.f_body;
                state.sail_tau_cg = [w[3], w[4], w[5]];
                state.sail_blend = ov.blend;
            } else {
                state.sail_f_body = [0.0; 3];
                state.sail_tau_cg = [0.0; 3];
                state.sail_blend = 0.0;
            }

            let mut params = cat_physics::lagoon_450s();
            // Mass slider: scale displacement + rotational inertias together
            // (added mass / geometry stay — they're hull shape, not load).
            let ms = state.control.mass_scale;
            if ms.is_finite() && (0.25..=4.0).contains(&ms) && (ms - 1.0).abs() > 1e-9 {
                params.mass *= ms;
                params.ixx *= ms;
                params.iyy *= ms;
                params.izz *= ms;
            }

            // Canonical wave field (shared with the slam check below and with
            // the frontend water surface — keep the three in lockstep):
            //   ph = k·along − ω·t,  along = E·sin(dir) + N·cos(dir), k = 0.08
            //   η   = H·(0.36·sin ph + 0.09·sin(1.7·ph + 0.8))   [display up +]
            // Slopes feed the restoring targets so the hull rides the surface.
            let wave_h = state.env.wave_height_m.unwrap_or(0.0);
            let (wave_eta_disp, wave_pose) = if wave_h > 1.0e-3 {
                let dir = state.env.wave_to_deg.unwrap_or(290.0).to_radians();
                let period = state.env.wave_period_s.unwrap_or(7.0).max(1.0);
                let omega = std::f64::consts::TAU / period;
                // Deep-water dispersion: k = ω²/g. Short period ⇒ short AND
                // steep waves; the period slider now controls steepness the
                // way the real sea does. (Was a hardcoded k = 0.08 — every
                // sea state looked like 78 m swell and the boat rode flat.)
                let k0 = omega * omega / 9.81;
                let k1 = (1.7 * omega).powi(2) / 9.81;
                let along = state.local_pos_m.east * dir.sin() + state.local_pos_m.north * dir.cos();
                let hdg = state.heading_true_deg.to_radians();
                // Wave travel relative to the bow — used for hull averaging.
                let mu = dir - hdg;
                // Hull-length averaging (Smith-type correction): the pose the
                // hull can actually follow is the wave field AVERAGED over the
                // waterplane. sinc(k·L/2 · cos μ)·sinc(k·B/2 · sin μ) per
                // component — waves shorter than the hull pass underneath
                // without pitching it. Lagoon 450S: L/2 = 7.0 m, B/2 = 3.9 m.
                let sinc = |x: f64| if x.abs() < 1.0e-6 { 1.0 } else { x.sin() / x };
                let hull_avg = |k: f64| {
                    sinc(k * 7.0 * mu.cos()) * sinc(k * 3.9 * mu.sin())
                };
                // Per-component elevation + slope (full field for the slam
                // check / rendering; averaged field for the pose targets).
                let comps = [
                    (0.36 * wave_h, k0, k0 * along - omega * state.elapsed_s),
                    (0.09 * wave_h, k1, k1 * along - 1.7 * omega * state.elapsed_s + 0.8),
                ];
                let mut eta_disp = 0.0;
                let mut eta_avg = 0.0;
                let mut dslope_avg = 0.0;
                for (amp, k, ph) in comps {
                    let f = hull_avg(k);
                    eta_disp += amp * ph.sin();
                    eta_avg += amp * ph.sin() * f;
                    dslope_avg += amp * k * ph.cos() * f;
                }
                // Display-frame slope vector and body-axis components.
                let (s_e, s_n) = (dslope_avg * dir.sin(), dslope_avg * dir.cos());
                let slope_bow = s_e * hdg.sin() + s_n * hdg.cos();
                let slope_stbd = s_e * hdg.cos() - s_n * hdg.sin();
                // Engine targets: eta2 = −η (bob = −eta2); heel_deg = φ is
                // port-down-positive → surface higher to starboard tilts the
                // hull port-down (+φ); pitch_deg = θ is bow-up-positive →
                // surface rising toward the bow lifts it (+θ). Conventions
                // measured via live wrench probes 2026-07-09.
                (
                    eta_disp,
                    Some([-eta_avg, slope_stbd.atan(), slope_bow.atan()]),
                )
            } else {
                (0.0, None)
            };

            let env_phys = cat_physics::Environment {
                wind_world: [state.env.wind_ground_mps.north, state.env.wind_ground_mps.east, 0.0],
                current_world: [state.env.current_ground_mps.north, state.env.current_ground_mps.east, 0.0],
                wave_pose,
            };
            let ctrl_phys = cat_physics::CatControl {
                rudder_cmd: state.control.helm * params.rudder_max,
                sail_trim: cat_physics::sail_trim_to_sheet_rad(state.control.sail_trim),
                thrust_port: state.control.thrust_port,
                thrust_stbd: state.control.thrust_stbd,
                traveler: state.control.traveler,
            };

            let next_cat_state = cat_physics::cat_step(
                &state.cat_state,
                &ctrl_phys,
                &env_phys,
                &params,
                dt,
                sail_override,
            );
            // Self-heal: if the integrator ever produces a non-finite state
            // (poisoned input, numeric blowup), reset the boat instead of
            // serializing NaN->null to every client forever. Env and control
            // are preserved.
            let finite = next_cat_state.eta.iter().chain(next_cat_state.nu.iter()).all(|v| v.is_finite());
            if finite {
                state.cat_state = next_cat_state;
            } else {
                tracing::error!("physics state went non-finite — auto-resetting boat (env/control preserved)");
                let env_keep = state.env.clone();
                let ctrl_keep = state.control.clone();
                *state = create_initial_state();
                state.env = env_keep;
                state.control = ctrl_keep;
                {
                    let mut wrench = wrench_for_physics.write().unwrap();
                    *wrench = None;
                }
            }

            // Extract telemetry values
            let eta = state.cat_state.eta;
            let nu = state.cat_state.nu;
            let phi = eta[3];
            let theta = eta[4];
            let psi = eta[5];

            let r_mat = cat_physics::rotation_body_to_world(phi, theta, psi);

            let nu_lin = [nu[0], nu[1], nu[2]];

            let current_body = cat_physics::rotate_world_to_body(&r_mat, env_phys.current_world);
            let ground_lin = [
                nu_lin[0] + current_body[0],
                nu_lin[1] + current_body[1],
                nu_lin[2] + current_body[2],
            ];
            let ground_world = cat_physics::rotate_body_to_world(&r_mat, ground_lin);

            let stw_sign = if nu[0] >= 0.0 { 1.0 } else { -1.0 };
            let sog_sign = if ground_lin[0] >= 0.0 { 1.0 } else { -1.0 };
            state.stw_mps = nu[0].hypot(nu[1]) * stw_sign;
            state.sog_mps = ground_world[0].hypot(ground_world[1]) * sog_sign;
            state.cog_true_deg = (-ground_world[1]).atan2(ground_world[0]).to_degrees().rem_euclid(360.0);
            state.heading_true_deg = (-psi).to_degrees().rem_euclid(360.0);
            state.rudder_deg = state.cat_state.rudder.to_degrees();
            state.heel_deg = phi.to_degrees();
            state.pitch_deg = theta.to_degrees();
            state.bob_m = -eta[2]; // NED down: bob height is negative of z
            // Leeway sign convention: POSITIVE = drifting to starboard, so the
            // water track = heading + leeway (compass). Engine body frame has
            // +y = PORT (measured; see cat_physics frame-probe tests), so
            // starboard drift is nu[1] < 0 — hence the negation.
            state.leeway_deg = (-nu[1]).atan2(nu[0].max(1.0e-3)).to_degrees();

            // Apparent wind (body frame at mast CE height)
            let wind_body = cat_physics::rotate_world_to_body(&r_mat, env_phys.wind_world);
            let v_pt_air = [
                ground_lin[0] - nu[4] * params.mast_ce_height,
                ground_lin[1] + nu[3] * params.mast_ce_height,
                ground_lin[2],
            ];
            let awv = [
                wind_body[0] - v_pt_air[0],
                wind_body[1] - v_pt_air[1],
            ];
            let aws = awv[0].hypot(awv[1]);
            let awa_rad = awv[1].atan2(awv[0]);
            // Boat-relative AWA (deg); sign matches legacy HUD field that lived on twa_deg.
            state.aws_mps = aws;
            state.awa_deg = -awa_rad.to_degrees();

            // True wind over water (plan §2.2): TWA is relative to FROM, not TO.
            let wind_water = wind_over_water(&state.env);
            let wind_to_deg = wind_water.to_deg();
            state.tws_mps = wind_water.magnitude();
            state.twa_deg = true_wind_angle_deg(state.heading_true_deg, wind_to_deg);

            let over_ground_vec = Vec2Mps { east: -ground_world[1], north: ground_world[0] };
            // Grounding: if the next position falls on the land mask, freeze
            // the hull (position held, surge/sway zeroed). Driving back toward
            // water un-grounds naturally — the next candidate step is clear.
            let next_pos = move_latlon(state.pos, over_ground_vec, dt);
            let grounded = land_mask_physics
                .as_ref()
                .as_ref()
                .map(|m| m.on_land(next_pos.lat_deg, next_pos.lon_deg))
                .unwrap_or(false);
            if grounded {
                if !state.aground {
                    tracing::warn!(
                        lat = state.pos.lat_deg,
                        lon = state.pos.lon_deg,
                        "AGROUND — hull on the land mask, way stopped"
                    );
                }
                state.aground = true;
                state.cat_state.nu[0] = 0.0;
                state.cat_state.nu[1] = 0.0;
            } else {
                state.aground = false;
                state.local_pos_m = state.local_pos_m + over_ground_vec * dt;
                state.pos = next_pos;
            }

            let local_pos = state.local_pos_m;
            let last_trail = state.trail.last().copied().unwrap_or(Vec2Mps::ZERO);
            if state.trail.is_empty() || (last_trail - local_pos).magnitude() > 5.0 {
                state.trail.push(local_pos);
                if state.trail.len() > 300 {
                    state.trail.remove(0);
                }
            }

            // Wave height at location (needed for bridgedeck slam checking)
            // Bridgedeck slam — same canonical wave elevation computed pre-step.
            let underside = -params.bridgedeck_clearance + eta[2];
            let penetration = wave_eta_disp - (-underside);
            state.slam_warning = penetration > 0.1 && state.stw_mps > 2.0;

            // Course classification from true TWA
            state.course = format!("{:?}", classify_course(state.twa_deg.abs()));

            // Stability state mapping
            state.stability_state = match state.cat_state.stability {
                cat_physics::StabilityState::Upright => "upright".to_string(),
                cat_physics::StabilityState::Knockdown => "knockdown".to_string(),
                cat_physics::StabilityState::CapsizedTransverse | cat_physics::StabilityState::CapsizedPitchpole => "capsized".to_string(),
            };
        }
    });

    // Background Thread: Signal K Publishing Loop (Every 1 second)
    if let Some(sk) = sk_client {
        let state_for_sk = shared_state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let data = {
                    let state = state_for_sk.read().unwrap();
                    state.clone()
                };

                let current_bearing_rad = data.env.current_ground_mps.to_deg().to_radians();
                let wind_water = wind_over_water(&data.env);
                let wind_from_true_rad =
                    (wind_water.to_deg() + 180.0).rem_euclid(360.0).to_radians();

                let delta = SignalKDelta {
                    context: "vessels.self".to_string(),
                    updates: vec![SignalKUpdate {
                        source: SignalKSource {
                            label: "sailing-simulator".to_string(),
                            source_type: "simulator".to_string(),
                        },
                        values: vec![
                            SignalKPathValue {
                                path: "navigation.position".to_string(),
                                value: serde_json::json!({
                                    "latitude": data.pos.lat_deg,
                                    "longitude": data.pos.lon_deg,
                                }),
                            },
                            SignalKPathValue {
                                path: "navigation.headingTrue".to_string(),
                                value: serde_json::json!(data.heading_true_deg.to_radians()),
                            },
                            SignalKPathValue {
                                path: "navigation.speedThroughWater".to_string(),
                                value: serde_json::json!(data.stw_mps),
                            },
                            SignalKPathValue {
                                path: "navigation.speedOverGround".to_string(),
                                value: serde_json::json!(data.sog_mps),
                            },
                            SignalKPathValue {
                                path: "navigation.courseOverGroundTrue".to_string(),
                                value: serde_json::json!(data.cog_true_deg.to_radians()),
                            },
                            SignalKPathValue {
                                path: "environment.current.drift".to_string(),
                                value: serde_json::json!(data.env.current_ground_mps.magnitude()),
                            },
                            SignalKPathValue {
                                path: "environment.current.setTrue".to_string(),
                                value: serde_json::json!(current_bearing_rad),
                            },
                            SignalKPathValue {
                                path: "environment.wind.speedApparent".to_string(),
                                value: serde_json::json!(data.aws_mps),
                            },
                            SignalKPathValue {
                                path: "environment.wind.angleApparent".to_string(),
                                // Boat-relative radians (same sign as awa_deg).
                                value: serde_json::json!(data.awa_deg.to_radians()),
                            },
                            SignalKPathValue {
                                path: "environment.wind.speedTrue".to_string(),
                                value: serde_json::json!(data.tws_mps),
                            },
                            SignalKPathValue {
                                // True-north FROM direction (rad), plan §2.2.
                                path: "environment.wind.directionTrue".to_string(),
                                value: serde_json::json!(wind_from_true_rad),
                            },
                        ],
                    }],
                };

                if let Err(e) = sk.send_delta(&delta).await {
                    tracing::error!("Failed to stream delta updates to Signal K: {e}");
                }
            }
        });
    }

    // Server API Router
    let app_state = AppState {
        sim_state: shared_state,
        sail_wrench: shared_sail_wrench,
        land_mask: land_mask.clone(),
    };

    let static_dir = if std::path::Path::new("skiff/web/dist").exists() {
        "skiff/web/dist"
    } else {
        "web/dist"
    };
    tracing::info!("Serving static files from: {}", static_dir);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/sim/state", get(get_state))
        .route("/v1/sim/control", post(post_control))
        .route("/v1/sim/environment", post(post_environment))
        .route("/v1/sim/position", post(post_position))
        .route("/v1/sim/reset", post(post_reset))
        .route("/v1/sim/sail_wrench", post(post_sail_wrench))
        // precompressed_gzip: serves foo.gz with Content-Encoding when present —
        // the 42 MB hull GLB exceeds Cloud Run's 32 MB HTTP/1 response cap,
        // but its .gz (27 MB) fits. Browsers always send Accept-Encoding: gzip.
        .fallback_service(ServeDir::new(static_dir).precompressed_gzip())
        .layer(cors)
        .with_state(app_state);

    // SKIFF_PORT wins locally; PORT is the Cloud Run contract; 18081 default.
    let port = std::env::var("SKIFF_PORT")
        .ok()
        .or_else(|| std::env::var("PORT").ok())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(18081);
    let addr: SocketAddr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("sailing-api server listening on {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn get_state(State(state): State<AppState>) -> Json<FullSimState> {
    let current = state.sim_state.read().unwrap();
    Json(current.clone())
}

async fn post_control(
    State(state): State<AppState>,
    Json(req): Json<SimControlInput>,
) -> Json<FullSimState> {
    let mut current = state.sim_state.write().unwrap();
    current.control = req;
    Json(current.clone())
}

async fn post_environment(
    State(state): State<AppState>,
    Json(req): Json<SetEnvironmentInput>,
) -> Json<FullSimState> {
    let mut current = state.sim_state.write().unwrap();
    current.env.wind_ground_mps = Vec2Mps::from_speed_to_deg(req.wind_speed_mps, req.wind_to_deg);
    current.env.current_ground_mps = Vec2Mps::from_speed_to_deg(req.current_speed_mps, req.current_to_deg);
    current.env.wave_height_m = req.wave_height_m;
    current.env.wave_period_s = req.wave_period_s;
    current.env.wave_to_deg = req.wave_to_deg;
    current.manual_env_override = true;
    Json(current.clone())
}

async fn post_position(
    State(state): State<AppState>,
    Json(req): Json<SetPositionInput>,
) -> Json<FullSimState> {
    // Never teleport INTO the island: an on-land target would leave the boat
    // permanently frozen by the grounding check. Snap to the nearest water.
    let (lat_deg, lon_deg) = match state.land_mask.as_ref() {
        Some(mask) => mask
            .nearest_water(req.lat_deg, req.lon_deg, 10_000.0)
            .unwrap_or((req.lat_deg, req.lon_deg)),
        None => (req.lat_deg, req.lon_deg),
    };
    if (lat_deg - req.lat_deg).abs() > 1e-9 || (lon_deg - req.lon_deg).abs() > 1e-9 {
        tracing::info!(
            requested = format!("{:.4},{:.4}", req.lat_deg, req.lon_deg),
            snapped = format!("{:.4},{:.4}", lat_deg, lon_deg),
            "position request was on land — snapped to nearest water"
        );
    }
    let mut current = state.sim_state.write().unwrap();
    current.pos = skiff::core::LatLon { lat_deg, lon_deg };
    current.local_pos_m = skiff::core::Vec2Mps::ZERO;
    current.trail = vec![skiff::core::Vec2Mps::ZERO];
    Json(current.clone())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResetInput {
    /// Optional initial heading. The frontend aligns the boat downwind before
    /// the cloth takes its first step so the sail paints in filled rather than
    /// initializing mid-tangle.
    pub heading_true_deg: Option<f64>,
}

async fn post_reset(
    State(state): State<AppState>,
    body: Option<Json<ResetInput>>,
) -> Json<FullSimState> {
    {
        let mut wrench = state.sail_wrench.write().unwrap();
        *wrench = None;
    }
    let mut current = state.sim_state.write().unwrap();
    *current = create_initial_state();
    if let Some(Json(input)) = body {
        if let Some(h) = input.heading_true_deg {
            let h = h.rem_euclid(360.0);
            // heading_true_deg = (−ψ) mod 360 (documented convention, plan §2.1)
            current.cat_state.eta[5] = -h.to_radians();
            current.heading_true_deg = h;
            current.cog_true_deg = h;
        }
    }
    Json(current.clone())
}

/// Sanity bounds for an incoming cloth wrench: anything non-finite or beyond
/// these magnitudes is physically impossible for this rig and would blow up
/// the integrator (no clamps exist downstream by design — validation happens
/// at the boundary instead).
const WRENCH_MAX_FORCE_N: f64 = 2.0e5;
const WRENCH_MAX_TORQUE_NM: f64 = 2.0e6;

async fn post_sail_wrench(
    State(state): State<AppState>,
    Json(req): Json<SailWrenchInput>,
) -> StatusCode {
    let finite = req.f_body.iter().chain(req.tau_body.iter()).all(|v| v.is_finite());
    let f_mag = (req.f_body[0].powi(2) + req.f_body[1].powi(2) + req.f_body[2].powi(2)).sqrt();
    let t_mag = (req.tau_body[0].powi(2) + req.tau_body[1].powi(2) + req.tau_body[2].powi(2)).sqrt();
    if !finite || f_mag > WRENCH_MAX_FORCE_N || t_mag > WRENCH_MAX_TORQUE_NM {
        // Rate-limited: at 15 Hz a misbehaving cloth floods the log otherwise.
        static REJECTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = REJECTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n % 75 == 0 {
            tracing::warn!(
                seq = req.seq, f_mag, t_mag, finite, total_rejected = n + 1,
                "rejected insane sail wrench (showing 1 in 75)"
            );
        }
        return StatusCode::UNPROCESSABLE_ENTITY;
    }
    let mut wrench = state.sail_wrench.write().unwrap();
    *wrench = Some(StoredSailWrench {
        f_body: req.f_body,
        tau_body: req.tau_body,
        seq: req.seq,
        received_at: Instant::now(),
    });
    StatusCode::NO_CONTENT
}
