// Pure: a unified "find a place" search over the globe's continents and countries.
// The center search box queries this — type "spa" → Spain, "eur" → Europe — and the
// chosen hit tells the globe where to FLY (its centroid) and which coverage node to
// open (`nodeId`: a continent slug like "europe" or an ISO-2 like "es"). Region search
// is layered on later (regions stream per-country); this index is built once from the
// bundled country borders so search is instant and offline.

import type { Vec3 } from "./globeLayout";

/** A searchable place: a continent or country with where to fly + which node to open. */
export interface PlaceHit {
  nodeId: string;
  label: string;
  level: "continent" | "country" | "region";
  /** Unit direction on the sphere (centroid) to centre the globe on. */
  dir: Vec3;
}

/** Score a label against a query: exact > prefix > word-prefix > substring. */
function matchScore(label: string, q: string): number {
  if (label === q) return 4;
  if (label.startsWith(q)) return 3;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (label.includes(q)) return 1;
  return 0;
}

/** Ranked place matches for a query (empty query → no results). Best first; ties
 *  break toward shorter (more specific) labels. Countries edge out continents on
 *  an equal score so typing a country name lands on the country. */
export function searchPlaces(places: PlaceHit[], query: string, limit = 8): PlaceHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const scored: { p: PlaceHit; s: number }[] = [];
  for (const p of places) {
    const s = matchScore(p.label.toLowerCase(), q);
    if (s > 0) scored.push({ p, s });
  }
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (a.p.level !== b.p.level) return a.p.level === "country" ? -1 : 1;
    return a.p.label.length - b.p.label.length;
  });
  return scored.slice(0, limit).map((x) => x.p);
}
