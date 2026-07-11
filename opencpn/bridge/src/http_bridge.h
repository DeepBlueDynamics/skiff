// Wx-free interface between the HTTP server TU (httplib) and the plugin TU
// (wxWidgets) — the two must never share headers (ssize_t redefinition war).
#pragma once
#include <functional>
#include <string>
#include <vector>

struct BridgeWaypoint {
  double lat;
  double lon;
  std::string name;  // empty = auto
};

// Every handler returns a JSON string (already composed by the plugin side).
struct BridgeHandlers {
  std::function<std::string()> ownship;
  std::function<std::string(double lat, double lon, double ppm)> jump;
  std::function<std::string()> routes;
  std::function<std::string(std::string name, std::vector<BridgeWaypoint>, bool permanent)> add_route;
  std::function<std::string(std::string guid)> del_route;
  // Route following: plugin-side sequencing + APB/RMB emission to SignalK.
  std::function<std::string(std::string guid, double radius_m, std::string nmea_host, int nmea_port,
                            int start_leg)>
      activate_route;
  std::function<std::string()> deactivate_route;
  std::function<std::string()> active_status;
};

void bridge_start(int port, BridgeHandlers handlers);
void bridge_stop();

// Fire-and-forget UDP datagram (winsock lives in this TU, not the wx one).
void bridge_udp_send(const std::string &host, int port, const std::string &payload);
