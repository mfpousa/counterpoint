// Slim Natural Earth Admin-1 (states/provinces) GeoJSON down to exactly what the
// 3D globe needs: per-region polygons tagged with the country ISO-2, the ISO 3166-2
// code (so the globe can match a region to its coverage node via slug(code)), and a
// display name. Coordinates are rounded to 2 decimals (~1.1 km) to shrink the bundle,
// and every simplified ring is VALIDATED so it can't self-intersect (which earcut would
// otherwise fill with a bridging face on the globe — see scripts/checkAdmin1.mjs).
//
// Usage:  node scripts/buildAdmin1.mjs [rawInput.geojson] [out.json]
// Source: the 10m set (the output is admin1-10m.json — the 50m set is MUCH sparser and
//   drops most countries, so don't use it):
//   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RAW = process.argv[2] || "/tmp/ne_admin1.geojson";
// Server-side data file: the app STREAMS one country's regions from /api/regions,
// so this lives with the backend and is never bundled into the app.
const OUT = process.argv[3] || "server/data/admin1-10m.json";

const EPS = Number(process.argv[4] || 0.03); // simplification tolerance in degrees (~3 km)
const round = (n) => Math.round(n * 100) / 100; // 2 decimals (~1.1 km) — plenty for a globe

let fallbacks = 0; // count rings that needed a gentler simplification to stay valid

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

// Do segments p1p2 and p3p4 properly CROSS (excluding shared endpoints)?
function segmentsCross(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

// Does a CLOSED ring (last === first) self-intersect? O(n^2); fine in a one-off build.
function selfIntersects(ring) {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // edges adjacent at the closing vertex
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

// Round + drop consecutive dupes, strip a trailing point equal to the first (the
// duplicate-closing PINCH), then re-close. Returns a closed ring (>=4 pts) or null.
function roundClose(openPts) {
  const out = [];
  for (const p of openPts) {
    const q = [round(p[0]), round(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
    out.pop();
  }
  if (out.length < 3) return null;
  out.push([out[0][0], out[0][1]]); // re-close
  return out;
}

// Simplify ONE ring to a VALID (non-self-intersecting) closed ring. Douglas-Peucker +
// rounding aren't topology-preserving, so we try progressively gentler simplification and
// accept the first candidate that doesn't self-intersect — worst case the raw rounded ring,
// else the raw ring. This is what stops earcut from filling a crossed ring with a bridging
// face on the globe (see scripts/checkAdmin1.mjs).
function simplifyRing(ring, eps) {
  let pts = ring.map((p) => [p[0], p[1]]);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
    pts = pts.slice(0, -1); // strip the source's closing duplicate
  }
  if (pts.length < 3) return null;
  const candidates = [
    roundClose(rdp(pts, eps)),
    roundClose(rdp(pts, eps / 2)),
    roundClose(rdp(pts, eps / 4)),
    roundClose(pts), // rounded, no Douglas-Peucker
    [...pts, pts[0]], // raw (full precision) — the source ring is valid by construction
  ];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c && c.length >= 4 && !selfIntersects(c)) {
      if (i > 0) fallbacks++;
      return c;
    }
  }
  return null;
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
  // The higher-level division this province rolls up to (e.g. its autonomous community).
  // Coverage is often keyed at THAT level, so the globe binds a province to its covered
  // region by EITHER the community code (`region_cod`, slugged) OR the community NAME
  // (`region`, normalised) — neither alone is complete (NE's codes aren't pure ISO 3166-2,
  // and names vary by language), so we carry both and match on either.
  const group = typeof p.region === "string" ? p.region : ""; // community NAME
  const groupCode = typeof p.region_cod === "string" ? p.region_cod : ""; // community CODE
  const geom = simplifyGeometry(g, EPS);
  if (!geom) continue; // simplified away to nothing
  out.features.push({
    type: "Feature",
    properties: { iso2, code, name, group, groupCode },
    geometry: geom,
  });
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const mb = (readFileSync(OUT).length / 1e6).toFixed(2);
console.log(`admin1: ${out.features.length} regions -> ${OUT} (${mb} MB)`);
console.log(`  ${fallbacks} ring(s) kept extra detail to stay topology-valid (no self-intersections).`);
