// Pure, dependency-free PLACE matching: given a reader's chosen place (country →
// region → locality) and a gazetteer of place nodes, score how relevant a piece
// of story text is to that place. This powers the geographic RELEVANCE BOOST —
// so a story about "Móstoles" surfaces even from a national feed — mirroring how
// src/lib/zones.ts handles international zones. Kept pure (no I/O, no model) so
// it's cheap to run per item and trivially unit-testable.
//
// The gazetteer itself is generated from open datasets (GeoNames + Wikidata) by
// scripts/buildGazetteer.ts; this module only consumes it.

import type { Place, PlaceNode } from "../types";

/** Per-level weight: a locality hit counts for more than a country hit. */
export const PLACE_LEVEL_WEIGHT: Record<PlaceNode["level"], number> = {
  locality: 3,
  region: 2,
  country: 1,
};

/** Unicode-aware lowercase token set (keeps accents: "móstoles", "lleida"). */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

/** Lowercase, accent- and punctuation-insensitive slug for matching free text. */
function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * How many DISTINCT aliases of a node appear in `text`. Single-word aliases match
 * whole tokens (so "leon" won't fire inside "napoleon"); multi-word aliases
 * ("comunidad de madrid") match as substrings.
 */
export function aliasHits(text: string, aliases: string[]): number {
  const lower = ` ${text.toLowerCase()} `;
  const tokens = tokenize(text);
  let hits = 0;
  const seen = new Set<string>();
  for (const alias of aliases) {
    const a = alias.toLowerCase().trim();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    const matched = a.includes(" ") ? lower.includes(a) : tokens.has(a);
    if (matched) hits += 1;
  }
  return hits;
}

/**
 * Resolve a reader's `Place` selection to the chain of gazetteer nodes it spans:
 * [country, region?, locality?]. The locality is free text, so it's resolved by
 * matching its slug against a locality node's id/label/aliases within the chosen
 * country (and region, when set). When no node matches, an AD-HOC locality node
 * is synthesized from the raw text so the boost still works for unknown places.
 */
export function resolveChain(place: Place, nodes: PlaceNode[]): PlaceNode[] {
  const chain: PlaceNode[] = [];
  const country = nodes.find((n) => n.level === "country" && n.id === place.country);
  if (country) chain.push(country);

  let region: PlaceNode | undefined;
  if (place.region) {
    region = nodes.find((n) => n.level === "region" && n.id === place.region);
    if (region) chain.push(region);
  }

  if (place.locality) {
    const want = slug(place.locality);
    const inScope = (n: PlaceNode) =>
      n.level === "locality" &&
      n.country === place.country &&
      (!region || n.parent === region.id);
    const match = nodes.find(
      (n) =>
        inScope(n) &&
        (slug(n.label) === want ||
          n.id.endsWith(`-${want}`) ||
          n.aliases.some((a) => slug(a) === want)),
    );
    chain.push(
      match ?? {
        id: `${region?.id ?? place.country}-${want}`,
        parent: region?.id ?? place.country,
        level: "locality",
        label: place.locality,
        country: place.country,
        aliases: [place.locality.toLowerCase()],
      },
    );
  }

  return chain;
}

/** The union of all aliases along a place's chain (country + region + locality). */
export function placeAliases(place: Place, nodes: PlaceNode[]): string[] {
  const set = new Set<string>();
  for (const n of resolveChain(place, nodes)) for (const a of n.aliases) set.add(a.toLowerCase());
  return [...set];
}

/**
 * Weighted relevance of `text` to a place: sum over the chain of
 * (level weight × distinct alias hits). 0 means "not about this place". The
 * weighting makes a locality mention outrank a mere country mention, so a feed
 * lensed to a council ranks genuinely local stories above national ones.
 */
export function scorePlace(text: string, place: Place, nodes: PlaceNode[]): number {
  let score = 0;
  for (const n of resolveChain(place, nodes)) {
    score += PLACE_LEVEL_WEIGHT[n.level] * aliasHits(text, n.aliases);
  }
  return score;
}

/** Whether `text` is relevant to a place at or above `minScore` (default 1). */
export function isPlaceRelevant(
  text: string,
  place: Place,
  nodes: PlaceNode[],
  minScore = 1,
): boolean {
  return scorePlace(text, place, nodes) >= minScore;
}

/** Tuning for {@link placeBoostedRelevance}. */
export interface PlaceBoostOptions {
  /** 0..1 — how strongly a full place match lifts relevance toward 1. */
  boostWeight?: number;
  /** Place score at/above which the boost is fully applied (saturates). */
  saturateAt?: number;
}

/**
 * Lift an item's 0..1 `relevance` toward 1 in proportion to how strongly its text
 * matches a place (`score` from {@link scorePlace}), saturating so a single strong
 * local hit is enough. Pure: never exceeds 1, never LOWERS relevance, and returns
 * it unchanged when there's no match (score 0) or the boost is disabled (weight 0).
 */
export function placeBoostedRelevance(
  relevance: number,
  score: number,
  opts: PlaceBoostOptions = {},
): number {
  const w = opts.boostWeight ?? 0.5;
  const sat = Math.max(1, opts.saturateAt ?? 3);
  if (score <= 0 || w <= 0) return relevance;
  const strength = Math.min(1, score / sat);
  return Math.min(1, relevance + w * strength * (1 - relevance));
}

/** Human label for a place chain, e.g. "Spain · Madrid · Móstoles" (for UI chips). */
export function placeLabel(place: Place, nodes: PlaceNode[]): string {
  const chain = resolveChain(place, nodes);
  if (chain.length === 0) return place.locality ?? place.region ?? place.country;
  return chain.map((n) => n.label).join(" · ");
}
