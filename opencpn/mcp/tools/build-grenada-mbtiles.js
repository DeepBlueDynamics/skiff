#!/usr/bin/env node
// Build an MBTiles raster chart of Grenada from OSM tiles for OpenCPN.
// One-time personal-use pull, OSM tile policy respected: 2 concurrent, real UA.
const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("fs");
const { dirname } = require("path");

const OUT = process.argv[2] || "C:\\ProgramData\\opencpn\\charts\\grenada-osm.mbtiles";
const UA = "skiff-sim-chart-builder/1.0 (one-time personal use; kordless@gmail.com)";

// [latS, latN, lonW, lonE, zmin, zmax]
const REGIONS = [
  [11.93, 12.28, -61.85, -61.55, 8, 14],   // Grenada island
  [11.96, 12.04, -61.82, -61.68, 15, 16],  // Prickly Bay / south coast detail
  [11.65, 11.95, -61.95, -61.60, 8, 12],   // southern approaches (open water)
];

const d2r = (d) => (d * Math.PI) / 180;
const tx = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const ty = (lat, z) =>
  Math.floor(((1 - Math.log(Math.tan(d2r(lat)) + 1 / Math.cos(d2r(lat))) / Math.PI) / 2) * 2 ** z);

const jobs = [];
const seen = new Set();
for (const [latS, latN, lonW, lonE, zmin, zmax] of REGIONS) {
  for (let z = zmin; z <= zmax; z++) {
    const x0 = tx(lonW, z), x1 = tx(lonE, z);
    const y0 = ty(latN, z), y1 = ty(latS, z); // y grows southward
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${z}/${x}/${y}`;
        if (!seen.has(k)) { seen.add(k); jobs.push([z, x, y]); }
      }
  }
}
console.log(`tiles to fetch: ${jobs.length}`);

mkdirSync(dirname(OUT), { recursive: true });
const db = new DatabaseSync(OUT);
db.exec(`
  CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT);
  CREATE TABLE IF NOT EXISTS tiles (zoom_level INT, tile_column INT, tile_row INT, tile_data BLOB);
  CREATE UNIQUE INDEX IF NOT EXISTS tile_index ON tiles (zoom_level, tile_column, tile_row);
  DELETE FROM metadata;
`);
const meta = db.prepare("INSERT INTO metadata VALUES (?, ?)");
for (const [k, v] of [
  ["name", "Grenada OSM"],
  ["type", "baselayer"],
  ["version", "1"],
  ["description", "OSM raster tiles, Grenada + Prickly Bay detail, for skiff sim testing"],
  ["format", "png"],
  ["bounds", "-61.95,11.65,-61.55,12.28"],
  ["minzoom", "8"],
  ["maxzoom", "16"],
]) meta.run(k, v);

const ins = db.prepare("INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)");
let done = 0, failed = 0;

async function fetchTile(z, x, y, attempt = 1) {
  const res = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * attempt)); return fetchTile(z, x, y, attempt + 1); }
    throw new Error(`${res.status} on ${z}/${x}/${y}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  ins.run(z, x, 2 ** z - 1 - y, buf); // MBTiles rows are TMS (south-origin)
}

(async () => {
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (queue.length) {
        const [z, x, y] = queue.shift();
        try { await fetchTile(z, x, y); } catch (e) { failed++; console.error(e.message); }
        if (++done % 100 === 0) console.log(`${done}/${jobs.length}`);
      }
    })
  );
  db.close();
  console.log(`DONE ${done - failed}/${jobs.length} tiles, ${failed} failed → ${OUT}`);
})();
