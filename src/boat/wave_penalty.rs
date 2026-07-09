use crate::core::{angle_diff_deg, normalize_360};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WavePenaltyModel {
    pub height_coeff: f64,
    pub short_period_coeff: f64,
    pub head_sea_coeff: f64,
    pub min_period_s: f64,
}

impl Default for WavePenaltyModel {
    fn default() -> Self {
        Self {
            height_coeff: 0.035,
            short_period_coeff: 0.08,
            head_sea_coeff: 0.06,
            min_period_s: 5.0,
        }
    }
}

/// Relative height below which wave state is treated as calm (no penalty).
const WAVE_HEIGHT_EPS_M: f64 = 1e-4;

/// Multiplier on boat speed through water from sea state (≤ 1 when penalized).
///
/// Design: this factor is used both as a **physics** speed reduction in boat
/// profiles and as the basis of **comfort** cost in the isochrone scorer
/// (`1 - wave_penalty`). That double-influence is intentional — see plan §4.7.
pub fn wave_speed_factor(
    heading_true_deg: f64,
    wave_to_deg: Option<f64>,
    height_m: Option<f64>,
    period_s: Option<f64>,
    model: WavePenaltyModel,
) -> f64 {
    let h = height_m.unwrap_or(0.0).max(0.0);
    let p = period_s.unwrap_or(10.0).max(1.0);

    // Calm water: do not apply short-period (or any) penalty when height ≈ 0.
    // Otherwise a default/short period with zero height would still slow the boat.
    if h <= WAVE_HEIGHT_EPS_M {
        return 1.0;
    }

    let short_period_penalty = if p < model.min_period_s {
        (model.min_period_s - p) / model.min_period_s
    } else {
        0.0
    };

    let head_sea = wave_to_deg
        .map(|w| angle_diff_deg(heading_true_deg, normalize_360(w + 180.0)).abs() / 180.0)
        .unwrap_or(0.0);

    let penalty = model.height_coeff * h
        + model.short_period_coeff * short_period_penalty
        + model.head_sea_coeff * head_sea;

    (1.0 - penalty).clamp(0.55, 1.05)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_wave_height_skips_short_period_penalty() {
        let model = WavePenaltyModel {
            height_coeff: 0.035,
            short_period_coeff: 0.5, // large so a bug is obvious
            head_sea_coeff: 0.0,
            min_period_s: 5.0,
        };
        // Period well below min_period_s, but height ~ 0 → no penalty.
        let f = wave_speed_factor(0.0, None, Some(0.0), Some(2.0), model);
        assert!(
            (f - 1.0).abs() < 1e-12,
            "calm seas must not apply short-period penalty, got {f}"
        );

        // Tiny height under epsilon also calm.
        let f_eps = wave_speed_factor(0.0, None, Some(1e-6), Some(2.0), model);
        assert!((f_eps - 1.0).abs() < 1e-12, "got {f_eps}");

        // Non-zero height with short period must penalize.
        let f_waves = wave_speed_factor(0.0, None, Some(1.0), Some(2.0), model);
        assert!(
            f_waves < 1.0 - 0.1,
            "expected material short-period penalty with height, got {f_waves}"
        );
    }
}
