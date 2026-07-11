use anyhow::{Result, anyhow};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use crate::core::{LatLon, Vec2Mps};
use crate::core::units::knots_to_mps;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::env::field::{Field, current_set_drift_to_vector_mps, WavePoint};
use crate::env::metocean::MetOcean;

#[derive(Debug, Clone)]
pub struct EnvQueryPoint {
    pub at: DateTime<Utc>,
    pub pos: LatLon,
}

#[derive(Debug, Clone)]
pub struct EnvBatchRequest {
    pub points: Vec<EnvQueryPoint>,
}

#[async_trait]
pub trait EnvironmentProvider: Send + Sync {
    async fn sample_many(&self, req: EnvBatchRequest) -> Result<Vec<MetOcean>>;
}

#[derive(Debug, Clone, Default)]
pub struct RouteEnvironmentBundle {
    pub wind: Option<Field>,
    pub current: Option<Field>,
    pub waves: Option<Field>,
}

pub struct ConstantEnvironment {
    pub sample: MetOcean,
}

pub struct FieldCurrentProvider {
    pub base: MetOcean,
    pub bundle: RouteEnvironmentBundle,
}

#[async_trait]
impl EnvironmentProvider for FieldCurrentProvider {
    async fn sample_many(&self, req: EnvBatchRequest) -> Result<Vec<MetOcean>> {
        req.points
            .into_iter()
            .map(|p| {
                let current_ground_mps = match &self.bundle.current {
                    Some(field) => {
                        let current = field.interpolate_current(p.pos, p.at)?;
                        current_set_drift_to_vector_mps(current.speed_kn, current.set_true_deg)
                    }
                    None => self.base.current_ground_mps,
                };

                Ok(MetOcean {
                    at: p.at,
                    pos: p.pos,
                    current_ground_mps,
                    wind_ground_mps: self.base.wind_ground_mps,
                    wave_height_m: self.base.wave_height_m,
                    wave_period_s: self.base.wave_period_s,
                    wave_to_deg: self.base.wave_to_deg,
                    gust_mps: self.base.gust_mps,
                    pressure_pa: self.base.pressure_pa,
                    source_time: self.base.source_time,
                })
            })
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct HttpCurrentFieldClient {
    pub base_url: String,
    pub bearer_token: Option<String>,
    client: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct CurrentFieldRequest {
    pub bbox: [f64; 4],
    pub hours: u32,
    pub step_hours: u32,
    pub resolution: f64,
    pub source: Option<String>,
}

impl HttpCurrentFieldClient {
    pub fn new(base_url: impl Into<String>, bearer_token: Option<String>) -> Self {
        Self {
            base_url: base_url.into(),
            bearer_token,
            client: reqwest::Client::new(),
        }
    }

    pub async fn fetch_current_field(&self, req: &CurrentFieldRequest) -> Result<Field> {
        let mut headers = HeaderMap::new();
        if let Some(token) = &self.bearer_token {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
        }

        let url = format!("{}/ocean/current", self.base_url.trim_end_matches('/'));
        let response = self
            .client
            .get(url)
            .headers(headers)
            .query(&[
                ("bbox", bbox_param(req.bbox)),
                ("hours", req.hours.to_string()),
                ("step_hours", req.step_hours.to_string()),
                ("resolution", req.resolution.to_string()),
                (
                    "source",
                    req.source.clone().unwrap_or_else(|| "auto".to_string()),
                ),
            ])
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "current field request failed with {status}: {body}"
            ));
        }

        let field = response.json::<Field>().await?;
        field.validate_current()?;
        Ok(field)
    }
}

fn bbox_param(bbox: [f64; 4]) -> String {
    format!("{},{},{},{}", bbox[0], bbox[1], bbox[2], bbox[3])
}

#[async_trait]
impl EnvironmentProvider for ConstantEnvironment {
    async fn sample_many(&self, req: EnvBatchRequest) -> Result<Vec<MetOcean>> {
        Ok(req
            .points
            .into_iter()
            .map(|p| MetOcean {
                at: p.at,
                pos: p.pos,
                ..self.sample.clone()
            })
            .collect())
    }
}

