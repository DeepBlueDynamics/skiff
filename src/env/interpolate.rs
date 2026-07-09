use crate::core::{LatLon, Vec2Mps};

use crate::env::metocean::MetOcean;

pub fn lerp_f64(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

pub fn lerp_vec2(a: Vec2Mps, b: Vec2Mps, t: f64) -> Vec2Mps {
    Vec2Mps {
        east: lerp_f64(a.east, b.east, t),
        north: lerp_f64(a.north, b.north, t),
    }
}

pub fn lerp_latlon(a: LatLon, b: LatLon, t: f64) -> LatLon {
    LatLon {
        lat_deg: lerp_f64(a.lat_deg, b.lat_deg, t),
        lon_deg: lerp_f64(a.lon_deg, b.lon_deg, t),
    }
}

pub fn blend_samples(a: &MetOcean, b: &MetOcean, t: f64) -> MetOcean {
    MetOcean {
        at: if t < 0.5 { a.at } else { b.at },
        pos: lerp_latlon(a.pos, b.pos, t),
        wind_ground_mps: lerp_vec2(a.wind_ground_mps, b.wind_ground_mps, t),
        current_ground_mps: lerp_vec2(a.current_ground_mps, b.current_ground_mps, t),
        gust_mps: blend_option(a.gust_mps, b.gust_mps, t),
        pressure_pa: blend_option(a.pressure_pa, b.pressure_pa, t),
        wave_height_m: blend_option(a.wave_height_m, b.wave_height_m, t),
        wave_period_s: blend_option(a.wave_period_s, b.wave_period_s, t),
        wave_to_deg: blend_option(a.wave_to_deg, b.wave_to_deg, t),
        source_time: a.source_time.or(b.source_time),
    }
}

fn blend_option(a: Option<f64>, b: Option<f64>, t: f64) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(lerp_f64(a, b, t)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}
