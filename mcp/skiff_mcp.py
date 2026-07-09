# /// script
# dependencies = [
#   "fastmcp>=2,<3",
# ]
# ///

import os
import math
import time
import json
import urllib.request
import urllib.error
from fastmcp import FastMCP

# Create the FastMCP server
mcp = FastMCP("skiff")

def _http_request(path: str, method: str = "GET", payload: dict = None) -> dict:
    """
    Helper function to perform HTTP requests to the simulator backend using urllib.
    """
    base_url = os.environ.get("SKIFF_URL", "http://localhost:18081").rstrip("/")
    url = f"{base_url}{path}"
    headers = {}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5.0) as response:
            res_data = response.read().decode("utf-8")
            return json.loads(res_data) if res_data else {}
    except urllib.error.HTTPError as e:
        # HTTPError is a subclass of URLError — handle first so 4xx/5xx keep body + status.
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return {
            "error": f"HTTP {e.code} from simulator at {base_url}: {e.reason}",
            "status_code": e.code,
            "body": body,
        }
    except urllib.error.URLError as e:
        return {"error": f"Failed to reach simulator at {base_url}: {e.reason}"}
    except Exception as e:
        return {"error": f"HTTP request failed: {str(e)}"}

def _vec2_to_speed_dir(vec: dict) -> tuple[float, float]:
    """
    Converts a 2D velocity vector {"east": x, "north": y} to magnitude (speed) 
    and heading direction in degrees following the TO-convention (towards).
    """
    v = vec or {}
    east = v.get("east", 0.0)
    north = v.get("north", 0.0)
    speed = math.hypot(east, north)
    to_deg = math.degrees(math.atan2(east, north)) % 360
    return speed, to_deg

# --- Plain tool bodies (callable from other tools / scripts) ---

def _get_state() -> dict:
    return _http_request("/v1/sim/state")

def _get_summary() -> dict:
    state = _http_request("/v1/sim/state")
    if "error" in state:
        return state
    return {
        "stw_mps": state.get("stw_mps"),
        "sog_mps": state.get("sog_mps"),
        "heading_true_deg": state.get("heading_true_deg"),
        "cog_true_deg": state.get("cog_true_deg"),
        "awa_deg": state.get("awa_deg"),
        "aws_mps": state.get("aws_mps"),
        "twa_deg": state.get("twa_deg"),
        "tws_mps": state.get("tws_mps"),
        "heel_deg": state.get("heel_deg"),
        "pitch_deg": state.get("pitch_deg"),
        "leeway_deg": state.get("leeway_deg"),
        "stability_state": state.get("stability_state"),
        "control": state.get("control"),
        "pos": state.get("pos"),
    }

def _set_control(
    helm: float = None,
    sail_trim: float = None,
    reef: float = None,
    thrust_port: float = None,
    thrust_stbd: float = None,
) -> dict:
    state = _http_request("/v1/sim/state")
    if "error" in state:
        return state
    
    current_ctrl = state.get("control", {})
    payload = {
        "helm": helm if helm is not None else current_ctrl.get("helm", 0.0),
        "sail_trim": sail_trim if sail_trim is not None else current_ctrl.get("sail_trim", 0.76),
        "reef": reef if reef is not None else current_ctrl.get("reef", 0.0),
        "thrust_port": thrust_port if thrust_port is not None else current_ctrl.get("thrust_port", 0.0),
        "thrust_stbd": thrust_stbd if thrust_stbd is not None else current_ctrl.get("thrust_stbd", 0.0),
    }
    return _http_request("/v1/sim/control", method="POST", payload=payload)

