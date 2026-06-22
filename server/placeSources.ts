// Server-side PLACE-SOURCE loader. Returns the locally-discovered news outlets
// (Source[]) for a country — the feeds the automated pipeline found via Wikidata
// + Media Cloud + RSS autodiscovery (scripts/buildPlaceSources.ts). When a reader
// sets a place, feedService fetches these ON DEMAND so genuinely local coverage
// enters the pool (then the place gazetteer BOOST lifts it in the ranking).
//
// Source per country code:
//   src/data/placeSources/<cc>.json  — generated; absent until the pipeline runs
//   (so the place lens degrades gracefully to boost-only when no registry exists).
//
// Results are cached per country for the process lifetime.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Source } from "../src/types";

const cache = new Map<string, Source[]>();

/** Locally-discovered sources for a country code (empty when no registry exists). */
export function placeSourcesFor(country: string | undefined | null): Source[] {
  const cc = (country ?? "").toLowerCase().slice(0, 2);
  if (!cc) return [];
  const hit = cache.get(cc);
  if (hit) return hit;

  let sources: Source[] = [];
  const file = resolve(process.cwd(), "src/data/placeSources", `${cc}.json`);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) sources = parsed as Source[];
    } catch (e) {
      console.warn(`[placeSources] failed to parse ${file}:`, e instanceof Error ? e.message : e);
    }
  }
  cache.set(cc, sources);
  return sources;
}

/** Test-only: drop the cached registries. */
export function _clearPlaceSourcesCache(): void {
  cache.clear();
}
