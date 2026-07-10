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
}