def _set_environment(
    wind_speed_mps: float = None,
    wind_to_deg: float = None,
    current_speed_mps: float = None,
    current_to_deg: float = None,
    wave_height_m: float = None,
    wave_period_s: float = None,
    wave_to_deg: float = None,
) -> dict:
    state = _http_request("/v1/sim/state")
    if "error" in state:
        return state

    env = state.get("env", {})
    wind_speed, wind_deg = _vec2_to_speed_dir(env.get("wind_ground_mps", {}))
    current_speed, current_deg = _vec2_to_speed_dir(env.get("current_ground_mps", {}))
    
    payload = {
        "wind_speed_mps": wind_speed_mps if wind_speed_mps is not None else wind_speed,
        "wind_to_deg": wind_to_deg if wind_to_deg is not None else wind_deg,
        "current_speed_mps": current_speed_mps if current_speed_mps is not None else current_speed,
        "current_to_deg": current_to_deg if current_to_deg is not None else current_deg,
        "wave_height_m": wave_height_m if wave_height_m is not None else env.get("wave_height_m"),
        "wave_period_s": wave_period_s if wave_period_s is not None else env.get("wave_period_s"),
        "wave_to_deg": wave_to_deg if wave_to_deg is not None else env.get("wave_to_deg"),
    }
    return _http_request("/v1/sim/environment", method="POST", payload=payload)

def _set_position(lat_deg: float, lon_deg: float) -> dict:
    payload = {
        "lat_deg": lat_deg,
        "lon_deg": lon_deg
    }
    return _http_request("/v1/sim/position", method="POST", payload=payload)

def _reset(heading_true_deg: float = None) -> dict:
    payload = {}
    if heading_true_deg is not None:
        payload["heading_true_deg"] = heading_true_deg
    return _http_request("/v1/sim/reset", method="POST", payload=payload)

def _sample(duration_s: float, interval_s: float = 1.0) -> dict:
    duration_s = max(0.0, min(120.0, duration_s))
    # Cap interval so sampling cannot stretch beyond the requested duration.
    interval_s = max(0.2, min(interval_s, duration_s if duration_s > 0 else 0.2))
    
    samples = []
    start_time = time.time()
    elapsed = 0.0
    
    while elapsed <= duration_s:
        summary = _get_summary()
        if "error" in summary:
            return {"samples": samples, "error": summary["error"]}
        
        summary["sample_timestamp_s"] = round(elapsed, 3)
        samples.append(summary)
        
        remaining = duration_s - (time.time() - start_time)
        if remaining <= 0:
            break

        next_checkpoint = start_time + len(samples) * interval_s
        sleep_time = next_checkpoint - time.time()
        if sleep_time > 0:
            time.sleep(min(sleep_time, remaining))
            
        elapsed = time.time() - start_time
        
    return {"samples": samples}

# --- FastMCP thin wrappers ---

@mcp.tool()
def get_state() -> dict:
    """
    Get the full telemetry and simulator state of the skiff catamaran.

    Returns:
        dict: The complete FullSimState JSON structure, or a dict containing an 'error' key if unreachable.
    """
    return _get_state()

@mcp.tool()
def get_summary() -> dict:
    """
    Get a trimmed summary of key sailing telemetry and control variables.

    Returns:
        dict: A dictionary containing:
            - stw_mps (float): Speed Through Water (boat speed relative to water, m/s).
            - sog_mps (float): Speed Over Ground (boat speed relative to ground, m/s).
            - heading_true_deg (float): True heading direction of the boat (degrees, 0=N, 90=E).
            - cog_true_deg (float): Course Over Ground (movement direction relative to ground, degrees).
            - awa_deg (float): Apparent Wind Angle relative to the bow (degrees, positive starboard, negative port).
            - aws_mps (float): Apparent Wind Speed (m/s).
            - twa_deg (float): True Wind Angle over water (degrees).
            - tws_mps (float): True Wind Speed over water (m/s).
            - heel_deg (float): Heel (roll) angle of the boat (degrees, positive port-down/stbd-up).
            - pitch_deg (float): Pitch angle of the boat (degrees).
            - leeway_deg (float): Leeway drift angle (degrees).
            - stability_state (str): Stability status ('upright', 'knockdown', or 'capsized').
            - control (dict): Current active control settings (helm, sail_trim, reef, engine thrust).
            - pos (dict): Geographic coordinates (lat_deg, lon_deg).
    """
    return _get_summary()

