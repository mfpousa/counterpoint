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
import type { Briefing, FeedItem } from "../src/types";
import { aiReachable } from "./ai";
import { analyzeItems, detectClickbait } from "./analysis";
import { generateBriefing } from "./briefing";
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

// Per-interest briefing cache (valid while builtAt matches) + in-flight dedupe.
const briefingCache = new Map<string, { builtAt: number; briefing: Briefing | null }>();
const briefingInFlight = new Map<string, Promise<Briefing | null>>();

/** Normalize interest text into a stable key (trim/lower/collapse ws). */
function interestKey(interest: string): string {
  return interest.trim().toLowerCase().replace(/\s+/g, " ").slice(0, config.feed.maxInterestLen);
}

/**
 * A throttled progress reporter for a long phase. Logs at most every ~2.5s
 * (plus the final 100%), with elapsed time, throughput, and a rough ETA, so a
 * multi-minute analysis pass shows steady progress instead of going silent.
 */
function progressLogger(label: string): (done: number, total: number) => void {
  const start = Date.now();
  let lastLog = 0;
  return (done, total) => {
    const now = Date.now();
    const finished = done >= total;
    if (!finished && now - lastLog < 2500) return;
    lastLog = now;
    const elapsed = (now - start) / 1000;
    const rate = done / Math.max(elapsed, 0.001); // items/sec
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    const tail = finished
      ? `done in ${elapsed.toFixed(0)}s`
      : `${elapsed.toFixed(0)}s elapsed, ~${Math.round((total - done) / Math.max(rate, 0.001))}s left` +
        ` (${rate.toFixed(1)}/s)`;
    console.log(`[feed] ${label}: ${done}/${total} (${pct}%) — ${tail}`);
  };
}

/**
 * Fetch everything and bring the store up to date: triage + analyze all NEW
 * items, persist, prune. Interest plays no part here.
 */
async function buildPool(): Promise<void> {
  const started = Date.now();
  console.log(`[feed] build starting — fetching ${SOURCES.length} sources…`);
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
    const triageBatches = Math.ceil(fresh.length / config.ai.triageBatchSize);
    console.log(
      `[feed] triage: starting ${fresh.length} headline(s) in ${triageBatches} batch(es)` +
        ` (concurrency ${config.ai.concurrency})…`,
    );
    junk = await detectClickbait(fresh, progressLogger("triage"));
    console.log(`[feed] triage flagged ${junk.size}/${fresh.length} as clickbait/junk`);
  }
  const survivors = fresh.filter((it) => !junk.has(it.id));

  // 2. Deep analysis of survivors (uncapped by default; AI_MAX_ITEMS can cap).
  const slice = config.ai.maxItems > 0 ? survivors.slice(0, config.ai.maxItems) : survivors;
  if (slice.length > 0) {
    console.log(`[feed] fetching transcripts for up to ${slice.length} item(s)…`);
  }
  const transcripts = await fetchTranscripts(slice);
  if (transcripts.size > 0) console.log(`[feed] fetched ${transcripts.size} transcript(s)`);
  if (slice.length > 0) {
    const analyzeBatches = Math.ceil(slice.length / config.ai.batchSize);
    console.log(
      `[feed] deep analysis: starting ${slice.length} item(s) in ${analyzeBatches} batch(es)` +
        ` (concurrency ${config.ai.concurrency})…`,
    );
  }
  const analyses = await analyzeItems(slice, transcripts, progressLogger("analyze"));
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
 * Synthesize (and cache) a "what's happening / where it's headed" briefing for
 * the interest, from the top of the ranked pool. Builds the pool first if
 * needed. Returns null when the model is unreachable or has nothing usable.
 */
export async function getBriefing(
  force = false,
  interest = config.feed.interest,
): Promise<Briefing | null> {
  await ensurePool(force);
  const key = interestKey(interest);

  const cached = briefingCache.get(key);
  if (cached && cached.builtAt === lastBuildAt) return cached.briefing;

  const existing = briefingInFlight.get(key);
  if (existing) return existing;

  const builtAtSnapshot = lastBuildAt;
  const p = (async (): Promise<Briefing | null> => {
    // Don't cache failures from an offline model — let a later request retry.
    if (!(await aiReachable())) return null;
    const view = assembleView(key);
    const sample = view.items.slice(0, 40);
    const started = Date.now();
    console.log(`[feed] briefing: synthesizing "${key || "general"}" from ${sample.length} item(s)…`);
    const briefing = await generateBriefing(key, sample);
    briefingCache.set(key, { builtAt: builtAtSnapshot, briefing });
    console.log(
      `[feed] briefing: ${briefing ? `${briefing.threads.length} thread(s)` : "none"}` +
        ` in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    return briefing;
  })().finally(() => briefingInFlight.delete(key));

  briefingInFlight.set(key, p);
  return p;
}

/**
 * Invalidate the freshness so the next request rebuilds (re-fetch + analyze new
 * items). The persisted analysis store is intentionally KEPT so we don't re-pay
 * the model for items we've already analyzed.
 */
export function clearCaches(): void {
  lastBuildAt = 0;
  viewCache.clear();
  briefingCache.clear();
}
