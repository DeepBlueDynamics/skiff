use crate::core::{Vec2Mps, angle_diff_deg};
use crate::env::boat_over_ground;

use crate::boat::leeway::LeewayModel;
use crate::boat::profile::{BoatInput, BoatOutput, BoatProfile};
use crate::boat::wave_penalty::{WavePenaltyModel, wave_speed_factor};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindCourse {
    HeadToWind,
    CloseHauled,
    CrossingWind,
    BroadReach,
    WindRightAft,
}

#[derive(Debug, Clone)]
pub struct CastOffProfile {
    pub base_efficiency: f64,
    pub max_hull_speed_mps: f64,
    pub no_go_angle_deg: f64,
    pub use_repo_head_to_wind_multiplier: bool,
    pub wave_penalty: WavePenaltyModel,
    pub leeway_model: LeewayModel,
}

impl Default for CastOffProfile {
    fn default() -> Self {
        Self {
            base_efficiency: 0.42,
            max_hull_speed_mps: 3.6,
            no_go_angle_deg: 35.0,
            use_repo_head_to_wind_multiplier: true,
            wave_penalty: WavePenaltyModel::default(),
            leeway_model: LeewayModel::default(),
        }
    }
}

impl BoatProfile for CastOffProfile {
    fn id(&self) -> &str {
        "castoff-compatible"
    }

    fn predict(&self, input: BoatInput) -> BoatOutput {
        let tws_mps = input.wind_water_mps.magnitude();
        let wind_to_deg = input.wind_water_mps.to_deg();
        // TWA is relative angle between bow heading and wind moving toward. This preserves the
        // old Cast-Off spirit: wind course buckets are based on wind vector versus pointing vector.
        let twa_deg = angle_diff_deg(input.heading_true_deg, wind_to_deg);
        // Design: port/starboard symmetry via abs(TWA) is intentional for now
        // (see plan §4.7). Course buckets ignore tack side.
        let twa_abs = twa_deg.abs();
        let course = classify_course(twa_abs);

        let no_go_factor =
            if !self.use_repo_head_to_wind_multiplier && twa_abs < self.no_go_angle_deg {
                0.0
            } else {
                1.0
            };

        let trim_factor = input.sail_trim.clamp(0.0, 1.0);
        let reef_factor = 1.0 - input.reef.clamp(0.0, 1.0);
        // Design: wave_speed_factor slows STW (physics); same factor feeds comfort
        // cost in the router. Double-influence intentional — plan §4.7.
        let wave_factor = wave_speed_factor(
            input.heading_true_deg,
            input.wave_to_deg,
            input.wave_height_m,
            input.wave_period_s,
            self.wave_penalty,
        );

        let stw_mps = (tws_mps
            * self.base_efficiency
            * castoff_multiplier(course)
            * trim_factor
            * reef_factor
            * no_go_factor
            * wave_factor)
            .clamp(0.0, self.max_hull_speed_mps);
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

pub fn classify_course(twa_deg: f64) -> WindCourse {
    let a = twa_deg.abs();

    if a > 15.0 && a <= 60.0 {
        WindCourse::CloseHauled
    } else if a > 60.0 && a <= 110.0 {
        WindCourse::CrossingWind
    } else if a > 110.0 && a <= 160.0 {
        WindCourse::BroadReach
    } else if a > 160.0 && a <= 180.0 {
        WindCourse::WindRightAft
    } else {
        WindCourse::HeadToWind
    }
}

pub fn castoff_multiplier(course: WindCourse) -> f64 {
    match course {
        WindCourse::HeadToWind => 0.3,
        WindCourse::CloseHauled => 0.8,
        WindCourse::CrossingWind => 1.0,
        WindCourse::BroadReach => 1.1,
        WindCourse::WindRightAft => 1.2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_current_changes_cog_not_stw() {
        let profile = CastOffProfile::default();
        let out = profile.predict(BoatInput {
            heading_true_deg: 0.0,
            wind_water_mps: Vec2Mps::from_speed_to_deg(8.0, 90.0),
            current_ground_mps: Vec2Mps::from_speed_to_deg(1.0, 90.0),
            wave_height_m: None,
            wave_period_s: None,
            wave_to_deg: None,
            reef: 0.0,
            sail_trim: 1.0,
        });

        assert!(out.stw_mps > 0.0);
        assert!(out.sog_mps > out.stw_mps);
        assert_ne!(out.cog_true_deg.round(), 0.0);
    }
}
