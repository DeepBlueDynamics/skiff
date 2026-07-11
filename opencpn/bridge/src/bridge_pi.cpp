// ocpn_bridge_pi: in-process control bridge for OpenCPN.
// This TU owns wxWidgets + the plugin API; the HTTP server lives in
// http_bridge.cpp (httplib and wx must not share a translation unit).
// Consumed by opencpn-mcp/server.js; replaces keystroke injection.
#include <wx/wx.h>
#include <wx/listimpl.cpp>
#include "ocpn_plugin.h"
#include "json.hpp"
#include "http_bridge.h"

// The API header only declares these wx list types; each plugin instantiates them.
WX_DEFINE_LIST(Plugin_WaypointList);
WX_DEFINE_LIST(Plugin_WaypointExList);

#include <algorithm>
#include <chrono>
#include <cmath>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <vector>

using json = nlohmann::json;

static const int BRIDGE_PORT = 18082;

// ---------- great-circle helpers + NMEA composition ----------

static const double DEG = 3.14159265358979323846 / 180.0;
static const double EARTH_R = 6371000.0;

static double haversine_m(double lat1, double lon1, double lat2, double lon2) {
  double dlat = (lat2 - lat1) * DEG, dlon = (lon2 - lon1) * DEG;
  double a = sin(dlat / 2) * sin(dlat / 2) +
             cos(lat1 * DEG) * cos(lat2 * DEG) * sin(dlon / 2) * sin(dlon / 2);
  return 2 * EARTH_R * asin(sqrt(a));
}

static double bearing_deg(double lat1, double lon1, double lat2, double lon2) {
  double y = sin((lon2 - lon1) * DEG) * cos(lat2 * DEG);
  double x = cos(lat1 * DEG) * sin(lat2 * DEG) -
             sin(lat1 * DEG) * cos(lat2 * DEG) * cos((lon2 - lon1) * DEG);
  double b = atan2(y, x) / DEG;
  return b < 0 ? b + 360.0 : b;
}

// Signed cross-track distance (m) of P from the leg A->B; + = right of track.
static double xte_m(double latA, double lonA, double latB, double lonB, double latP,
                    double lonP) {
  double d13 = haversine_m(latA, lonA, latP, lonP) / EARTH_R;
  double b13 = bearing_deg(latA, lonA, latP, lonP) * DEG;
  double b12 = bearing_deg(latA, lonA, latB, lonB) * DEG;
  return asin(sin(d13) * sin(b13 - b12)) * EARTH_R;
}

static std::string nmea(const std::string &body) {
  unsigned char c = 0;
  for (char ch : body) c ^= static_cast<unsigned char>(ch);
  char buf[8];
  snprintf(buf, sizeof(buf), "*%02X\r\n", c);
  return "$" + body + buf;
}

static std::string nmea_latlon(double lat, double lon) {
  char buf[64];
  double alat = fabs(lat), alon = fabs(lon);
  int latd = (int)alat, lond = (int)alon;
  snprintf(buf, sizeof(buf), "%02d%07.4f,%c,%03d%07.4f,%c", latd, (alat - latd) * 60.0,
           lat >= 0 ? 'N' : 'S', lond, (alon - lond) * 60.0, lon >= 0 ? 'E' : 'W');
  return buf;
}

static std::string sanitize_wp(std::string s) {
  for (auto &c : s)
    if (c == ',' || c == '*' || c == '$') c = '_';
  return s.empty() ? "WP" : s.substr(0, 10);
}

// Run fn on the wx main thread; wait up to 5s for its JSON result.
static std::string RunOnMain(std::function<std::string()> fn) {
  auto prom = std::make_shared<std::promise<std::string>>();
  auto fut = prom->get_future();
  wxTheApp->CallAfter([prom, fn]() {
    try {
      prom->set_value(fn());
    } catch (const std::exception &e) {
      prom->set_value(json{{"error", e.what()}}.dump());
    } catch (...) {
      prom->set_value("{\"error\":\"unknown exception on main thread\"}");
    }
  });
  if (fut.wait_for(std::chrono::seconds(5)) != std::future_status::ready)
    return "{\"error\":\"main-thread timeout\"}";
  return fut.get();
}

class BridgePlugin : public opencpn_plugin_118 {
public:
  explicit BridgePlugin(void *ppimgr) : opencpn_plugin_118(ppimgr) {}

