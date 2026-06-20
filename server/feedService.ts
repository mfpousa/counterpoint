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
import { embedQuery, embedTexts, itemEmbedText } from "./embeddings";
import { interestTokens, toFeedItem } from "./personalize";
import { rankItems } from "./rank";
import {
  allStored,
  hasStored,
  pruneStore,
  saveStore,
  storeSize,
  upsertStored,
  type StoredItem,
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

// Live build progress, surfaced to the UI via /api/status so users can watch
// the (potentially long) analysis advance instead of staring at a spinner.
type BuildPhase = "idle" | "fetching" | "triage" | "transcripts" | "analyzing";
let buildStatus: { phase: BuildPhase; done: number; total: number } = {
  phase: "idle",
  done: 0,
  total: 0,
};
function setPhase(phase: BuildPhase, done = 0, total = 0): void {
  buildStatus = { phase, done, total };
}

export interface AnalysisStatus {
  /** Current build phase ("idle" when nothing is running). */
  phase: BuildPhase;
  /** Whether a build/analysis is currently active. */
  active: boolean;
  /** Items completed in the current pass. */
  done: number;
  /** Items in the current pass. */
  total: number;
  /** Items still awaiting deep analysis (within the recency window). */
  pending: number;
  /** Items analyzed and eligible for the feed (within the recency window). */
  analyzed: number;
}

/** Snapshot of build/analysis progress for the UI. */
export function getStatus(): AnalysisStatus {
  const cutoff = analyzeCutoff();
  let pending = 0;
  let analyzed = 0;
  for (const s of allStored()) {
    if (s.clickbait || s.item.publishedAt < cutoff) continue;
    if (s.analyzed) analyzed += 1;
    else pending += 1;
  }
  const active = buildStatus.phase !== "idle" || buildInFlight !== null || analyzeInFlight !== null;
  return { phase: buildStatus.phase, active, done: buildStatus.done, total: buildStatus.total, pending, analyzed };
}

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
    setPhase(label === "triage" ? "triage" : "analyzing", done, total);
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

/** Oldest publish time eligible for analysis (keeps the backlog tractable). */
function analyzeCutoff(now = Date.now()): number {
  return now - config.feed.analyzeMaxAgeMs;
}

/** The recency-ordered backlog of items still needing deep analysis. */
function pendingForAnalysis(): StoredItem[] {
  const cutoff = analyzeCutoff();
  return allStored()
    .filter((s) => !s.clickbait && !s.analyzed && s.item.publishedAt >= cutoff)
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt);
}

/**
 * Network phase: fetch all sources, triage brand-new & recent items, and store
 * them — junk flagged, survivors marked PENDING (analyzed:false). Deep analysis
 * is deferred to analyzePending() so the build is chunked, not a multi-hour block.
 */
async function refreshSources(): Promise<void> {
  const started = Date.now();
  setPhase("fetching");
  console.log(`[feed] refresh — fetching ${SOURCES.length} sources…`);
  const raw = await fetchAll(SOURCES);
  const cutoff = analyzeCutoff();
  // Never-seen items inside the recency window are all that need triage.
  const untriaged = raw.filter((it) => !hasStored(it.id) && it.publishedAt >= cutoff);
  console.log(
    `[feed] fetched ${raw.length}; ${untriaged.length} new & recent to triage; ${storeSize()} in store`,
  );

  if (untriaged.length > 0) {
    // Fail fast if the model is down: don't store half-processed items; retry later.
    if (!(await aiReachable())) {
      console.warn("[feed] AI endpoint unreachable — skipping triage this refresh.");
      lastBuildAt = Date.now();
      setPhase("idle");
      return;
    }
    let junk = new Set<string>();
    if (config.feed.clickbaitFilter) {
      const batches = Math.ceil(untriaged.length / config.ai.triageBatchSize);
      console.log(`[feed] triage: ${untriaged.length} headline(s) in ${batches} batch(es)…`);
      junk = await detectClickbait(untriaged, progressLogger("triage"));
      console.log(`[feed] triage flagged ${junk.size}/${untriaged.length} as clickbait/junk`);
    }
    for (const it of untriaged) {
      upsertStored({
        item: it,
        clickbait: junk.has(it.id),
        analyzed: false, // deep analysis pending
        topic: it.topic,
        lean: it.lean,
        importance: 0,
        summary: "",
        keywords: [],
        analyzedAt: 0,
      });
    }
  }

  const removed = pruneStore();
  if (removed > 0) console.log(`[feed] pruned ${removed} stale item(s)`);
  saveStore();
  lastBuildAt = Date.now();
  console.log(`[feed] refresh done in ${lastBuildAt - started}ms`);
}

