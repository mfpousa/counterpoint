// Orchestrates the AI-first pipeline.
//
//   fetch all feeds (server-side, no CORS)
//     -> clickbait triage (drop junk)
//     -> deep AI analysis of every NEW item (topic/lean/importance/summary/keywords)
//     -> persist to the on-disk store (reused across restarts & interests)
//     -> per-request: personalize (interest match) + rank + diversify -> serve
//
// The expensive analysis is interest-INDEPENDENT and persisted, so:
//  - restarts reuse prior analysis (only genuinely new items hit the model);
//  - changing the reader's interest re-ranks the cached pool instantly, with
//    no new model calls.

import SOURCES from "../src/data/sources";
import { fetchAll } from "../src/lib/rss";
import type { FeedItem } from "../src/types";
import { aiReachable } from "./ai";
import { analyzeItems, detectClickbait } from "./analysis";
import { config } from "./config";
import { interestTokens, toFeedItem } from "./personalize";
import { rankItems } from "./rank";
import {
  allStored,
  hasStored,
  pruneStore,
  saveStore,
  storeSize,
  upsertStored,
} from "./store";
import { fetchTranscripts } from "./transcripts";

export interface FeedResult {
  items: FeedItem[];
  builtAt: number;
  /** Items currently in the store (analyzed pool size). */
  fetched: number;
  /** Items eligible for the feed (analyzed, non-clickbait, in window). */
  enriched: number;
  durationMs: number;
  interest: string;
}

// Timestamp of the last interest-independent pool build, the in-flight build,
// and a small cache of assembled per-interest views (valid while builtAt matches).
let lastBuildAt = 0;
let buildInFlight: Promise<void> | null = null;
const viewCache = new Map<string, { builtAt: number; result: FeedResult }>();

/** Normalize interest text into a stable key (trim/lower/collapse ws). */
function interestKey(interest: string): string {
  return interest.trim().toLowerCase().replace(/\s+/g, " ").slice(0, config.feed.maxInterestLen);
}

/**
 * Fetch everything and bring the store up to date: triage + analyze all NEW
 * items, persist, prune. Interest plays no part here.
 */
async function buildPool(): Promise<void> {
  const started = Date.now();
  const raw = await fetchAll(SOURCES);
  console.log(`[feed] fetched ${raw.length} items from ${SOURCES.length} sources`);

  // Only items we've never seen need any model work.
  const fresh = raw.filter((it) => !hasStored(it.id));
  console.log(`[feed] ${fresh.length} new item(s); ${storeSize()} already analyzed in store`);

  // Fail fast if the model is down: skip both passes (hundreds of doomed
  // requests) and keep whatever we already have. Mark the build done so we
  // don't hammer a missing endpoint on every request; the TTL will retry.
  if (fresh.length > 0 && !(await aiReachable())) {
    console.warn("[feed] AI endpoint unreachable — skipping analysis this build.");
    lastBuildAt = Date.now();
    return;
  }

  // 1. Clickbait triage (cheap, title-only) — drop junk before deep analysis.
  let junk = new Set<string>();
  if (config.feed.clickbaitFilter && fresh.length > 0) {
    junk = await detectClickbait(fresh);
    console.log(`[feed] triage flagged ${junk.size}/${fresh.length} as clickbait/junk`);
  }
  const survivors = fresh.filter((it) => !junk.has(it.id));

  // 2. Deep analysis of survivors (uncapped by default; AI_MAX_ITEMS can cap).
  const slice = config.ai.maxItems > 0 ? survivors.slice(0, config.ai.maxItems) : survivors;
  const transcripts = await fetchTranscripts(slice);
  if (transcripts.size > 0) console.log(`[feed] fetched ${transcripts.size} transcript(s)`);
  const analyses = await analyzeItems(slice, transcripts);
  console.log(`[feed] analyzed ${analyses.size}/${slice.length} item(s)`);

  // 3. Persist results. Clickbait items are remembered (so we never re-triage);
  //    analyzed items carry their analysis. Items neither flagged nor analyzed
  //    (over the cap or a failed batch) are intentionally left unstored so a
  //    later build retries them.
  const now = Date.now();
  for (const it of fresh) {
    if (junk.has(it.id)) {
      upsertStored({
        item: it,
        clickbait: true,
        analyzed: false,
        topic: it.topic,
        lean: it.lean,
        importance: 0,
        summary: "",
        keywords: [],
        analyzedAt: now,
      });
      continue;
    }
    const a = analyses.get(it.id);
    if (a) {
      upsertStored({
        item: it,
        clickbait: false,
        analyzed: true,
        topic: a.topic,
        lean: a.lean,
        importance: a.importance,
        summary: a.summary,
        keywords: a.keywords,
        analyzedAt: now,
      });
    }
  }

  const removed = pruneStore(now);
  if (removed > 0) console.log(`[feed] pruned ${removed} stale item(s)`);
  saveStore();

  lastBuildAt = Date.now();
  console.log(`[feed] pool ready: ${storeSize()} stored in ${lastBuildAt - started}ms`);
}

/** Ensure the pool is fresh (TTL) or forced; concurrent callers share one build. */
async function ensurePool(force: boolean): Promise<void> {
  const fresh =
    !force &&
    lastBuildAt > 0 &&
    storeSize() > 0 &&
    Date.now() - lastBuildAt < config.server.feedTtlMs;
  if (fresh) return;
  if (!buildInFlight) {
    buildInFlight = buildPool().finally(() => {
      buildInFlight = null;
    });
  }
  await buildInFlight;
}

/** Assemble (and cache) the ranked feed for a given interest from the pool. */
function assembleView(interest: string): FeedResult {
  const key = interestKey(interest);
  const cached = viewCache.get(key);
  if (cached && cached.builtAt === lastBuildAt) return cached.result;

  const started = Date.now();
  const tokens = interestTokens(key);
  const hasInterest = tokens.size > 0;
  const now = Date.now();

  const pool = allStored()
    .filter(
      (s) => !s.clickbait && s.analyzed && now - s.item.publishedAt <= config.feed.retentionMs,
    )
    .map((s) => toFeedItem(s, tokens, hasInterest));

  const ranked = rankItems(pool);
  const result: FeedResult = {
    items: ranked,
    builtAt: lastBuildAt,
    fetched: storeSize(),
    enriched: pool.length,
    durationMs: Date.now() - started,
    interest: key,
  };
  viewCache.set(key, { builtAt: lastBuildAt, result });
  console.log(
    `[feed] view "${key}" -> ${ranked.length} items from ${pool.length} eligible` +
      ` in ${result.durationMs}ms`,
  );
  return result;
}

/**
 * Get the ranked feed for an interest. Builds/refreshes the analyzed pool as
 * needed (TTL-cached), then personalizes + ranks it for the interest.
 */
export async function getFeed(force = false, interest = config.feed.interest): Promise<FeedResult> {
  await ensurePool(force);
  return assembleView(interest);
}

/**
 * Invalidate the freshness so the next request rebuilds (re-fetch + analyze new
 * items). The persisted analysis store is intentionally KEPT so we don't re-pay
 * the model for items we've already analyzed.
 */
export function clearCaches(): void {
  lastBuildAt = 0;
  viewCache.clear();
}
