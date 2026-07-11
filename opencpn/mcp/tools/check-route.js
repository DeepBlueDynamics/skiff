// Verify a route never touches land: point-in-polygon test against the sim's
// grounding mask for every waypoint AND sampled points every ~50m along legs.
const fs = require("fs");
const gj = JSON.parse(
  fs.readFileSync("C:/Users/kordl/Code/DeepBlueDynamics/skiff/web/public/world/grenada.geojson", "utf8")
);

const polys = [];
const collect = (geom) => {
  if (geom.type === "Polygon") polys.push(geom.coordinates);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach((p) => polys.push(p));
};
(gj.features || [gj]).forEach((f) => collect(f.geometry || f));

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
const onLand = (lat, lon) =>
  polys.some((poly) => inRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lon, lat, h)));

// min distance (m) from a point to any polygon vertex — coarse coastline clearance
function clearance(lat, lon) {
  let best = Infinity;
  const clat = Math.cos((lat * Math.PI) / 180);
  for (const poly of polys)
    for (const ring of poly)
      for (const [x, y] of ring) {
        const d = Math.hypot((y - lat) * 111320, (x - lon) * 111320 * clat);
        if (d < best) best = d;
      }
  return best;
}

const route = JSON.parse(process.argv[2]);
let ok = true;
for (let i = 0; i < route.length; i++) {
  const w = route[i];
  const land = onLand(w.lat, w.lon);
  const cl = Math.round(clearance(w.lat, w.lon));
  console.log(`WP${i + 1} ${w.name || ""} ${w.lat},${w.lon}: ${land ? "ON LAND!" : "water"}, coast ${cl}m`);
  if (land || cl < 150) ok = false;
  if (i > 0) {
    const p = route[i - 1];
    const steps = Math.ceil(Math.hypot((w.lat - p.lat) * 111320, (w.lon - p.lon) * 111320 * 0.978) / 50);
    let worst = Infinity, landHit = false;
    for (let s = 1; s < steps; s++) {
      const lat = p.lat + ((w.lat - p.lat) * s) / steps;
      const lon = p.lon + ((w.lon - p.lon) * s) / steps;
      if (onLand(lat, lon)) landHit = true;
      const c = clearance(lat, lon);
      if (c < worst) worst = c;
    }
    console.log(`  leg ${i}->${i + 1}: ${landHit ? "CROSSES LAND!" : "clear"}, min coast ${Math.round(worst)}m (${steps} samples)`);
    if (landHit || worst < 100) ok = false;
  }
}
console.log(ok ? "ROUTE SAFE" : "ROUTE UNSAFE — fix before plotting");