// Dedupe concurrent chunk analysis (background catch-up + a user request).
let analyzeInFlight: Promise<{ remaining: number; progressed: number }> | null = null;

/**
 * Deep-analyze ONE chunk (config.ai.maxItems) of the pending backlog, newest
 * first, and persist. Returns the remaining backlog and how many we completed,
 * so the caller can decide whether to schedule another chunk.
 */
function analyzePending(): Promise<{ remaining: number; progressed: number }> {
  if (analyzeInFlight) return analyzeInFlight;
  analyzeInFlight = (async () => {
    const pending = pendingForAnalysis();
    if (pending.length === 0) {
      setPhase("idle");
      return { remaining: 0, progressed: 0 };
    }
    if (!(await aiReachable())) {
      setPhase("idle");
      return { remaining: pending.length, progressed: 0 };
    }

    const slice = config.ai.maxItems > 0 ? pending.slice(0, config.ai.maxItems) : pending;
    const items = slice.map((s) => s.item);

    setPhase("transcripts", 0, items.length);
    console.log(`[feed] fetching transcripts for up to ${items.length} item(s)…`);
    const transcripts = await fetchTranscripts(items);
    if (transcripts.size > 0) console.log(`[feed] fetched ${transcripts.size} transcript(s)`);

    const batches = Math.ceil(items.length / config.ai.batchSize);
    console.log(
      `[feed] deep analysis: ${items.length} of ${pending.length} pending in ${batches} batch(es)` +
        ` (concurrency ${config.ai.concurrency})…`,
    );
    const analyses = await analyzeItems(items, transcripts, progressLogger("analyze"));

    const now = Date.now();
    let progressed = 0;
    for (const s of slice) {
      const a = analyses.get(s.item.id);
      if (!a) continue;
      upsertStored({
        ...s,
        analyzed: true,
        topic: a.topic,
        lean: a.lean,
        importance: a.importance,
        summary: a.summary,
        keywords: a.keywords,
        analyzedAt: now,
      });
      progressed += 1;
    }

    saveStore();
    // Fresh analyses are now available — invalidate assembled views/briefings.
    lastBuildAt = Date.now();
    viewCache.clear();
    briefingCache.clear();

    const remaining = pendingForAnalysis().length;
    if (remaining === 0) setPhase("idle");
    console.log(`[feed] analyzed ${progressed}/${items.length}; ${remaining} still pending`);
    return { remaining, progressed };
  })().finally(() => {
    analyzeInFlight = null;
  });
  return analyzeInFlight;
}

/** Analyzed items (in window) still lacking a semantic embedding, newest first. */
function pendingForEmbedding(): StoredItem[] {
  if (!config.ai.embeddingsEnabled) return [];
  const cutoff = analyzeCutoff();
  return allStored()
    .filter((s) => !s.clickbait && s.analyzed && !s.embedding && s.item.publishedAt >= cutoff)
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt);
}

let embedInFlight: Promise<{ remaining: number; progressed: number }> | null = null;

/**
 * Embed ONE chunk of analyzed-but-unembedded items (newest first) and persist.
 * Best-effort: if embeddings are unavailable (no model loaded), every vector
 * comes back null, we make no progress, and report nothing remaining so the
 * background loop stops instead of spinning.
 */
