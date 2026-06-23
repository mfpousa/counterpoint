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

import { fetchAll } from "../src/lib/rss";
import type { AnalysisStatus, Briefing, FeedItem, Lang, Story } from "../src/types";
import { DEFAULT_WORLD_ID, WORLDS, isPlaceWorldId, placeCountryOf, worldSources } from "../src/data/worlds";
import {
  geoNodeIdOf,
  GEO_ROOT_ID,
  isGeoPoolId,
  poolIdForNode,
  type GeoNode,
} from "../src/data/geo";
import {
  childrenOf,
  coverageStateOf,
  geoLabel,
  geoNode,
  pathOf,
  sourcesForGeoNode,
  type CoverageState,
} from "./geoTree";
import { ZONES, ZONES_BY_ID } from "../src/data/zones";
import { detectZones } from "../src/lib/zones";
import { gazetteerFor } from "./places";
import { placeSourcesFor } from "./placeSources";
import { dedupeNearClones } from "./dedupe";
import { interleaveByRecencyBuckets } from "./fairness";
import type { Source } from "../src/types";
import { aiReachable, withConcurrency } from "./ai";
import {
  analyzeItems,
  classifyGlobalScope,
  detectClickbait,
  prescreenGeo,
  prescreenRegional,
  type ItemAnalysis,
} from "./analysis";
import { generateBriefing, generateBriefingStream } from "./briefing";
import {
  clusterItems,
  coverageOf,
  groupIntoIssues,
  isDevelopingIssue,
  jaccard,
  rankClusters,
  titleTokens,
  type ClusterInput,
} from "./cluster";
import { config } from "./config";
import { cosineSim, embedQuery, embedTexts, itemEmbedText } from "./embeddings";
import { interestTokens, partitionByExclusion, toFeedItem, tokenize } from "./personalize";
import { interpretQuery, type ParsedQuery } from "./query";
import { rankItems } from "./rank";
import { getStore, storedAcrossPools, type StoredItem } from "./store";
import { getStoryStore, type StoryKind } from "./storyStore";
import { buildDevelopingStory, buildStory } from "./synthesize";
import { fetchTranscripts } from "./transcripts";
import {
  cleanHeadlineQuery,
  searchYouTube,
  youTubeSearchDisabled,
  type YouTubeHit,
} from "./youtubeSearch";

export interface FeedResult {
  items: FeedItem[];
  builtAt: number;
  /** Items currently in the store (analyzed pool size). */
  fetched: number;
  /** Items eligible for the feed (analyzed, non-clickbait, in window). */
  enriched: number;
  durationMs: number;
  interest: string;
  /** The world this feed was assembled for. */
  world: string;
  /** If a DIFFERENT world is refreshing (only one at a time), its id; this world
   *  then served whatever it already had (possibly stale/empty). */
  busyWith?: string | null;
}

// Live build progress, surfaced to the UI via /api/status so users can watch
// the (potentially long) analysis advance instead of staring at a spinner.
type BuildPhase =
  | "idle"
  | "fetching"
  | "triage"
  | "transcripts"
  | "analyzing"
  | "embedding"
  | "synthesizing";

/** All mutable build/cache state for ONE world. */
interface WorldState {
  worldId: string;
  /** Timestamp of this world's last pool build (for TTL + cache validity). */
  lastBuildAt: number;
  status: { phase: BuildPhase; done: number; total: number };
  /** Assembled per-interest views (valid while builtAt matches lastBuildAt). */
  viewCache: Map<string, { builtAt: number; result: FeedResult }>;
  briefingCache: Map<string, { builtAt: number; briefing: Briefing | null }>;
  briefingInFlight: Map<string, Promise<Briefing | null>>;
  /** Synthesized cross-source stories, keyed by language (valid while
   *  builtAt === lastBuildAt). */
  storiesCache: Map<string, { builtAt: number; builtWallAt: number; stories: Story[] }>;
  storiesInFlight: Map<string, Promise<Story[]>>;
  /** Fetched-but-not-yet-prescreened items, drained in chunks by the catch-up
   *  loop so a flood doesn't block the cold-start feed. */
  prescreenQueue: FeedItem[];
  buildInFlight: Promise<void> | null;
  analyzeInFlight: Promise<{ remaining: number; progressed: number }> | null;
  embedInFlight: Promise<{ remaining: number; progressed: number }> | null;
  /** Reactive augmentation pass — YouTube + intl zones (fire-and-forget, one per world). */
  augmentInFlight: Promise<void> | null;
  /** Per-zone last fetch time (epoch ms), for the reactive-load TTL. */
  zoneFetchedAt: Map<string, number>;
  catchUpTimer: ReturnType<typeof setTimeout> | null;
  /** Epoch ms of this pool's last status poll — its "is anyone looking?" signal. */
  lastWatchedAt: number;
  /** True when the catch-up loop stopped for lack of a viewer (resumes on return). */
  catchUpPaused: boolean;
  /** Cached near-clone DEDUP for a GEO pool, keyed by survivor COUNT. The dedup is
   *  O(n²) and used to run on EVERY status poll + view build (the server stuttered while
   *  busy). Analysis only flips `analyzed` flags — it never adds/removes items — so the
   *  cluster STRUCTURE is stable until prescreen/prune change the set; we re-resolve to
   *  live items each call, so the un-analyzed filter stays fresh. */
  geoDedup:
    | { key: number; clusters: { repId: string; memberIds: string[]; sourceCount: number }[] }
    | null;
}

const worldStates = new Map<string, WorldState>();

function ws(worldId: string): WorldState {
  let s = worldStates.get(worldId);
  if (!s) {
    s = {
      worldId,
      lastBuildAt: 0,
      status: { phase: "idle", done: 0, total: 0 },
      viewCache: new Map(),
      briefingCache: new Map(),
      briefingInFlight: new Map(),
      storiesCache: new Map(),
      storiesInFlight: new Map(),
      prescreenQueue: [],
      buildInFlight: null,
      analyzeInFlight: null,
      embedInFlight: null,
      augmentInFlight: null,
      zoneFetchedAt: new Map(),
      catchUpTimer: null,
      lastWatchedAt: 0,
      catchUpPaused: false,
      geoDedup: null,
    };
    worldStates.set(worldId, s);
  }
  return s;
}

// GLOBAL model mutex. Deep analysis, triage, and embedding all hit the SAME local
// model server, which serves one heavy request at a time, so we serialize those
// passes across ALL worlds to avoid overloading it. Crucially the lock is held
// only for ONE pass and released BETWEEN chunks — so a world switch can interleave
// its own fetch/triage/first chunk instead of waiting for another world's entire
// backlog to drain. This is what makes switching worlds responsive while a big
// drain is in progress (the old single-build lock blocked it for minutes/hours).
let modelChain: Promise<unknown> = Promise.resolve();
function withModelLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = modelChain.then(fn, fn);
  // Keep the chain alive regardless of any individual pass failing.
  modelChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function setPhase(state: WorldState, phase: BuildPhase, done = 0, total = 0): void {
  state.status = { phase, done, total };
}

/** A pool is WATCHED while the client keeps polling its status (every ~3s). The
 *  background catch-up loop only advances watched pools, so we never burn the
 *  model on a pool nobody's looking at. */
function isWatched(worldId: string): boolean {
  return Date.now() - ws(worldId).lastWatchedAt < config.feed.watchedTtlMs;
}

/** Heartbeat: record that the reader is looking at this pool (called on every
 *  status poll). If its catch-up loop had PAUSED for lack of a viewer, resume it. */
function markWatched(worldId: string): void {
  const state = ws(worldId);
  state.lastWatchedAt = Date.now();
  if (state.catchUpPaused) {
    state.catchUpPaused = false;
    console.log(`[feed:${worldId}] catch-up resumed — pool watched again`);
    scheduleCatchUp(worldId);
  }
}

/** Human-readable name of the place/world a status refers to (shown in the UI as
 *  'Updating <place>'): the geo node's label for geo pools, the country for regional
 *  pools, else the topical world's title. */
function poolLabel(worldId: string): string {
  if (isGeoPoolId(worldId)) return geoLabel(geoNodeIdOf(worldId)) || "World";
  const cc = placeCountryOf(worldId);
  if (cc) return placeLabelFor(cc);
  return WORLDS.find((w) => w.id === worldId)?.title ?? worldId;
}

