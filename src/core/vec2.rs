use serde::{Deserialize, Serialize};

use crate::core::units::{deg_to_rad, normalize_360, rad_to_deg};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vec2Mps {
    pub east: f64,
    pub north: f64,
}

impl Vec2Mps {
    pub const ZERO: Self = Self {
        east: 0.0,
        north: 0.0,
    };

    pub fn new(east: f64, north: f64) -> Self {
        Self { east, north }
    }

    pub fn from_speed_to_deg(speed_mps: f64, to_deg: f64) -> Self {
        let rad = deg_to_rad(to_deg);
        Self {
            east: speed_mps * rad.sin(),
            north: speed_mps * rad.cos(),
        }
    }

    pub fn magnitude(self) -> f64 {
        self.east.hypot(self.north)
    }

    pub fn to_deg(self) -> f64 {
        if self.magnitude() <= f64::EPSILON {
            return 0.0;
        }
        normalize_360(rad_to_deg(self.east.atan2(self.north)))
    }

    pub fn scale(self, factor: f64) -> Self {
        Self {
            east: self.east * factor,
            north: self.north * factor,
        }
    }

    pub fn add_components(self, rhs: Self) -> Self {
        Self {
            east: self.east + rhs.east,
            north: self.north + rhs.north,
        }
    }

    pub fn sub_components(self, rhs: Self) -> Self {
        Self {
            east: self.east - rhs.east,
            north: self.north - rhs.north,
        }
    }
}

impl std::ops::Add for Vec2Mps {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        self.add_components(rhs)
    }
}

impl std::ops::Sub for Vec2Mps {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        self.sub_components(rhs)
    }
}

impl std::ops::Mul<f64> for Vec2Mps {
    type Output = Self;

    fn mul(self, rhs: f64) -> Self::Output {
        self.scale(rhs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_direction_uses_true_degrees() {
        let east = Vec2Mps::from_speed_to_deg(2.0, 90.0);
        assert!((east.east - 2.0).abs() < 1e-9);
        assert!(east.north.abs() < 1e-9);
        assert!((east.to_deg() - 90.0).abs() < 1e-9);
    }
}
