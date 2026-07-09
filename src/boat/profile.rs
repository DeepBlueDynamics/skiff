use crate::core::Vec2Mps;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy)]
pub struct BoatInput {
    pub heading_true_deg: f64,
    /// Air over water.
    pub wind_water_mps: Vec2Mps,
    /// Current over ground.
    pub current_ground_mps: Vec2Mps,
    pub wave_height_m: Option<f64>,
    pub wave_period_s: Option<f64>,
    pub wave_to_deg: Option<f64>,
    pub reef: f64,
    pub sail_trim: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BoatOutput {
    /// Boat speed through water.
    pub stw_mps: f64,
    /// Velocity through water in earth EN frame.
    pub through_water_mps: Vec2Mps,
    /// Velocity over ground after current.
    pub over_ground_mps: Vec2Mps,
    pub twa_deg: f64,
    pub tws_mps: f64,
    pub sog_mps: f64,
    pub cog_true_deg: f64,
    pub leeway_deg: f64,
    pub wave_penalty: f64,
    pub safety_penalty: f64,
}

pub trait BoatProfile: Send + Sync {
    fn id(&self) -> &str;
    fn predict(&self, input: BoatInput) -> BoatOutput;
}
