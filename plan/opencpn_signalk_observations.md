# OpenCPN → SignalK route guidance: observed paths (for the autopilot parser)

Measured live against the Pi's signalk-server v2.28 on 2026-07-10, by injecting
the exact sentence set OpenCPN emits for an active route (`model/src/routeman.cpp`
`UpdateAutopilot()`: talker **EC**, sentences **RMB, APB, XTE — and RMC**, see
hazard below) into the new UDP provider. Everything below is what actually
appeared under `vessels.self`, not spec reading.

## Paths that appear (SI units: radians, meters, m/s)

From the raw NMEA mapping — `$source: "opencpn-nav.EC"`, refreshed ~1 Hz only
while OpenCPN has an active route, **stale otherwise (check timestamp)**:

| path | example | from |
|---|---|---|
| `navigation.courseRhumbline.crossTrackError` | `37.04` (m; NM→m converted; sign: L=+) | RMB/XTE |
| `navigation.courseRhumbline.bearingToDestinationTrue` | `3.752` (rad = 215°) | RMB |
| `navigation.courseRhumbline.bearingTrackTrue` | `3.752` (rad) | APB |
| `navigation.courseRhumbline.bearingOriginToDestinationTrue` | `3.752` (rad) | APB |
| `steering.autopilot.target.headingTrue` | `3.752` (rad), `sentence: "APB"` | APB |

NOTE: `courseRhumbline.nextPoint.bearingTrue` (Goose's guess) does **not**
appear on this server version — the bearing lands on the three
`bearing*True` paths above.

## Bonus: the server's Course API engages

Ingesting RMB (destination waypoint position) activated signalk-server's course
provider. These are **recomputed continuously by the server from the boat's own
live position** — they keep updating between OpenCPN's 1 Hz emissions and are
arguably the better guidance source (`$source: "course-provider"`):

- `navigation.course.calcValues.bearingTrue` (rad, live)
- `navigation.course.calcValues.crossTrackError` (m, live, signed)
- `navigation.course.calcValues.distance` (m), `.velocityMadeGood` (m/s),
  `.timeToGo` (s), `.estimatedTimeOfArrival` (ISO), `.bearingTrackTrue`
- `navigation.courseRhumbline.activeRoute.startTime` non-null ⇒ a route is active

Recommendation: steer to `course.calcValues.bearingTrue` + damp with
`.crossTrackError`; treat `steering.autopilot.target.headingTrue` /
`courseRhumbline.*` as the OpenCPN-authoritative fallback and staleness signal.
Course can be cleared with `DELETE /signalk/v2/api/vessels/self/navigation/course`.

## Ownship jumping: root cause findings

1. **There is no second position source.** `navigation.position` has exactly one
   source: `sailing-simulator.XX`. Sources list shows nothing else publishing
   position (only webapps + my one-off `wstest` wind value).
2. **skiff was never actually disconnected** — deleting the WS client in the
   admin UI doesn't stick because skiff auto-reconnects with backoff (by
   design). Its service still has `SIGNALK_HOST=localhost:3000` and is
   publishing now. No re-enable needed.
3. The observed "jumping" timing matches **sim teleports**: a `reset` was issued
   (~20:22Z, `elapsed_s` dropped to 52) which snaps the boat back to Prickly
   Bay, and `set_position` does the same spiral-snap. OpenCPN faithfully renders
   the teleport as a jump.
4. **Future hazard, already mitigated**: with route output enabled, OpenCPN
   emits `ECRMC` (its own position echo) which WOULD have become a second
   position source. The SignalK provider now has
   `ignoredSentences: ["RMC","GGA","GLL"]`, so OpenCPN can never publish
   position — skiff stays the only self-position source.

## Plumbing now in place

- **SignalK**: `~/.signalk/settings.json` created with UDP NMEA0183 provider
  `opencpn-nav` on **port 10111** (RMC/GGA/GLL ignored). Service restarted.
- **OpenCPN** (Windows box): second connection added — UDP **output** to
  `192.168.68.29:10111`, NMEA0183, output-only. Config:
  `C:\ProgramData\opencpn\opencpn.ini`, `[Settings/NMEADataSource]`.
- Existing input connection (SignalK 192.168.68.29:3000) untouched — ownship
  still driven by skiff. "Bidirectional" = two one-way links.

## Caveat

The synthetic injection validates the SignalK mapping end-to-end; the last
untested hop is OpenCPN's own emission on route activation (GUI action —
Windows blocked focus-steal automation while Kord was using the desktop).
To finish: draw a route in OpenCPN, right-click it → **Activate**, and the
paths above should light up with fresh timestamps. Values in the tree right
now (WP001, bearing 215°) are my synthetic test — a real activation overwrites
them.
