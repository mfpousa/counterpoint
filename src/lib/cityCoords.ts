// A compact, BUNDLED city-coordinate gazetteer for geocoding a place NAME to a point —
// the first (and most reliable) tier of resolving where a co-located "gathering" happened
// (see geocodeGathering in placeGeocode.ts). Generated from the open GeoNames cities dump
// by scripts/buildCityCoords.ts (never hand-edited); each entry is a compact tuple
//   [asciiname, iso2, lat, lon, population]
// so the file stays small. When the dataset hasn't been built yet the array is empty and
// every lookup misses (so geocoding falls through to the model-coords / centroid tiers).

import citiesRaw from "../data/cityCoords.json";

/** One gazetteer city row. */
type CityRow = [name: string, cc: string, lat: number, lon: number, pop: number];

/** A resolved point from the gazetteer. */
export interface CityCoord {
  lat: number;
  lon: number;
}

const RAW = citiesRaw as unknown as CityRow[];

/** Accent/punctuation-insensitive key so "Genève" / "Geneva" / "geneva" all collide and a
 *  model's English/ASCII spelling matches the GeoNames asciiname. */
export function normalizePlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface IndexedCity {
  cc: string;
  lat: number;
  lon: number;
  pop: number;
}

// name-key -> every city sharing that name (several "Springfield"s, etc.).
const INDEX: Map<string, IndexedCity[]> = (() => {
  const m = new Map<string, IndexedCity[]>();
  for (const row of RAW) {
    const [name, cc, lat, lon, pop] = row;
    const key = normalizePlace(name);
    if (!key) continue;
    const arr = m.get(key);
    const entry: IndexedCity = { cc: cc.toLowerCase(), lat, lon, pop: pop || 0 };
    if (arr) arr.push(entry);
    else m.set(key, [entry]);
  }
  return m;
})();

/**
 * Geocode a place NAME to coordinates from the bundled gazetteer. Disambiguates by
 * PREFERRING a city in the given host country (`iso2`), then the most populous match
 * (so "Geneva" → Switzerland, not Geneva, Illinois). null when the name is unknown.
 */
export function lookupCity(place: string, iso2?: string): CityCoord | null {
  const key = normalizePlace(place || "");
  if (!key) return null;
  const cands = INDEX.get(key);
  if (!cands || cands.length === 0) return null;
  const cc = (iso2 || "").toLowerCase();
  const scoped = cc ? cands.filter((c) => c.cc === cc) : [];
  const pool = scoped.length > 0 ? scoped : cands;
  let best = pool[0];
  for (const c of pool) if (c.pop > best.pop) best = c;
  return { lat: best.lat, lon: best.lon };
}

/** Number of cities in the bundled gazetteer (0 until the dataset is built). */
export function cityCount(): number {
  return RAW.length;
}
