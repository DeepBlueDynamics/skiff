pub const EARTH_RADIUS_M: f64 = 6_371_000.0;
pub const METERS_PER_NAUTICAL_MILE: f64 = 1852.0;
pub const MPS_PER_KNOT: f64 = 0.514_444_444_444;

pub fn deg_to_rad(deg: f64) -> f64 {
    deg.to_radians()
}

pub fn rad_to_deg(rad: f64) -> f64 {
    rad.to_degrees()
}

pub fn knots_to_mps(knots: f64) -> f64 {
    knots * MPS_PER_KNOT
}

pub fn mps_to_knots(mps: f64) -> f64 {
    mps / MPS_PER_KNOT
}

pub fn normalize_360(deg: f64) -> f64 {
    deg.rem_euclid(360.0)
}

pub fn normalize_180(deg: f64) -> f64 {
    let mut out = (deg + 180.0).rem_euclid(360.0) - 180.0;
    if out == -180.0 {
        out = 180.0;
    }
    out
}
