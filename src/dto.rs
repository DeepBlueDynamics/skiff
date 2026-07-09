use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoatProfileSummary {
    pub id: String,
    pub kind: String,
}
