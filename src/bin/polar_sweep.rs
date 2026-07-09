//! WP-C1: headless polar validation harness.
//!
//! Sweeps TWS × TWA with a locked heading, coarsely optimizes sail trim,
//! and compares steady-state STW against the router/CLI boat profile
//! (`CastOffProfile` / castoff-compatible — what `skiff-cli` uses; there is
//! no filled `PolarProfile` table in-tree, so predictions come from the same
//! `BoatProfile` path the isochrone router exercises).

use std::fs;
use std::path::PathBuf;

use skiff::boat::{BoatInput, BoatProfile, CastOffProfile};
use skiff::cat_physics::{
    cat_step, lagoon_450s, sail_trim_to_sheet_rad, CatControl, CatState, Environment,
    StabilityState,
};
use skiff::core::{knots_to_mps, mps_to_knots, normalize_180, Vec2Mps};

const DT: f64 = 0.05;
const SIM_S: f64 = 180.0;
const AVG_TAIL_S: f64 = 30.0;
const TARGET_HEADING_DEG: f64 = 0.0;
/// Proportional gain: rudder_cmd (rad) ≈ −KP * heading_error (rad).
const HEADING_KP: f64 = 1.8;

const TWS_KNOTS: [f64; 4] = [6.0, 10.0, 14.0, 20.0];
const TWA_START: f64 = 40.0;
const TWA_END: f64 = 170.0;
const TWA_STEP: f64 = 10.0;
const TRIM_SWEEP: [f64; 5] = [0.4, 0.6, 0.76, 0.9, 1.0];

const REPORT_PATH: &str = "reports/polar_report.md";

#[derive(Clone, Debug)]
struct PointResult {
    tws_kt: f64,
    twa_deg: f64,
    best_trim: f64,
    sim_kts: f64,
    polar_kts: f64,
    delta_pct: f64,
    stability: StabilityState,
}

fn main() {
    let params = lagoon_450s();
    let profile = CastOffProfile::default();

    let mut points: Vec<PointResult> = Vec::new();
    let twa_values: Vec<f64> = {
        let mut v = Vec::new();
        let mut twa = TWA_START;
        while twa <= TWA_END + 1e-9 {
            v.push(twa);
            twa += TWA_STEP;
        }
        v
    };

    eprintln!(
        "polar_sweep: TWS {:?} kt × TWA {:?}–{:?} step {} × trim {:?} | dt={} sim={}s",
        TWS_KNOTS,
        TWA_START,
        TWA_END,
        TWA_STEP,
        TRIM_SWEEP,
        DT,
        SIM_S
    );

    for &tws_kt in &TWS_KNOTS {
        for &twa_deg in &twa_values {
            let mut best_stw = f64::NEG_INFINITY;
            let mut best_trim = TRIM_SWEEP[0];
            let mut best_stab = StabilityState::Upright;

            for &trim in &TRIM_SWEEP {
                let (mean_stw, stab) = run_case(&params, tws_kt, twa_deg, trim);
                if mean_stw > best_stw {
                    best_stw = mean_stw;
                    best_trim = trim;
                    best_stab = stab;
                }
            }

            let polar_stw = router_polar_stw_mps(&profile, tws_kt, twa_deg);
            let sim_kts = mps_to_knots(best_stw.max(0.0));
            let polar_kts = mps_to_knots(polar_stw.max(0.0));
            let delta_pct = if polar_kts.abs() < 1e-6 {
                if sim_kts.abs() < 1e-6 {
                    0.0
                } else {
                    f64::INFINITY
                }
            } else {
                (sim_kts - polar_kts) / polar_kts * 100.0
            };

            eprintln!(
                "  TWS={tws_kt:4.1} TWA={twa_deg:5.1} trim={best_trim:.2} sim={sim_kts:5.2} kt polar={polar_kts:5.2} kt Δ={delta_pct:+6.1}% {:?}",
                best_stab
            );

            points.push(PointResult {
                tws_kt,
                twa_deg,
                best_trim,
                sim_kts,
                polar_kts,
                delta_pct,
                stability: best_stab,
            });
        }
    }

    let report = format_report(&points, profile.id());
    print!("{report}");

    let path = PathBuf::from(REPORT_PATH);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create reports/");
    }
    fs::write(&path, &report).expect("write polar report");
    eprintln!("wrote {}", path.display());
}

