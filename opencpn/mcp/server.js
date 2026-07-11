#!/usr/bin/env node
// opencpn-mcp: a "fake plugin" for OpenCPN.
// Zero-dependency MCP stdio server that drives the running OpenCPN window by
// injecting the chart canvas's own keyboard shortcuts (verified against
// gui/src/chcanv.cpp: '+'/'-' zoom, arrows pan, F2 toggles own-ship follow),
// and grabs screenshots of the window so an agent can see the chart.
// Requires: Windows, OpenCPN running. Register with:
//   claude mcp add opencpn -- node <this file>

const { execFile } = require("child_process");
const { readFileSync, unlinkSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");

// ---------- PowerShell helpers ----------

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout.trim());
      }
    );
  });
}

// Bring OpenCPN to the foreground and send keystrokes (WScript SendKeys syntax).
function sendKeys(keys) {
  const script = `
$w = New-Object -ComObject WScript.Shell
if (-not $w.AppActivate('OpenCPN')) { Write-Error 'OpenCPN window not found (is it running?)'; exit 1 }
Start-Sleep -Milliseconds 200
$w.SendKeys('${keys.replace(/'/g, "''")}')
Start-Sleep -Milliseconds 100
Write-Output 'sent'`;
  return ps(script);
}

// Screenshot the OpenCPN window (activates it first; scales to <=1280px wide).
async function screenshotB64() {
  const out = join(tmpdir(), `opencpn-shot-${Date.now()}.png`);
  const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$w = New-Object -ComObject WScript.Shell
if (-not $w.AppActivate('OpenCPN')) { Write-Error 'OpenCPN window not found (is it running?)'; exit 1 }
Start-Sleep -Milliseconds 400
$p = Get-Process opencpn -ErrorAction Stop | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
Add-Type @'
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class Win32 { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); }
'@
$r = New-Object RECT
[Win32]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$wid = $r.R - $r.L; $hei = $r.B - $r.T
if ($wid -le 0 -or $hei -le 0) { Write-Error 'bad window rect'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($wid, $hei)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$g.Dispose()
if ($wid -gt 1280) {
  $nh = [int]($hei * 1280 / $wid)
  $small = New-Object System.Drawing.Bitmap($bmp, 1280, $nh)
  $bmp.Dispose(); $bmp = $small
}
$bmp.Save('${out.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'ok'`;
  await ps(script);
  const b64 = readFileSync(out).toString("base64");
  try { unlinkSync(out); } catch {}
  return b64;
}

// ---------- tools ----------

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

// ---------- SignalK v2 Course API (headless route control) ----------

const SIGNALK = process.env.SIGNALK_URL || "http://192.168.68.29:3000";
const SKIFF = process.env.SKIFF_URL || "http://192.168.68.29:18081";

async function sk(path, method = "GET", body) {
  const res = await fetch(SIGNALK + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

const validLatLon = (p) =>
  p && Number.isFinite(Number(p.lat)) && Math.abs(p.lat) <= 90 &&
  Number.isFinite(Number(p.lon)) && Math.abs(p.lon) <= 180;

// In-process OpenCPN bridge plugin (ocpn_bridge_pi.dll) on localhost.
const BRIDGE = process.env.OCPN_BRIDGE_URL || "http://127.0.0.1:18082";

async function bridgeCall(method, path, body) {
  let res;
  try {
    res = await fetch(BRIDGE + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new Error(
      `bridge unreachable (${e.message}) — is OpenCPN running with the OCPNBridge plugin enabled?`
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

const TOOLS = [
  {
    name: "zoom",
    description:
      "Zoom the OpenCPN chart. Positive steps zoom in, negative zoom out (each step is one '+'/'-' keypress, factor 2 by default in OpenCPN).",
    inputSchema: {
      type: "object",
      properties: {
        steps: { type: "integer", description: "-10..10; positive = in, negative = out" },
      },
      required: ["steps"],
    },
    run: async (a) => {
      const n = clampInt(a.steps, -10, 10, 1);
      if (n === 0) return "zoom 0 steps: nothing to do";
      const key = n > 0 ? "{+}" : "-";
      await sendKeys(key.repeat(Math.abs(n)));
      return `zoomed ${n > 0 ? "in" : "out"} ${Math.abs(n)} step(s)`;
    },
  },
  {
    name: "pan",
    description:
      "Pan the OpenCPN chart view with arrow-key presses. Direction is where the VIEW moves (north = view slides north / content moves down).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["north", "south", "east", "west"] },
        steps: { type: "integer", description: "1..50 arrow presses (default 5)" },
      },
      required: ["direction"],
    },
    run: async (a) => {
      const KEY = { north: "{UP}", south: "{DOWN}", east: "{RIGHT}", west: "{LEFT}" }[a.direction];
      if (!KEY) throw new Error(`bad direction: ${a.direction}`);
      const n = clampInt(a.steps, 1, 50, 5);
      await sendKeys(KEY.repeat(n));
      return `panned ${a.direction} ${n} step(s)`;
    },
  },
  {
    name: "follow",
    description:
      "Press F2: TOGGLES OpenCPN's auto-follow-own-ship mode. Take a screenshot to confirm which state it landed in.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      await sendKeys("{F2}");
      return "toggled follow mode (F2)";
    },
  },
  {
    name: "press_keys",
    description:
      "Escape hatch: send raw WScript SendKeys sequences to the OpenCPN window (e.g. '{F5}' day/dusk/night cycle, '{+}{+}'). Syntax: https://ss64.com/vb/sendkeys.html",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "string" } },
      required: ["keys"],
    },
    run: async (a) => {
      if (typeof a.keys !== "string" || !a.keys) throw new Error("keys required");
      await sendKeys(a.keys);
      return `sent: ${a.keys}`;
    },
  },
  {
    name: "screenshot",
    description: "Capture the OpenCPN window and return it as a PNG image.",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({
      content: [{ type: "image", data: await screenshotB64(), mimeType: "image/png" }],
    }),
  },
  {
    name: "click",
    description:
      "Click inside the OpenCPN window at fractional coordinates (0..1 of window width/height, origin top-left). button: 'left' (default) or 'right' (context menu). Use screenshot first to find the target. Screenshots may be scaled to 1280px wide; fractions are scale-independent.",
    inputSchema: {
      type: "object",
      properties: {
        fx: { type: "number", description: "0..1 fraction of window width" },
        fy: { type: "number", description: "0..1 fraction of window height" },
        button: { type: "string", enum: ["left", "right"], description: "default left" },
      },
      required: ["fx", "fy"],
    },
    run: async (a) => {
      const fx = Math.max(0, Math.min(1, Number(a.fx)));
      const fy = Math.max(0, Math.min(1, Number(a.fy)));
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) throw new Error("fx/fy must be numbers 0..1");
      const [down, up] = a.button === "right" ? [8, 16] : [2, 4];
      const script = `
$w = New-Object -ComObject WScript.Shell
if (-not $w.AppActivate('OpenCPN')) { Write-Error 'OpenCPN window not found'; exit 1 }
Start-Sleep -Milliseconds 250
$p = Get-Process opencpn -ErrorAction Stop | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
Add-Type @'
using System; using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
'@
$r = New-Object RECT
[W32]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$x = $r.L + [int](($r.R - $r.L) * ${fx})
$y = $r.T + [int](($r.B - $r.T) * ${fy})
[W32]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 120
[W32]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
[W32]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "clicked $x,$y"`;
      return await ps(script);
    },
  },
  {
    name: "jump_to",
    description:
      "Center the OpenCPN chart on a position at a chart scale (e.g. 50000 = 1:50k) via the in-process bridge plugin — deterministic, no focus stealing. Preferred over zoom/pan keystrokes.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        chart_scale: { type: "number", description: "1:X scale denominator, default 50000" },
      },
      required: ["lat", "lon"],
    },
    run: async (a) => bridgeCall("POST", "/view/jump", { lat: a.lat, lon: a.lon, chart_scale: a.chart_scale }),
  },
  {
    name: "ocpn_ownship",
    description: "Read ownship position/SOG/COG as OpenCPN sees it (from its SignalK feed), via the bridge plugin.",
    inputSchema: { type: "object", properties: {} },
    run: async () => bridgeCall("GET", "/ownship"),
  },
  {
    name: "ocpn_routes",
    description: "List routes in OpenCPN's route manager: [{guid, name}].",
    inputSchema: { type: "object", properties: {} },
    run: async () => bridgeCall("GET", "/routes"),
  },
  {
    name: "ocpn_create_route",
    description:
      "Create a route inside OpenCPN's own route manager (drawn on the chart, visible in Route & Mark Manager). Does NOT activate it — activation/guidance goes through set_destination/set_route (SignalK). permanent=false makes a temp route that vanishes on exit.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        permanent: { type: "boolean", description: "default true" },
        waypoints: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
              name: { type: "string" },
            },
            required: ["lat", "lon"],
          },
        },
      },
      required: ["waypoints"],
    },
    run: async (a) =>
      bridgeCall("POST", "/route", { name: a.name, waypoints: a.waypoints, permanent: a.permanent }),
  },
  {
    name: "ocpn_delete_route",
    description: "Delete a route from OpenCPN's route manager by GUID (see ocpn_routes).",
    inputSchema: {
      type: "object",
      properties: { guid: { type: "string" } },
      required: ["guid"],
    },
    run: async (a) => bridgeCall("DELETE", `/route?guid=${encodeURIComponent(a.guid)}`),
  },
  {
    name: "set_destination",
    description:
      "Set the vessel's active destination via the SignalK v2 Course API (headless — no OpenCPN GUI involved). SignalK computes live bearing/XTE/ETA and skiff's autopilot follows it. On-land targets: skiff snaps guidance, but prefer water.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        arrival_circle_m: { type: "number", description: "optional arrival radius, meters" },
      },
      required: ["lat", "lon"],
    },
    run: async (a) => {
      if (!validLatLon(a)) throw new Error("lat/lon out of range");
      await sk("/signalk/v2/api/vessels/self/navigation/course/destination", "PUT", {
        position: { latitude: Number(a.lat), longitude: Number(a.lon) },
      });
      if (Number.isFinite(Number(a.arrival_circle_m)))
        await sk("/signalk/v2/api/vessels/self/navigation/course/arrivalCircle", "PUT", {
          value: Number(a.arrival_circle_m),
        }).catch(() => {});
      return `destination set: ${a.lat}, ${a.lon} — SignalK is now computing guidance; skiff follows when its route-follow is live`;
    },
  },
  {
    name: "set_route",
    description:
      "Create a multi-waypoint route in SignalK's resource store and activate it via the v2 Course API. Waypoints in sailing order. Returns the route id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        waypoints: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: { lat: { type: "number" }, lon: { type: "number" } },
            required: ["lat", "lon"],
          },
        },
      },
      required: ["waypoints"],
    },
    run: async (a) => {
      if (!Array.isArray(a.waypoints) || a.waypoints.length < 2) throw new Error("need >=2 waypoints");
      for (const w of a.waypoints) if (!validLatLon(w)) throw new Error("waypoint lat/lon out of range");
      const route = {
        name: a.name || "agent-route",
        feature: {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: a.waypoints.map((w) => [Number(w.lon), Number(w.lat)]),
          },
          properties: {},
        },
      };
      const created = await sk("/signalk/v2/api/resources/routes", "POST", route);
      const id = created.id || created.href || (typeof created === "string" ? created : null);
      if (!id) throw new Error(`route created but no id in response: ${JSON.stringify(created).slice(0, 200)}`);
      const href = String(id).startsWith("/") ? String(id) : `/resources/routes/${id}`;
      await sk("/signalk/v2/api/vessels/self/navigation/course/activeRoute", "PUT", { href });
      return `route "${route.name}" created (${a.waypoints.length} waypoints) and activated: ${href}`;
    },
  },
  {
    name: "clear_course",
    description: "Clear the active destination/route (SignalK v2 Course API DELETE). Skiff autopilot releases to manual.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      await sk("/signalk/v2/api/vessels/self/navigation/course", "DELETE");
      return "course cleared";
    },
  },
  {
    name: "course_status",
    description:
      "Read the whole guidance chain: SignalK v2 course (destination/route), live calcValues (bearing/XTE/DTG/ETA), and skiff's route_guidance + position so you can see what the boat is doing about it.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const [course, calc, sim] = await Promise.all([
        sk("/signalk/v2/api/vessels/self/navigation/course").catch((e) => ({ error: e.message })),
        sk("/signalk/v1/api/vessels/self/navigation/course/calcValues").catch(() => null),
        fetch(SKIFF + "/v1/sim/state", { signal: AbortSignal.timeout(8000) })
          .then((r) => r.json())
          .catch((e) => ({ error: e.message })),
      ]);
      const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
      return JSON.stringify(
        {
          course,
          calcValues: calc,
          skiff: pick(sim, ["pos", "heading_true_deg", "cog_true_deg", "sog_mps", "rudder_deg", "route_guidance", "course_hold"]),
        },
        null,
        1
      );
    },
  },
];

// ---------- MCP stdio plumbing (newline-delimited JSON-RPC 2.0) ----------

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — nothing to do
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "opencpn-fake-plugin", version: "0.1.0" },
        instructions:
          "Two tool families: (1) window control of the running OpenCPN desktop (zoom/pan/follow/click/screenshot — keystroke injection, briefly steals focus; avoid while a human is typing); (2) headless vessel routing via the SignalK v2 Course API (set_destination/set_route/clear_course/course_status) — no GUI, skiff's autopilot follows the guidance.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return replyErr(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const r = await tool.run(params?.arguments || {});
        return reply(id, typeof r === "string" ? { content: [{ type: "text", text: r }] } : r);
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true });
      }
    }
    default:
      return replyErr(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
let pending = 0;
let stdinClosed = false;
const maybeExit = () => { if (stdinClosed && pending === 0) process.exit(0); };

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    pending++;
    handle(msg)
      .catch((e) => {
        if (msg.id !== undefined && msg.id !== null) replyErr(msg.id, -32603, e.message);
      })
      .finally(() => { pending--; maybeExit(); });
  }
});
// Don't exit with tool calls still in flight — drain first.
process.stdin.on("end", () => { stdinClosed = true; maybeExit(); });
