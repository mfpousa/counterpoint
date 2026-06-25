// Resolve WHERE a co-located "gathering" happened (Story.gatherings) to a direction on the
// globe, more accurately than a country centroid. Three tiers, best-first — exactly the
// "Both" strategy: gazetteer → validated model coords → centroid.
//
//   1. GAZETTEER — the place NAME looked up in the bundled cities dump (lookupCity),
//      preferring the host country. The most reliable, never trusts model coordinates.
//   2. MODEL COORDS — the model's lat/lon, but ONLY if they sanity-check against the host
//      country's bounding box. This catches the small/famous venues a population-floored
//      gazetteer misses (Davos, Sharm el-Sheikh, Camp David's nearest town, …).
//   3. CENTROID — the host country's pin anchor: an always-available last resort.
//
// Pure (no three.js / data imports) so it's unit-tested and the real indices are injected.

import { latLonToVec3, type Vec3 } from "./globeLayout";
import type { BBox } from "./geoShapes";

/** Everything the resolver needs, injected so this stays pure + testable. */
export interface GeocodeContext {
  /** Gazetteer lookup: place name (+ host iso2) -> coords, or null. */
  lookupCity: (place: string, iso2?: string) => { lat: number; lon: number } | null;
  /** Per-country lon/lat extents, to validate model coords. */
  bboxes: Map<string, BBox>;
  /** Per-country centroid directions (the fallback anchor). */
  byIso2: Map<string, Vec3>;
}

/** The geolocatable fields of a gathering. */
export interface GeocodeInput {
  place: string;
  iso2: string;
  lat?: number;
  lon?: number;
}

// Degrees of slack around a country's bbox: borders are coarse and many venues sit on a
// coast or just over a line, so we don't reject a plausible nearby point.
const BBOX_PAD = 1.5;

/** True when lat/lon falls within the country's padded bbox — or we have NO bbox for it
 *  (an unknown country: we can't disprove the point, so allow it as a last resort before
 *  giving up). */
function withinCountry(
  iso2: string,
  lat: number,
  lon: number,
  bboxes: Map<string, BBox>,
): boolean {
  const bb = bboxes.get(iso2);
  if (!bb) return true;
  return (
    lat >= bb.minLat - BBOX_PAD &&
    lat <= bb.maxLat + BBOX_PAD &&
    lon >= bb.minLon - BBOX_PAD &&
    lon <= bb.maxLon + BBOX_PAD
  );
}

/**
 * Resolve a gathering's place to a unit sphere direction (gazetteer → validated model
 * coords → country centroid). Returns null only when the place can't be located at all
 * (no gazetteer hit, no usable/valid coords, and an unknown host country).
 */
export function geocodeGathering(g: GeocodeInput, ctx: GeocodeContext): Vec3 | null {
  const iso2 = (g.iso2 || "").toLowerCase();

  // 1. Gazetteer (most reliable).
  const city = g.place ? ctx.lookupCity(g.place, iso2) : null;
  if (city) return latLonToVec3(city.lat, city.lon);

  // 2. Model coords, validated against the host country.
  if (
    typeof g.lat === "number" &&
    typeof g.lon === "number" &&
    Number.isFinite(g.lat) &&
    Number.isFinite(g.lon) &&
    withinCountry(iso2, g.lat, g.lon, ctx.bboxes)
  ) {
    return latLonToVec3(g.lat, g.lon);
  }

  // 3. Country centroid (always-available fallback).
  return ctx.byIso2.get(iso2) ?? null;
}