function embedPending(): Promise<{ remaining: number; progressed: number }> {
  if (embedInFlight) return embedInFlight;
  embedInFlight = (async () => {
    const pending = pendingForEmbedding();
    if (pending.length === 0) return { remaining: 0, progressed: 0 };

    // Reuse the analysis chunk size for the embedding chunk.
    const slice = config.ai.maxItems > 0 ? pending.slice(0, config.ai.maxItems) : pending;
    const texts = slice.map((s) => itemEmbedText(s.item.title, s.summary, s.keywords));
    console.log(`[feed] embedding ${slice.length} of ${pending.length} item(s)…`);
    const vecs = await embedTexts(texts);

    let progressed = 0;
    slice.forEach((s, i) => {
      const v = vecs[i];
      if (v && v.length > 0) {
        upsertStored({ ...s, embedding: v });
        progressed += 1;
      }
    });

    if (progressed > 0) {
      saveStore();
      // New embeddings change interest matching — invalidate assembled views.
      lastBuildAt = Date.now();
      viewCache.clear();
      briefingCache.clear();
    }
    // If nothing embedded, embeddings are unavailable: stop the loop.
    const remaining = progressed > 0 ? pendingForEmbedding().length : 0;
    console.log(`[feed] embedded ${progressed}/${slice.length}; ${remaining} still need embeddings`);
    return { remaining, progressed };
  })().finally(() => {
    embedInFlight = null;
  });
  return embedInFlight;
}

let catchUpTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a background chunk to keep chewing through analysis + embedding backlogs. */
function scheduleCatchUp(): void {
  if (catchUpTimer) return;
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null;
    void (async () => {
      try {
        const a = await analyzePending();
        // Only embed once a chunk's analysis is in (embedding needs the summary).
        const e = await embedPending();
        const moreWork =
          (a.remaining > 0 && a.progressed > 0) || (e.remaining > 0 && e.progressed > 0);
        if (moreWork) scheduleCatchUp();
        else if (a.remaining > 0) console.warn(`[feed] catch-up stalled with ${a.remaining} pending`);
        else console.log("[feed] analysis + embedding backlog cleared");
      } catch (err) {
        console.warn("[feed] catch-up failed:", err);
      }
    })();
  }, config.feed.catchUpDelayMs);
}

/**
 * Bring the store up to date, then analyze the FIRST chunk so the feed is usable
 * quickly. Any remaining backlog is drained in the background (non-blocking).
 */
async function buildPool(): Promise<void> {
  await refreshSources();
  const a = await analyzePending();
  const e = await embedPending();
  const moreWork = (a.remaining > 0 && a.progressed > 0) || (e.remaining > 0 && e.progressed > 0);
  if (moreWork) {
    console.log(
      `[feed] backlog — ${a.remaining} to analyze, ${e.remaining} to embed; continuing in background`,
    );
    scheduleCatchUp();
  }
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

/**
 * Assemble (and cache) the ranked feed for a given interest from the pool.
 * `queryVec` (the interest's embedding) enables SEMANTIC matching; when absent
 * (no embedding model / empty interest), toFeedItem falls back to keywords.
 */
function assembleView(interest: string, queryVec?: number[] | null): FeedResult {
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
    .map((s) => toFeedItem(s, tokens, hasInterest, queryVec));

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
  const mode = hasInterest ? (queryVec ? "semantic" : "keyword") : "general";
  console.log(
    `[feed] view "${key}" (${mode}) -> ${ranked.length} items from ${pool.length} eligible` +
      ` in ${result.durationMs}ms`,
  );
  return result;
}

/**
 * Get the ranked feed for an interest. Builds/refreshes the analyzed pool as
 * needed (TTL-cached), then personalizes + ranks it for the interest. The
 * interest is embedded once (cached) for semantic matching.
 */
export async function getFeed(force = false, interest = config.feed.interest): Promise<FeedResult> {
  await ensurePool(force);
  const queryVec = await embedQuery(interest);
  return assembleView(interest, queryVec);
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
    const queryVec = await embedQuery(key);
    const view = assembleView(key, queryVec);
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
