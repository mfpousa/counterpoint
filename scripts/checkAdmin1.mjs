// Diagnostic: find decimation damage in the slim Admin-1 data (server/data/admin1-10m.json).
//
// scripts/buildAdmin1.mjs simplifies with Douglas-Peucker + rounds to 2 decimals, and
// NEITHER step is topology-preserving — so a ring can end up SELF-INTERSECTING or with a
// repeated (non-consecutive) point. earcut then fills those with overlapping / bridging
// faces, which show on the globe as "a triangle that spans across the coastline".
//
// This reports, per region polygon's OUTER ring:
//   - self-intersections (two non-adjacent edges crossing)
//   - duplicate non-consecutive vertices (a pinch point)
//
// Usage:
//   node scripts/checkAdmin1.mjs            # scan every country
//   node scripts/checkAdmin1.mjs ru         # scan one country (ISO-2)
//   node scripts/checkAdmin1.mjs ru --verbose

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DATA = resolve(process.cwd(), "server/data/admin1-10m.json");
const ccFilter = (process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "").toLowerCase();
const verbose = process.argv.includes("--verbose");

if (!existsSync(DATA)) {
  console.error(`Not found: ${DATA} — run "node scripts/buildAdmin1.mjs" first.`);
  process.exit(1);
}

/** Do segments p1p2 and p3p4 properly cross (excluding shared endpoints)? */
function segmentsCross(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false; // parallel/collinear — ignore
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** First self-intersection [i,j] in a closed ring, or null. O(n^2) — fine post-decimation. */
function firstSelfIntersection(ring) {
  const n = ring.length - 1; // ring is closed (last === first)
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // edges sharing the closing vertex are adjacent
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return [i, j];
    }
  }
  return null;
}

/** A vertex that repeats at a NON-consecutive position (a pinch), or null. */
function duplicatePinch(ring) {
  const seen = new Map();
  for (let i = 0; i < ring.length - 1; i++) {
    const key = `${ring[i][0]},${ring[i][1]}`;
    if (seen.has(key) && seen.get(key) !== i - 1) return [seen.get(key), i];
    seen.set(key, i);
  }
  return null;
}

const geo = JSON.parse(readFileSync(DATA, "utf8"));
const features = geo.features.filter(
  (f) => !ccFilter || (f.properties?.iso2 || "").toLowerCase() === ccFilter,
);

let regionsScanned = 0;
let selfHits = 0;
let pinchHits = 0;
const offenders = [];

for (const f of features) {
  const g = f.geometry;
  if (!g) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let regionBad = false;
  polys.forEach((poly, pi) => {
    const outer = poly[0];
    if (!outer || outer.length < 4) return;
    const si = firstSelfIntersection(outer);
    const dp = duplicatePinch(outer);
    if (si || dp) {
      regionBad = true;
      if (si) selfHits++;
      if (dp) pinchHits++;
      if (verbose) {
        const p = f.properties;
        console.log(
          `  ${p.iso2}/${p.code || "?"} ${p.name || ""} poly#${pi} verts=${outer.length}` +
            (si ? ` SELF-INTERSECT edges ${si[0]},${si[1]}` : "") +
            (dp ? ` PINCH verts ${dp[0]},${dp[1]}` : ""),
        );
      }
    }
  });
  regionsScanned++;
  if (regionBad) offenders.push(`${f.properties.iso2}/${f.properties.code || "?"} ${f.properties.name || ""}`);
}

console.log(
  `\nScanned ${regionsScanned} region(s)${ccFilter ? ` for "${ccFilter}"` : ""}: ` +
    `${selfHits} self-intersecting + ${pinchHits} pinched ring(s) across ${offenders.length} region(s).`,
);
if (offenders.length && !verbose) {
  console.log("Offending regions (use --verbose for edge indices):");
  for (const o of offenders.slice(0, 40)) console.log(`  ${o}`);
  if (offenders.length > 40) console.log(`  …and ${offenders.length - 40} more`);
}