pub struct FallbackEnvironmentProvider<P> {
    pub inner: P,
    pub fallback: MetOcean,
}

#[async_trait]
impl<P> EnvironmentProvider for FallbackEnvironmentProvider<P>
where
    P: EnvironmentProvider,
{
    async fn sample_many(&self, req: EnvBatchRequest) -> Result<Vec<MetOcean>> {
        let points = req.points.clone();
        match self.inner.sample_many(req).await {
            Ok(samples) if samples.len() == points.len() => Ok(samples),
            Ok(samples) if samples.is_empty() => Ok(fallback_samples(points, &self.fallback)),
            Ok(samples) => Err(anyhow!(
                "environment provider returned {} samples for {} query points",
                samples.len(),
                points.len()
            )),
            Err(_) => Ok(fallback_samples(points, &self.fallback)),
        }
    }
}

fn fallback_samples(points: Vec<EnvQueryPoint>, fallback: &MetOcean) -> Vec<MetOcean> {
    points
        .into_iter()
        .map(|p| MetOcean {
            at: p.at,
            pos: p.pos,
            ..fallback.clone()
        })
        .collect()
}

#[derive(Debug, Serialize)]
struct AuthRequest {
    client_id: String,
    client_secret: String,
}

#[derive(Debug, Deserialize)]
struct AuthResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
}

#[derive(Clone)]
pub struct NutsAuthClient {
    client_id: String,
    client_secret: String,
    auth_url: String,
    client: reqwest::Client,
    cached_token: Arc<Mutex<Option<(String, DateTime<Utc>)>>>,
}

impl NutsAuthClient {
    pub fn new(client_id: String, client_secret: String, auth_url: String) -> Self {
        Self {
            client_id,
            client_secret,
            auth_url,
            client: reqwest::Client::new(),
            cached_token: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn get_token(&self) -> anyhow::Result<String> {
        let mut cache = self.cached_token.lock().await;
        let now = Utc::now();
        if let Some((token, expiry)) = &*cache {
            if *expiry > now + Duration::seconds(30) {
                return Ok(token.clone());
            }
        }

        let res = self
            .client
            .post(&self.auth_url)
            .json(&AuthRequest {
                client_id: self.client_id.clone(),
                client_secret: self.client_secret.clone(),
            })
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("Nuts Auth token exchange failed ({status}): {body}"));
        }

        let auth_res = res.json::<AuthResponse>().await?;
        let token = auth_res.access_token;
        let expiry = now + Duration::seconds(auth_res.expires_in as i64);
        *cache = Some((token.clone(), expiry));
        Ok(token)
    }
}

pub struct HttpEnvironmentProvider {
    pub base_url: String,
    /// User JWT from the browser login flow (auth.nuts.services), pushed in
    /// via POST /v1/auth/token. Meridian validates it against its JWKS.
    /// None = unauthenticated; requests go out bare and protected endpoints
    /// will 401 (callers treat per-field failures as absent data).
    pub user_token: Arc<tokio::sync::RwLock<Option<String>>>,
    client: reqwest::Client,
}

impl HttpEnvironmentProvider {
    pub fn new(base_url: String, user_token: Arc<tokio::sync::RwLock<Option<String>>>) -> Self {
        Self {
            base_url,
            user_token,
            client: reqwest::Client::new(),
        }
    }

    async fn get_headers(&self) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        if let Some(token) = self.user_token.read().await.as_ref() {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
        }
        Ok(headers)
    }

    pub async fn fetch_field(&self, path: &str, bbox: [f64; 4], hours: u32) -> Result<Field> {
        let headers = self.get_headers().await?;
        let url = format!("{}/{}", self.base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let response = self
            .client
            .get(&url)
            .headers(headers)
            .query(&[
                ("bbox", bbox_param(bbox)),
                ("hours", hours.to_string()),
            ])
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Meridian field request to {path} failed ({status}): {body}"));
        }

        let field = response.json::<Field>().await?;
        Ok(field)
    }
}

