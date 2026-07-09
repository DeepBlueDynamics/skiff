use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use crate::core::{LatLon, Vec2Mps, knots_to_mps, normalize_360};
use serde::{Deserialize, Serialize};

use crate::env::interpolate::lerp_f64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Field {
    pub kind: String,
    pub grid: FieldGrid,
    pub times: Vec<DateTime<Utc>>,
    /// Speed values in knots for current fields, mps/knots for wind, meters for waves.
    pub speed: Vec<Option<f64>>,
    /// Direction values in true degrees.
    pub direction: Vec<Option<f64>>,
    /// Optional wave period values.
    #[serde(default)]
    pub period: Option<Vec<Option<f64>>>,
    pub source: FieldSource,
    pub age_secs: u64,
}


#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FieldGrid {
    pub lat0: f64,
    pub lon0: f64,
    pub d_lat: f64,
    pub d_lon: f64,
    pub n_lat: usize,
    pub n_lon: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSource {
    pub provider: String,
    pub model: String,
    pub fetched_at: DateTime<Utc>,
    pub attribution: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CurrentPoint {
    pub speed_kn: f64,
    pub set_true_deg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SignalKCurrent {
    pub drift_mps: f64,
    pub set_true_rad: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WavePoint {
    pub height_m: f64,
    pub period_s: f64,
    pub to_deg: f64,
}

impl Field {
    pub fn validate_current(&self) -> Result<()> {
        if self.kind != "current" {
            return Err(anyhow!("expected current field, got {}", self.kind));
        }
        let expected = self.times.len() * self.grid.n_lat * self.grid.n_lon;
        if self.speed.len() != expected || self.direction.len() != expected {
            return Err(anyhow!(
                "field arrays must be row-major [time][lat][lon], expected {expected} values"
            ));
        }
        if self.grid.n_lat == 0 || self.grid.n_lon == 0 || self.times.is_empty() {
            return Err(anyhow!("field grid and times must not be empty"));
        }
        Ok(())
    }

    pub fn interpolate_current(&self, pos: LatLon, at: DateTime<Utc>) -> Result<CurrentPoint> {
        self.validate_current()?;
        let (lat_i0, lat_i1, lat_t) = locate_axis(
            pos.lat_deg,
            self.grid.lat0,
            self.grid.d_lat,
            self.grid.n_lat,
        )
        .ok_or_else(|| anyhow!("position latitude is outside current field"))?;
        let (lon_i0, lon_i1, lon_t) = locate_axis(
            pos.lon_deg,
            self.grid.lon0,
            self.grid.d_lon,
            self.grid.n_lon,
        )
        .ok_or_else(|| anyhow!("position longitude is outside current field"))?;
        let (time_i0, time_i1, time_t) =
            locate_time(&self.times, at).ok_or_else(|| anyhow!("time is outside current field"))?;

        let a = self.interpolate_current_at_indices(
            time_i0, lat_i0, lat_i1, lat_t, lon_i0, lon_i1, lon_t,
        )?;
        let b = self.interpolate_current_at_indices(
            time_i1, lat_i0, lat_i1, lat_t, lon_i0, lon_i1, lon_t,
        )?;

        Ok(CurrentPoint {
            speed_kn: lerp_f64(a.speed_kn, b.speed_kn, time_t),
            set_true_deg: interpolate_degrees(a.set_true_deg, b.set_true_deg, time_t),
        })
    }

    fn interpolate_current_at_indices(
        &self,
        time_i: usize,
        lat_i0: usize,
        lat_i1: usize,
        lat_t: f64,
        lon_i0: usize,
        lon_i1: usize,
        lon_t: f64,
    ) -> Result<CurrentPoint> {
        let p00 = self.current_at(time_i, lat_i0, lon_i0);
        let p01 = self.current_at(time_i, lat_i0, lon_i1);
        let p10 = self.current_at(time_i, lat_i1, lon_i0);
        let p11 = self.current_at(time_i, lat_i1, lon_i1);

        let top = blend_current(p00, p01, lon_t);
        let bottom = blend_current(p10, p11, lon_t);
        blend_current(top, bottom, lat_t)
            .ok_or_else(|| anyhow!("current field has no usable surrounding samples"))
    }

    fn current_at(&self, time_i: usize, lat_i: usize, lon_i: usize) -> Option<CurrentPoint> {
        let idx = self.index(time_i, lat_i, lon_i);
        Some(CurrentPoint {
            speed_kn: self.speed.get(idx).copied().flatten()?,
            set_true_deg: self.direction.get(idx).copied().flatten()?,
        })
    }

    fn index(&self, time_i: usize, lat_i: usize, lon_i: usize) -> usize {
        (time_i * self.grid.n_lat * self.grid.n_lon) + (lat_i * self.grid.n_lon) + lon_i
    }

    pub fn validate_wind(&self) -> Result<()> {
        if self.kind != "wind" {
            return Err(anyhow!("expected wind field, got {}", self.kind));
        }
        let expected = self.times.len() * self.grid.n_lat * self.grid.n_lon;
        if self.speed.len() != expected || self.direction.len() != expected {
            return Err(anyhow!(
                "field arrays must be row-major [time][lat][lon], expected {expected} values"
            ));
        }
        if self.grid.n_lat == 0 || self.grid.n_lon == 0 || self.times.is_empty() {
            return Err(anyhow!("field grid and times must not be empty"));
        }
        Ok(())
    }

    pub fn interpolate_wind(&self, pos: LatLon, at: DateTime<Utc>) -> Result<Vec2Mps> {
        self.validate_wind()?;
        let (lat_i0, lat_i1, lat_t) = locate_axis(
            pos.lat_deg,
            self.grid.lat0,
            self.grid.d_lat,
            self.grid.n_lat,
        )
        .ok_or_else(|| anyhow!("position latitude is outside wind field"))?;
        let (lon_i0, lon_i1, lon_t) = locate_axis(
            pos.lon_deg,
            self.grid.lon0,
            self.grid.d_lon,
            self.grid.n_lon,
        )
        .ok_or_else(|| anyhow!("position longitude is outside wind field"))?;
        let (time_i0, time_i1, time_t) =
            locate_time(&self.times, at).ok_or_else(|| anyhow!("time is outside wind field"))?;

        let a = self.interpolate_current_at_indices(
            time_i0, lat_i0, lat_i1, lat_t, lon_i0, lon_i1, lon_t,
        )?;
        let b = self.interpolate_current_at_indices(
            time_i1, lat_i0, lat_i1, lat_t, lon_i0, lon_i1, lon_t,
        )?;

        let speed_kn = lerp_f64(a.speed_kn, b.speed_kn, time_t);
        let direction_deg = interpolate_degrees(a.set_true_deg, b.set_true_deg, time_t);
        Ok(Vec2Mps::from_speed_to_deg(knots_to_mps(speed_kn), direction_deg))
    }

    pub fn validate_wave(&self) -> Result<()> {
        if self.kind != "wave" && self.kind != "waves" {
            return Err(anyhow!("expected wave field, got {}", self.kind));
        }
        let expected = self.times.len() * self.grid.n_lat * self.grid.n_lon;
        if self.speed.len() != expected || self.direction.len() != expected {
            return Err(anyhow!(
                "field arrays must be row-major [time][lat][lon], expected {expected} values"
            ));
        }
        if let Some(period) = &self.period {
            if period.len() != expected {
                return Err(anyhow!(
                    "wave period array length must match speed/direction array, expected {expected} values"
                ));
            }
        }
        if self.grid.n_lat == 0 || self.grid.n_lon == 0 || self.times.is_empty() {
            return Err(anyhow!("field grid and times must not be empty"));
        }
        Ok(())
    }

    pub fn interpolate_wave(&self, pos: LatLon, at: DateTime<Utc>) -> Result<WavePoint> {
        self.validate_wave()?;
        let (lat_i0, lat_i1, lat_t) = locate_axis(
            pos.lat_deg,
            self.grid.lat0,
            self.grid.d_lat,
            self.grid.n_lat,
        )
        .ok_or_else(|| anyhow!("position latitude is outside wave field"))?;
        let (lon_i0, lon_i1, lon_t) = locate_axis(
            pos.lon_deg,
            self.grid.lon0,
            self.grid.d_lon,
            self.grid.n_lon,
        )
        .ok_or_else(|| anyhow!("position longitude is outside wave field"))?;
        let (time_i0, time_i1, time_t) =
            locate_time(&self.times, at).ok_or_else(|| anyhow!("time is outside wave field"))?;

        let h_a = self.speed_at(time_i0, lat_i0, lon_i0, lat_i1, lon_i1, lat_t, lon_t)?;
        let h_b = self.speed_at(time_i1, lat_i0, lon_i0, lat_i1, lon_i1, lat_t, lon_t)?;
        let height_m = lerp_f64(h_a, h_b, time_t);

        let d_a = self.direction_at(time_i0, lat_i0, lon_i0, lat_i1, lon_i1, lat_t, lon_t)?;
        let d_b = self.direction_at(time_i1, lat_i0, lon_i0, lat_i1, lon_i1, lat_t, lon_t)?;
        let to_deg = interpolate_degrees(d_a, d_b, time_t);

        let period_s = if let Some(period_vec) = &self.period {
            let p_a = self.period_at(period_vec, time_i0, lat_i0, lon_i0, lat_i1, lon_i1, lat_t, lon_t)?;
            let p_b = self.period_at(period_vec, time_i1, lat_i0, lon_i0, lat_i1, lon_i1, lat_t, lon_t)?;
            lerp_f64(p_a, p_b, time_t)
        } else {
            6.0
        };

        Ok(WavePoint {
            height_m,
            period_s,
            to_deg,
        })
    }

    fn speed_at(&self, time_i: usize, lat_i0: usize, lon_i0: usize, lat_i1: usize, lon_i1: usize, lat_t: f64, lon_t: f64) -> Result<f64> {
        let p00 = self.speed.get(self.index(time_i, lat_i0, lon_i0)).copied().flatten();
        let p01 = self.speed.get(self.index(time_i, lat_i0, lon_i1)).copied().flatten();
        let p10 = self.speed.get(self.index(time_i, lat_i1, lon_i0)).copied().flatten();
        let p11 = self.speed.get(self.index(time_i, lat_i1, lon_i1)).copied().flatten();
        blend_scalars(p00, p01, p10, p11, lat_t, lon_t).ok_or_else(|| anyhow!("missing speed samples in wave field"))
    }

    fn direction_at(&self, time_i: usize, lat_i0: usize, lon_i0: usize, lat_i1: usize, lon_i1: usize, lat_t: f64, lon_t: f64) -> Result<f64> {
        let p00 = self.direction.get(self.index(time_i, lat_i0, lon_i0)).copied().flatten();
        let p01 = self.direction.get(self.index(time_i, lat_i0, lon_i1)).copied().flatten();
        let p10 = self.direction.get(self.index(time_i, lat_i1, lon_i0)).copied().flatten();
        let p11 = self.direction.get(self.index(time_i, lat_i1, lon_i1)).copied().flatten();
        blend_angles(p00, p01, p10, p11, lat_t, lon_t).ok_or_else(|| anyhow!("missing direction samples in wave field"))
    }

    fn period_at(&self, period_vec: &[Option<f64>], time_i: usize, lat_i0: usize, lon_i0: usize, lat_i1: usize, lon_i1: usize, lat_t: f64, lon_t: f64) -> Result<f64> {
        let p00 = period_vec.get(self.index(time_i, lat_i0, lon_i0)).copied().flatten();
        let p01 = period_vec.get(self.index(time_i, lat_i0, lon_i1)).copied().flatten();
        let p10 = period_vec.get(self.index(time_i, lat_i1, lon_i0)).copied().flatten();
        let p11 = period_vec.get(self.index(time_i, lat_i1, lon_i1)).copied().flatten();
        blend_scalars(p00, p01, p10, p11, lat_t, lon_t).ok_or_else(|| anyhow!("missing period samples in wave field"))
    }
}

fn blend_scalars(p00: Option<f64>, p01: Option<f64>, p10: Option<f64>, p11: Option<f64>, lat_t: f64, lon_t: f64) -> Option<f64> {
    let top = match (p00, p01) {
        (Some(a), Some(b)) => Some(lerp_f64(a, b, lon_t)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let bottom = match (p10, p11) {
        (Some(a), Some(b)) => Some(lerp_f64(a, b, lon_t)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    match (top, bottom) {
        (Some(t), Some(b)) => Some(lerp_f64(t, b, lat_t)),
        (Some(t), None) => Some(t),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn blend_angles(p00: Option<f64>, p01: Option<f64>, p10: Option<f64>, p11: Option<f64>, lat_t: f64, lon_t: f64) -> Option<f64> {
    let top = match (p00, p01) {
        (Some(a), Some(b)) => Some(interpolate_degrees(a, b, lon_t)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let bottom = match (p10, p11) {
        (Some(a), Some(b)) => Some(interpolate_degrees(a, b, lon_t)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    match (top, bottom) {
        (Some(t), Some(b)) => Some(interpolate_degrees(t, b, lat_t)),
        (Some(t), None) => Some(t),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}


pub fn current_set_drift_to_vector_mps(speed_kn: f64, set_true_deg: f64) -> Vec2Mps {
    Vec2Mps::from_speed_to_deg(knots_to_mps(speed_kn), set_true_deg)
}

pub fn current_to_signalk(speed_kn: f64, set_true_deg: f64) -> SignalKCurrent {
    SignalKCurrent {
        drift_mps: knots_to_mps(speed_kn),
        set_true_rad: normalize_rad(set_true_deg.to_radians()),
    }
}

pub fn normalize_rad(rad: f64) -> f64 {
    let two_pi = std::f64::consts::PI * 2.0;
    rad.rem_euclid(two_pi)
}

fn locate_axis(value: f64, start: f64, step: f64, len: usize) -> Option<(usize, usize, f64)> {
    if len == 1 {
        return Some((0, 0, 0.0));
    }
    if step == 0.0 {
        return None;
    }
    let raw = (value - start) / step;
    if raw < 0.0 || raw > (len - 1) as f64 {
        return None;
    }
    let i0 = raw.floor() as usize;
    let i1 = (i0 + 1).min(len - 1);
    Some((i0, i1, raw - i0 as f64))
}

fn locate_time(times: &[DateTime<Utc>], at: DateTime<Utc>) -> Option<(usize, usize, f64)> {
    if times.len() == 1 {
        return (times[0] == at).then_some((0, 0, 0.0));
    }
    for i in 0..times.len() - 1 {
        if at >= times[i] && at <= times[i + 1] {
            let total = (times[i + 1] - times[i]).num_milliseconds() as f64;
            let elapsed = (at - times[i]).num_milliseconds() as f64;
            return Some((i, i + 1, if total == 0.0 { 0.0 } else { elapsed / total }));
        }
    }
    None
}

fn blend_current(a: Option<CurrentPoint>, b: Option<CurrentPoint>, t: f64) -> Option<CurrentPoint> {
    match (a, b) {
        (Some(a), Some(b)) => Some(CurrentPoint {
            speed_kn: lerp_f64(a.speed_kn, b.speed_kn, t),
            set_true_deg: interpolate_degrees(a.set_true_deg, b.set_true_deg, t),
        }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn interpolate_degrees(a: f64, b: f64, t: f64) -> f64 {
    let delta = (b - a + 180.0).rem_euclid(360.0) - 180.0;
    normalize_360(a + delta * t.clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn current_direction_toward_east_becomes_positive_east_vector() {
        let v = current_set_drift_to_vector_mps(1.0, 90.0);

        assert!(v.east > 0.51 && v.east < 0.52);
        assert!(v.north.abs() < 0.0001);
    }

    #[test]
    fn current_direction_toward_north_becomes_positive_north_vector() {
        let v = current_set_drift_to_vector_mps(1.0, 0.0);

        assert!(v.north > 0.51 && v.north < 0.52);
        assert!(v.east.abs() < 0.0001);
    }

    #[test]
    fn interpolates_current_field_row_major_time_lat_lon() {
        let t0 = DateTime::<Utc>::UNIX_EPOCH;
        let t1 = t0 + Duration::hours(1);
        let field = Field {
            kind: "current".to_string(),
            grid: FieldGrid {
                lat0: 0.0,
                lon0: 0.0,
                d_lat: 1.0,
                d_lon: 1.0,
                n_lat: 2,
                n_lon: 2,
            },
            times: vec![t0, t1],
            speed: vec![
                Some(1.0),
                Some(1.0),
                Some(1.0),
                Some(1.0),
                Some(3.0),
                Some(3.0),
                Some(3.0),
                Some(3.0),
            ],
            direction: vec![
                Some(90.0),
                Some(90.0),
                Some(90.0),
                Some(90.0),
                Some(90.0),
                Some(90.0),
                Some(90.0),
                Some(90.0),
            ],
            period: None,
            source: FieldSource {
                provider: "test".to_string(),
                model: "test".to_string(),
                fetched_at: t0,
                attribution: None,
            },
            age_secs: 0,
        };

        let p = field
            .interpolate_current(
                LatLon {
                    lat_deg: 0.5,
                    lon_deg: 0.5,
                },
                t0 + Duration::minutes(30),
            )
            .unwrap();

        assert_eq!(p.speed_kn, 2.0);
        assert_eq!(p.set_true_deg, 90.0);
    }

    #[test]
    fn signalk_current_uses_mps_and_radians() {
        let out = current_to_signalk(0.9, 86.0);
        assert!(out.drift_mps > 0.46 && out.drift_mps < 0.47);
        assert!(out.set_true_rad > 1.50 && out.set_true_rad < 1.51);
    }
}
