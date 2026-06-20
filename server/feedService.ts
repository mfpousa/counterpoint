// Orchestrates the AI-first pipeline and caches the result.
//
//   fetch all feeds (server-side, no CORS)  ->  AI enrich (topic/lean/relevance)
//        ->  rank + diversify  ->  cache (TTL)  ->  serve
//
// A per-item enrichment cache survives refreshes so we never re-pay the model
// for an article we've already classified. A whole-feed cache (TTL) avoids
// re-running the pipeline on every request.

import SOURCES from "../src/data/sources";
import { fetchAll } from "../src/lib/rss";
import type { FeedItem } from "../src/types";
import { enrichItems, type Enrichment } from "./ai";
import { config } from "./config";
import { rankItems } from "./rank";

export interface FeedResult {
  items: FeedItem[];
  builtAt: number;
  fetched: number;
  enriched: number;
  durationMs: number;
}

// id -> enrichment we've already computed (cheap memory cache).
const enrichmentCache = new Map<string, Enrichment>();

let cached: FeedResult | null = null;
let inFlight: Promise<FeedResult> | null = null;

/** Apply a cached enrichment onto an item (same shape as ai.enrichItems). */
function applyCached(item: FeedItem, e: Enrichment): FeedItem {
  return {
    ...item,
    topic: e.topic,
    lean: e.lean,
    leanSource: "llm",
    relevance: e.relevance,
    aiReason: e.reason || undefined,
  };
}

async function build(): Promise<FeedResult> {
  const started = Date.now();
  const raw = await fetchAll(SOURCES);
  console.log(`[feed] fetched ${raw.length} items from ${SOURCES.length} sources`);

  // Split into already-enriched (from cache) vs. items still needing the model.
  const fromCache: FeedItem[] = [];
  const toEnrich: FeedItem[] = [];
  for (const it of raw) {
    const hit = enrichmentCache.get(it.id);
    if (hit) fromCache.push(applyCached(it, hit));
    else toEnrich.push(it);
  }

  const freshlyEnriched = await enrichItems(toEnrich);
  // Persist new enrichments to the cache for next time.
  for (const it of freshlyEnriched) {
    if (typeof it.relevance === "number" && it.leanSource === "llm") {
      enrichmentCache.set(it.id, {
        topic: it.topic,
        lean: it.lean,
        relevance: it.relevance,
        reason: it.aiReason ?? "",
      });
    }
  }

  const all = [...fromCache, ...freshlyEnriched];
  const ranked = rankItems(all);
  const enrichedCount = all.filter((i) => typeof i.relevance === "number").length;

  const result: FeedResult = {
    items: ranked,
    builtAt: Date.now(),
    fetched: raw.length,
    enriched: enrichedCount,
    durationMs: Date.now() - started,
  };
  console.log(
    `[feed] built ${ranked.length} ranked items (${enrichedCount} AI-enriched) in ${result.durationMs}ms`,
  );
  return result;
}

/** Get the feed, using the TTL cache. Concurrent callers share one build. */
export async function getFeed(force = false): Promise<FeedResult> {
  const fresh = cached && Date.now() - cached.builtAt < config.server.feedTtlMs;
  if (!force && fresh) return cached as FeedResult;
  if (inFlight) return inFlight;

  inFlight = build()
    .then((r) => {
      cached = r;
      return r;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop all caches (used by POST /api/refresh for a full rebuild). */
export function clearCaches(): void {
  cached = null;
  enrichmentCache.clear();
}