@mcp.tool()
def set_control(
    helm: float = None,
    sail_trim: float = None,
    reef: float = None,
    thrust_port: float = None,
    thrust_stbd: float = None,
) -> dict:
    """
    Perform a partial update on the simulator control settings.

    Reads the current state, overrides only the specified fields, and posts the updated controls.

    Args:
        helm (float, optional): Rudder control from -1.0 (hard port) to 1.0 (hard starboard).
        sail_trim (float, optional): Mainsail trim sheet extension from 0.0 (fully sheeted in) to 1.0 (fully eased out).
        reef (float, optional): Reefing fraction of the mainsail from 0.0 (full sail area) to 1.0 (fully reefed).
        thrust_port (float, optional): Port engine propeller thrust in Newtons (range: -3000 to +3000 N).
        thrust_stbd (float, optional): Starboard engine propeller thrust in Newtons (range: -3000 to +3000 N).

    Returns:
        dict: The updated state JSON, or a dict containing an 'error' key if unreachable.
    """
    return _set_control(helm, sail_trim, reef, thrust_port, thrust_stbd)

@mcp.tool()
def set_environment(
    wind_speed_mps: float = None,
    wind_to_deg: float = None,
    current_speed_mps: float = None,
    current_to_deg: float = None,
    wave_height_m: float = None,
    wave_period_s: float = None,
    wave_to_deg: float = None,
) -> dict:
    """
    Perform a partial update on the metocean environmental parameters.

    All directions follow the TO-convention (true degrees towards which wind/current/waves travel).
    This function reads the current state, decodes the ground wind/current velocity vectors back to
    speed and direction, merges the provided settings, and posts the updated environment.

    Args:
        wind_speed_mps (float, optional): Ground wind speed in meters per second.
        wind_to_deg (float, optional): Direction the ground wind blows TOWARDS in true degrees.
        current_speed_mps (float, optional): Current flow speed in meters per second.
        current_to_deg (float, optional): Direction the current flows TOWARDS in true degrees.
        wave_height_m (float, optional): Significant wave height in meters.
        wave_period_s (float, optional): Wave period in seconds.
        wave_to_deg (float, optional): Direction waves travel TOWARDS in true degrees.

    Returns:
        dict: The updated state JSON, or a dict containing an 'error' key if unreachable.
    """
    return _set_environment(
        wind_speed_mps,
        wind_to_deg,
        current_speed_mps,
        current_to_deg,
        wave_height_m,
        wave_period_s,
        wave_to_deg,
    )

@mcp.tool()
def set_position(lat_deg: float, lon_deg: float) -> dict:
    """
    Teleport the boat to the specified geographic coordinate (lat/lon).

    This clears the boat's trail history and resets the local XY position to (0,0).

    Args:
        lat_deg (float): Latitude in decimal degrees.
        lon_deg (float): Longitude in decimal degrees.

    Returns:
        dict: The updated state JSON, or a dict containing an 'error' key if unreachable.
    """
    return _set_position(lat_deg, lon_deg)

@mcp.tool()
def reset(heading_true_deg: float = None) -> dict:
    """
    Reset the catamaran simulation state back to default initial values.

    Clears active sail wrenches and resets physics. Optionally aligns the boat true heading.

    Args:
        heading_true_deg (float, optional): If provided, aligns the boat's starting heading to this direction.

    Returns:
        dict: The updated state JSON, or a dict containing an 'error' key if unreachable.
    """
    return _reset(heading_true_deg)

@mcp.tool()
def sample(duration_s: float, interval_s: float = 1.0) -> dict:
    """
    Block and sample a series of state summaries over a specified duration.

    This function blocks and polls get_summary at the specified interval, collecting a chronological
    history. Excellent for scenario testing and tracing response dynamics.

    Args:
        duration_s (float): Duration in seconds to collect samples (clamped to a max of 120 seconds).
        interval_s (float, optional): Sampling interval in seconds (clamped to a min of 0.2 seconds).

    Returns:
        dict: A dictionary containing:
            - samples (list): A list of chronological summaries, each with an added "sample_timestamp_s" offset.
            - error (str, optional): If the simulation becomes unreachable during sampling.
    """
    return _sample(duration_s, interval_s)

if __name__ == "__main__":
    mcp.run()
