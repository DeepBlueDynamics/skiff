pub mod castoff;
pub mod leeway;
pub mod polar;
pub mod profile;
pub mod wave_penalty;

pub use castoff::{CastOffProfile, WindCourse, classify_course};
pub use leeway::LeewayModel;
pub use polar::PolarProfile;
pub use profile::{BoatInput, BoatOutput, BoatProfile};
pub use wave_penalty::{WavePenaltyModel, wave_speed_factor};
