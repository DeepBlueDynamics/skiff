use anyhow::{Result, anyhow};
use chrono::{DateTime, Duration, Utc};
use geojson::{Feature, FeatureCollection, GeoJson, Geometry, Value};
use crate::boat::{BoatInput, BoatProfile};
use crate::core::{
    LatLon, Vec2Mps, bearing_deg, distance_m, move_latlon, mps_to_knots, normalize_360,
};
use crate::env::{EnvBatchRequest, EnvQueryPoint, EnvironmentProvider, wind_over_water};
use serde::{Deserialize, Serialize};
use serde_json::{Map, json};

use crate::route::constraints::route_constraints_ok;
use crate::route::cost::score_node;
use crate::route::prune::prune_frontier;

#[derive(Debug, Clone, Deserialize)]
pub struct IsochroneRequest {
    pub origin: LatLon,
    pub destination: LatLon,
    pub depart_at: DateTime<Utc>,
    pub boat_profile_id: String,
    pub step_s: u32,
    pub horizon_s: u32,
    pub heading_resolution_deg: f64,
    pub max_frontier_points: usize,
    pub avoid_land: bool,
    pub min_depth_m: Option<f64>,
    pub comfort_weight: f64,
    pub safety_weight: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IsochroneProfile {
    pub boat_profile_id: String,
    pub depart_at: DateTime<Utc>,
    pub origin: LatLon,
    pub destination: LatLon,
    pub rings: Vec<IsochroneRing>,
    pub best_route: Option<Vec<RoutePoint>>,
    pub summary: IsochroneSummary,
}

#[derive(Debug, Clone, Serialize)]
pub struct IsochroneRing {
    pub elapsed_s: u32,
    pub points: Vec<ReachPoint>,
    pub envelope_geojson: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReachPoint {
    pub id: u64,
    pub parent_id: Option<u64>,
    pub at: DateTime<Utc>,
    pub pos: LatLon,
    pub heading_true_deg: f64,
    pub cog_true_deg: f64,
    pub stw_knots: f64,
    pub sog_knots: f64,
    pub tws_knots: f64,
    pub twa_deg: f64,
    pub current_set_deg: f64,
    pub current_drift_knots: f64,
    pub wave_height_m: Option<f64>,
    pub wave_period_s: Option<f64>,
    pub cost: f64,
    pub distance_to_dest_nm: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutePoint {
    pub at: DateTime<Utc>,
    pub pos: LatLon,
    pub heading_true_deg: f64,
    pub cog_true_deg: f64,
    pub sog_knots: f64,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IsochroneSummary {
    pub reached_destination: bool,
    pub eta: Option<DateTime<Utc>>,
    pub elapsed_s: Option<u32>,
    pub distance_nm: f64,
    pub min_sog_knots: f64,
    pub avg_sog_knots: f64,
    pub max_current_drift_knots: f64,
    pub worst_wave_height_m: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ReachNode {
    pub id: u64,
    pub parent_id: Option<u64>,
    pub at: DateTime<Utc>,
    pub pos: LatLon,
    pub heading_true_deg: f64,
    pub cog_true_deg: f64,
    pub stw_mps: f64,
    pub sog_mps: f64,
    pub twa_deg: f64,
    pub tws_mps: f64,
    pub current_ground_mps: Vec2Mps,
    pub wave_height_m: Option<f64>,
    pub wave_period_s: Option<f64>,
    pub cost: f64,
}

impl ReachNode {
    pub fn origin(id: u64, pos: LatLon, at: DateTime<Utc>) -> Self {
        Self {
            id,
            parent_id: None,
            at,
            pos,
            heading_true_deg: 0.0,
            cog_true_deg: 0.0,
            stw_mps: 0.0,
            sog_mps: 0.0,
            twa_deg: 0.0,
            tws_mps: 0.0,
            current_ground_mps: Vec2Mps::ZERO,
            wave_height_m: None,
            wave_period_s: None,
            cost: 0.0,
        }
    }
}

impl ReachPoint {
    pub fn from_node(node: &ReachNode, destination: LatLon) -> Self {
        Self {
            id: node.id,
            parent_id: node.parent_id,
            at: node.at,
            pos: node.pos,
            heading_true_deg: node.heading_true_deg,
            cog_true_deg: node.cog_true_deg,
            stw_knots: mps_to_knots(node.stw_mps),
            sog_knots: mps_to_knots(node.sog_mps),
            tws_knots: mps_to_knots(node.tws_mps),
            twa_deg: node.twa_deg,
            current_set_deg: node.current_ground_mps.to_deg(),
            current_drift_knots: mps_to_knots(node.current_ground_mps.magnitude()),
            wave_height_m: node.wave_height_m,
            wave_period_s: node.wave_period_s,
            cost: node.cost,
            distance_to_dest_nm: distance_m(node.pos, destination)
                / crate::core::units::METERS_PER_NAUTICAL_MILE,
        }
    }
}

pub async fn build_isochrone<P, E>(
    profile: &P,
    env: &E,
    req: IsochroneRequest,
) -> Result<IsochroneProfile>
where
    P: BoatProfile,
    E: EnvironmentProvider,
{
    validate_request(&req)?;

    let mut node_id = 1_u64;
    let mut frontier = vec![ReachNode::origin(node_id, req.origin, req.depart_at)];
    let mut all_nodes = frontier.clone();
    let mut rings = Vec::new();
    let mut destination_hit: Option<ReachNode> = None;

    let steps = req.horizon_s / req.step_s;
    for step_idx in 1..=steps {
        let query = EnvBatchRequest {
            points: frontier
                .iter()
                .map(|n| EnvQueryPoint {
                    at: n.at,
                    pos: n.pos,
                })
                .collect(),
        };

        let env_samples = env.sample_many(query).await?;
        let mut candidates = Vec::new();

        for (node, met) in frontier.iter().zip(env_samples.iter()) {
            for heading in heading_fan(node.pos, req.destination, req.heading_resolution_deg) {
                let out = profile.predict(BoatInput {
                    heading_true_deg: heading,
                    wind_water_mps: wind_over_water(met),
                    current_ground_mps: met.current_ground_mps,
                    wave_height_m: met.wave_height_m,
                    wave_period_s: met.wave_period_s,
                    wave_to_deg: met.wave_to_deg,
                    reef: 0.0,
                    sail_trim: 1.0,
                });

                let next_pos = move_latlon(node.pos, out.over_ground_mps, req.step_s as f64);
                if !route_constraints_ok(node.pos, next_pos, &req) {
                    continue;
                }

                node_id += 1;
                candidates.push(ReachNode {
                    id: node_id,
                    parent_id: Some(node.id),
                    at: node.at + Duration::seconds(req.step_s as i64),
                    pos: next_pos,
                    heading_true_deg: heading,
                    cog_true_deg: out.cog_true_deg,
                    stw_mps: out.stw_mps,
                    sog_mps: out.sog_mps,
                    twa_deg: out.twa_deg,
                    tws_mps: out.tws_mps,
                    current_ground_mps: met.current_ground_mps,
                    wave_height_m: met.wave_height_m,
                    wave_period_s: met.wave_period_s,
                    cost: score_node(next_pos, req.destination, &out, met, &req),
                });
            }
        }

        let pruned = prune_frontier(candidates, req.destination, req.max_frontier_points);
        if pruned.is_empty() {
            break;
        }

        if destination_hit.is_none() {
            destination_hit = find_destination_hit(&pruned, req.destination);
        }

        all_nodes.extend(pruned.iter().cloned());
        rings.push(IsochroneRing {
            elapsed_s: step_idx * req.step_s,
            points: pruned
                .iter()
                .map(|node| ReachPoint::from_node(node, req.destination))
                .collect(),
            envelope_geojson: Some(build_envelope_geojson(&pruned)?),
        });

        if destination_hit.is_some() {
            break;
        }
        frontier = pruned;
    }

    Ok(make_profile(req, rings, all_nodes, destination_hit))
}

pub fn heading_fan(pos: LatLon, destination: LatLon, resolution_deg: f64) -> Vec<f64> {
    let center = bearing_deg(pos, destination);
    let resolution = resolution_deg.max(1.0);
    let mut headings = Vec::new();
    let mut offset = -180.0;
    while offset < 180.0 {
        headings.push(normalize_360(center + offset));
        offset += resolution;
    }
    headings
}

fn validate_request(req: &IsochroneRequest) -> Result<()> {
    if req.step_s == 0 || req.horizon_s == 0 {
        return Err(anyhow!("step_s and horizon_s must be positive"));
    }
    if req.heading_resolution_deg <= 0.0 {
        return Err(anyhow!("heading_resolution_deg must be positive"));
    }
    if req.max_frontier_points == 0 {
        return Err(anyhow!("max_frontier_points must be positive"));
    }
    Ok(())
}

fn find_destination_hit(nodes: &[ReachNode], destination: LatLon) -> Option<ReachNode> {
    nodes
        .iter()
        .find(|node| {
            distance_m(node.pos, destination) <= crate::core::units::METERS_PER_NAUTICAL_MILE
        })
        .cloned()
}

fn build_envelope_geojson(nodes: &[ReachNode]) -> Result<serde_json::Value> {
    let coordinates = nodes
        .iter()
        .map(|node| vec![node.pos.lon_deg, node.pos.lat_deg])
        .collect::<Vec<_>>();
    let feature = Feature {
        bbox: None,
        geometry: Some(Geometry::new(Value::MultiPoint(coordinates))),
        id: None,
        properties: Some(Map::from_iter([("kind".to_string(), json!("isochrone"))])),
        foreign_members: None,
    };
    let collection = FeatureCollection {
        bbox: None,
        features: vec![feature],
        foreign_members: None,
    };
    Ok(serde_json::to_value(GeoJson::from(collection))?)
}

fn make_profile(
    req: IsochroneRequest,
    rings: Vec<IsochroneRing>,
    all_nodes: Vec<ReachNode>,
    destination_hit: Option<ReachNode>,
) -> IsochroneProfile {
    let speeds = all_nodes
        .iter()
        .filter(|n| n.sog_mps > 0.0)
        .map(|n| mps_to_knots(n.sog_mps))
        .collect::<Vec<_>>();
    let avg_sog_knots = if speeds.is_empty() {
        0.0
    } else {
        speeds.iter().sum::<f64>() / speeds.len() as f64
    };
    let min_sog_knots = speeds.iter().copied().reduce(f64::min).unwrap_or(0.0);
    let max_current_drift_knots = all_nodes
        .iter()
        .map(|n| mps_to_knots(n.current_ground_mps.magnitude()))
        .reduce(f64::max)
        .unwrap_or(0.0);
    let worst_wave_height_m = all_nodes
        .iter()
        .filter_map(|n| n.wave_height_m)
        .reduce(f64::max);

    IsochroneProfile {
        boat_profile_id: req.boat_profile_id.clone(),
        depart_at: req.depart_at,
        origin: req.origin,
        destination: req.destination,
        best_route: destination_hit.as_ref().map(|hit| {
            vec![RoutePoint {
                at: hit.at,
                pos: hit.pos,
                heading_true_deg: hit.heading_true_deg,
                cog_true_deg: hit.cog_true_deg,
                sog_knots: mps_to_knots(hit.sog_mps),
                notes: vec!["destination reached".to_string()],
            }]
        }),
        summary: IsochroneSummary {
            reached_destination: destination_hit.is_some(),
            eta: destination_hit.as_ref().map(|hit| hit.at),
            elapsed_s: destination_hit
                .as_ref()
                .map(|hit| (hit.at - req.depart_at).num_seconds().max(0) as u32),
            distance_nm: distance_m(req.origin, req.destination)
                / crate::core::units::METERS_PER_NAUTICAL_MILE,
            min_sog_knots,
            avg_sog_knots,
            max_current_drift_knots,
            worst_wave_height_m,
        },
        rings,
    }
}
