// HTTP server TU: httplib + nlohmann only. NO wx headers here (ssize_t war).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "httplib.h"
#include "json.hpp"
#include "http_bridge.h"

#include <memory>
#include <thread>

using json = nlohmann::json;

static std::unique_ptr<httplib::Server> g_server;
static std::thread g_thread;

// 96 dpi screen: pixels per meter of physical screen, for chart_scale -> ppm.
static const double SCREEN_PPM = 3779.5;

void bridge_start(int port, BridgeHandlers h) {
  g_server = std::make_unique<httplib::Server>();
  auto &svr = *g_server;

  svr.Get("/ping", [](const httplib::Request &, httplib::Response &res) {
    res.set_content(
        json{{"plugin", "ocpn_bridge_pi"}, {"version", "0.1"}, {"api", 118}}.dump(),
        "application/json");
  });

  svr.Get("/ownship", [h](const httplib::Request &, httplib::Response &res) {
    res.set_content(h.ownship(), "application/json");
  });

  svr.Post("/view/jump", [h](const httplib::Request &req, httplib::Response &res) {
    json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded() || !body.contains("lat") || !body.contains("lon")) {
      res.status = 400;
      res.set_content("{\"error\":\"need lat, lon (optional chart_scale)\"}",
                      "application/json");
      return;
    }
    double chart_scale = body.value("chart_scale", 50000.0);
    res.set_content(h.jump(body["lat"], body["lon"], SCREEN_PPM / chart_scale),
                    "application/json");
  });

  svr.Get("/routes", [h](const httplib::Request &, httplib::Response &res) {
    res.set_content(h.routes(), "application/json");
  });

  svr.Post("/route", [h](const httplib::Request &req, httplib::Response &res) {
    json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded() || !body.contains("waypoints") ||
        !body["waypoints"].is_array() || body["waypoints"].size() < 2) {
      res.status = 400;
      res.set_content("{\"error\":\"need waypoints array (>=2 of {lat,lon})\"}",
                      "application/json");
      return;
    }
    std::vector<BridgeWaypoint> wps;
    for (auto &w : body["waypoints"]) {
      if (!w.contains("lat") || !w.contains("lon")) {
        res.status = 400;
        res.set_content("{\"error\":\"each waypoint needs lat and lon\"}",
                        "application/json");
        return;
      }
      wps.push_back({w["lat"], w["lon"], w.value("name", "")});
    }
    res.set_content(h.add_route(body.value("name", "agent-route"), std::move(wps),
                                body.value("permanent", true)),
                    "application/json");
  });

  svr.Delete("/route", [h](const httplib::Request &req, httplib::Response &res) {
    if (!req.has_param("guid")) {
      res.status = 400;
      res.set_content("{\"error\":\"need ?guid=...\"}", "application/json");
      return;
    }
    res.set_content(h.del_route(req.get_param_value("guid")), "application/json");
  });

  svr.Post("/route/activate", [h](const httplib::Request &req, httplib::Response &res) {
    json body = json::parse(req.body, nullptr, false);
    if (body.is_discarded() || !body.contains("guid")) {
      res.status = 400;
      res.set_content(
          "{\"error\":\"need guid (optional arrival_radius_m, nmea_target host:port)\"}",
          "application/json");
      return;
    }
    std::string target = body.value("nmea_target", "192.168.68.29:10111");
    std::string host = target;
    int port = 10111;
    auto colon = target.rfind(':');
    if (colon != std::string::npos) {
      host = target.substr(0, colon);
      port = std::atoi(target.c_str() + colon + 1);
    }
    res.set_content(h.activate_route(body["guid"], body.value("arrival_radius_m", 60.0),
                                     host, port, body.value("start_leg", 1)),
                    "application/json");
  });

  svr.Post("/route/deactivate", [h](const httplib::Request &, httplib::Response &res) {
    res.set_content(h.deactivate_route(), "application/json");
  });

  svr.Get("/route/active", [h](const httplib::Request &, httplib::Response &res) {
    res.set_content(h.active_status(), "application/json");
  });

  g_thread = std::thread([port]() { g_server->listen("127.0.0.1", port); });
}

void bridge_stop() {
  if (g_server) g_server->stop();
  if (g_thread.joinable()) g_thread.join();
  g_server.reset();
}

void bridge_udp_send(const std::string &host, int port, const std::string &payload) {
  // httplib already ran WSAStartup for this process.
  SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s == INVALID_SOCKET) return;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<unsigned short>(port));
  inet_pton(AF_INET, host.c_str(), &addr.sin_addr);
  sendto(s, payload.data(), static_cast<int>(payload.size()), 0,
         reinterpret_cast<sockaddr *>(&addr), sizeof(addr));
  closesocket(s);
}
