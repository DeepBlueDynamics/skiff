use anyhow::Result;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SignalKDelta {
    pub context: String,
    pub updates: Vec<SignalKUpdate>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalKUpdate {
    pub source: SignalKSource,
    pub values: Vec<SignalKPathValue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalKSource {
    pub label: String,
    #[serde(rename = "type")]
    pub source_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalKPathValue {
    pub path: String,
    pub value: serde_json::Value,
}

pub struct SignalKClient {
    host: String,
    token: Option<String>,
    client: reqwest::Client,
}

impl SignalKClient {
    pub fn new(host: String, token: Option<String>) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            token,
            client: reqwest::Client::new(),
        }
    }

    pub async fn send_delta(&self, delta: &SignalKDelta) -> Result<()> {
        let mut headers = HeaderMap::new();
        if let Some(token) = &self.token {
            if !token.is_empty() {
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {token}"))?,
                );
            }
        }

        let url = format!("{}/signalk/v1/api/", self.host);
        tracing::debug!("Sending delta to Signal K: {}", url);
        let res = self
            .client
            .post(&url)
            .headers(headers)
            .json(delta)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            tracing::error!("Failed to send delta to Signal K ({status}): {body}");
        }
        Ok(())
    }
}
