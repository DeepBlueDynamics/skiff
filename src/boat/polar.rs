use crate::core::{Vec2Mps, angle_diff_deg, knots_to_mps, mps_to_knots};
use crate::env::boat_over_ground;

use crate::boat::leeway::LeewayModel;
use crate::boat::profile::{BoatInput, BoatOutput, BoatProfile};
use crate::boat::wave_penalty::{WavePenaltyModel, wave_speed_factor};

#[derive(Debug, Clone)]
pub struct PolarProfile {
    pub id: String,
    pub tws_knots: Vec<f64>,
    pub twa_deg: Vec<f64>,
    pub speed_knots: Vec<Vec<f64>>,
    pub wave_penalty: WavePenaltyModel,
    pub leeway_model: LeewayModel,
}

impl BoatProfile for PolarProfile {
    fn id(&self) -> &str {
        &self.id
    }

    fn predict(&self, input: BoatInput) -> BoatOutput {
        let tws_mps = input.wind_water_mps.magnitude();
        let tws_knots = mps_to_knots(tws_mps);
        let wind_to_deg = input.wind_water_mps.to_deg();
        let twa_deg = angle_diff_deg(input.heading_true_deg, wind_to_deg);
        let twa_abs = twa_deg.abs().min(180.0);
        let base_stw_knots = self.lookup_speed_knots(tws_knots, twa_abs);
        let trim_factor = input.sail_trim.clamp(0.0, 1.0);
        let reef_factor = 1.0 - input.reef.clamp(0.0, 1.0);
        let wave_factor = wave_speed_factor(
            input.heading_true_deg,
            input.wave_to_deg,
            input.wave_height_m,
            input.wave_period_s,
            self.wave_penalty,
        );
        let stw_mps = knots_to_mps(base_stw_knots * trim_factor * reef_factor * wave_factor);
        let leeway_deg = self.leeway_model.estimate(twa_deg, stw_mps) * twa_deg.signum();
        let through_water_mps =
            Vec2Mps::from_speed_to_deg(stw_mps, input.heading_true_deg + leeway_deg);
        let over_ground_mps = boat_over_ground(through_water_mps, input.current_ground_mps);

        BoatOutput {
            stw_mps,
            through_water_mps,
            over_ground_mps,
            twa_deg,
            tws_mps,
            sog_mps: over_ground_mps.magnitude(),
            cog_true_deg: over_ground_mps.to_deg(),
            leeway_deg,
            wave_penalty: wave_factor,
            safety_penalty: 0.0,
        }
    }
}

impl PolarProfile {
    pub fn lookup_speed_knots(&self, tws_knots: f64, twa_deg: f64) -> f64 {
        if self.tws_knots.is_empty() || self.twa_deg.is_empty() || self.speed_knots.is_empty() {
            return 0.0;
        }
        let (tws0, tws1, tws_t) = locate(&self.tws_knots, tws_knots);
        let (twa0, twa1, twa_t) = locate(&self.twa_deg, twa_deg);

        let q00 = self.speed_at(tws0, twa0);
        let q01 = self.speed_at(tws0, twa1);
        let q10 = self.speed_at(tws1, twa0);
        let q11 = self.speed_at(tws1, twa1);

        let top = lerp(q00, q01, twa_t);
        let bottom = lerp(q10, q11, twa_t);
        lerp(top, bottom, tws_t)
    }

    fn speed_at(&self, tws_i: usize, twa_i: usize) -> f64 {
        self.speed_knots
            .get(tws_i)
            .and_then(|row| row.get(twa_i))
            .copied()
            .unwrap_or(0.0)
    }
}

fn locate(values: &[f64], value: f64) -> (usize, usize, f64) {
    if values.len() == 1 {
        return (0, 0, 0.0);
    }
    if value <= values[0] {
        return (0, 0, 0.0);
    }
    for i in 0..values.len() - 1 {
        if value >= values[i] && value <= values[i + 1] {
            let span = values[i + 1] - values[i];
            return (
                i,
                i + 1,
                if span == 0.0 {
                    0.0
                } else {
                    (value - values[i]) / span
                },
            );
        }
    }
    let last = values.len() - 1;
    (last, last, 0.0)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}
