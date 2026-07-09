use chrono::{DateTime, Utc};
use crate::core::{LatLon, Vec2Mps};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DirectionalScalar {
    /// Direction the value is moving toward, true degrees.
    pub to_deg: f64,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetOcean {
    pub at: DateTime<Utc>,
    pub pos: LatLon,
    /// Air velocity over ground.
    pub wind_ground_mps: Vec2Mps,
    /// Water velocity over ground.
    pub current_ground_mps: Vec2Mps,
    pub gust_mps: Option<f64>,
    pub pressure_pa: Option<f64>,
    /// Significant wave height.
    pub wave_height_m: Option<f64>,
    /// Wave period, seconds.
    pub wave_period_s: Option<f64>,
    /// Direction waves travel toward, true degrees.
    pub wave_to_deg: Option<f64>,
    pub source_time: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MotionFrame {
    pub wind_ground_mps: Vec2Mps,
    pub current_ground_mps: Vec2Mps,
    pub wind_water_mps: Vec2Mps,
    pub boat_water_mps: Vec2Mps,
    pub boat_ground_mps: Vec2Mps,
}

pub fn wind_over_water(env: &MetOcean) -> Vec2Mps {
    wind_over_water_vectors(env.wind_ground_mps, env.current_ground_mps)
}

pub fn wind_over_water_vectors(wind_ground: Vec2Mps, current_ground: Vec2Mps) -> Vec2Mps {
    wind_ground - current_ground
}

pub fn add_current(through_water: Vec2Mps, current: Vec2Mps) -> Vec2Mps {
    through_water + current
}

pub fn boat_over_ground(boat_water: Vec2Mps, current_ground: Vec2Mps) -> Vec2Mps {
    boat_water + current_ground
}

pub fn test_env() -> MetOcean {
    MetOcean {
        at: DateTime::<Utc>::UNIX_EPOCH,
        pos: LatLon {
            lat_deg: 0.0,
            lon_deg: 0.0,
        },
        wind_ground_mps: Vec2Mps::ZERO,
        current_ground_mps: Vec2Mps::ZERO,
        gust_mps: None,
        pressure_pa: None,
        wave_height_m: None,
        wave_period_s: None,
        wave_to_deg: None,
        source_time: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_adds_to_ground_velocity() {
        let boat = Vec2Mps {
            east: 2.0,
            north: 0.0,
        };
        let cur = Vec2Mps {
            east: 0.5,
            north: 1.0,
        };
        let ground = add_current(boat, cur);

        assert_eq!(ground.east, 2.5);
        assert_eq!(ground.north, 1.0);
    }

    #[test]
    fn wind_over_water_subtracts_current() {
        let env = MetOcean {
            wind_ground_mps: Vec2Mps {
                east: 5.0,
                north: 0.0,
            },
            current_ground_mps: Vec2Mps {
                east: 1.0,
                north: 0.0,
            },
            ..test_env()
        };

        let wow = wind_over_water(&env);
        assert_eq!(wow.east, 4.0);
        assert_eq!(wow.north, 0.0);
    }
}