  int Init(void) override {
    BridgeHandlers h;

    h.ownship = [this]() -> std::string {
      std::lock_guard<std::mutex> lk(m_fix_mutex);
      if (!m_have_fix) return "{\"error\":\"no position fix yet\"}";
      return json{{"lat", m_fix.Lat},
                  {"lon", m_fix.Lon},
                  {"sog", m_fix.Sog},
                  {"cog", m_fix.Cog},
                  {"hdt", m_fix.Hdt},
                  {"fix_time", (long long)m_fix.FixTime}}
          .dump();
    };

    h.jump = [](double lat, double lon, double ppm) {
      return RunOnMain([lat, lon, ppm]() {
        JumpToPosition(lat, lon, ppm);
        return json{{"jumped", {lat, lon}}}.dump();
      });
    };

    h.routes = []() {
      return RunOnMain([]() {
        json out = json::array();
        wxArrayString guids = GetRouteGUIDArray();
        for (size_t i = 0; i < guids.GetCount(); i++) {
          auto r = GetRoute_Plugin(guids[i]);
          out.push_back({{"guid", std::string(guids[i].mb_str())},
                         {"name", r ? std::string(r->m_NameString.mb_str()) : ""}});
        }
        return out.dump();
      });
    };

    h.add_route = [](std::string name, std::vector<BridgeWaypoint> wps, bool permanent) {
      return RunOnMain([name, wps, permanent]() {
        // Ownership contract (core ctor/dtor): the ctor allocates
        // pWaypointList; the dtor deletes it with DeleteContents(false) —
        // caller owns the waypoint DATA, core owns the LIST. Never replace,
        // delete, or null the list (a nulled list crashes the dtor).
        PlugIn_Route_Ex route;
        route.m_NameString = wxString(name.c_str(), wxConvUTF8);
        route.m_GUID = GetNewGUID();
        route.m_isActive = false;
        route.m_isVisible = true;
        int n = 0;
        for (const auto &w : wps) {
          wxString wname = w.name.empty()
                               ? wxString::Format("%s-%d", route.m_NameString, n + 1)
                               : wxString(w.name.c_str(), wxConvUTF8);
          auto *wp = new PlugIn_Waypoint_Ex(w.lat, w.lon, _T("circle"), wname,
                                            GetNewGUID());
          route.pWaypointList->Append(wp);
          n++;
        }
        bool ok = AddPlugInRouteEx(&route, permanent);
        for (auto node = route.pWaypointList->GetFirst(); node; node = node->GetNext())
          delete node->GetData();
        route.pWaypointList->Clear();
        if (!ok) return std::string("{\"error\":\"AddPlugInRouteEx failed\"}");
        return json{{"guid", std::string(route.m_GUID.mb_str())}, {"waypoints", n}}
            .dump();
      });
    };

    h.del_route = [](std::string guid) {
      return RunOnMain([guid]() {
        wxString g(guid.c_str(), wxConvUTF8);
        bool ok = DeletePlugInRoute(g);
        return json{{"deleted", ok}}.dump();
      });
    };

    h.activate_route = [this](std::string guid, double radius, std::string host, int port,
                              int start_leg) {
      return RunOnMain([this, guid, radius, host, port, start_leg]() {
        return StartFollow(guid, radius, host, port, start_leg);
      });
    };
    h.deactivate_route = [this]() {
      return RunOnMain([this]() { return StopFollow(false); });
    };
    h.active_status = [this]() {
      return RunOnMain([this]() { return FollowStatus(); });
    };

    bridge_start(BRIDGE_PORT, h);
    wxLogMessage("ocpn_bridge_pi: HTTP bridge listening on 127.0.0.1:%d", BRIDGE_PORT);
    return WANTS_NMEA_EVENTS;
  }

  bool DeInit(void) override {
    if (m_timer) m_timer->Stop();
    bridge_stop();
    return true;
  }

  int GetAPIVersionMajor() override { return 1; }
  int GetAPIVersionMinor() override { return 18; }
  int GetPlugInVersionMajor() override { return 0; }
  int GetPlugInVersionMinor() override { return 1; }

