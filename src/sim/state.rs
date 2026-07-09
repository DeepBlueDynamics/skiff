use chrono::{DateTime, Utc};
use crate::core::LatLon;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoatState {
    pub at: DateTime<Utc>,
    pub pos: LatLon,
    pub heading_true_deg: f64,
    pub sog_mps: f64,
    pub cog_true_deg: f64,
}