/// Router/CLI castoff-compatible prediction at full trim, flat water, no current.
fn router_polar_stw_mps(profile: &CastOffProfile, tws_kt: f64, twa_abs_deg: f64) -> f64 {
    let tws_mps = knots_to_mps(tws_kt);
    // Heading 0°, wind TO = −TWA so angle_diff_deg(heading, wind_to) = +TWA.
    let wind_to_deg = -twa_abs_deg;
    let wind_water = Vec2Mps::from_speed_to_deg(tws_mps, wind_to_deg);
    let out = profile.predict(BoatInput {
        heading_true_deg: TARGET_HEADING_DEG,
        wind_water_mps: wind_water,
        current_ground_mps: Vec2Mps::ZERO,
        wave_height_m: None,
        wave_period_s: None,
        wave_to_deg: None,
        reef: 0.0,
        sail_trim: 1.0,
    });
    out.stw_mps
}

fn run_case(
    params: &skiff::cat_physics::CatParams,
    tws_kt: f64,
    twa_deg: f64,
    sail_trim_01: f64,
) -> (f64, StabilityState) {
    let tws_mps = knots_to_mps(tws_kt);
    // Wind TO direction for desired true-wind angle relative to fixed heading.
    let wind_to_deg = TARGET_HEADING_DEG - twa_deg;
    let wind_to_rad = wind_to_deg.to_radians();
    let env = Environment {
        // World frame matches main.rs: [north, east, 0], TO convention.
        wind_world: [
            tws_mps * wind_to_rad.cos(),
            tws_mps * wind_to_rad.sin(),
            0.0,
        ],
        current_world: [0.0, 0.0, 0.0],
    };

    // heading_true = (−ψ)·180/π ⇒ ψ = −heading for heading 0°.
    let mut st = CatState {
        eta: [0.0, 0.0, 0.0, 0.0, 0.0, -TARGET_HEADING_DEG.to_radians()],
        nu: [0.0; 6],
        rudder: 0.0,
        stability: StabilityState::Upright,
    };

    let n_steps = (SIM_S / DT).round() as usize;
    let avg_steps = (AVG_TAIL_S / DT).round() as usize;
    let avg_start = n_steps.saturating_sub(avg_steps);

    let mut stw_sum = 0.0;
    let mut stw_n = 0usize;

    for step in 0..n_steps {
        let heading = (-st.eta[5]).to_degrees().rem_euclid(360.0);
        let err_deg = normalize_180(TARGET_HEADING_DEG - heading);
        let err_rad = err_deg.to_radians();
        // Positive error (heading left of target) → starboard rudder (negative ψ rate toward target).
        // rudder chord uses −st.rudder; sign chosen so P-control reduces heading error in practice.
        let rudder_cmd = (HEADING_KP * err_rad).clamp(-params.rudder_max, params.rudder_max);

        let ctrl = CatControl {
            rudder_cmd,
            sail_trim: sail_trim_to_sheet_rad(sail_trim_01),
            thrust_port: 0.0,
            thrust_stbd: 0.0,
        };

        st = cat_step(&st, &ctrl, &env, params, DT, None);

        if matches!(
            st.stability,
            StabilityState::CapsizedTransverse | StabilityState::CapsizedPitchpole
        ) {
            // Terminal capsize — record remaining as zero speed.
            break;
        }

        if step >= avg_start {
            let stw = st.nu[0].hypot(st.nu[1]);
            // Prefer forward progress; still count magnitude for mean STW.
            stw_sum += stw;
            stw_n += 1;
        }
    }

    let mean = if stw_n == 0 {
        0.0
    } else {
        stw_sum / stw_n as f64
    };
    (mean, st.stability)
}

