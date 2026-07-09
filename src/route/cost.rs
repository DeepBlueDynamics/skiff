use crate::boat::BoatOutput;
use crate::core::{LatLon, Vec2Mps, bearing_deg, distance_m, mps_to_knots};
use crate::env::MetOcean;

use crate::route::isochrone::IsochroneRequest;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurrentRouteCost {
    pub drift_kn: f64,
    pub set_true_deg: f64,
    pub along_track_kn: f64,
    pub cross_track_kn: f64,
}

pub fn current_route_cost(current: Vec2Mps, pos: LatLon, destination: LatLon) -> CurrentRouteCost {
    let bearing = bearing_deg(pos, destination);
    let along_unit = Vec2Mps::from_speed_to_deg(1.0, bearing);
    let cross_unit = Vec2Mps::from_speed_to_deg(1.0, bearing + 90.0);
    let along_mps = current.east * along_unit.east + current.north * along_unit.north;
    let cross_mps = current.east * cross_unit.east + current.north * cross_unit.north;

    CurrentRouteCost {
        drift_kn: mps_to_knots(current.magnitude()),
        set_true_deg: current.to_deg(),
        along_track_kn: mps_to_knots(along_mps),
        cross_track_kn: mps_to_knots(cross_mps),
    }
}

pub fn score_node(
    pos: LatLon,
    destination: LatLon,
    out: &BoatOutput,
    met: &MetOcean,
    req: &IsochroneRequest,
) -> f64 {
    let distance_nm = distance_m(pos, destination) / crate::core::units::METERS_PER_NAUTICAL_MILE;
    let speed_cost = if out.sog_mps <= 0.05 {
        10_000.0
    } else {
        1.0 / out.sog_mps
    };
    let comfort_cost = (1.0 - out.wave_penalty).max(0.0) * req.comfort_weight;
    let safety_cost = out.safety_penalty * req.safety_weight;
    let current = current_route_cost(met.current_ground_mps, pos, destination);
    let adverse_current_cost = (-current.along_track_kn).max(0.0) * 0.05;

    distance_nm + speed_cost + comfort_cost + safety_cost + adverse_current_cost
}