  wxString GetCommonName() override { return _T("OCPNBridge"); }
  wxString GetShortDescription() override {
    return _T("Localhost HTTP bridge for programmatic control");
  }
  wxString GetLongDescription() override {
    return _T("Exposes view and route control on 127.0.0.1:18082 for the ")
           _T("opencpn-mcp agent server. No remote access: localhost only.");
  }

  void SetPositionFixEx(PlugIn_Position_Fix_Ex &pfix) override {
    std::lock_guard<std::mutex> lk(m_fix_mutex);
    m_fix = pfix;
    m_have_fix = true;
  }

private:
  std::mutex m_fix_mutex;
  PlugIn_Position_Fix_Ex m_fix{};
  bool m_have_fix = false;

  // ---- route following (all state touched on the main thread only) ----
  struct LegPoint {
    double lat, lon;
    std::string name;
  };
  struct Follow {
    bool active = false;
    bool completed = false;
    std::string guid, name;
    std::vector<LegPoint> pts;
    size_t idx = 0;          // current target waypoint
    double prev_lat, prev_lon;  // leg start (for XTE)
    double radius_m = 60.0;
    std::string nmea_host;
    int nmea_port = 10111;
  } m_follow;
  wxEvtHandler m_timer_owner;
  std::unique_ptr<wxTimer> m_timer;

  std::string StartFollow(const std::string &guid, double radius_m,
                          const std::string &host, int port, int start_leg = 1) {
    wxString g(guid.c_str(), wxConvUTF8);
    auto r = GetRoute_Plugin(g);
    if (!r) return json{{"error", "route not found: " + guid}}.dump();
    Follow f;
    f.guid = guid;
    f.name = std::string(r->m_NameString.mb_str());
    for (auto node = r->pWaypointList->GetFirst(); node; node = node->GetNext()) {
      PlugIn_Waypoint *wp = node->GetData();
      f.pts.push_back({wp->m_lat, wp->m_lon, std::string(wp->m_MarkName.mb_str())});
    }
    if (f.pts.size() < 1) return json{{"error", "route has no waypoints"}}.dump();
    {
      std::lock_guard<std::mutex> lk(m_fix_mutex);
      if (!m_have_fix) return json{{"error", "no ownship fix yet"}}.dump();
      f.prev_lat = m_fix.Lat;
      f.prev_lon = m_fix.Lon;
    }
    f.radius_m = radius_m;
    f.nmea_host = host;
    f.nmea_port = port;
    if (start_leg > 1 && (size_t)start_leg <= f.pts.size()) {
      f.idx = start_leg - 1;
      f.prev_lat = f.pts[f.idx - 1].lat;  // leg starts at the prior waypoint
      f.prev_lon = f.pts[f.idx - 1].lon;
    }
    f.active = true;
    m_follow = f;
    if (!m_timer) {
      m_timer = std::make_unique<wxTimer>(&m_timer_owner);
      m_timer_owner.Bind(wxEVT_TIMER, [this](wxTimerEvent &) { FollowTick(); });
    }
    m_timer->Start(1000);
    FollowTick();  // first emission immediately
    return json{{"activated", f.name},
                {"guid", f.guid},
                {"waypoints", f.pts.size()},
                {"arrival_radius_m", f.radius_m},
                {"nmea_target", f.nmea_host + ":" + std::to_string(f.nmea_port)}}
        .dump();
  }

  std::string StopFollow(bool completed) {
    if (m_timer) m_timer->Stop();
    m_follow.active = false;
    m_follow.completed = completed;
    return json{{"deactivated", m_follow.guid}, {"completed", completed}}.dump();
  }

  std::string FollowStatus() {
    json j{{"active", m_follow.active}, {"completed", m_follow.completed}};
    if (m_follow.active || m_follow.completed) {
      j["guid"] = m_follow.guid;
      j["name"] = m_follow.name;
      j["leg"] = m_follow.idx + 1;
      j["legs_total"] = m_follow.pts.size();
      std::lock_guard<std::mutex> lk(m_fix_mutex);
      if (m_have_fix && m_follow.active && m_follow.idx < m_follow.pts.size()) {
        const auto &t = m_follow.pts[m_follow.idx];
        j["next_wp"] = t.name;
        j["dist_to_next_m"] = haversine_m(m_fix.Lat, m_fix.Lon, t.lat, t.lon);
        j["bearing_to_next"] = bearing_deg(m_fix.Lat, m_fix.Lon, t.lat, t.lon);
      }
    }
    return j.dump();
  }

