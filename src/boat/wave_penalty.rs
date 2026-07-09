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

pub fn wave_speed_factor(
    heading_true_deg: f64,
    wave_to_deg: Option<f64>,
    height_m: Option<f64>,
    period_s: Option<f64>,
    model: WavePenaltyModel,
) -> f64 {
    let h = height_m.unwrap_or(0.0).max(0.0);
    let p = period_s.unwrap_or(10.0).max(1.0);

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
