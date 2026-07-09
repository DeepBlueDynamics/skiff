use std::collections::HashMap;

use crate::core::{LatLon, bearing_deg, distance_m};

use crate::route::isochrone::ReachNode;

pub fn prune_frontier(
    candidates: Vec<ReachNode>,
    destination: LatLon,
    max_points: usize,
) -> Vec<ReachNode> {
    let bucketed = prune_by_spatial_bucket(candidates, 0.05);
    let sector = prune_by_bearing_sector(bucketed, destination, 2.5);
    prune_by_cost(sector, max_points)
}

pub fn prune_by_spatial_bucket(candidates: Vec<ReachNode>, cell_deg: f64) -> Vec<ReachNode> {
    let mut buckets: HashMap<(i64, i64), ReachNode> = HashMap::new();
    for node in candidates {
        let key = (
            (node.pos.lat_deg / cell_deg).floor() as i64,
            (node.pos.lon_deg / cell_deg).floor() as i64,
        );
        match buckets.get(&key) {
            Some(existing) if existing.cost <= node.cost => {}
            _ => {
                buckets.insert(key, node);
            }
        }
    }
    buckets.into_values().collect()
}

pub fn prune_by_bearing_sector(
    candidates: Vec<ReachNode>,
    destination: LatLon,
    sector_deg: f64,
) -> Vec<ReachNode> {
    let mut sectors: HashMap<i64, ReachNode> = HashMap::new();
    for node in candidates {
        let sector = (bearing_deg(node.pos, destination) / sector_deg).floor() as i64;
        match sectors.get(&sector) {
            Some(existing) if dominates(existing, &node, destination) => {}
            _ => {
                sectors.insert(sector, node);
            }
        }
    }
    sectors.into_values().collect()
}

pub fn prune_by_cost(mut candidates: Vec<ReachNode>, max_points: usize) -> Vec<ReachNode> {
    candidates.sort_by(|a, b| a.cost.total_cmp(&b.cost));
    candidates.truncate(max_points.max(1));
    candidates
}

fn dominates(a: &ReachNode, b: &ReachNode, destination: LatLon) -> bool {
    a.cost <= b.cost && distance_m(a.pos, destination) <= distance_m(b.pos, destination)
}
