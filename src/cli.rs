use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use skiff::boat::{BoatInput, BoatProfile, CastOffProfile};
use skiff::core::{LatLon, Vec2Mps, knots_to_mps};
use skiff::env::{ConstantEnvironment, MetOcean, test_env};
use skiff::route::{IsochroneRequest, build_isochrone};
use skiff::sim::{BoatState, StepRequest, step_boat};

#[derive(Debug, Parser)]
#[command(name = "sailing")]
#[command(about = "Current-aware sailing simulator and isochrone router")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Route {
        #[arg(long)]
        origin: String,
        #[arg(long)]
        dest: String,
        #[arg(long)]
        depart: DateTime<Utc>,
        #[arg(long, default_value = "castoff-compatible")]
        profile: String,
        #[arg(long, default_value_t = 900)]
        step: u32,
        #[arg(long, default_value = "72h")]
        horizon: String,
        #[arg(long)]
        out: Option<String>,
    },
    ProfileTest {
        #[arg(long, default_value = "castoff-compatible")]
        profile: String,
        #[arg(long, default_value = "10kt")]
        wind: String,
        #[arg(long, default_value = "0kt@0")]
        current: String,
        #[arg(long)]
        waves: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Route {
            origin,
            dest,
            depart,
            profile,
            step,
            horizon,
            out,
        } => route(origin, dest, depart, profile, step, horizon, out).await,
        Command::ProfileTest {
            profile,
            wind,
            current,
            waves,
        } => profile_test(profile, wind, current, waves).await,
    }
}

async fn route(
    origin: String,
    dest: String,
    depart: DateTime<Utc>,
    profile: String,
    step: u32,
    horizon: String,
    out: Option<String>,
) -> Result<()> {
    let origin = parse_latlon(&origin)?;
    let destination = parse_latlon(&dest)?;
    let horizon_s = parse_duration_s(&horizon)?;
    let env = ConstantEnvironment {
        sample: MetOcean {
            wind_ground_mps: Vec2Mps::from_speed_to_deg(8.0, 90.0),
            ..test_env()
        },
    };
    let profile_model = CastOffProfile::default();
    let result = build_isochrone(
        &profile_model,
        &env,
        IsochroneRequest {
            origin,
            destination,
            depart_at: depart,
            boat_profile_id: profile,
            step_s: step,
            horizon_s,
            heading_resolution_deg: 10.0,
            max_frontier_points: 1000,
            avoid_land: false,
            min_depth_m: None,
            comfort_weight: 0.2,
            safety_weight: 0.5,
        },
    )
    .await?;

    let json = serde_json::to_string_pretty(&result)?;
    if let Some(out) = out {
        std::fs::write(out, json)?;
    } else {
        println!("{json}");
    }
    Ok(())
}

async fn profile_test(
    _profile: String,
    wind: String,
    current: String,
    waves: Option<String>,
) -> Result<()> {
    let wind_speed = parse_speed_knots(&wind)?;
    let current_vec = parse_current(&current)?;
    let (wave_height_m, wave_period_s, wave_to_deg) = parse_waves(waves.as_deref())?;
    let profile = CastOffProfile::default();
    let wind_ground_mps = Vec2Mps::from_speed_to_deg(knots_to_mps(wind_speed), 90.0);
    let out = profile.predict(BoatInput {
        heading_true_deg: 0.0,
        wind_water_mps: wind_ground_mps - current_vec,
        current_ground_mps: current_vec,
        wave_height_m,
        wave_period_s,
        wave_to_deg,
        reef: 0.0,
        sail_trim: 1.0,
    });

    println!("{}", serde_json::to_string_pretty(&out)?);

    let env = ConstantEnvironment {
        sample: MetOcean {
            wind_ground_mps,
            current_ground_mps: current_vec,
            wave_height_m,
            wave_period_s,
            wave_to_deg,
            ..test_env()
        },
    };
    let _ = step_boat(
        &profile,
        &env,
        StepRequest {
            state: BoatState {
                at: DateTime::<Utc>::UNIX_EPOCH,
                pos: LatLon {
                    lat_deg: 0.0,
                    lon_deg: 0.0,
                },
                heading_true_deg: 0.0,
                sog_mps: 0.0,
                cog_true_deg: 0.0,
            },
            dt_s: 60.0,
            commanded_heading_true_deg: 0.0,
            reef: 0.0,
            sail_trim: 1.0,
        },
    )
    .await?;

    Ok(())
}

fn parse_latlon(value: &str) -> Result<LatLon> {
    let (lat, lon) = value
        .split_once(',')
        .ok_or_else(|| anyhow!("expected lat,lon"))?;
    Ok(LatLon {
        lat_deg: lat.parse()?,
        lon_deg: lon.parse()?,
    })
}

fn parse_duration_s(value: &str) -> Result<u32> {
    if let Some(hours) = value.strip_suffix('h') {
        Ok(hours.parse::<u32>()? * 3600)
    } else {
        Ok(value.parse()?)
    }
}

fn parse_speed_knots(value: &str) -> Result<f64> {
    Ok(value.trim_end_matches("kt").parse()?)
}

fn parse_current(value: &str) -> Result<Vec2Mps> {
    let (speed, direction) = value
        .split_once('@')
        .ok_or_else(|| anyhow!("expected current like 1.5kt@120"))?;
    Ok(Vec2Mps::from_speed_to_deg(
        knots_to_mps(parse_speed_knots(speed)?),
        direction.parse()?,
    ))
}

type WaveArgs = (Option<f64>, Option<f64>, Option<f64>);

fn parse_waves(value: Option<&str>) -> Result<WaveArgs> {
    let Some(value) = value else {
        return Ok((None, None, None));
    };
    let mut parts = value.split(',');
    let height = parts
        .next()
        .map(|v| v.trim_end_matches('m').parse())
        .transpose()?;
    let period = parts
        .next()
        .map(|v| v.trim_end_matches('s').parse())
        .transpose()?;
    let direction = parts
        .next()
        .and_then(|v| v.split_once('@').map(|(_, d)| d))
        .map(str::parse)
        .transpose()?;
    Ok((height, period, direction))
}
