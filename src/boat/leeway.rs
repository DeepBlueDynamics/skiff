use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LeewayModel {
    pub max_deg: f64,
    pub upwind_twa_deg: f64,
}

impl Default for LeewayModel {
    fn default() -> Self {
        Self {
            max_deg: 5.0,
            upwind_twa_deg: 45.0,
        }
    }
}

impl LeewayModel {
    pub fn estimate(self, twa_deg: f64, stw_mps: f64) -> f64 {
        if stw_mps <= 0.05 {
            return 0.0;
        }
        let upwind_factor = (1.0 - (twa_deg.abs() / self.upwind_twa_deg).clamp(0.0, 1.0)).max(0.0);
        self.max_deg * upwind_factor
    }
}
