use crate::core::{LatLon, Vec2Mps, move_latlon};

pub fn integrate_position(pos: LatLon, over_ground_mps: Vec2Mps, dt_s: f64) -> LatLon {
    move_latlon(pos, over_ground_mps, dt_s)
}
