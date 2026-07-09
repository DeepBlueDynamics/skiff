import urllib.request
import json
import time
import os
import sys

SKIFF_PORT = os.environ.get("SKIFF_PORT", "18081")
API_URL = f"http://127.0.0.1:{SKIFF_PORT}/v1/sim/state"

def clear_screen():
    # ANSI escape sequence to clear screen and home cursor
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()

def format_status(state):
    stability = state.get("stability_state", "upright").upper()
    if stability == "CAPSIZED":
        return "\033[1;31m[CRITICAL: WOULD FLIP]\033[0m"
    elif stability == "KNOCKDOWN":
        return "\033[1;33m[WARNING: WINDWARD HULL FLYING]\033[0m"
    return "\033[1;32m[NORMAL - UPRIGHT]\033[0m"

def format_slam(state):
    if state.get("slam_warning", False):
        return "\033[1;5;31m[BRIDGE DECK SLAM DETECTED!]\033[0m"
    return "\033[37m[OK]\033[0m"

def main():
    print(f"Connecting to sailing-api server at http://127.0.0.1:{SKIFF_PORT} ...")
    time.sleep(1)

    while True:
        try:
            req = urllib.request.Request(API_URL, method="GET")
            with urllib.request.urlopen(req, timeout=1.0) as response:
                data = json.loads(response.read().decode())
            
            clear_screen()
            
            # Print Dashboard
            print("=" * 60)
            print("       MERIDIAN CATAMARAN SIMULATOR TELEMETRY MONITOR")
            print("=" * 60)
            
            print(f" Elapsed Time : {data.get('elapsed_s', 0.0):.1f} s")
            print(f" Stability    : {format_status(data)}")
            print(f" Bridgedeck   : {format_slam(data)}")
            print("-" * 60)
            
            # Position & Motion
            gps = data.get("pos", {})
            local_pos = data.get("local_pos_m", {})
            print(" NAVIGATION & POSITION:")
            print(f"   GPS Lat/Lon  : {gps.get('lat_deg', 0.0):.5f}°, {gps.get('lon_deg', 0.0):.5f}°")
            print(f"   Local E/N (m): {local_pos.get('east', 0.0):.1f}m, {local_pos.get('north', 0.0):.1f}m")
            print(f"   Heading      : {data.get('heading_true_deg', 0.0):.1f}°")
            print(f"   COG / Leeway : {data.get('cog_true_deg', 0.0):.1f}° / {data.get('leeway_deg', 0.0):.1f}°")
            
            # Speeds
            mps_to_kt = 1.94384
            stw = data.get("stw_mps", 0.0) * mps_to_kt
            sog = data.get("sog_mps", 0.0) * mps_to_kt
            print(f"   Speed Thru W : {stw:.2f} kt")
            print(f"   Speed Over G : {sog:.2f} kt")
            print("-" * 60)
            
            # Catamaran attitude
            print(" HULL ATTITUDE:")
            print(f"   Heel (Roll)  : {data.get('heel_deg', 0.0):.2f}°")
            print(f"   Pitch        : {data.get('pitch_deg', 0.0):.2f}°")
            print(f"   Bobbing (Z)  : {data.get('bob_m', 0.0):.2f} m")
            print("-" * 60)
            
            # Engines & Control inputs
            ctrl = data.get("control", {})
            print(" PROPULSION & CONTROL:")
            print(f"   Helm Input   : {ctrl.get('helm', 0.0):.2f}")
            print(f"   Sail Trim    : {ctrl.get('sail_trim', 0.0):.2f} (Reef: {ctrl.get('reef', 0.0):.2f})")
            print(f"   Port Engine  : {ctrl.get('thrust_port', 0.0):.0f} N")
            print(f"   Stbd Engine  : {ctrl.get('thrust_stbd', 0.0):.0f} N")
            print("-" * 60)
            
            # MetOcean conditions
            env = data.get("env", {})
            wave_height = env.get("wave_height_m")
            wave_h_str = f"{wave_height:.2f} m" if wave_height is not None else "N/A"
            wave_period = env.get("wave_period_s")
            wave_p_str = f"{wave_period:.1f} s" if wave_period is not None else "N/A"
            print(" METOCEAN ENVIRONMENT:")
            print(f"   App. Wind    : {data.get('tws_mps', 0.0)*mps_to_kt:.1f} kt @ {data.get('twa_deg', 0.0):.1f}°")
            print(f"   Waves        : {wave_h_str} / {wave_p_str}")
            print("=" * 60)
            print(" Press Ctrl+C to exit monitoring.")
            
        except urllib.error.URLError as e:
            clear_screen()
            print("=" * 60)
            print(" MONITORING ERROR: Cannot connect to simulation server.")
            print("=" * 60)
            print(f" Make sure the sailing-api server is running on port {SKIFF_PORT}.")
            print(f" Details: {e}")
            print("\n Retrying in 2 seconds...")
            time.sleep(2)
        except KeyboardInterrupt:
            print("\nExiting monitor.")
            break
        
        time.sleep(0.2)

if __name__ == "__main__":
    main()
