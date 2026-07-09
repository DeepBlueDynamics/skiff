use serde::{Deserialize, Serialize};

use crate::core::units::{EARTH_RADIUS_M, deg_to_rad, normalize_360, rad_to_deg};
use crate::core::vec2::Vec2Mps;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LatLon {
    pub lat_deg: f64,
    pub lon_deg: f64,
}

pub fn distance_m(a: LatLon, b: LatLon) -> f64 {
    let lat1 = deg_to_rad(a.lat_deg);
    let lat2 = deg_to_rad(b.lat_deg);
    let dlat = deg_to_rad(b.lat_deg - a.lat_deg);
    let dlon = deg_to_rad(b.lon_deg - a.lon_deg);

    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().atan2((1.0 - h).sqrt())
}

pub fn bearing_deg(from: LatLon, to: LatLon) -> f64 {
    let lat1 = deg_to_rad(from.lat_deg);
    let lat2 = deg_to_rad(to.lat_deg);
    let dlon = deg_to_rad(to.lon_deg - from.lon_deg);

    let y = dlon.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();
    normalize_360(rad_to_deg(y.atan2(x)))
}

pub fn move_latlon(pos: LatLon, velocity: Vec2Mps, dt_s: f64) -> LatLon {
    let east_m = velocity.east * dt_s;
    let north_m = velocity.north * dt_s;
    let lat_rad = deg_to_rad(pos.lat_deg);

    let dlat = north_m / EARTH_RADIUS_M;
    let cos_lat = lat_rad.cos().abs().max(1.0e-9);
    let dlon = east_m / (EARTH_RADIUS_M * cos_lat);

    LatLon {
        lat_deg: pos.lat_deg + rad_to_deg(dlat),
        lon_deg: pos.lon_deg + rad_to_deg(dlon),
    }
}

pub fn angle_diff_deg(a_deg: f64, b_deg: f64) -> f64 {
    let mut diff = (a_deg - b_deg + 180.0).rem_euclid(360.0) - 180.0;
    if diff == -180.0 {
        diff = 180.0;
    }
    diff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearing_cardinals_are_stable() {
        let origin = LatLon {
            lat_deg: 0.0,
            lon_deg: 0.0,
        };

        assert!(
            (bearing_deg(
                origin,
                LatLon {
                    lat_deg: 1.0,
                    lon_deg: 0.0
                }
            ) - 0.0)
                .abs()
                < 1e-9
        );
        assert!(
            (bearing_deg(
                origin,
                LatLon {
                    lat_deg: 0.0,
                    lon_deg: 1.0
                }
            ) - 90.0)
                .abs()
                < 1e-9
        );
    }

    #[test]
    fn move_north_one_second() {
        let pos = LatLon {
            lat_deg: 0.0,
            lon_deg: 0.0,
        };
        let next = move_latlon(
            pos,
            Vec2Mps {
                east: 0.0,
                north: 1.0,
            },
            1.0,
        );

        assert!(next.lat_deg > 0.0);
        assert_eq!(next.lon_deg, 0.0);
    }
}