fn format_report(points: &[PointResult], profile_id: &str) -> String {
    let mut out = String::new();
    out.push_str("# Polar validation report (WP-C1)\n\n");
    out.push_str(&format!(
        "- **Sim:** `cat_physics::cat_step` dt={DT}s, duration={SIM_S}s, mean STW over final {AVG_TAIL_S}s\n"
    ));
    out.push_str(&format!(
        "- **Heading lock:** P-controller KP={HEADING_KP}, target heading {TARGET_HEADING_DEG}°\n"
    ));
    out.push_str(&format!(
        "- **Trim sweep:** {:?} (best steady STW kept); sheet map `sail_trim_to_sheet_rad` ≈ 85°…6°\n",
        TRIM_SWEEP
    ));
    out.push_str(&format!(
        "- **Router polar:** `{profile_id}` via `CastOffProfile::default()` at sail_trim=1.0, reef=0, flat water, no current\n"
    ));
    out.push_str("- **Environment:** constant TWS, TWA = |heading − wind_to|, flat water, zero current\n");
    out.push_str(&format!(
        "- **delta_pct:** `(sim_kts − polar_kts) / polar_kts × 100`\n\n"
    ));

    for &tws in &TWS_KNOTS {
        out.push_str(&format!("## TWS = {tws:.0} kt\n\n"));
        out.push_str("| TWA (°) | sim (kt) | polar (kt) | Δ% | best trim | stability |\n");
        out.push_str("|--------:|---------:|-----------:|---:|----------:|-----------|\n");
        for p in points.iter().filter(|p| (p.tws_kt - tws).abs() < 1e-9) {
            let d = if p.delta_pct.is_finite() {
                format!("{:+.1}", p.delta_pct)
            } else {
                "n/a".into()
            };
            out.push_str(&format!(
                "| {:>7.0} | {:>8.2} | {:>10.2} | {:>4} | {:>9.2} | {:?} |\n",
                p.twa_deg, p.sim_kts, p.polar_kts, d, p.best_trim, p.stability
            ));
        }
        out.push('\n');
    }

    // Summary of worst deviations (by |delta_pct|, finite only).
    let mut ranked: Vec<&PointResult> = points
        .iter()
        .filter(|p| p.delta_pct.is_finite())
        .collect();
    ranked.sort_by(|a, b| {
        b.delta_pct
            .abs()
            .partial_cmp(&a.delta_pct.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    out.push_str("## Worst deviations (by |Δ%|)\n\n");
    out.push_str("| rank | TWS (kt) | TWA (°) | sim (kt) | polar (kt) | Δ% | best trim |\n");
    out.push_str("|-----:|---------:|--------:|---------:|-----------:|---:|----------:|\n");
    for (i, p) in ranked.iter().take(15).enumerate() {
        out.push_str(&format!(
            "| {:>4} | {:>8.0} | {:>7.0} | {:>8.2} | {:>10.2} | {:+.1} | {:>9.2} |\n",
            i + 1,
            p.tws_kt,
            p.twa_deg,
            p.sim_kts,
            p.polar_kts,
            p.delta_pct,
            p.best_trim
        ));
    }
    out.push('\n');

    if let Some(w) = ranked.first() {
        out.push_str(&format!(
            "**Worst single point:** TWS={:.0} kt TWA={:.0}° sim={:.2} kt polar={:.2} kt Δ={:+.1}% (trim={:.2})\n\n",
            w.tws_kt, w.twa_deg, w.sim_kts, w.polar_kts, w.delta_pct, w.best_trim
        ));
    }

    let n = ranked.len().max(1) as f64;
    let mean_abs: f64 = ranked.iter().map(|p| p.delta_pct.abs()).sum::<f64>() / n;
    let mean_signed: f64 = ranked.iter().map(|p| p.delta_pct).sum::<f64>() / n;
    let rms: f64 = (ranked.iter().map(|p| p.delta_pct * p.delta_pct).sum::<f64>() / n).sqrt();
    out.push_str(&format!(
        "**Aggregate (|finite| points = {}):** mean Δ% = {:+.1}, mean |Δ|% = {:.1}, RMS Δ% = {:.1}\n",
        ranked.len(),
        mean_signed,
        mean_abs,
        rms
    ));

    out
}
