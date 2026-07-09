use crate::core::LatLon;

use crate::route::isochrone::IsochroneRequest;

pub fn route_constraints_ok(_from: LatLon, _to: LatLon, _req: &IsochroneRequest) -> bool {
    // Land/depth/exclusion data is intentionally pluggable. Until that data exists, this keeps
    // the router deterministic and does not pretend unknown water is safe or unsafe.
    true
}