  void FollowTick() {
    if (!m_follow.active) return;
    // Re-read the route each tick so GUI edits (dragged/added/deleted
    // waypoints) take effect live. NOTE: edits bypass any pre-activation
    // land check — the human editing the chart owns that risk.
    {
      wxString g(m_follow.guid.c_str(), wxConvUTF8);
      auto r = GetRoute_Plugin(g);
      if (r) {
        std::vector<LegPoint> pts;
        for (auto node = r->pWaypointList->GetFirst(); node; node = node->GetNext()) {
          PlugIn_Waypoint *wp = node->GetData();
          pts.push_back({wp->m_lat, wp->m_lon, std::string(wp->m_MarkName.mb_str())});
        }
        if (!pts.empty()) {
          if (m_follow.idx >= pts.size()) m_follow.idx = pts.size() - 1;
          m_follow.pts = std::move(pts);
        }
      } else {
        wxLogMessage("ocpn_bridge_pi: active route deleted; stopping follow");
        StopFollow(false);
        return;
      }
    }
    double lat, lon, sog, cog;
    {
      std::lock_guard<std::mutex> lk(m_fix_mutex);
      if (!m_have_fix) return;
      lat = m_fix.Lat;
      lon = m_fix.Lon;
      sog = m_fix.Sog;
      cog = m_fix.Cog;
    }
    // Arrival + advance (may skip several if circles overlap).
    while (m_follow.idx < m_follow.pts.size() &&
           haversine_m(lat, lon, m_follow.pts[m_follow.idx].lat,
                       m_follow.pts[m_follow.idx].lon) < m_follow.radius_m) {
      m_follow.prev_lat = m_follow.pts[m_follow.idx].lat;
      m_follow.prev_lon = m_follow.pts[m_follow.idx].lon;
      m_follow.idx++;
      wxLogMessage("ocpn_bridge_pi: advanced to leg %zu/%zu", m_follow.idx + 1,
                   m_follow.pts.size());
    }
    if (m_follow.idx >= m_follow.pts.size()) {
      wxLogMessage("ocpn_bridge_pi: route complete");
      StopFollow(true);
      return;
    }
    const auto &t = m_follow.pts[m_follow.idx];
    double dist = haversine_m(lat, lon, t.lat, t.lon);
    double brg = bearing_deg(lat, lon, t.lat, t.lon);
    double xte = xte_m(m_follow.prev_lat, m_follow.prev_lon, t.lat, t.lon, lat, lon);
    double xte_nm = fabs(xte) / 1852.0;
    char steer = xte > 0 ? 'L' : 'R';  // right of track -> steer left
    double vmg = sog * cos((cog - brg) * DEG);
    std::string from = sanitize_wp(m_follow.idx == 0 ? "START"
                                                     : m_follow.pts[m_follow.idx - 1].name);
    std::string to = sanitize_wp(t.name);
    char buf[256];
    snprintf(buf, sizeof(buf), "ECRMB,A,%.3f,%c,%s,%s,%s,%.2f,%.1f,%.1f,%c,A",
             std::min(xte_nm, 9.99), steer, from.c_str(), to.c_str(),
             nmea_latlon(t.lat, t.lon).c_str(), dist / 1852.0, brg, vmg,
             dist < m_follow.radius_m ? 'A' : 'V');
    std::string rmb = nmea(buf);
    snprintf(buf, sizeof(buf), "ECAPB,A,A,%.3f,%c,N,V,V,%.1f,T,%s,%.1f,T,%.1f,T,A",
             std::min(xte_nm, 9.99), steer, brg, to.c_str(), brg, brg);
    std::string apb = nmea(buf);
    snprintf(buf, sizeof(buf), "ECXTE,A,A,%.3f,%c,N,A", std::min(xte_nm, 9.99), steer);
    std::string xtes = nmea(buf);
    bridge_udp_send(m_follow.nmea_host, m_follow.nmea_port, rmb + apb + xtes);
  }
};

extern "C" DECL_EXP opencpn_plugin *create_pi(void *ppimgr) {
  return new BridgePlugin(ppimgr);
}

extern "C" DECL_EXP void destroy_pi(opencpn_plugin *p) { delete p; }
