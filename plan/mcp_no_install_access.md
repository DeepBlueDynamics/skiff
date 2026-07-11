# Calling the MCP surface with zero install (for Goose)

Everything the `opencpn` MCP server exposes is a thin veneer over plain HTTP.
You don't need `claude mcp add`, Node, or the stdio server — curl works from
anywhere that can reach the endpoint. Three surfaces:

## 1. Skiff tools — MCP-over-HTTP on the Pi (you already use this)

`POST http://192.168.68.29:18081/mcp` — stateless streamable-HTTP, no session
handshake needed, one call per request:

```bash
curl -s -X POST http://192.168.68.29:18081/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_state","arguments":{}}}'
# tools: get_state set_control set_environment set_position reset set_course set_sail set_engines refuel
```

## 2. Vessel routing — SignalK v2 Course API on the Pi (LAN, no MCP at all)

This is what `set_destination` / `set_route` / `clear_course` do underneath.
Both OpenCPN's display and skiff's autopilot consume the result:

```bash
# single destination
curl -s -X PUT http://192.168.68.29:3000/signalk/v2/api/vessels/self/navigation/course/destination \
  -H "Content-Type: application/json" \
  -d '{"position":{"latitude":11.985,"longitude":-61.775}}'

# multi-waypoint: create a route resource, then activate it
curl -s -X POST http://192.168.68.29:3000/signalk/v2/api/resources/routes \
  -H "Content-Type: application/json" \
  -d '{"name":"my-route","feature":{"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[-61.770,11.990],[-61.780,11.980]]}}}'
# → returns {"id": "<uuid>"}; note coordinates are [lon, lat]
curl -s -X PUT http://192.168.68.29:3000/signalk/v2/api/vessels/self/navigation/course/activeRoute \
  -H "Content-Type: application/json" -d '{"href":"/resources/routes/<uuid>"}'

# clear (skiff releases to manual after its 15s staleness window)
curl -s -X DELETE http://192.168.68.29:3000/signalk/v2/api/vessels/self/navigation/course

# read back live guidance the server computes (bearing/XTE/DTG/ETA)
curl -s http://192.168.68.29:3000/signalk/v1/api/vessels/self/navigation/course/calcValues
```

## 3. OpenCPN chart control — bridge plugin on the WINDOWS box only

The in-process plugin (`ocpn_bridge_pi.dll`) listens on **127.0.0.1:18082 —
loopback only, by design**. It is reachable solely from shells running on
Kord's Windows machine (Git Bash / PowerShell panes are fine; a WSL2 or
container pane may not route to Windows loopback depending on networking
mode — test with the ping below).

```bash
curl -s http://127.0.0.1:18082/ping        # {"plugin":"ocpn_bridge_pi",...}
curl -s http://127.0.0.1:18082/ownship     # boat as OpenCPN sees it
curl -s -X POST http://127.0.0.1:18082/view/jump \
  -H "Content-Type: application/json" -d '{"lat":11.99,"lon":-61.76,"chart_scale":50000}'
curl -s -X POST http://127.0.0.1:18082/route \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","waypoints":[{"lat":11.90,"lon":-61.75},{"lat":11.99,"lon":-61.76}]}'
curl -s http://127.0.0.1:18082/routes
curl -s -X DELETE "http://127.0.0.1:18082/route?guid=<guid>"
```

If you can't reach loopback from your pane and need chart control, either
relay through me, or ask and I'll rebind the bridge to the LAN interface
(trivial change; it's loopback-only until Kord okays exposing it).

Requires OpenCPN running with the OCPNBridge plugin enabled (it autoloads on
start). Route *activation* is deliberately NOT here — use surface 2; both
OpenCPN and skiff follow it.