/** Snapshot of build/analysis progress for a world, for the UI. */
export function getStatus(worldId: string = DEFAULT_WORLD_ID): AnalysisStatus {
  // Every status poll is a heartbeat that this pool is being watched — and the
  // trigger that resumes a catch-up loop paused while the reader was away.
  markWatched(worldId);
  const state = ws(worldId);
  const st = getStore(worldId);
  const cutoff = analyzeCutoff();
  let analyzed = 0;
  for (const s of st.all()) {
    if (s.clickbait || s.item.publishedAt < cutoff) continue;
    if (s.analyzed) analyzed += 1;
  }
  // Remaining = queued-but-not-yet-prescreened + what the analyzer WILL actually deep-
  // analyze (the capped/deduped set), NOT every un-analyzed item. Counting the whole
  // un-analyzed store is what made capped geo/place pools show a backlog that never
  // drained — "N pending" stuck forever even though the server was done. Mirroring
  // pendingForAnalysis makes the indicator reach completion when the analyzer does.
  const pending = state.prescreenQueue.length + pendingForAnalysis(worldId).length;
  const active =
    state.status.phase !== "idle" ||
    state.buildInFlight !== null ||
    state.analyzeInFlight !== null ||
    state.prescreenQueue.length > 0 ||
    state.catchUpTimer !== null;
  // Worlds no longer block each other (model passes serialize on a mutex but each
  // world builds independently), so nothing is ever "busy with" another world.
  return {
    phase: state.status.phase,
    active,
    done: state.status.done,
    total: state.status.total,
    pending,
    analyzed,
    world: worldId,
    label: poolLabel(worldId),
    busyWith: null,
  };
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
function progressLogger(state: WorldState, label: string): (done: number, total: number) => void {
  const start = Date.now();
  let lastLog = 0;
  return (done, total) => {
    setPhase(state, label === "triage" ? "triage" : "analyzing", done, total);
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
    console.log(`[feed:${state.worldId}] ${label}: ${done}/${total} (${pct}%) — ${tail}`);
  };
}

/** Oldest publish time eligible for analysis (keeps the backlog tractable). */
function analyzeCutoff(now = Date.now()): number {
  return now - config.feed.analyzeMaxAgeMs;
}

/** The backlog of items still needing deep analysis. Items the cheap triage pass
 *  judged clickbait — or GLOBAL in a regional pool — are excluded (they'd be kept
 *  out of the feed anyway, so we never pay the expensive pass on them).
 *
 *  REGIONAL pools additionally cap the backlog to the top-N local survivors by
 *  COARSE (prescreen) importance: local outlets flood the pool but only a few
 *  hundred reach the reader, so deep-analyzing the long tail is wasted tokens.
 *  The cut is taken over ALL in-window survivors (analyzed + pending) so it stays
 *  stable as items get analyzed — we never deep-analyze more than N locals — and
 *  the returned backlog is importance-ordered so the most newsworthy go first. */
function pendingForAnalysis(worldId: string): StoredItem[] {
  // GEO pools deep-analyze only the top-N near-clone CLUSTERS (see planGeoAnalysis +
  // analyzeGeoChunk), so the "pending" set MUST mirror that — the still-unanalyzed
  // cluster representatives. The generic all-unanalyzed list (below) is what made
  // items BEYOND the cap (and clones not yet folded into a rep) show as provisional
  // FOREVER: they were served to the feed but the analyzer never reached them, so
  // they stayed "analyzing" across every refresh. Mirroring the plan fixes it — every
  // provisional geo item is now one the analyzer WILL reach (and the long tail beyond
  // the cap is simply not shown, never stuck).
  if (isGeoPoolId(worldId)) {
    return planGeoAnalysis(worldId, config.geo.deepAnalyzeKeep)
      .filter((c) => !c.rep.analyzed)
      .map((c) => c.rep);
  }
  const cutoff = analyzeCutoff();
  const all = getStore(worldId).all();
  if (isPlaceWorldId(worldId) && config.place.deepAnalyzeKeep > 0) {
    const survivors = all.filter(
      (s) => !s.clickbait && s.global !== true && s.item.publishedAt >= cutoff,
    );
    // topLocalBacklog caps WHICH locals earn the deep pass (top-N by importance);
    // orderBacklog then sequences them freshest-first for analysis priority.
    return orderBacklog(topLocalBacklog(survivors, config.place.deepAnalyzeKeep));
  }
  const pending = all.filter(
    (s) => !s.clickbait && !s.analyzed && s.global !== true && s.item.publishedAt >= cutoff,
  );
  return orderBacklog(pending);
}

/** Best-first ordering for the backlog/provisional set: coarse newsworthiness
 *  first (the cheap triage importance), recency breaking ties. */
function byImportanceThenRecency(a: StoredItem, b: StoredItem): number {
  return (
    (b.prescreenImportance ?? 0.5) - (a.prescreenImportance ?? 0.5) ||
    b.item.publishedAt - a.item.publishedAt
  );
}

/**
 * Order a backlog the way we WORK it: freshest news first, stepping backwards in
 * fixed time buckets, and WITHIN each bucket provider-fair + importance-first. So
 * 1-2h-old stories across all outlets get analyzed (and shown provisionally)
 * before we move to the next band — while no single provider dominates a band.
 */
function orderBacklog(items: StoredItem[], now = Date.now()): StoredItem[] {
  return interleaveByRecencyBuckets(
    items,
    (s) => now - s.item.publishedAt,
    (s) => s.item.sourceId,
    byImportanceThenRecency,
    config.feed.recencyBucketHours * 60 * 60 * 1000,
  );
}

/**
 * Pure: from the in-window LOCAL survivors (already filtered for clickbait/global/
 * recency), pick the not-yet-analyzed members of the TOP-`keep` by coarse prescreen
 * importance. The cut is taken over the WHOLE survivor set (analyzed + pending) so
 * it's STABLE: as items get analyzed they keep occupying their slot, so the total
 * deep-analyzed local count never exceeds `keep`. Returned importance-first.
 */
export function topLocalBacklog(survivors: StoredItem[], keep: number): StoredItem[] {
  const ranked = [...survivors].sort(
    (a, b) =>
      (b.prescreenImportance ?? 0.5) - (a.prescreenImportance ?? 0.5) ||
      b.item.publishedAt - a.item.publishedAt,
  );
  const cut = keep > 0 ? ranked.slice(0, keep) : ranked;
  return cut.filter((s) => !s.analyzed);
}

/**
 * The source set for a pool:
 *  - a GEOGRAPHIC pool (`geo-<nodeId>`) draws from the node's discovered outlets —
 *    its country's set, narrowed to the region for region nodes (see geoTree);
 *  - a legacy REGIONAL pool (`place-<cc>`) uses the country's discovered outlets;
 *  - a topical world uses its curated sources.
 */
function sourcesForWorld(worldId: string): Source[] {
  if (isGeoPoolId(worldId)) return sourcesForGeoNode(geoNodeIdOf(worldId));
  const cc = placeCountryOf(worldId);
  return cc ? placeSourcesFor(cc) : worldSources(worldId);
}

/**
 * Prescreen (cheap title-only triage) a SLICE of fetched items and store the
 * survivors as PENDING (analyzed:false). Extracted so both the synchronous
 * cold-start first chunk and the background catch-up loop share one path. The
 * caller must have confirmed the model is reachable.
 */
async function prescreenAndStore(worldId: string, items: FeedItem[]): Promise<void> {
  if (items.length === 0) return;
  const state = ws(worldId);
  const st = getStore(worldId);
  const cc = placeCountryOf(worldId);
  const regional = !!cc && config.place.sourcesEnabled;
  const geo = isGeoPoolId(worldId);

  const junk = new Set<string>();
  const coarse = new Map<string, number>(); // id -> coarse importance (capped pools)
  const globals = new Set<string>();
  if (geo) {
    // ONE cheap title-only pass: clickbait + coarse importance (no global flag).
    const batches = Math.ceil(items.length / config.ai.triageBatchSize);
    console.log(`[feed:${worldId}] prescreen(geo): ${items.length} headline(s) in ${batches} batch(es)…`);
    const verdicts = await withModelLock(() =>
      prescreenGeo(
        items.map((it) => ({ id: it.id, title: it.title, summary: it.summary })),
        geoLabel(geoNodeIdOf(worldId)),
        progressLogger(state, "triage"),
      ),
    );
    for (const it of items) {
      const v = verdicts.get(it.id);
      if (!v) continue; // absent → kept, neutral importance
      if (config.feed.clickbaitFilter && v.junk) junk.add(it.id);
      coarse.set(it.id, v.importance);
    }
    console.log(`[feed:${worldId}] prescreen(geo) flagged ${junk.size} junk of ${items.length}`);
  } else if (regional && cc) {
    // Regional pools: ONE cheap title-only pass folds clickbait + local/global +
    // a coarse importance, so we scan the flood once and later deep-analyze only
    // the top-N local items by that score.
    const batches = Math.ceil(items.length / config.ai.triageBatchSize);
    console.log(`[feed:${worldId}] prescreen: ${items.length} headline(s) in ${batches} batch(es)…`);
    const verdicts = await withModelLock(() =>
      prescreenRegional(
        items.map((it) => ({ id: it.id, title: it.title, summary: it.summary })),
        placeLabelFor(cc),
        progressLogger(state, "triage"),
      ),
    );
    for (const it of items) {
      const v = verdicts.get(it.id);
      if (!v) continue; // absent from reply → treat conservatively (kept, default importance)
      if (config.feed.clickbaitFilter && v.junk) junk.add(it.id);
      if (v.global) globals.add(it.id);
      coarse.set(it.id, v.importance);
    }
    console.log(
      `[feed:${worldId}] prescreen flagged ${junk.size} junk, ${globals.size} global ` +
        `of ${items.length}`,
    );
  } else if (config.feed.clickbaitFilter) {
    // TOPICAL worlds: ONE cheap title-only pass folds clickbait + a coarse
    // importance, so the front page can rank its provisional items (and order
    // its analysis backlog) by newsworthiness instead of pure recency.
    const batches = Math.ceil(items.length / config.ai.triageBatchSize);
    console.log(`[feed:${worldId}] triage: ${items.length} headline(s) in ${batches} batch(es)…`);
    const verdicts = await withModelLock(() =>
      detectClickbait(items, progressLogger(state, "triage")),
    );
    for (const it of items) {
      const v = verdicts.get(it.id);
      if (!v) continue; // absent → kept, neutral importance
      if (v.junk) junk.add(it.id);
      coarse.set(it.id, v.importance);
    }
    console.log(`[feed:${worldId}] triage flagged ${junk.size}/${items.length} as clickbait/junk`);
  }

  for (const it of items) {
    st.upsert({
      item: it,
      clickbait: junk.has(it.id),
      // Set at prescreen for legacy regional pools so global stories are excluded
      // from the backlog + feed. Geo pools never drop globals (undefined).
      global: regional ? globals.has(it.id) : undefined,
      // Coarse newsworthiness from the cheap triage pass — now scored for EVERY
      // pool (topical included). Drives provisional ranking + analysis order;
      // overwritten by the real score once deep-analyzed.
      prescreenImportance: coarse.has(it.id) ? coarse.get(it.id) : undefined,
      analyzed: false, // deep analysis pending
      topic: it.topic,
      lean: it.lean,
      importance: 0,
      summary: "",
      keywords: [],
      analyzedAt: 0,
    });
  }
  // The survivor set just grew — drop the cached near-clone dedup so it's rebuilt once.
  state.geoDedup = null;
}

/**
 * Network phase: fetch all sources, then prescreen ONLY the freshest chunk
 * synchronously so the cold-start feed lands FAST even when a pool floods with
 * thousands of items. The remainder is queued on the world state; the background
 * catch-up loop (prescreenPending) drains it in chunks, populating the feed
 * continuously while it's in use. Deep analysis is likewise chunked downstream.
 */
async function refreshSources(worldId: string): Promise<void> {
  const state = ws(worldId);
  const st = getStore(worldId);
  const sources = sourcesForWorld(worldId);
  const started = Date.now();
  setPhase(state, "fetching");
  console.log(`[feed:${worldId}] refresh — fetching ${sources.length} sources…`);
  const raw = await fetchAll(sources);
  const cutoff = analyzeCutoff();
  // Never-seen items inside the recency window are all that need triage, FRESHEST
  // first so the synchronous first chunk prescreens the most recent news.
  const untriaged = raw
    .filter((it) => !st.has(it.id) && it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  console.log(
    `[feed:${worldId}] fetched ${raw.length}; ${untriaged.length} new & recent to triage; ${st.size()} in store`,
  );

  if (untriaged.length > 0) {
    // Fail fast if the model is down: don't store half-processed items; retry later.
    if (!(await aiReachable())) {
      console.warn(`[feed:${worldId}] AI endpoint unreachable — skipping triage this refresh.`);
      state.prescreenQueue = [];
      state.lastBuildAt = Date.now();
      setPhase(state, "idle");
      return;
    }
    // Only the FIRST chunk is awaited (one cheap model round); the rest is queued
    // for the background loop so the cold-start response isn't held by a flood.
    const firstN = config.feed.prescreenChunk > 0 ? config.feed.prescreenChunk : untriaged.length;
    state.prescreenQueue = untriaged.slice(firstN);
    await prescreenAndStore(worldId, untriaged.slice(0, firstN));
  } else {
    state.prescreenQueue = [];
  }

  const removed = st.prune();
  if (removed > 0) console.log(`[feed:${worldId}] pruned ${removed} stale item(s)`);
  st.save();
  state.lastBuildAt = Date.now();
  console.log(
    `[feed:${worldId}] refresh done in ${state.lastBuildAt - started}ms ` +
      `(${state.prescreenQueue.length} queued for background prescreen)`,
  );
}

/**
 * Background: prescreen ONE chunk of the queued (fetched-but-not-yet-triaged)
 * items and store the survivors, so provisional items keep entering the feed bit
 * by bit. Returns the remaining queue + how many we processed.
 */
function prescreenPending(worldId: string): Promise<{ remaining: number; progressed: number }> {
  const state = ws(worldId);
  return (async () => {
    if (state.prescreenQueue.length === 0) return { remaining: 0, progressed: 0 };
    if (!(await aiReachable())) return { remaining: state.prescreenQueue.length, progressed: 0 };
    const size =
      config.feed.prescreenChunk > 0 ? config.feed.prescreenChunk : state.prescreenQueue.length;
    const chunk = state.prescreenQueue.splice(0, size);
    await prescreenAndStore(worldId, chunk);
    getStore(worldId).save();
    // New provisional items are now servable — invalidate assembled views/briefings.
    state.lastBuildAt = Date.now();
    state.viewCache.clear();
    state.briefingCache.clear();
    console.log(
      `[feed:${worldId}] prescreened ${chunk.length}; ${state.prescreenQueue.length} still queued`,
    );
    return { remaining: state.prescreenQueue.length, progressed: chunk.length };
  })();
}

/** Resolve an analysis onto a stored item (rep OR clone). The model's topic /
 *  importance / summary / keywords / refined-lean VALUE are shared, but the
 *  lean PROVENANCE + rationale are recomputed from THIS item's own source so a
 *  clone keeps an honest attribution. `coveredBy` records the cluster size. */
function applyAnalysisToItem(
  target: StoredItem,
  a: ItemAnalysis,
  srcById: Map<string, Source>,
  now: number,
  coveredBy?: number,
  cloneOf?: string,
): StoredItem {
  const refined = config.ai.leanRefine && a.leanRefined && a.lean !== null;
  const lean = refined ? a.lean : target.item.lean;
  const leanSource: "llm" | "source" = refined ? "llm" : "source";
  const srcRationale = srcById.get(target.item.sourceId)?.leanRationale;
  const leanRationale =
    lean === null ? undefined : refined ? a.leanRationale || srcRationale : srcRationale;
  return {
    ...target,
    analyzed: true,
    topic: a.topic,
    lean,
    leanSource,
    leanRationale,
    importance: a.importance,
    summary: a.summary,
    keywords: a.keywords,
    analyzedAt: now,
    coveredBy: coveredBy && coveredBy > 1 ? coveredBy : target.coveredBy,
    // A clone points at its representative so the feed shows one card per story.
    cloneOf: cloneOf ?? target.cloneOf,
  };
}

interface GeoCluster {
  rep: StoredItem;
  members: StoredItem[];
  sourceCount: number;
}

/**
 * Plan a GEO pool's deep analysis: near-clone DEDUP the in-window survivors, rank
 * clusters by representative coarse (prescreen) importance, keep the TOP-N, and
 * return those that still have un-analyzed members. The cut is over ALL survivors
 * (analyzed + pending) so it's stable like topLocalBacklog, but at CLUSTER
 * granularity — identical wire copy is analyzed once and fanned out to the rest.
 */
function planGeoAnalysis(worldId: string, keep: number): GeoCluster[] {
  const state = ws(worldId);
  const cutoff = analyzeCutoff();
  const survivors = getStore(worldId)
    .all()
    .filter((s) => !s.clickbait && s.item.publishedAt >= cutoff);
  if (survivors.length === 0) {
    state.geoDedup = null;
    return [];
  }
  const byId = new Map(survivors.map((s) => [s.item.id, s]));

  // Reuse the cached dedup STRUCTURE while the survivor set is unchanged (see WorldState
  // .geoDedup). Only the expensive O(n²) dedup is cached; the rank + un-analyzed filter
  // below re-resolve against the LIVE store every call, so they reflect fresh analysis.
  let cached = state.geoDedup;
  if (!cached || cached.key !== survivors.length) {
    const clusters = dedupeNearClones(
      survivors.map((s) => ({
        id: s.item.id,
        sourceId: s.item.sourceId,
        title: s.item.title,
        summary: s.item.summary,
        publishedAt: s.item.publishedAt,
        importance: s.prescreenImportance ?? 0.5,
      })),
      { jaccardThreshold: config.geo.dedupeJaccard, windowMs: config.geo.dedupeWindowMs },
    );
    cached = {
      key: survivors.length,
      clusters: clusters.map((c) => ({
        repId: c.representativeId,
        memberIds: c.memberIds,
        sourceCount: c.sourceCount,
      })),
    };
    state.geoDedup = cached;
  }

  const ranked = cached.clusters
    .map((c): GeoCluster | null => {
      const rep = byId.get(c.repId);
      if (!rep) return null;
      const members = c.memberIds.map((id) => byId.get(id)).filter((s): s is StoredItem => !!s);
      return { rep, members, sourceCount: c.sourceCount };
    })
    .filter((c): c is GeoCluster => c !== null)
    .sort(
      (a, b) =>
        (b.rep.prescreenImportance ?? 0.5) - (a.rep.prescreenImportance ?? 0.5) ||
        b.rep.item.publishedAt - a.rep.item.publishedAt,
    );
  const cut = keep > 0 ? ranked.slice(0, keep) : ranked;
  return cut.filter((c) => c.members.some((m) => !m.analyzed));
}

/**
 * Deep-analyze ONE chunk of a GEO pool. We only call the model on each cluster's
 * REPRESENTATIVE (capped to maxItems), then fan its analysis out to the cluster's
 * clones — so N near-identical copies cost ONE deep pass. Clusters whose rep is
 * already analyzed but still have un-analyzed clones are resolved for free.
 */
async function analyzeGeoChunk(
  worldId: string,
  state: WorldState,
  st: ReturnType<typeof getStore>,
): Promise<{ remaining: number; progressed: number }> {
  const plan = planGeoAnalysis(worldId, config.geo.deepAnalyzeKeep);
  if (plan.length === 0) {
    setPhase(state, "idle");
    return { remaining: 0, progressed: 0 };
  }
  if (!(await aiReachable())) {
    setPhase(state, "idle");
    return { remaining: plan.length, progressed: 0 };
  }

  // Representatives still needing a model pass, capped to one chunk.
  const repsPending = plan.filter((c) => !c.rep.analyzed);
  const repSlice =
    config.ai.maxItems > 0 ? repsPending.slice(0, config.ai.maxItems) : repsPending;
  const items = repSlice.map((c) => c.rep.item);

  let analyses = new Map<string, ItemAnalysis>();
  if (items.length > 0) {
    // Transcripts deferred to the background enrichTranscripts() tick (see
    // analyzePending) — analyze on title+summary now to keep the path fast.
    const batches = Math.ceil(items.length / config.ai.batchSize);
    console.log(
      `[feed:${worldId}] geo deep analysis: ${items.length} representative(s) ` +
        `(of ${plan.length} clusters) in ${batches} batch(es)…`,
    );
    analyses = await withModelLock(() =>
      analyzeItems(items, new Map(), progressLogger(state, "analyze")),
    );
  }

  const srcById = new Map(sourcesForWorld(worldId).map((src) => [src.id, src]));
  const now = Date.now();
  let progressed = 0;
  let fannedOut = 0;

  // Only clusters whose representative now HAS an analysis (freshly produced, or
  // already stored) can be resolved this round.
  const repInSlice = new Set(repSlice.map((c) => c.rep.item.id));
  for (const c of plan) {
    const fresh = analyses.get(c.rep.item.id);
    // The analysis to fan out: the model's fresh result, else the rep's stored one.
    let a: ItemAnalysis | null = null;
    if (fresh) a = fresh;
    else if (c.rep.analyzed) {
      a = {
        topic: c.rep.topic,
        lean: c.rep.lean,
        leanRefined: c.rep.leanSource === "llm",
        leanRationale: c.rep.leanRationale ?? "",
        importance: c.rep.importance,
        summary: c.rep.summary,
        keywords: c.rep.keywords,
      };
    }
    // No analysis available (rep failed this round, or wasn't in this chunk's
    // slice) — leave the whole cluster pending so a later chunk retries it.
    if (!a) continue;
    for (const m of c.members) {
      if (m.analyzed) continue;
      const isClone = m.item.id !== c.rep.item.id;
      st.upsert(
        applyAnalysisToItem(m, a, srcById, now, c.sourceCount, isClone ? c.rep.item.id : undefined),
      );
      progressed += 1;
      if (isClone) fannedOut += 1;
    }
  }

  st.save();
  state.lastBuildAt = Date.now();
  state.viewCache.clear();
  state.briefingCache.clear();

  const remaining = planGeoAnalysis(worldId, config.geo.deepAnalyzeKeep).length;
  if (remaining === 0) setPhase(state, "idle");
  console.log(
    `[feed:${worldId}] geo analyzed ${progressed} item(s) ` +
      `(${fannedOut} fanned out from clones); ${remaining} cluster(s) still pending`,
  );
  return { remaining, progressed };
}

/**
 * Deep-analyze ONE chunk (config.ai.maxItems) of a world's pending backlog,
 * newest first, and persist. Returns the remaining backlog and how many we
 * completed, so the caller can decide whether to schedule another chunk.
 */
function analyzePending(worldId: string): Promise<{ remaining: number; progressed: number }> {
  const state = ws(worldId);
  if (state.analyzeInFlight) return state.analyzeInFlight;
  const st = getStore(worldId);
  state.analyzeInFlight = (async () => {
    // GEO pools dedup near-clones and analyze one representative per cluster.
    if (isGeoPoolId(worldId)) return analyzeGeoChunk(worldId, state, st);
    const pending = pendingForAnalysis(worldId);
    if (pending.length === 0) {
      setPhase(state, "idle");
      return { remaining: 0, progressed: 0 };
    }
    if (!(await aiReachable())) {
      setPhase(state, "idle");
      return { remaining: pending.length, progressed: 0 };
    }

    const slice = config.ai.maxItems > 0 ? pending.slice(0, config.ai.maxItems) : pending;
    const items = slice.map((s) => s.item);

    // Transcripts are NOT fetched here — they're slow (yt-dlp + network) and would
    // stall the hot path. Items are analyzed on title+summary now; the background
    // enrichTranscripts() tick later re-analyzes important video/podcast items with
    // their transcript for a sharper summary.
    const batches = Math.ceil(items.length / config.ai.batchSize);
    console.log(
      `[feed:${worldId}] deep analysis: ${items.length} of ${pending.length} pending in ${batches} batch(es)` +
        ` (concurrency ${config.ai.concurrency})…`,
    );
    const analyses = await withModelLock(() =>
      analyzeItems(items, new Map(), progressLogger(state, "analyze")),
    );

    // Source-level lean rationales (the curated prior) for the "source" provenance
    // path and as a fallback when the model omits its own rationale.
    const srcById = new Map(worldSources(worldId).map((src) => [src.id, src]));

    const now = Date.now();
    let progressed = 0;
    for (const s of slice) {
      const a = analyses.get(s.item.id);
      if (!a) continue;
      // Refine only when enabled AND the model actually produced a usable lean.
      // Otherwise keep the curated source prior (honest provenance, not "llm").
      const refined = config.ai.leanRefine && a.leanRefined && a.lean !== null;
      const lean = refined ? a.lean : s.item.lean;
      const leanSource = refined ? "llm" : "source";
      const srcRationale = srcById.get(s.item.sourceId)?.leanRationale;
      // Only political items carry a rationale (non-political lean is null).
      const leanRationale =
        lean === null ? undefined : refined ? a.leanRationale || srcRationale : srcRationale;
      st.upsert({
        ...s,
        analyzed: true,
        topic: a.topic,
        lean,
        leanSource,
        leanRationale,
        importance: a.importance,
        summary: a.summary,
        keywords: a.keywords,
        analyzedAt: now,
      });
      progressed += 1;
    }

    st.save();
    // Fresh analyses are now available — invalidate assembled views/briefings.
    state.lastBuildAt = Date.now();
    state.viewCache.clear();
    state.briefingCache.clear();

    const remaining = pendingForAnalysis(worldId).length;
    if (remaining === 0) setPhase(state, "idle");
    console.log(`[feed:${worldId}] analyzed ${progressed}/${items.length}; ${remaining} still pending`);
    return { remaining, progressed };
  })().finally(() => {
    state.analyzeInFlight = null;
  });
  return state.analyzeInFlight;
}

/** Analyzed items (in window) still lacking a semantic embedding, newest first. */
function pendingForEmbedding(worldId: string): StoredItem[] {
  if (!config.ai.embeddingsEnabled) return [];
  const cutoff = analyzeCutoff();
  return getStore(worldId)
    .all()
    .filter((s) => !s.clickbait && s.analyzed && !s.embedding && s.item.publishedAt >= cutoff)
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt);
}

/**
 * Embed ONE chunk of a world's analyzed-but-unembedded items (newest first) and
 * persist. Best-effort: if embeddings are unavailable (no model loaded), every
 * vector comes back null, we make no progress, and report nothing remaining so
 * the background loop stops instead of spinning.
 */
function embedPending(worldId: string): Promise<{ remaining: number; progressed: number }> {
  const state = ws(worldId);
  if (state.embedInFlight) return state.embedInFlight;
  const st = getStore(worldId);
  state.embedInFlight = (async () => {
    const pending = pendingForEmbedding(worldId);
    if (pending.length === 0) return { remaining: 0, progressed: 0 };

    // Reuse the analysis chunk size for the embedding chunk.
    const slice = config.ai.maxItems > 0 ? pending.slice(0, config.ai.maxItems) : pending;
    const texts = slice.map((s) => itemEmbedText(s.item.title, s.summary, s.keywords));
    setPhase(state, "embedding", 0, slice.length);
    console.log(`[feed:${worldId}] embedding ${slice.length} of ${pending.length} item(s)…`);
    const vecs = await withModelLock(() => embedTexts(texts));

    let progressed = 0;
    slice.forEach((s, i) => {
      const v = vecs[i];
      if (v && v.length > 0) {
        st.upsert({ ...s, embedding: v });
        progressed += 1;
      }
    });

    if (progressed > 0) {
      st.save();
      // New embeddings change interest matching — invalidate assembled views.
      state.lastBuildAt = Date.now();
      state.viewCache.clear();
      state.briefingCache.clear();
    }
    // If nothing embedded, embeddings are unavailable: stop the loop.
    const remaining = progressed > 0 ? pendingForEmbedding(worldId).length : 0;
    if (state.status.phase === "embedding") setPhase(state, remaining === 0 ? "idle" : "embedding", progressed, slice.length);
    console.log(`[feed:${worldId}] embedded ${progressed}/${slice.length}; ${remaining} still need embeddings`);
    return { remaining, progressed };
  })().finally(() => {
    state.embedInFlight = null;
  });
  return state.embedInFlight;
}

/**
 * Pick the single most relevant search hit for a source headline (relevance gate
 * only — the chosen video is analyzed/embedded later like any other item).
 * Embedding-based when available, else lexical token overlap. Returns null when
 * nothing clears the bar — i.e. YouTube had nothing genuinely on-topic.
 */
async function pickRelevantVideo(
  hits: YouTubeHit[],
  src: StoredItem,
): Promise<YouTubeHit | null> {
  if (config.ai.embeddingsEnabled && src.embedding) {
    const vecs = await embedTexts(hits.map((h) => h.title));
    let best: YouTubeHit | null = null;
    let bestScore = -1;
    hits.forEach((h, i) => {
      const v = vecs[i];
      if (!v || v.length === 0) return;
      const sim = cosineSim(src.embedding as number[], v);
      if (sim > bestScore) {
        bestScore = sim;
        best = h;
      }
    });
    return best && bestScore >= config.youtube.minRelevance ? best : null;
  }
  // Fallback (no embeddings): lexical overlap between candidate title & source.
  const tks = new Set<string>([
    ...tokenize(src.item.title),
    ...src.keywords.flatMap((k) => tokenize(k)),
  ]);
  let best: YouTubeHit | null = null;
  let bestScore = 0;
  for (const h of hits) {
    const overlap = tokenize(h.title).reduce((n, t) => n + (tks.has(t) ? 1 : 0), 0);
    if (overlap > bestScore) {
      bestScore = overlap;
      best = h;
    }
  }
  return best && bestScore >= 2 ? best : null;
}

/**
 * Build a PENDING StoredItem for a discovered video. It enters the pool exactly
 * like a freshly-fetched RSS item (`analyzed: false`) so the normal pipeline —
 * transcript fetch + deep model analysis + embedding — gives it the SAME
 * treatment as any other article: a model-written summary, its own
 * topic/keywords/importance, and lean refinement. The only YouTube-specific bits
 * are discovery (it came from search), the channel name as its source, and the
 * `youtubeSearch` tag. `publishedAt` is clamped to be no older than the source
 * story so it stays in-window and sorts alongside the coverage it extends; the
 * source's topic is a prior the analysis is free to overwrite.
 */
function youTubePendingItem(hit: YouTubeHit, src: StoredItem): StoredItem {
  const slug =
    hit.channel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "youtube";
  const estMinutes = hit.durationSec
    ? Math.max(1, Math.round(hit.durationSec / 60))
    : Math.max(3, src.item.estMinutes);
  const item: FeedItem = {
    id: `ytsearch:${hit.videoId}`,
    sourceId: `youtube:${slug}`,
    sourceTitle: hit.channel,
    title: hit.title,
    summary: "",
    url: hit.url,
    thumbnail: hit.thumbnail,
    publishedAt: Math.max(hit.uploadedAt ?? 0, src.item.publishedAt),
    kind: "video",
    topic: src.topic,
    lean: null,
    leanSource: "source",
    confidence: 0,
    estMinutes,
    youtubeSearch: true,
  };
  return {
    item,
    clickbait: false,
    analyzed: false, // deep analysis pending — treated like any other new item
    topic: src.topic,
    lean: null,
    importance: 0,
    summary: "",
    keywords: [],
    analyzedAt: 0,
  };
}

/**
 * Story-driven YouTube discovery: search YouTube for the top current headlines
 * and, when a relevant longer-form news/podcast video turns up, add it to the
 * pool as a PENDING video article (channel name as the source, `youtubeSearch`
 * tag). It then goes through the SAME analysis as everything else (transcript +
 * model). Bounded (maxQueries) + per-query cached. Returns how many were queued;
 * does NOT analyze (the orchestrator drains the backlog once for all sources).
 */
async function addYouTubePending(worldId: string): Promise<number> {
  if (!config.youtube.searchEnabled || youTubeSearchDisabled()) return 0;
  const st = getStore(worldId);
  const now = Date.now();
  // Seed queries from the most important, recent, NON-youtube headlines.
  const candidates = st
    .all()
    .filter(
      (s) =>
        s.analyzed &&
        !s.clickbait &&
        !s.item.youtubeSearch &&
        s.importance >= config.youtube.minSourceImportance &&
        now - s.item.publishedAt <= config.youtube.sourceMaxAgeMs,
    )
    .sort((a, b) => b.importance - a.importance || b.item.publishedAt - a.item.publishedAt);

  // Dedupe near-identical headlines (same event covered by many outlets) by a
  // sorted token signature so we don't spend several queries on one story.
  const picked: { q: string; src: StoredItem }[] = [];
  const seenSig = new Set<string>();
  for (const s of candidates) {
    if (picked.length >= config.youtube.maxQueries) break;
    const q = cleanHeadlineQuery(s.item.title);
    if (q.length < 8) continue;
    const sig = tokenize(q).sort().slice(0, 8).join(" ");
    if (!sig || seenSig.has(sig)) continue;
    seenSig.add(sig);
    picked.push({ q, src: s });
  }
  if (picked.length === 0) return 0;

  let added = 0;
  for (const { q, src } of picked) {
    const hits = await searchYouTube(q);
    const fresh = hits.filter((h) => !st.has(`ytsearch:${h.videoId}`));
    if (fresh.length === 0) continue;
    // Relevance gate (off-topic noise out); the embedding here only ranks
    // candidates — the stored item is re-embedded properly post-analysis.
    const best = await pickRelevantVideo(fresh, src);
    if (!best) continue;
    st.upsert(youTubePendingItem(best, src));
    added += 1;
  }
  if (added > 0) console.log(`[youtube:${worldId}] queued ${added} searched video(s) for analysis`);
  return added;
}

/** Salient content tokens of a fetched zone article, for relatedness scoring. */
function articleTokens(title: string): Set<string> {
  return titleTokens(title);
}

/**
 * Reactive INTERNATIONAL coverage: detect which foreign zones the live stories
 * involve (gazetteer over the top analyzed headlines), then for each involved
 * zone fetch ONLY that zone's outlets, keep the articles related to the active
 * stories, and add them as PENDING items tagged with their `zone`. They are then
 * analyzed like any other item and cluster into the story, where the synthesis
 * surfaces how each side frames it. Bounded (maxZonesPerBuild) + per-zone TTL.
 * Returns how many articles were queued; does NOT analyze.
 */
async function addZonePending(worldId: string): Promise<number> {
  if (!config.zones.enabled) return 0;
  const st = getStore(worldId);
  const now = Date.now();
  const cutoff = analyzeCutoff();
  const state = ws(worldId);

  // Seeds: the most important, recent, NON-reactive analyzed items (the stories
  // currently in play). Reactive (already-zoned) items don't seed new fetches.
  const seeds = st
    .all()
    .filter(
      (s) =>
        s.analyzed &&
        !s.clickbait &&
        !s.item.zone &&
        s.importance >= config.zones.minSeedImportance &&
        now - s.item.publishedAt <= config.zones.sourceMaxAgeMs,
    )
    .sort((a, b) => b.importance - a.importance || b.item.publishedAt - a.item.publishedAt)
    .slice(0, config.zones.seedItems);
  if (seeds.length === 0) return 0;

  // Accumulate involved zones + the salient tokens AND embeddings of the stories
  // that triggered each. Tokens relate English coverage; embeddings relate
  // ORIGINAL-LANGUAGE coverage (cross-lingual) that shares no Latin tokens.
  const involved = new Map<
    string,
    { score: number; tokens: Set<string>; embeddings: number[][] }
  >();
  for (const s of seeds) {
    const text = `${s.item.title} ${s.summary} ${s.keywords.join(" ")}`;
    const zoneIds = detectZones(text, ZONES, config.zones.minAliasHits);
    if (zoneIds.length === 0) continue;
    const seedToks = titleTokens(s.item.title, s.keywords);
    for (const id of zoneIds) {
      const cur = involved.get(id) ?? { score: 0, tokens: new Set<string>(), embeddings: [] };
      cur.score += 1;
      for (const t of seedToks) cur.tokens.add(t);
      if (s.embedding && s.embedding.length > 0) cur.embeddings.push(s.embedding);
      involved.set(id, cur);
    }
  }
  if (involved.size === 0) return 0;

  // Strongest zones first, skipping any fetched within the TTL, capped per build.
  const chosen = [...involved.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .filter(([id]) => now - (state.zoneFetchedAt.get(id) ?? 0) >= config.zones.zoneTtlMs)
    .slice(0, config.zones.maxZonesPerBuild);
  if (chosen.length === 0) return 0;

  let added = 0;
  for (const [zoneId, { tokens, embeddings }] of chosen) {
    const zone = ZONES_BY_ID[zoneId];
    if (!zone || zone.sources.length === 0) continue;
    state.zoneFetchedAt.set(zoneId, now);
    let raw: FeedItem[];
    try {
      raw = await fetchAll(zone.sources);
    } catch (e) {
      console.warn(`[zones:${worldId}] fetch failed for "${zoneId}":`, e);
      continue;
    }
    // Candidates: NEW, recent articles from this zone. We then keep only those
    // RELATED to the triggering stories — by shared salient tokens (English) OR by
    // cross-lingual embedding similarity (original-language) — so we get this
    // zone's take on THESE stories, not its entire feed.
    const candidates = raw.filter((it) => !st.has(it.id) && it.publishedAt >= cutoff);
    const scored = candidates.map((it) => {
      let shared = 0;
      for (const t of articleTokens(it.title)) if (tokens.has(t)) shared += 1;
      return { it, shared, sim: 0 };
    });
    // Embedding relatedness (what attaches non-Latin-script coverage to a story).
    if (config.ai.embeddingsEnabled && embeddings.length > 0 && scored.length > 0) {
      const vecs = await embedTexts(scored.map((x) => x.it.title));
      scored.forEach((x, i) => {
        const v = vecs[i];
        if (!v || v.length === 0) return;
        let best = 0;
        for (const e of embeddings) best = Math.max(best, cosineSim(v, e));
        x.sim = best;
      });
    }
    const related = scored
      .filter((x) => x.shared >= config.zones.minSharedTokens || x.sim >= config.zones.minRelevance)
      .sort((a, b) => b.sim - a.sim || b.shared - a.shared || b.it.publishedAt - a.it.publishedAt)
      .slice(0, config.zones.perZoneItemCap);

    for (const { it } of related) {
      st.upsert({
        item: it, // carries `zone` from the source (set in rss.normalize)
        clickbait: false,
        analyzed: false, // full analysis pending, same as any item
        topic: it.topic,
        lean: it.lean,
        importance: 0,
        summary: "",
        keywords: [],
        analyzedAt: 0,
      });
      added += 1;
    }
    if (related.length > 0) {
      console.log(`[zones:${worldId}] queued ${related.length} "${zone.label}" article(s) for analysis`);
    }
  }
  return added;
}

/** Display label for a country code (gazetteer country node, else the code). */
function placeLabelFor(cc: string): string {
  const country = gazetteerFor(cc).find((n) => n.level === "country");
  return country?.label ?? cc.toUpperCase();
}

/**
 * REGIONAL pools only: classify each newly-analyzed LOCAL item as GLOBAL (an
 * international story already covered by international sources) vs genuinely
 * LOCAL, and persist the verdict on the stored item. assembleView then filters
 * the globals out, so the regional feed stays local. No-op for topical worlds.
 * Returns how many items were classified.
 */
async function classifyRegionalScope(worldId: string): Promise<number> {
  if (!config.place.sourcesEnabled) return 0;
  const cc = placeCountryOf(worldId);
  if (!cc) return 0;
  const st = getStore(worldId);
  const cutoff = analyzeCutoff();
  const pending = st
    .all()
    .filter((s) => s.analyzed && !s.clickbait && s.global === undefined && s.item.publishedAt >= cutoff);
  if (pending.length === 0) return 0;
  if (!(await aiReachable())) return 0;

  const globals = await classifyGlobalScope(
    pending.map((s) => ({ id: s.item.id, title: s.item.title, summary: s.summary })),
    placeLabelFor(cc),
  );
  for (const s of pending) {
    s.global = globals.has(s.item.id);
    st.upsert(s);
  }
  st.save();
  // Bust cached views so the filter takes effect on the next assemble.
  ws(worldId).lastBuildAt = Date.now();
  console.log(
    `[place:${worldId}] geo-scope: ${globals.size}/${pending.length} judged global (hidden from local feed)`,
  );
  return pending.length;
}

/**
 * Background ENRICHMENT TICK. The fast analysis path skips transcript fetching
 * (slow yt-dlp + network), so video/podcast items are first summarized from just
 * their title+feed-description. This pass picks the most IMPORTANT such items that
 * haven't been enriched yet, fetches their transcript, and RE-analyzes only those
 * for a faithful summary/keywords. Bounded by importance + a per-tick cap, and
 * idempotent (the `transcriptEnriched` flag stops re-work). Returns how many were
 * actually re-analyzed. Works for ANY pool.
 */
async function enrichTranscripts(worldId: string): Promise<number> {
  if (!config.transcripts.enabled) return 0;
  const st = getStore(worldId);
  const cutoff = analyzeCutoff();
  const candidates = st
    .all()
    .filter(
      (s) =>
        s.analyzed &&
        !s.transcriptEnriched &&
        !s.clickbait &&
        !s.cloneOf &&
        (s.item.kind === "video" || s.item.kind === "podcast") &&
        s.importance >= config.transcripts.enrichMinImportance &&
        s.item.publishedAt >= cutoff,
    )
    .sort((a, b) => b.importance - a.importance)
    .slice(0, config.transcripts.enrichMaxPerTick);
  if (candidates.length === 0) return 0;
  if (!(await aiReachable())) return 0;

  const transcripts = await fetchTranscripts(candidates.map((s) => s.item));
  const withT = candidates.filter((s) => transcripts.has(s.item.id));

  let reanalyzed = 0;
  if (withT.length > 0) {
    const analyses = await withModelLock(() =>
      analyzeItems(
        withT.map((s) => s.item),
        transcripts,
        () => {},
      ),
    );
    const srcById = new Map(sourcesForWorld(worldId).map((src) => [src.id, src]));
    const now = Date.now();
    for (const s of withT) {
      const a = analyses.get(s.item.id);
      if (!a) continue;
      // Re-apply the sharper analysis and clear the stale embedding so the next
      // embed pass re-embeds from the transcript-informed summary.
      st.upsert({
        ...applyAnalysisToItem(s, a, srcById, now, s.coveredBy),
        embedding: undefined,
        transcriptEnriched: true,
      });
      reanalyzed += 1;
    }
  }
  // Mark items we couldn't get a transcript for as enriched too, so we don't
  // re-attempt the (failing) fetch every tick.
  for (const s of candidates) {
    if (!transcripts.has(s.item.id)) st.upsert({ ...s, transcriptEnriched: true });
  }
  st.save();
  const state = ws(worldId);
  state.lastBuildAt = Date.now();
  state.viewCache.clear();
  if (reanalyzed > 0) {
    console.log(`[feed:${worldId}] transcript enrichment re-analyzed ${reanalyzed} item(s)`);
  }
  return reanalyzed;
}

/**
 * Run the reactive augmentations after a build. EVERY pool first gets transcript
 * enrichment for its important video/podcast items; then TOPICAL worlds get
 * YouTube discovery + international zones, and a REGIONAL pool gets the geo-scope
 * pass (drop global stories from local outlets). Fire-and-forget; guarded so only
 * one runs per world. Model passes serialize on the global mutex.
 */
function augmentReactively(worldId: string): Promise<void> {
  const state = ws(worldId);
  if (state.augmentInFlight) return state.augmentInFlight;

  state.augmentInFlight = (async () => {
    // Deferred transcript enrichment for important video/podcast items (all pools).
    // If anything was re-analyzed, its embedding was cleared — re-embed in the bg.
    const enriched = await enrichTranscripts(worldId);
    if (enriched > 0) scheduleCatchUp(worldId);

    // GEO pools show everything their own outlets report — no geo-scope filtering,
    // and no YouTube/zone augmentation (those extend TOPICAL worlds). Nothing more.
    if (isGeoPoolId(worldId)) return;
    // Regional pool: classify geo-scope (no YouTube/zones — those are international).
    if (isPlaceWorldId(worldId)) {
      await classifyRegionalScope(worldId);
      return;
    }
    let added = 0;
    added += await addYouTubePending(worldId);
    added += await addZonePending(worldId);
    if (added === 0) return;

    getStore(worldId).save();

    // Analyze the newly-added items in the background, like any other pending
    // item. analyzePending is per-world re-entrancy-guarded and its model passes
    // serialize on the global mutex, so this needs no cross-world lock.
    scheduleCatchUp(worldId);
  })()
    .catch((e) => {
      console.warn(`[augment:${worldId}] reactive augmentation failed:`, e);
    })
    .finally(() => {
      state.augmentInFlight = null;
    });
  return state.augmentInFlight;
}

/** Schedule a background chunk to keep chewing through a world's analysis +
 *  embedding backlogs. Each chunk's model pass serializes on the global mutex,
 *  and the loop yields between chunks so other worlds can interleave their own
 *  passes (a world switch isn't blocked by this world's full drain). */
function scheduleCatchUp(worldId: string): void {
  const state = ws(worldId);
  if (state.catchUpTimer) return;
  state.catchUpTimer = setTimeout(() => {
    state.catchUpTimer = null;
    // PRESENCE GATE: never START a new chunk for a pool nobody's watching. An
    // in-flight chunk is never interrupted — we only ever check at this boundary,
    // and a returning reader's status poll (markWatched) restarts the loop.
    if (!isWatched(worldId)) {
      state.catchUpPaused = true;
      console.log(`[feed:${worldId}] catch-up paused — pool unwatched (resumes when viewed)`);
      return;
    }
    void (async () => {
      try {
        // Drain a chunk of the prescreen queue first so more provisional items keep
        // entering the feed, then deep-analyze + embed a chunk of what's ready.
        const p = await prescreenPending(worldId);
        const a = await analyzePending(worldId);
        // Only embed once a chunk's analysis is in (embedding needs the summary).
        const e = await embedPending(worldId);
        const moreWork =
          (p.remaining > 0 && p.progressed > 0) ||
          (a.remaining > 0 && a.progressed > 0) ||
          (e.remaining > 0 && e.progressed > 0);
        if (moreWork) {
          // The chunk we just ran finished uninterrupted; only queue the NEXT one
          // if the reader is still here, else pause (resumes on their return).
          if (isWatched(worldId)) {
            scheduleCatchUp(worldId);
          } else {
            state.catchUpPaused = true;
            console.log(
              `[feed:${worldId}] catch-up paused — pool unwatched ` +
                `(${p.remaining + a.remaining} pending, resumes when viewed)`,
            );
          }
        } else {
          const stuck = p.remaining + a.remaining;
          if (stuck > 0) console.warn(`[feed:${worldId}] catch-up stalled with ${stuck} pending`);
          else console.log(`[feed:${worldId}] analysis + embedding backlog cleared`);
          // The pool is now fully analyzed — reactively extend the stories with
          // relevant YouTube videos and international (per-zone) coverage.
          void augmentReactively(worldId);
        }
      } catch (err) {
        console.warn(`[feed:${worldId}] catch-up failed:`, err);
      }
    })();
  }, config.feed.catchUpDelayMs);
}

/**
 * Bring a world's store up to date (fetch + cheap triage) so PROVISIONAL items
 * are immediately servable, then drain the deep-analysis backlog in the
 * BACKGROUND. The cold-start response only waits on this fetch + triage — never
 * on the (slow) model analysis — so the feed is usable in seconds and enriches
 * live as each background chunk lands.
 */
async function buildPool(worldId: string): Promise<void> {
  await refreshSources(worldId);
  // Deep analysis + embedding + augmentation run in the background, one model
  // pass at a time (global mutex), so they never block the response or starve
  // another world that the reader just switched to.
  scheduleCatchUp(worldId);
}

/**
 * Ensure a world's pool is fresh (TTL) or forced. Each world builds INDEPENDENTLY
 * now (model passes serialize on the global mutex), so worlds never block each
 * other — switching is responsive. `busyWith` is always null, kept only for API
 * compatibility with the client/status shape.
 */
async function ensurePool(worldId: string, force: boolean): Promise<{ busyWith: string | null }> {
  const state = ws(worldId);
  const st = getStore(worldId);
  // Whether we already have something to serve. The persisted store survives
  // cache clears, so this is based on store size (NOT lastBuildAt, which a
  // forced refresh zeroes). When we have content we NEVER block a request on a
  // (re)build — the existing feed stays available and uninterrupted while the
  // refresh runs in the background; new items stream in via the status poll.
  const hasContent = st.size() > 0;
  const fresh =
    !force &&
    state.lastBuildAt > 0 &&
    hasContent &&
    Date.now() - state.lastBuildAt < config.server.feedTtlMs;
  if (fresh) return { busyWith: null };

  // A (re)build for THIS world is already running. Block ONLY on a cold start
  // (nothing to show yet); otherwise return immediately and let the in-flight
  // build surface provisional + newly-analyzed items live.
  if (state.buildInFlight) {
    if (!hasContent) await state.buildInFlight;
    return { busyWith: null };
  }

  const build = buildPool(worldId).finally(() => {
    state.buildInFlight = null;
  });
  state.buildInFlight = build;
  // Cold start must wait so the response has something to return — but buildPool
  // only awaits fetch + triage, so this resolves with PROVISIONAL items in
  // seconds; deep analysis continues in the background.
  if (!hasContent) await build;
  return { busyWith: null };
}

/**
 * Assemble (and cache) the ranked feed for a given interest from the pool.
 * `parsed` carries the POSITIVE intent (matched semantically/keyword) and the
 * EXCLUDED terms (hard-filtered out — embeddings can't express negation).
 * `queryVec` is the embedding of the positive intent; when absent, toFeedItem
 * falls back to keyword matching.
 */
function assembleView(
  worldId: string,
  interest: string,
  parsed: ParsedQuery,
  queryVec?: number[] | null,
): FeedResult {
  const state = ws(worldId);
  const st = getStore(worldId);
  const key = interestKey(interest);
  const cached = state.viewCache.get(key);
  if (cached && cached.builtAt === state.lastBuildAt) return cached.result;

  const started = Date.now();
  // Keyword/semantic matching keys off the POSITIVE intent only, so negation
  // words ("not", "israel") never count as things to match ON.
  const tokens = interestTokens(parsed.positive);
  const hasInterest = tokens.size > 0;
  const now = Date.now();

  // REGIONAL pools drop items the geo-scope pass judged GLOBAL (international
  // stories local outlets republish, already covered by international sources).
  const dropGlobal = isPlaceWorldId(worldId);
  const eligible = st
    .all()
    .filter(
      (s) =>
        !s.clickbait &&
        s.analyzed &&
        !s.cloneOf && // near-clone copies are folded into their representative
        now - s.item.publishedAt <= config.feed.retentionMs &&
        !(dropGlobal && s.global === true),
    );
  // Apply negation exclusions with a safety valve against over-broad terms.
  const { kept, removed, skipped, counts } = partitionByExclusion(eligible, parsed.exclude);
  if (skipped.length > 0) {
    console.warn(
      `[query] ignoring over-broad exclude term(s) [${skipped.join(", ")}] — each matched ` +
        `>${Math.round(0.6 * 100)}% of the feed (would hide too much).`,
    );
  }
  const pool = kept.map((s) => toFeedItem(s, tokens, hasInterest, queryVec));

  const ranked = rankItems(pool);

  // REACTIVE LOADING: append items that are fetched + triaged but NOT yet deep-
  // analyzed, so the feed is usable in seconds instead of waiting for the model.
  // They're drawn from the SAME backlog the analyzer will work through (already
  // filtered for clickbait/global/recency), capped and importance-ordered so a
  // flood of locals can't swamp the feed, and ranked strictly BELOW analyzed
  // items. As each analysis chunk lands, those items graduate from this set into
  // `ranked` above and upgrade in place on the client.
  let provisional: FeedItem[] = [];
  if (config.feed.serveProvisional) {
    const pend = pendingForAnalysis(worldId).filter(
      (s) =>
        !s.cloneOf &&
        now - s.item.publishedAt <= config.feed.retentionMs &&
        !(dropGlobal && s.global === true),
    );
    // Freshest-first, then provider-fair + importance within each time bucket, so
    // the FIRST provisionalMax items (what the reader sees while analysis catches
    // up) lead with very recent news and no single source fills the slice.
    const fair = orderBacklog(pend, now);
    const sliced = fair.slice(0, config.feed.provisionalMax);
    const { kept: pkept } = partitionByExclusion(sliced, parsed.exclude);
    provisional = rankItems(pkept.map((s) => toFeedItem(s, tokens, hasInterest, queryVec, true)));
  }

  const result: FeedResult = {
    items: [...ranked, ...provisional],
    builtAt: state.lastBuildAt,
    fetched: st.size(),
    enriched: pool.length,
    durationMs: Date.now() - started,
    interest: key,
    world: worldId,
  };
  state.viewCache.set(key, { builtAt: state.lastBuildAt, result });
  const mode = hasInterest ? (queryVec ? "semantic" : "keyword") : "general";
  const exNote =
    removed > 0
      ? `, ${removed}/${eligible.length} excluded {${Object.entries(counts)
          .map(([t, n]) => `${t}:${n}`)
          .join(", ")}}`
      : "";
  const provNote = provisional.length > 0 ? ` (+${provisional.length} provisional)` : "";
  console.log(
    `[feed:${worldId}] view "${key}" (${mode}) -> ${ranked.length} items from ${pool.length} eligible${provNote}${exNote}` +
      ` in ${result.durationMs}ms`,
  );
  return result;
}

/**
 * Get the ranked feed for an interest. Builds/refreshes the analyzed pool as
 * needed (TTL-cached), then personalizes + ranks it for the interest. The
 * interest is embedded once (cached) for semantic matching.
 */
export async function getFeed(
  worldId: string = DEFAULT_WORLD_ID,
  force = false,
  interest = config.feed.interest,
): Promise<FeedResult> {
  const { busyWith } = await ensurePool(worldId, force);
  const parsed = await interpretQuery(interest);
  // Embed the POSITIVE intent (not the raw query): embedding "not israel" would
  // sit right next to Israel coverage, which is the opposite of what's wanted.
  const queryVec = await embedQuery(parsed.positive);
  const result = assembleView(worldId, interest, parsed, queryVec);
  return { ...result, busyWith };
}

/**
 * Synthesize (and cache) a "what's happening / where it's headed" briefing for
 * the interest, from the top of the ranked pool. Builds the pool first if
 * needed. Returns null when the model is unreachable or has nothing usable.
 */
export async function getBriefing(
  worldId: string = DEFAULT_WORLD_ID,
  force = false,
  interest = config.feed.interest,
  lang: Lang = "en",
): Promise<Briefing | null> {
  await ensurePool(worldId, force);
  const state = ws(worldId);
  // Key per language so an EN and ES briefing don't overwrite each other.
  const key = `${lang}:${interestKey(interest)}`;
  const interestStr = interestKey(interest);

  const cached = state.briefingCache.get(key);
  if (cached && cached.builtAt === state.lastBuildAt) return cached.briefing;

  const existing = state.briefingInFlight.get(key);
  if (existing) return existing;

  const builtAtSnapshot = state.lastBuildAt;
  const p = (async (): Promise<Briefing | null> => {
    // Don't cache failures from an offline model — let a later request retry.
    if (!(await aiReachable())) return null;
    const parsed = await interpretQuery(interestStr);
    const queryVec = await embedQuery(parsed.positive);
    const view = assembleView(worldId, interestStr, parsed, queryVec);
    const sample = view.items.slice(0, 40);
    const started = Date.now();
    console.log(`[feed:${worldId}] briefing(${lang}): synthesizing "${interestStr || "general"}" from ${sample.length} item(s)…`);
    const briefing = await generateBriefing(interestStr, sample, lang);
    state.briefingCache.set(key, { builtAt: builtAtSnapshot, briefing });
    console.log(
      `[feed:${worldId}] briefing: ${briefing ? `${briefing.threads.length} thread(s)` : "none"}` +
        ` in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
    return briefing;
  })().finally(() => state.briefingInFlight.delete(key));

  state.briefingInFlight.set(key, p);
  return p;
}

/**
 * STREAMING briefing: forwards the model's tokens via `onDelta` so the card shows
 * the AI writing live, then returns (and caches) the parsed Briefing. A fresh
 * cached briefing is returned immediately (no stream). Falls back to the JSON
 * generator if the streamed prose can't be parsed.
 */
export async function getBriefingStream(
  worldId: string = DEFAULT_WORLD_ID,
  interest = config.feed.interest,
  lang: Lang = "en",
  onDelta: (delta: string) => void = () => {},
): Promise<Briefing | null> {
  await ensurePool(worldId, false);
  const state = ws(worldId);
  const key = `${lang}:${interestKey(interest)}`;
  const interestStr = interestKey(interest);

  const cached = state.briefingCache.get(key);
  if (cached && cached.builtAt === state.lastBuildAt) return cached.briefing;
  // Coalesce with any in-flight generation for the same world+lang+interest
  // (incl. a non-streaming getBriefing) so concurrent readers share ONE LLM call.
  const existing = state.briefingInFlight.get(key);
  if (existing) return existing;
  if (!(await aiReachable())) return null;

  const builtAtSnapshot = state.lastBuildAt;
  const p = (async (): Promise<Briefing | null> => {
    const parsed = await interpretQuery(interestStr);
    const queryVec = await embedQuery(parsed.positive);
    const view = assembleView(worldId, interestStr, parsed, queryVec);
    const sample = view.items.slice(0, 40);
    console.log(`[feed:${worldId}] briefing(${lang}): streaming "${interestStr || "general"}" from ${sample.length} item(s)…`);
    // Fall back to the (reliable, constrained) JSON generator if the streamed
    // prose doesn't parse into anything usable.
    const briefing =
      (await generateBriefingStream(interestStr, sample, onDelta, lang)) ??
      (await generateBriefing(interestStr, sample, lang));
    state.briefingCache.set(key, { builtAt: builtAtSnapshot, briefing });
    return briefing;
  })().finally(() => state.briefingInFlight.delete(key));

  state.briefingInFlight.set(key, p);
  return p;
}

/** The recent, analyzed pool eligible to be clustered into stories. Uses the
 *  WIDER of the event/issue windows so multi-day developing issues are covered.
 *
 *  Near-clones (`cloneOf`) are EXCLUDED — only REPRESENTATIVES cluster. A rep carries
 *  `coveredBy` (its near-clone group's outlet count), and synthesis counts breadth via
 *  coverageOf(), so a geo event still clears the multi-source thresholds WITHOUT the
 *  flood of duplicate copies. (Briefly keeping the copies churned each ongoing issue's
 *  member set every rebuild — its article-derived id drifted, bestMatch missed, and the
 *  development kept vanishing/recreating. Excluding them keeps member sets small +
 *  STABLE, while coveredBy preserves the multi-source signal the threshold needs.) */
function storyEligible(worldId: string, now = Date.now()): StoredItem[] {
  const window = Math.min(
    config.feed.retentionMs,
    Math.max(config.stories.windowMs, config.stories.issueWindowMs),
  );
  const inWindow = (s: StoredItem) =>
    !s.clickbait && s.analyzed && !s.cloneOf && now - s.item.publishedAt <= window;
  // The WORLD / front page draws on ALL the news the system has fetched (front page +
  // every loaded geo/regional pool), so ongoing stories aren't siloed per-place —
  // segregating synthesis to one pool defeats its point. A SPECIFIC geo selection (and
  // other themed topical worlds) stay scoped to their own pool. De-duped by id in case
  // a source feeds more than one pool.
  if (worldId === DEFAULT_WORLD_ID) {
    const seen = new Set<string>();
    const out: StoredItem[] = [];
    for (const s of storedAcrossPools(
      (id) => id === DEFAULT_WORLD_ID || isGeoPoolId(id) || isPlaceWorldId(id),
    )) {
      if (seen.has(s.item.id) || !inWindow(s)) continue;
      seen.add(s.item.id);
      out.push(s);
    }
    return out;
  }
  return getStore(worldId).all().filter(inWindow);
}

/** Token set for a synthesized story (from its title + source headlines), used
 *  to relate cached stories that have no centroid handy. */
function storyTokens(story: Story): Set<string> {
  const t = new Set<string>();
  for (const tok of titleTokens(story.title)) t.add(tok);
  for (const src of story.sources) for (const tok of titleTokens(src.title)) t.add(tok);
  return t;
}

/** Fill each story's relatedIds from cluster proximity (centroid cosine, else
 *  shared-token Jaccard). Mutates the stories in place. */
function linkRelated(
  built: { story: Story; centroid: number[] | null; tokens: Set<string> }[],
): void {
  for (let i = 0; i < built.length; i++) {
    const scores: { id: string; score: number }[] = [];
    for (let j = 0; j < built.length; j++) {
      if (i === j) continue;
      const a = built[i];
      const b = built[j];
      const score =
        a.centroid && b.centroid
          ? cosineSim(a.centroid, b.centroid)
          : jaccard(a.tokens, b.tokens);
      if (score > 0) scores.push({ id: b.story.id, score });
    }
    scores.sort((x, y) => y.score - x.score);
    built[i].story.relatedIds = scores.slice(0, config.stories.relatedCount).map((s) => s.id);
  }
}

/** Cache version for a world's synthesized stories. For the WORLD it must advance when
 *  ANY contributing pool (front page + any loaded geo/regional pool) rebuilds, so news
 *  fetched while the reader was off browsing a place joins the world's stories on return.
 *  For other pools it's simply that pool's own build timestamp. */
function storiesBuildVersion(worldId: string): number {
  if (worldId !== DEFAULT_WORLD_ID) return ws(worldId).lastBuildAt;
  let v = ws(DEFAULT_WORLD_ID).lastBuildAt;
  for (const [id, st] of worldStates) {
    if (isGeoPoolId(id) || isPlaceWorldId(id)) v = Math.max(v, st.lastBuildAt);
  }
  return v;
}

/**
 * Build (and cache) the synthesized cross-source stories for a world. Clusters
 * the recent analyzed pool by same-event similarity, keeps clusters spanning
 * >= minSources outlets, and synthesizes the top maxStories. Interest-independent
 * (one set per world), cached until the pool rebuilds. Lazy: the (expensive)
 * synthesis only runs on the first /api/stories request after a rebuild.
 */
export async function getStories(
  worldId: string = DEFAULT_WORLD_ID,
  force = false,
  lang: Lang = "en",
): Promise<{ stories: Story[]; busyWith: string | null; synthesizing: boolean }> {
  const { busyWith } = await ensurePool(worldId, force);
  if (!config.stories.enabled) return { stories: [], busyWith, synthesizing: false };

  const state = ws(worldId);
  // For the world this advances when ANY contributing pool rebuilds (see helper).
  const buildVersion = storiesBuildVersion(worldId);
  const cachedForLang = state.storiesCache.get(lang);
  // Reuse the cache when the build is unchanged OR (throttle) when it was rebuilt very
  // recently — re-clustering + cross-source synthesis is expensive, so we don't redo it
  // on every pool tick during a drain (the feed updates live regardless). Force rebuilds.
  if (
    cachedForLang &&
    (cachedForLang.builtAt === buildVersion ||
      (!force && Date.now() - cachedForLang.builtWallAt < config.stories.minRebuildMs))
  ) {
    return { stories: cachedForLang.stories, busyWith, synthesizing: false };
  }
  // A (re)build for this language is already running: return what we have RIGHT NOW
  // (stale or empty) and let it finish in the background. We must NOT await it — synthesis
  // is dozens of slow LLM calls, and blocking the response on it is what made /api/stories
  // hang for minutes while the feed/status endpoints stayed responsive.
  if (state.storiesInFlight.get(lang)) {
    return { stories: cachedForLang?.stories ?? [], busyWith, synthesizing: true };
  }

  // Per-language persistent store so EN and ES syntheses don't cross-pollinate.
  const storeKey = lang === "en" ? worldId : `${worldId}__${lang}`;
  const builtAtSnapshot = buildVersion;
  const p = (async (): Promise<Story[]> => {
    const eligible = storyEligible(worldId);
    const byId = new Map(eligible.map((s) => [s.item.id, s]));
    const inputs: ClusterInput[] = eligible.map((s) => ({
      id: s.item.id,
      sourceId: s.item.sourceId,
      publishedAt: s.item.publishedAt,
      topic: s.topic,
      importance: s.importance,
      title: s.item.title,
      keywords: s.keywords,
      embedding: s.embedding,
      // A representative stands in for `coveredBy` outlets (its near-clone group), so
      // coverage thresholds still see the full breadth though we cluster one copy.
      coveredBy: s.coveredBy,
    }));

    // Level 1: dedupe into same-event clusters.
    const clusters = clusterItems(inputs, {
      simThreshold: config.stories.simThreshold,
      textSimThreshold: config.stories.textSimThreshold,
      windowMs: config.stories.windowMs,
    });
    const toStored = (members: ClusterInput[]): StoredItem[] =>
      members.map((m) => byId.get(m.id)).filter((s): s is StoredItem => !!s);

    // Level 2: group event clusters into broader ongoing issues, then keep only
    // those the heuristic flags as DEVELOPING (an LLM later confirms).
    const issues = groupIntoIssues(clusters, {
      simThreshold: config.stories.issueSimThreshold,
      textSimThreshold: config.stories.issueTextSimThreshold,
      windowMs: config.stories.issueWindowMs,
    });
    const developing = issues
      .filter((iss) =>
        isDevelopingIssue(iss, {
          minSpanMs: config.stories.issueMinSpanMs,
          minEvents: config.stories.issueMinEvents,
          minSources: config.stories.issueMinSources,
          activeMs: config.stories.issueActiveMs,
        }),
      )
      .sort((a, b) => {
        const sa = coverageOf(a.members);
        const sb = coverageOf(b.members);
        if (sb !== sa) return sb - sa;
        return b.latestAt - a.latestAt;
      })
      .slice(0, config.stories.maxIssues);

    // DIAGNOSTIC: why ongoing stories appear/vanish across rebuilds. Per build, count how
    // many issues PASSED the developing gate, how many were RANKED OUT by maxIssues, and
    // for the failures, WHICH gate (events/span/sources/active) rejected them.
    {
      const dnow = Date.now();
      let pass = 0;
      let fEvents = 0;
      let fSpan = 0;
      let fSources = 0;
      let fActive = 0;
      for (const iss of issues) {
        const okEvents = iss.clusters.length >= config.stories.issueMinEvents;
        const okSpan = iss.latestAt - iss.earliestAt >= config.stories.issueMinSpanMs;
        const okSources = coverageOf(iss.members) >= config.stories.issueMinSources;
        const okActive = dnow - iss.latestAt <= config.stories.issueActiveMs;
        if (okEvents && okSpan && okSources && okActive) pass += 1;
        else {
          if (!okEvents) fEvents += 1;
          if (!okSpan) fSpan += 1;
          if (!okSources) fSources += 1;
          if (!okActive) fActive += 1;
        }
      }
      console.log(
        `[stories:${worldId}] eligible=${eligible.length} clusters=${clusters.length} ` +
          `issues=${issues.length} developing=${pass} kept=${developing.length} ` +
          `rankedOut=${Math.max(0, pass - developing.length)} ` +
          `(failed gates \u2014 events:${fEvents} span:${fSpan} sources:${fSources} active:${fActive})`,
      );
    }

    // Every multi-source cluster becomes an event story — INCLUDING those that
    // belong to a developing issue. We no longer hide issue members; instead the
    // client tags each story/article with a link up to its ongoing issue. The
    // issue itself is still emitted as its own umbrella story (with the timeline).
    const eventCandidates = clusters.filter(
      (c) => coverageOf(c.members) >= config.stories.minSources,
    );
    const remainingSlots = Math.max(0, config.stories.maxStories - developing.length);
    const topEvents = rankClusters(eventCandidates).slice(0, remainingSlots);

    // Target story specs (deterministic; no model calls yet).
    type Spec = {
      kind: StoryKind;
      members: StoredItem[];
      /** Sub-events (for an issue's timeline); undefined for event stories. */
      events?: StoredItem[][];
      centroid: number[] | null;
    };
    const specs: Spec[] = [
      ...developing.map((iss): Spec => ({
        kind: "issue",
        members: toStored(iss.members),
        events: iss.clusters.map((c) => toStored(c.members)).filter((e) => e.length > 0),
        centroid: iss.centroid,
      })),
      ...topEvents.map((c): Spec => ({ kind: "event", members: toStored(c.members), centroid: c.centroid })),
    ].filter((s) => s.members.length > 0);

    console.log(
      `[stories:${worldId}] ${eligible.length} eligible -> ${clusters.length} clusters, ` +
        `${issues.length} issues; ${developing.length} developing + ${topEvents.length} event spec(s)`,
    );
    if (specs.length === 0) {
      state.storiesCache.set(lang, { builtAt: builtAtSnapshot, builtWallAt: Date.now(), stories: [] });
      return [];
    }

    // INCREMENTAL: reuse cached stories whose article set is unchanged; only
    // (re)synthesize new or changed ones, preserving a development's id when it
    // merely gained/lost coverage. This is what stops a refresh re-computing all.
    const store = getStoryStore(storeKey);
    type Built = { story: Story; centroid: number[] | null; tokens: Set<string> };
    const used = new Set<string>();
    const reused: Built[] = [];
    const toSynth: { spec: Spec; memberIds: string[]; reuseId?: string }[] = [];
    for (const spec of specs) {
      const memberIds = spec.members.map((s) => s.item.id).sort();
      const match = store.bestMatch(spec.kind, memberIds, used, config.stories.matchThreshold);
      if (match) used.add(match.entry.id);
      // Reuse verbatim only when the set is unchanged AND the cached synthesis is
      // a real one. A DEGRADED story (model was offline -> headline fallback) is
      // re-synthesized so its heading/description upgrade once the model is back.
      if (match && match.equal && !match.entry.story.degraded) {
        reused.push({ story: match.entry.story, centroid: null, tokens: storyTokens(match.entry.story) });
      } else {
        toSynth.push({ spec, memberIds, reuseId: match?.entry.id });
      }
    }

    const started = Date.now();
    console.log(`[stories:${worldId}] ${reused.length} reused, ${toSynth.length} (re)synthesizing…`);
    if (toSynth.length > 0) setPhase(state, "synthesizing", 0, toSynth.length);
    const synthed = await withConcurrency(
      toSynth.map((t) => async (): Promise<Built> => {
        const story =
          t.spec.kind === "issue"
            ? await buildDevelopingStory(t.spec.events ?? [t.spec.members], lang)
            : await buildStory(t.spec.members, lang);
        // Keep the development's identity across membership changes.
        if (t.reuseId) story.id = t.reuseId;
        store.upsert({
          id: story.id,
          kind: t.spec.kind,
          memberIds: t.memberIds,
          story,
          builtAt: Date.now(),
          updatedAt: story.updatedAt,
        });
        return { story, centroid: t.spec.centroid, tokens: storyTokens(story) };
      }),
      config.ai.concurrency,
    );

    if (state.status.phase === "synthesizing") setPhase(state, "idle");
    const built = [...reused, ...synthed];
    linkRelated(built);
    store.prune(used);
    store.save();

    // Developing issues surface first (highlighted), then most-recent stories.
    const result = built
      .map((b) => b.story)
      .sort((a, b) => {
        const da = a.developing ? 1 : 0;
        const db = b.developing ? 1 : 0;
        if (db !== da) return db - da;
        return b.updatedAt - a.updatedAt;
      });
    console.log(
      `[stories:${worldId}] ${result.length} stor${result.length === 1 ? "y" : "ies"} ` +
        `(${synthed.length} synthesized in ${((Date.now() - started) / 1000).toFixed(0)}s, ${reused.length} cached)`,
    );
    state.storiesCache.set(lang, { builtAt: builtAtSnapshot, builtWallAt: Date.now(), stories: result });
    return result;
  })().finally(() => {
    state.storiesInFlight.delete(lang);
  });

  // Run in the BACKGROUND: we deliberately don't await the synthesis here (see above).
  // Swallow rejections so the un-awaited promise can't surface as an unhandled rejection,
  // and serve whatever we have cached now; the client polls back while `synthesizing` is
  // true and swaps in the fresh set once the background build populates the cache.
  p.catch((e) => console.error(`[stories:${worldId}] synthesis failed:`, e));
  state.storiesInFlight.set(lang, p);
  return { stories: cachedForLang?.stories ?? [], busyWith, synthesizing: true };
}

/** A single synthesized story by id (builds the set if needed). Null if gone. */
export async function getStory(
  worldId: string = DEFAULT_WORLD_ID,
  id: string,
  lang: Lang = "en",
): Promise<Story | null> {
  const { stories } = await getStories(worldId, false, lang);
  const live = stories.find((s) => s.id === id);
  if (live) return live;
  // Not in the CURRENT set (it dropped out of the top issues/events, or its cluster
  // membership changed). The story STORE still holds it while within the retention
  // window, so a deep link / related link resolves instead of dead-ending in a 404.
  const storeKey = lang === "en" ? worldId : `${worldId}__${lang}`;
  return getStoryStore(storeKey).get(id)?.story ?? null;
}

/**
 * Nearest-neighbor "related news" for an item: most semantically similar OTHER
 * items in the recent pool (embedding cosine), falling back to topic + keyword
 * overlap when embeddings are unavailable. Powers the in-app reader's continuous
 * "keep reading" flow. Empty when the item is unknown/aged out.
 */
export function getRelated(
  worldId: string = DEFAULT_WORLD_ID,
  id: string,
  limit = 6,
): FeedItem[] {
  const store = getStore(worldId);
  const target = store.all().find((s) => s.item.id === id);
  if (!target) return [];

  const now = Date.now();
  const pool = store
    .all()
    .filter(
      (s) =>
        s.item.id !== id &&
        !s.clickbait &&
        s.analyzed &&
        !s.cloneOf &&
        now - s.item.publishedAt <= config.feed.retentionMs,
    );

  let ranked: StoredItem[];
  if (target.embedding) {
    ranked = pool
      .filter((s) => s.embedding)
      .map((s) => ({ s, score: cosineSim(target.embedding as number[], s.embedding as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  } else {
    const tks = new Set(target.keywords.map((k) => k.toLowerCase()));
    ranked = pool
      .map((s) => {
        const overlap = s.keywords.reduce((n, k) => n + (tks.has(k.toLowerCase()) ? 1 : 0), 0);
        return { s, score: overlap + (s.topic === target.topic ? 1 : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }
  return ranked.map((s) => toFeedItem(s, new Set<string>(), false));
}

// --- Coverage map (drill-down navigation) -----------------------------------

/** A node as the client's navigation map needs it. */
export interface CoverageNode {
  nodeId: string;
  /** The pool id to request the feed for this node (`geo-<nodeId>`). */
  poolId: string;
  label: string;
  level: GeoNode["level"];
  /** Whether (and how well) this node has discovered sources. */
  state: CoverageState;
  /** True if the reader can drill further down from here. */
  hasChildren: boolean;
}

export interface CoverageView {
  /** The node currently in focus. */
  node: CoverageNode;
  /** Breadcrumb from the root down to (and including) the focused node. */
  path: CoverageNode[];
  /** The focused node's children — the drill-down options to render on the map. */
  children: CoverageNode[];
}

function toCoverageNode(n: GeoNode): CoverageNode {
  return {
    nodeId: n.id,
    poolId: poolIdForNode(n.id),
    label: n.label,
    level: n.level,
    state: coverageStateOf(n.id),
    hasChildren: childrenOf(n.id).length > 0,
  };
}

/**
 * The coverage view for a geographic node: itself, its breadcrumb, and its
 * children (each with a coverage state so the map can color them). Unknown ids
 * fall back to the world root. This powers on-demand drill-down — fetching the
 * actual feed for a node still happens via getFeed(`geo-<nodeId>`).
 */
export function getCoverage(nodeId: string = GEO_ROOT_ID): CoverageView {
  const node = geoNode(nodeId) ?? geoNode(GEO_ROOT_ID)!;
  return {
    node: toCoverageNode(node),
    path: pathOf(node.id).map(toCoverageNode),
    children: childrenOf(node.id).map(toCoverageNode),
  };
}

/**
 * Invalidate the freshness so the next request rebuilds (re-fetch + analyze new
 * items). The persisted analysis store is intentionally KEPT so we don't re-pay
 * the model for items we've already analyzed.
 */
export function clearCaches(worldId: string = DEFAULT_WORLD_ID): void {
  const state = ws(worldId);
  state.lastBuildAt = 0;
  state.viewCache.clear();
  state.briefingCache.clear();
  state.storiesCache.clear();
}
