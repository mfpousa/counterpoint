// Pure, dependency-free ZONE detection: scan a story's text for the signal words
// that mark a geographic / affiliation zone as involved (e.g. "kyiv", "kremlin").
// The server uses this to decide which international sources to load REACTIVELY
// for a live story. Kept pure (no I/O, no model) so it's cheap and unit-testable.

import { ZONES } from "../data/zones";
import type { Zone } from "../types";

/** One zone's match strength for a piece of text. */
export interface ZoneScore {
  id: string;
  /** Number of DISTINCT aliases of the zone that appear in the text. */
  hits: number;
}

/** Unicode-aware lowercase token set (keeps accents: "türkiye", "erdoğan"). */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

/**
 * Score every zone against `text` by how many DISTINCT aliases it contains.
 * Single-word aliases match whole tokens (so "china" won't fire on "porcelain");
 * multi-word aliases ("hong kong", "kim jong un") match as substrings.
 * Returned highest-score first.
 */
export function scoreZones(text: string, zones: Zone[] = ZONES): ZoneScore[] {
  const lower = ` ${text.toLowerCase()} `;
  const tokens = tokenize(text);
  const scored: ZoneScore[] = [];
  for (const z of zones) {
    let hits = 0;
    for (const alias of z.aliases) {
      const a = alias.toLowerCase();
      const matched = a.includes(" ") ? lower.includes(a) : tokens.has(a);
      if (matched) hits += 1;
    }
    if (hits > 0) scored.push({ id: z.id, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || (a.id < b.id ? -1 : 1));
  return scored;
}

/**
 * Zone ids involved in `text`, strongest first. `minHits` is the minimum number
 * of distinct aliases required (2 is stricter — avoids a single passing mention
 * dragging in a whole region's outlets).
 */
export function detectZones(text: string, zones: Zone[] = ZONES, minHits = 1): string[] {
  return scoreZones(text, zones)
    .filter((s) => s.hits >= minHits)
    .map((s) => s.id);
}
