//! World geography: land mask for grounding checks.
//!
//! Pattern borrowed from meridian's `lib/landmask.js` / `sidecar/.../landmask.rs`
//! (polygon rings + bbox prefilter + even-odd ray cast), but sourced from OSM
//! coastline data at bay-scale detail instead of Natural Earth — you can sail
//! into Prickly Bay here. Data: `web/public/world/grenada.geojson` (Grenada +
//! everything within ~20 nm; OSM ODbL).

use std::fs;

struct Island {
    /// [min_lon, min_lat, max_lon, max_lat]
    bbox: [f64; 4],
    /// Closed ring, [lon, lat] pairs (first == last).
    ring: Vec<[f64; 2]>,
}

pub struct LandMask {
    islands: Vec<Island>,
}

impl LandMask {
    /// Load from the served world data. Tries the built dist first (what the
    /// container ships), then the source public dir (local dev pre-build).
    pub fn load() -> Option<LandMask> {
        const CANDIDATES: [&str; 2] = [
            "web/dist/world/grenada.geojson",
            "web/public/world/grenada.geojson",
        ];
        for path in CANDIDATES {
            if let Ok(text) = fs::read_to_string(path) {
                match Self::parse(&text) {
                    Some(mask) => {
                        tracing::info!(
                            path,
                            islands = mask.islands.len(),
                            "land mask loaded (grounding enabled)"
                        );
                        return Some(mask);
                    }
                    None => tracing::warn!(path, "land mask file present but unparseable"),
                }
            }
        }
        tracing::warn!("no land mask data found — grounding disabled");
        None
    }

    fn parse(text: &str) -> Option<LandMask> {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        let features = v.get("features")?.as_array()?;
        let mut islands = Vec::with_capacity(features.len());
        for f in features {
            let ring_json = f
                .get("geometry")?
                .get("coordinates")?
                .as_array()?
                .first()?
                .as_array()?;
            let mut ring = Vec::with_capacity(ring_json.len());
            let mut bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
            for p in ring_json {
                let c = p.as_array()?;
                let lon = c.first()?.as_f64()?;
                let lat = c.get(1)?.as_f64()?;
                bbox[0] = bbox[0].min(lon);
                bbox[1] = bbox[1].min(lat);
                bbox[2] = bbox[2].max(lon);
                bbox[3] = bbox[3].max(lat);
                ring.push([lon, lat]);
            }
            if ring.len() >= 4 {
                islands.push(Island { bbox, ring });
            }
        }
        if islands.is_empty() {
            None
        } else {
            Some(LandMask { islands })
        }
    }

    /// Even-odd point-in-polygon over all islands, bbox-prefiltered.
    pub fn on_land(&self, lat_deg: f64, lon_deg: f64) -> bool {
        for isl in &self.islands {
            if lon_deg < isl.bbox[0]
                || lat_deg < isl.bbox[1]
                || lon_deg > isl.bbox[2]
                || lat_deg > isl.bbox[3]
            {
                continue;
            }
            let mut inside = false;
            let ring = &isl.ring;
            let mut j = ring.len() - 1;
            for i in 0..ring.len() {
                let (xi, yi) = (ring[i][0], ring[i][1]);
                let (xj, yj) = (ring[j][0], ring[j][1]);
                if (yi > lat_deg) != (yj > lat_deg)
                    && lon_deg < (xj - xi) * (lat_deg - yi) / (yj - yi) + xi
                {
                    inside = !inside;
                }
                j = i;
            }
            if inside {
                return true;
            }
        }
        false
    }
}

impl LandMask {
    /// Nearest water to a point (meridian `nearestWater` pattern): if the
    /// point is already water, return it; otherwise spiral outward in rings
    /// of 16 bearings until a water point is found or `max_m` is exhausted.
    /// Guarantees a teleport onto the island can't strand the boat where the
    /// grounding freeze blocks every direction.
    pub fn nearest_water(&self, lat_deg: f64, lon_deg: f64, max_m: f64) -> Option<(f64, f64)> {
        if !self.on_land(lat_deg, lon_deg) {
            return Some((lat_deg, lon_deg));
        }
        const R: f64 = 6_371_000.0;
        let m_per_deg_lat = R * std::f64::consts::PI / 180.0;
        let m_per_deg_lon = m_per_deg_lat * lat_deg.to_radians().cos();
        let mut radius = 50.0;
        while radius <= max_m {
            for k in 0..16 {
                let brg = (k as f64) * std::f64::consts::TAU / 16.0;
                let lat = lat_deg + radius * brg.cos() / m_per_deg_lat;
                let lon = lon_deg + radius * brg.sin() / m_per_deg_lon;
                if !self.on_land(lat, lon) {
                    return Some((lat, lon));
                }
            }
            // Coarser steps far out — this is a rescue, not a survey.
            radius += if radius < 500.0 { 50.0 } else { 250.0 };
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask() -> Option<LandMask> {
        LandMask::load()
    }

    #[test]
    fn grenada_interior_is_land_and_anchorages_are_water() {
        let Some(m) = mask() else {
            eprintln!("world data not present; skipping");
            return;
        };
        // Grand Etang, island interior.
        assert!(m.on_land(12.095, -61.693), "island interior must be land");
        // Prickly Bay spawn anchorage (verified 142 m off the nearest shore).
        assert!(!m.on_land(12.0010, -61.7640), "spawn anchorage must be water");
        // Open sea, 10 nm south.
        assert!(!m.on_land(11.82, -61.75), "open sea must be water");
        // Carriacou interior (in-bbox northern island).
        assert!(m.on_land(12.48, -61.455), "Carriacou interior must be land");
    }

    #[test]
    fn nearest_water_rescues_inland_teleports() {
        let Some(m) = mask() else {
            eprintln!("world data not present; skipping");
            return;
        };
        // Water point passes through unchanged.
        let (lat, lon) = m.nearest_water(12.0010, -61.7640, 8000.0).unwrap();
        assert!((lat - 12.0010).abs() < 1e-9 && (lon + 61.7640).abs() < 1e-9);
        // Grand Etang — deep in the island interior — must resolve to water.
        let (lat, lon) = m
            .nearest_water(12.095, -61.693, 10_000.0)
            .expect("interior point should find water within 10 km");
        assert!(!m.on_land(lat, lon), "rescued point must be water");
    }
}
