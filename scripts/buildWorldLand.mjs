// Slim Natural Earth 50m Admin-0 (countries) GeoJSON into the bundled world-land file the
// globe imports (src/data/world/countries-50m.json). The 110m set was too coarse — at that
// scale big countries' coastlines are drawn with long straight edges, so the fill spans
// straight across gulfs/bays (a "triangle overlapping the coastline" on the globe). The
// 50m source resolves those; we simplify it the SAME topology-safe way as the Admin-1
// data: Douglas-Peucker + 2-decimal rounding, with every ring VALIDATED so it can't
// self-intersect (which earcut would otherwise fill with a bridging face).
//
// Keeps only the properties geoShapes.ts reads (ISO codes, names, CONTINENT).
//
// Usage:  node scripts/buildWorldLand.mjs [rawInput.geojson] [out.json] [eps]
// Source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RAW = process.argv[2] || "/tmp/ne_countries.geojson";
const OUT = process.argv[3] || "src/data/world/countries-50m.json";
const EPS = Number(process.argv[4] || 0.04); // ~4 km — background land, a touch coarser than admin-1
const round = (n) => Math.round(n * 100) / 100;

// Properties geoShapes.ts uses (iso2Of + computeCentroids + buildCountryShapes). The rest
// of Natural Earth's ~160 fields are dropped to keep the bundle small.
const KEEP = ["ISO_A2_EH", "ISO_A2", "NAME", "NAME_LONG", "ADMIN", "CONTINENT"];

let fallbacks = 0;

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

function segmentsCross(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

function selfIntersects(ring) {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

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
  out.push([out[0][0], out[0][1]]);
  return out;
}

// Simplify ONE ring to a VALID (non-self-intersecting) closed ring, falling back to gentler
// simplification (then raw) when a candidate would self-intersect — see scripts/checkGeo.mjs.
function simplifyRing(ring, eps) {
  let pts = ring.map((p) => [p[0], p[1]]);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
    pts = pts.slice(0, -1);
  }
  if (pts.length < 3) return null;
  const candidates = [
    roundClose(rdp(pts, eps)),
    roundClose(rdp(pts, eps / 2)),
    roundClose(rdp(pts, eps / 4)),
    roundClose(pts),
    [...pts, pts[0]],
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
  const geom = simplifyGeometry(g, EPS);
  if (!geom) continue;
  const props = {};
  for (const k of KEEP) if (f.properties?.[k] != null) props[k] = f.properties[k];
  out.features.push({ type: "Feature", properties: props, geometry: geom });
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const mb = (readFileSync(OUT).length / 1e6).toFixed(2);
console.log(`world land: ${out.features.length} countries -> ${OUT} (${mb} MB)`);
console.log(`  ${fallbacks} ring(s) kept extra detail to stay topology-valid.`);
