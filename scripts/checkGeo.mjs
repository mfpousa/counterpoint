// Diagnostic for ANY GeoJSON FeatureCollection of country/region polygons: reports
// self-intersecting / pinched outer rings (which earcut fills with bridging faces on the
// globe) and the widest high-latitude coastline edge (a coarse "gulf bridge"). Works on
// the bundled world land (src/data/world/countries-110m.json) and the server Admin-1 set.
//
// Usage:
//   node scripts/checkGeo.mjs src/data/world/countries-110m.json Russia
//   node scripts/checkGeo.mjs server/data/admin1-10m.json            # whole file

import { existsSync, readFileSync } from "node:fs";

const FILE = process.argv[2];
const nameSub = (process.argv[3] || "").toLowerCase();
if (!FILE || !existsSync(FILE)) {
  console.error(`Usage: node scripts/checkGeo.mjs <geojson> [nameSubstring]\nNot found: ${FILE}`);
  process.exit(1);
}

const featureName = (p) =>
  p.NAME || p.name || p.ADMIN || p.admin || p.NAME_EN || p.name_en || p.iso2 || p.code || "?";

function segmentsCross(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}
function firstSelfIntersection(ring) {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return [i, j];
    }
  return null;
}

const geo = JSON.parse(readFileSync(FILE, "utf8"));
const features = (geo.features || []).filter(
  (f) => !nameSub || featureName(f.properties).toLowerCase().includes(nameSub),
);

let self = 0;
let widestArc = 0;
let widestAt = null;
for (const f of features) {
  const g = f.geometry;
  if (!g) continue;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  polys.forEach((poly, pi) => {
    const outer = poly[0];
    if (!outer || outer.length < 4) return;
    const hit = firstSelfIntersection(outer);
    if (hit) {
      self++;
      console.log(`SELF-INTERSECT ${featureName(f.properties)} poly#${pi} verts=${outer.length} edges ${hit[0]},${hit[1]}`);
    }
    // widest coastline edge above 60N (a coarse gulf-spanning segment)
    for (let i = 1; i < outer.length; i++) {
      const [aLon, aLat] = outer[i - 1];
      const [bLon, bLat] = outer[i];
      if (aLat > 60 && bLat > 60) {
        const arc = Math.hypot(bLon - aLon, bLat - aLat);
        if (arc > widestArc) {
          widestArc = arc;
          widestAt = { feature: featureName(f.properties), a: outer[i - 1], b: outer[i] };
        }
      }
    }
  });
}

console.log(
  `\n${FILE}${nameSub ? ` ["${nameSub}"]` : ""}: scanned ${features.length} feature(s), ` +
    `${self} self-intersecting ring(s).`,
);
if (widestAt) {
  console.log(
    `Widest >60°N coastline edge: ${widestArc.toFixed(1)}° on ${widestAt.feature} ` +
      `(${JSON.stringify(widestAt.a)} → ${JSON.stringify(widestAt.b)}) — a long edge here is a ` +
      `coarse "gulf bridge" the fill spans straight across.`,
  );
}
