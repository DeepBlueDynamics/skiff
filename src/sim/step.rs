use anyhow::{Result, anyhow};
use chrono::Duration;
use crate::boat::{BoatInput, BoatOutput, BoatProfile};
use crate::env::{EnvBatchRequest, EnvQueryPoint, EnvironmentProvider, MetOcean, wind_over_water};
use serde::{Deserialize, Serialize};

use crate::sim::integrator::integrate_position;
use crate::sim::state::BoatState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRequest {
    pub state: BoatState,
    pub dt_s: f64,
    pub commanded_heading_true_deg: f64,
    pub reef: f64,
    pub sail_trim: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub state: BoatState,
    pub boat: BoatOutput,
    pub env: MetOcean,
}

pub async fn step_boat<P, E>(profile: &P, env_provider: &E, req: StepRequest) -> Result<StepResult>
where
    P: BoatProfile,
    E: EnvironmentProvider,
{
    if req.dt_s <= 0.0 {
        return Err(anyhow!("dt_s must be positive"));
    }

    let mut samples = env_provider
        .sample_many(EnvBatchRequest {
            points: vec![EnvQueryPoint {
                at: req.state.at,
                pos: req.state.pos,
            }],
        })
        .await?;
    let env = samples
        .pop()
        .ok_or_else(|| anyhow!("environment provider returned no samples"))?;

    let wind_water_mps = wind_over_water(&env);
    let boat = profile.predict(BoatInput {
        heading_true_deg: req.commanded_heading_true_deg,
        wind_water_mps,
        current_ground_mps: env.current_ground_mps,
        wave_height_m: env.wave_height_m,
        wave_period_s: env.wave_period_s,
        wave_to_deg: env.wave_to_deg,
        reef: req.reef,
        sail_trim: req.sail_trim,
    });

    let next_pos = integrate_position(req.state.pos, boat.over_ground_mps, req.dt_s);

    Ok(StepResult {
        state: BoatState {
            at: req.state.at + Duration::milliseconds((req.dt_s * 1000.0).round() as i64),
            pos: next_pos,
            heading_true_deg: req.commanded_heading_true_deg,
            sog_mps: boat.sog_mps,
            cog_true_deg: boat.cog_true_deg,
        },
        boat,
        env,
    })
}

#[cfg(test)]
mod tests {
    use crate::boat::CastOffProfile;
    use crate::core::{LatLon, Vec2Mps};
    use crate::env::{ConstantEnvironment, MetOcean, test_env};

    use super::*;

    #[tokio::test]
    async fn no_current_cog_matches_heading_approximately() {
        let env = ConstantEnvironment {
            sample: MetOcean {
                wind_ground_mps: Vec2Mps::from_speed_to_deg(8.0, 90.0),
                current_ground_mps: Vec2Mps::ZERO,
                ..test_env()
            },
        };
        let result = step_boat(
            &CastOffProfile::default(),
            &env,
            StepRequest {
                state: BoatState {
                    at: chrono::DateTime::<chrono::Utc>::UNIX_EPOCH,
                    pos: LatLon {
                        lat_deg: 0.0,
                        lon_deg: 0.0,
                    },
                    heading_true_deg: 0.0,
                    sog_mps: 0.0,
                    cog_true_deg: 0.0,
                },
                dt_s: 60.0,
                commanded_heading_true_deg: 0.0,
                reef: 0.0,
                sail_trim: 1.0,
            },
        )
        .await
        .unwrap();

        assert!((result.boat.cog_true_deg - result.state.heading_true_deg).abs() < 6.0);
        assert!((result.boat.sog_mps - result.boat.stw_mps).abs() < 0.01);
    }
}
