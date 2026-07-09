use anyhow::{Result, anyhow};

use crate::core::LatLon;
use crate::route::isochrone::IsochroneRequest;

/// Land / depth filters are not implemented yet. Callers must not enable them
/// (see [`validate_route_constraint_flags`]); this predicate only runs after
/// validation and currently accepts all edges.
pub fn route_constraints_ok(_from: LatLon, _to: LatLon, _req: &IsochroneRequest) -> bool {
    // Design: avoid_land / min_depth_m are accepted on IsochroneRequest but
    // unimplemented. We refuse such requests at validation time rather than
    // silently ignoring them (safety) — see plan §4.7.
    true
}

/// Reject requests that enable unimplemented safety constraints.
pub fn validate_route_constraint_flags(req: &IsochroneRequest) -> Result<()> {
    // Design: avoid_land / min_depth_m are accepted but unimplemented — return
    // an error rather than silently ignoring (safety). See plan §4.7.
    if req.avoid_land {
        return Err(anyhow!(
            "avoid_land is not implemented; refuse rather than silently ignore (safety)"
        ));
    }
    if req.min_depth_m.is_some() {
        return Err(anyhow!(
            "min_depth_m is not implemented; refuse rather than silently ignore (safety)"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use crate::core::LatLon;

    fn base_req() -> IsochroneRequest {
        IsochroneRequest {
            origin: LatLon {
                lat_deg: 0.0,
                lon_deg: 0.0,
            },
            destination: LatLon {
                lat_deg: 1.0,
                lon_deg: 0.0,
            },
            depart_at: Utc::now(),
            boat_profile_id: "castoff-compatible".into(),
            step_s: 900,
            horizon_s: 3600,
            heading_resolution_deg: 10.0,
            max_frontier_points: 100,
            avoid_land: false,
            min_depth_m: None,
            comfort_weight: 0.2,
            safety_weight: 0.5,
        }
    }

    #[test]
    fn avoid_land_is_rejected() {
        let mut req = base_req();
        req.avoid_land = true;
        let err = validate_route_constraint_flags(&req).unwrap_err();
        assert!(
            err.to_string().contains("avoid_land"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn min_depth_is_rejected() {
        let mut req = base_req();
        req.min_depth_m = Some(5.0);
        let err = validate_route_constraint_flags(&req).unwrap_err();
        assert!(
            err.to_string().contains("min_depth_m"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn unconstrained_request_ok() {
        assert!(validate_route_constraint_flags(&base_req()).is_ok());
    }
}