#[async_trait]
impl EnvironmentProvider for HttpEnvironmentProvider {
    async fn sample_many(&self, req: EnvBatchRequest) -> Result<Vec<MetOcean>> {
        if req.points.is_empty() {
            return Ok(vec![]);
        }

        // Calculate bounding box containing all query points (with a padding of 0.1 degrees)
        let mut lat_min = f64::MAX;
        let mut lat_max = f64::MIN;
        let mut lon_min = f64::MAX;
        let mut lon_max = f64::MIN;
        for p in &req.points {
            if p.pos.lat_deg < lat_min { lat_min = p.pos.lat_deg; }
            if p.pos.lat_deg > lat_max { lat_max = p.pos.lat_deg; }
            if p.pos.lon_deg < lon_min { lon_min = p.pos.lon_deg; }
            if p.pos.lon_deg > lon_max { lon_max = p.pos.lon_deg; }
        }
        let bbox = [
            lon_min - 0.1,
            lat_min - 0.1,
            lon_max + 0.1,
            lat_max + 0.1,
        ];

        // Fetch fields concurrently
        let wind_fut = self.fetch_field("/weather/wind", bbox, 24);
        let current_fut = self.fetch_field("/ocean/current", bbox, 24);
        let waves_fut = self.fetch_field("/weather/wave", bbox, 24);

        let (wind_res, current_res, waves_res) = tokio::join!(wind_fut, current_fut, waves_fut);

        // Surface per-field failures instead of silently zeroing them — a failed
        // wind fetch (401/404/parse) is exactly why "live" reads 0 wind, and the
        // old code swallowed it via `.ok()` while the caller logged "success".
        if let Err(e) = &wind_res {
            tracing::warn!("Meridian wind fetch failed (wind will read 0): {e}");
        }
        if let Err(e) = &current_res {
            tracing::warn!("Meridian current fetch failed: {e}");
        }
        if let Err(e) = &waves_res {
            tracing::warn!("Meridian wave fetch failed: {e}");
        }

        let wind_field: Option<Field> = wind_res.ok();
        let current_field: Option<Field> = current_res.ok();
        let wave_field: Option<Field> = waves_res.ok();

        let mut results = Vec::new();
        for p in req.points {
            // Interpolate wind
            let wind_ground_mps = match &wind_field {
                Some(field) => match field.interpolate_wind(p.pos, p.at) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            "Meridian wind field has no value at {:.4},{:.4} ({e}) — reading 0",
                            p.pos.lat_deg,
                            p.pos.lon_deg
                        );
                        Vec2Mps::ZERO
                    }
                },
                None => Vec2Mps::ZERO,
            };

            // Interpolate current
            let current_ground_mps = match &current_field {
                Some(field) => {
                    let pt = field.interpolate_current(p.pos, p.at).unwrap_or(crate::env::field::CurrentPoint { speed_kn: 0.0, set_true_deg: 0.0 });
                    current_set_drift_to_vector_mps(pt.speed_kn, pt.set_true_deg)
                }
                None => Vec2Mps::ZERO,
            };

            // Interpolate waves
            let (wave_height_m, wave_period_s, wave_to_deg) = match &wave_field {
                Some(field) => {
                    match field.interpolate_wave(p.pos, p.at) {
                        Ok(w) => (Some(w.height_m), Some(w.period_s), Some(w.to_deg)),
                        Err(_) => (None, None, None),
                    }
                }
                None => (None, None, None),
            };

            results.push(MetOcean {
                at: p.at,
                pos: p.pos,
                wind_ground_mps,
                current_ground_mps,
                gust_mps: None,
                pressure_pa: None,
                wave_height_m,
                wave_period_s,
                wave_to_deg,
                source_time: Some(Utc::now()),
            });
        }

        Ok(results)
    }
}

