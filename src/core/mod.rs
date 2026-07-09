pub mod error;
pub mod geo;
pub mod time;
pub mod units;
pub mod vec2;

pub use geo::{LatLon, angle_diff_deg, bearing_deg, distance_m, move_latlon};
pub use units::{deg_to_rad, knots_to_mps, mps_to_knots, normalize_180, normalize_360, rad_to_deg};
pub use vec2::Vec2Mps;
