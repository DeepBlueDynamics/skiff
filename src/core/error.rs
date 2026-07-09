use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq)]
pub enum SailingError {
    EmptyEnvironmentResponse,
    InvalidRequest(String),
}

impl Display for SailingError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyEnvironmentResponse => write!(f, "environment provider returned no samples"),
            Self::InvalidRequest(message) => write!(f, "invalid request: {message}"),
        }
    }
}

impl std::error::Error for SailingError {}
