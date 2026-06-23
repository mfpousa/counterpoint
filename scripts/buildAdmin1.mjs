// Slim Natural Earth Admin-1 (states/provinces) GeoJSON down to exactly what the
// 3D globe needs: per-region polygons tagged with the country ISO-2, the ISO 3166-2
// code (so the globe can match a region to its coverage node via slug(code)), and a
// display name. Coordinates are rounded to 3 decimals (~110 m) to shrink the bundle.
//
// Usage:  node scripts/buildAdmin1.mjs [rawInput.geojson] [out.json]
// Source: https://github.com/nvkelso/natural-earth-vector
//         geojson/ne_50m_admin_1_states_provinces.geojson

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RAW = process.argv[2] || "/tmp/ne_admin1.geojson";
// Server-side data file: the app STREAMS one country's regions from /api/regions,
// so this lives with the backend and is never bundled into the app.
const OUT = process.argv[3] || "server/data/admin1-10m.json";

const EPS = Number(process.argv[4] || 0.03); // simplification tolerance in degrees (~3 km)
const round = (n) => Math.round(n * 100) / 100; // 2 decimals (~1.1 km) — plenty for a globe

// Douglas-Peucker on a polyline of [lon,lat] points (perpendicular distance in degrees).
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-12;
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const t = ((px - ax) * dx + (py - ay) * dy) / len2;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }
  return [pts[0], pts[pts.length - 1]];
}

// Simplify + round + dedup one ring; returns a closed ring (>=4 pts) or null if degenerate.
function simplifyRing(ring, eps) {
  let pts = ring.map((p) => [p[0], p[1]]);
  const closed =
    pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (closed) pts = pts.slice(0, -1);
  const simplified = rdp(pts, eps);
  const out = [];
  for (const p of simplified) {
    const q = [round(p[0]), round(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]); // re-close
  return out;
}

function simplifyPolygon(rings, eps) {
  const r = rings.map((ring) => simplifyRing(ring, eps)).filter(Boolean);
  return r.length ? r : null;
}

function simplifyGeometry(g, eps) {
  if (g.type === "Polygon") {
    const p = simplifyPolygon(g.coordinates, eps);
    return p ? { type: "Polygon", coordinates: p } : null;
  }
  if (g.type === "MultiPolygon") {
    const ps = g.coordinates.map((poly) => simplifyPolygon(poly, eps)).filter(Boolean);
    return ps.length ? { type: "MultiPolygon", coordinates: ps } : null;
  }
  return null;
}

const raw = JSON.parse(readFileSync(RAW, "utf8"));
const out = { type: "FeatureCollection", features: [] };

for (const f of raw.features ?? []) {
  const g = f.geometry;
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
  const p = f.properties ?? {};
  // The ISO 3166-2 code is the reliable join key ("ES-GA"); its prefix is the country.
  const code = typeof p.iso_3166_2 === "string" && p.iso_3166_2.includes("-") ? p.iso_3166_2 : "";
  let iso2 = code ? code.split("-")[0].toLowerCase() : "";
  if (!iso2) {
    const a2 = typeof p.iso_a2 === "string" ? p.iso_a2 : "";
    if (/^[A-Za-z]{2}$/.test(a2)) iso2 = a2.toLowerCase();
  }
  if (!iso2) continue; // can't attribute to a country → skip
  const name = p.name || p.name_en || p.gn_name || p.gns_name || "";
  const geom = simplifyGeometry(g, EPS);
  if (!geom) continue; // simplified away to nothing
  out.features.push({
    type: "Feature",
    properties: { iso2, code, name },
    geometry: geom,
  });
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const mb = (readFileSync(OUT).length / 1e6).toFixed(2);
console.log(`admin1: ${out.features.length} regions -> ${OUT} (${mb} MB)`);
