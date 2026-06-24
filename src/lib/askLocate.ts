// Geolocate the places an AI news search ("ask") talks about, so the globe can drop
// a beacon on each. Three resolution paths, best-first, mirroring how the worldview
// anchors stories (geoAlerts.locateStory):
//   1. The model's ISO 3166-1 alpha-2 code  -> centroid (most reliable).
//   2. The place LABEL by country name/alias -> centroid (when the code is missing
//      or wrong; the model is good at NAMING places even when it skips the code).
//   3. Failing structured places entirely, a SCAN of the synopsis prose for country
//      names/aliases -> centroids (so even a pure-prose answer still anchors).
//
// Pure (no three.js) so it's unit-testable and shared web + native.

import type { GeoCentroids } from "./geoShapes";
import type { Vec3 } from "./globeLayout";

// Alias (lowercase) -> ISO-2 for places the bundled NAME property misses, or that the
// model commonly refers to by a different name than the borders dataset uses.
const ALIASES: Record<string, string> = {
  usa: "us",
  "u.s.": "us",
  "u.s.a.": "us",
  "united states": "us",
  "united states of america": "us",
  america: "us",
  uk: "gb",
  "u.k.": "gb",
  britain: "gb",
  "great britain": "gb",
  england: "gb",
  russia: "ru",
  "russian federation": "ru",
  gaza: "ps",
  "gaza strip": "ps",
  palestine: "ps",
  "palestinian territories": "ps",
  "west bank": "ps",
  "south korea": "kr",
  "north korea": "kp",
  korea: "kr",
  iran: "ir",
  syria: "sy",
  myanmar: "mm",
  burma: "mm",
  "dr congo": "cd",
  drc: "cd",
  "democratic republic of congo": "cd",
  "democratic republic of the congo": "cd",
  congo: "cd",
  "ivory coast": "ci",
  "cote d'ivoire": "ci",
  "czech republic": "cz",
  czechia: "cz",
  uae: "ae",
  "united arab emirates": "ae",
  vietnam: "vn",
  laos: "la",
  venezuela: "ve",
  bolivia: "bo",
  tanzania: "tz",
  moldova: "md",
  taiwan: "tw",
};

export interface AskNameIndex {
  byIso2: Map<string, Vec3>;
  /** Lowercase country names + aliases -> centroid direction. */
  byName: Map<string, Vec3>;
}

/** Build the name/alias -> centroid index from the bundled country centroids. */
export function buildAskNameIndex(centroids: GeoCentroids): AskNameIndex {
  const byName = new Map<string, Vec3>();
  for (const c of centroids.countries) byName.set(c.name.toLowerCase(), c.dir);
  for (const [alias, iso2] of Object.entries(ALIASES)) {
    const dir = centroids.byIso2.get(iso2);
    if (dir) byName.set(alias, dir);
  }
  return { byIso2: centroids.byIso2, byName };
}

/** Resolve one place: the model's ISO2 first, then its label by name/alias (also
 *  trying each part of a compound label like "Gaza / Israel"). null if unlocatable. */
export function resolveAskPlace(label: string, iso2: string, idx: AskNameIndex): Vec3 | null {
  if (iso2) {
    const d = idx.byIso2.get(iso2.toLowerCase());
    if (d) return d;
  }
  const key = label.trim().toLowerCase();
  const exact = idx.byName.get(key);
  if (exact) return exact;
  for (const part of key.split(/[/,;]|\band\b|\bvs\.?\b/)) {
    const p = part.trim();
    const d = p ? idx.byName.get(p) : undefined;
    if (d) return d;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(s: string): string {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Scan free prose for distinct country names/aliases (longest match wins, so
 *  "South Sudan" beats "Sudan"), returning their directions. The fallback used when
 *  the model produced no usable place lines. */
export function scanCountries(
  text: string,
  idx: AskNameIndex,
  max = 8,
): { name: string; dir: Vec3 }[] {
  const hay = text.toLowerCase();
  const names = [...idx.byName.keys()]
    .filter((n) => n.length >= 4)
    .sort((a, b) => b.length - a.length);
  const out: { name: string; dir: Vec3 }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const re = new RegExp(`(?:^|[^a-z])${escapeRe(name)}(?:[^a-z]|$)`);
    if (!re.test(hay)) continue;
    const dir = idx.byName.get(name) as Vec3;
    const key = `${dir.x.toFixed(2)}|${dir.y.toFixed(2)}|${dir.z.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: titleCase(name), dir });
    if (out.length >= max) break;
  }
  return out;
}
