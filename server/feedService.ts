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
import { countryLabel } from "../src/lib/countries";
import { gazetteerFor } from "./places";
import { placeSourcesFor } from "./placeSources";
import { dedupeNearClones } from "./dedupe";
import { interleaveByRecencyBuckets } from "./fairness";
import type { Source } from "../src/types";
import { createRotation, dealNextBatch, type RotationState } from "./sourceRotation";
import { aiReachable, withConcurrency, withModelPriority } from "./ai";
import {
  analyzeItems,
  classifyGlobalScope,
  detectClickbait,
  prescreenGeo,
  prescreenRegional,
  type ItemAnalysis,
} from "./analysis";
import { generateBriefing, generateBriefingStream } from "./briefing";
import { clusterItems, jaccard, titleTokens, type ClusterInput } from "./cluster";
import { runStoryPlan } from "./clusterPool";
import { config } from "./config";
import type { StoryPlanConfig } from "./storyPlan";
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

/** A concrete unit of work that's RUNNING (everything except the resting "idle"). */
export type ActivityStage = Exclude<BuildPhase, "idle">;

/** All mutable build/cache state for ONE world. */
interface WorldState {
  worldId: string;
  /** Timestamp of this world's last pool build (for TTL + cache validity). */
  lastBuildAt: number;
  /** Epoch ms a deep-analysis ROUND (backfill flush) was last kicked off / progressed.
   *  Gates how often a NAVIGATION refresh may start a new round (config.feed.navBatchTtlMs);
   *  manual refreshes ignore it, automatic refreshes never start one. */
  lastBatchAt: number;
  /** What's RUNNING for this world RIGHT NOW — the single source of truth behind the
   *  status indicator. Each entry is one in-flight pass (registered for its whole duration
   *  via withActivity); getStatus derives `active` + the dominant stage + progress from it,
   *  so the UI can never claim work that isn't happening (or miss work that is). */
  activities: Map<number, { stage: ActivityStage; done: number; total: number }>;
  activitySeq: number;
  /** Keep-alive for the backfill DRAIN chain: held across its inter-batch delays so the
   *  indicator never blinks off between batches. Doubles as the chain's single-flight guard. */
  draining: boolean;
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
  /** Epoch ms of this pool's last status poll — a lightweight presence signal. */
  lastWatchedAt: number;
  /** Cached near-clone DEDUP for a GEO pool, keyed by survivor COUNT. The dedup is
   *  O(n²) and used to run on EVERY status poll + view build (the server stuttered while
   *  busy). Analysis only flips `analyzed` flags — it never adds/removes items — so the
   *  cluster STRUCTURE is stable until prescreen/prune change the set; we re-resolve to
   *  live items each call, so the un-analyzed filter stays fresh. */
  geoDedup:
    | { key: number; clusters: { repId: string; memberIds: string[]; sourceCount: number }[] }
    | null;
  /** Shuffled-deck cursor for SOURCE ROTATION — which sources a warm refresh fetches,
   *  rotating through all of a world's sources with no repeats until the deck is spent. */
  rotation: RotationState;
}

const worldStates = new Map<string, WorldState>();

function ws(worldId: string): WorldState {
  let s = worldStates.get(worldId);
  if (!s) {
    s = {
      worldId,
      lastBuildAt: 0,
      lastBatchAt: 0,
      activities: new Map(),
      activitySeq: 0,
      draining: false,
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
      lastWatchedAt: 0,
      geoDedup: null,
      rotation: createRotation(),
    };
    worldStates.set(worldId, s);
  }
  return s;
}

// Model concurrency is governed by the GLOBAL REQUEST GATE in ai.ts: up to
// config.ai.maxConcurrency requests stream at once across ALL worlds (one per model
// instance), with INTERACTIVE work prioritised over BACKGROUND work and
// config.ai.reserveInteractive slots HELD BACK from background so user-facing requests
// (search/ask, briefing, reader, and the cold-start fetch + first-chunk triage) ALWAYS
// have an instance. The ENTIRE backfill DRAIN — prescreen + deep analysis + embedding —
// plus story synthesis and reactive augmentation run as BACKGROUND (runBackfillBatch wraps
// the drain; getStories/augment mark themselves too), so the bulk backlog can never occupy
// every instance and queue the reader behind it. Only the cold-start first paint stays
// interactive. Callers declare priority via withModelPriority(); default is interactive.

/** Resolve after `ms` (used to space out the backfill drain's chained batches). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ActivityHandle {
  /** Move this activity to a different stage (e.g. fetching → analyzing within one pass). */
  stage: (stage: ActivityStage) => void;
  /** Report progress for the current stage (drives the indicator's per-pass bar). */
  progress: (done: number, total: number) => void;
}

/** Register a RUNNING pass on a world's activity registry. The handle lets the pass refine
 *  its stage and report progress; `end()` removes it. Prefer withActivity (auto end on
 *  completion/throw). This registry is the SINGLE source of truth for the status indicator —
 *  no pass should do model/network work without an activity covering it, or the UI will
 *  under-report; none should leave one dangling, or it will over-report. */
function beginActivity(
  worldId: string,
  stage: ActivityStage,
): { handle: ActivityHandle; end: () => void } {
  const state = ws(worldId);
  const id = ++state.activitySeq;
  const task = { stage, done: 0, total: 0 };
  state.activities.set(id, task);
  return {
    handle: {
      stage: (s) => {
        task.stage = s;
      },
      progress: (done, total) => {
        task.done = done;
        task.total = total;
      },
    },
    end: () => {
      state.activities.delete(id);
    },
  };
}

/** Run `fn` with an activity registered for its whole duration (removed on return OR throw).
 *  The standard way to make a pass visible in the status indicator. */
async function withActivity<T>(
  worldId: string,
  stage: ActivityStage,
  fn: (h: ActivityHandle) => Promise<T>,
): Promise<T> {
  const { handle, end } = beginActivity(worldId, stage);
  try {
    return await fn(handle);
  } finally {
    end();
  }
}

/** Which running activity the indicator should HEADLINE when several overlap (e.g. a feed
 *  deep-analysis and a story synthesis at once). Ordered by how meaningful each stage is to a
 *  reader watching progress: deep analysis first, bare fetching last. Pure (exported for tests). */
const STAGE_PRIORITY: ActivityStage[] = [
  "analyzing",
  "triage",
  "transcripts",
  "embedding",
  "synthesizing",
  "fetching",
];
export function dominantActivity<T extends { stage: ActivityStage }>(tasks: T[]): T | null {
  for (const stage of STAGE_PRIORITY) {
    const t = tasks.find((x) => x.stage === stage);
    if (t) return t;
  }
  return null;
}

/** Heartbeat: record that the reader is looking at this pool (called on every
 *  status poll). A status poll NEVER starts/resumes analysis (that's what pinned the
 *  GPU before) — the timestamp is only read by `isWatched` as the STOP condition for an
 *  in-progress cold-fill chain, so it winds down once the reader navigates away. */
function markWatched(worldId: string): void {
  ws(worldId).lastWatchedAt = Date.now();
}

/** Whether the reader is still on this pool (polled status within watchedTtlMs). Used
 *  ONLY to decide whether a cold-fill backfill chain should run its NEXT batch — never
 *  to (re)start one, so leaving a pool quietly stops its fill instead of resuming it. */
function isWatched(worldId: string): boolean {
  return Date.now() - ws(worldId).lastWatchedAt < config.feed.watchedTtlMs;
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
  // Every status poll is a heartbeat that this pool is being watched — read only as the
  // stop condition for an in-progress cold-fill chain (it never STARTS analysis here).
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
  // SINGLE SOURCE OF TRUTH. `active`, the headline stage, and its progress all come straight
  // from the activity registry (every pass registers itself for its whole duration) plus the
  // drain keep-alive. So the indicator EXACTLY tracks what the server is doing for this pool:
  // no stale phase, no "Updating" while idle, and no blink-off between batches or during the
  // augmentation pass — the failure modes of the old heuristic union.
  const tasks = [...state.activities.values()];
  const dom = dominantActivity(tasks);
  const active = tasks.length > 0 || state.draining;
  // When only the drain keep-alive is up (between batches) there's no leaf stage to show, but
  // we ARE mid deep-analysis chain — surface "analyzing" so the copy stays coherent.
  const phase: BuildPhase = dom ? dom.stage : active ? "analyzing" : "idle";
  // Worlds no longer block each other (model passes share the bounded request gate in ai.ts
  // but each world builds independently), so nothing is ever "busy with" another world.
  return {
    phase,
    active,
    done: dom?.done ?? 0,
    total: dom?.total ?? 0,
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
function progressLogger(
  worldId: string,
  h: ActivityHandle,
  label: string,
): (done: number, total: number) => void {
  const start = Date.now();
  let lastLog = 0;
  return (done, total) => {
    h.progress(done, total);
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
    console.log(`[feed:${worldId}] ${label}: ${done}/${total} (${pct}%) — ${tail}`);
  };
}

/** Oldest publish time eligible for analysis (keeps the backlog tractable). */
function analyzeCutoff(now = Date.now()): number {
  return now - config.feed.analyzeMaxAgeMs;
}

/** How many near-clone CLUSTERS a pool deep-analyzes per pass: GEO pools cap to the
 *  top-N by coarse importance (a country's local flood has a long tail not worth the
 *  tokens); topical worlds (front page + themed) work the FULL backlog (0 = no cap). */
function analyzeKeepFor(worldId: string): number {
  return isGeoPoolId(worldId) ? config.geo.deepAnalyzeKeep : 0;
}

function pendingForAnalysis(worldId: string): StoredItem[] {
  // GEO + TOPICAL pools near-clone DEDUP and deep-analyze ONE representative per cluster,
  // fanning its analysis to the clones (planGeoAnalysis + analyzeGeoChunk), so the "pending"
  // set MUST mirror that — the still-unanalyzed cluster REPRESENTATIVES. The generic
  // all-unanalyzed list (the regional path below) is what made items BEYOND a cap (and
  // clones not yet folded into a rep) show as provisional FOREVER: served to the feed but
  // never reached by the analyzer. Mirroring the plan fixes it — every provisional item is
  // one the analyzer WILL reach (clones are hidden via their rep; a GEO pool's long tail
  // beyond the cap is simply not shown). GEO caps to the top-N clusters; topical works all.
  if (!isPlaceWorldId(worldId)) {
    return planGeoAnalysis(worldId, analyzeKeepFor(worldId))
      .filter((c) => !c.rep.analyzed)
      .map((c) => c.rep);
  }
  // REGIONAL (place) pools: cap the deep pass to the top-N local survivors by coarse
  // importance (the local flood's long tail isn't worth the tokens); per-item (no dedup).
  const cutoff = analyzeCutoff();
  const all = getStore(worldId).all();
  if (config.place.deepAnalyzeKeep > 0) {
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
async function prescreenAndStore(
  worldId: string,
  items: FeedItem[],
  h: ActivityHandle,
): Promise<void> {
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
    const verdicts = await prescreenGeo(
      items.map((it) => ({ id: it.id, title: it.title, summary: it.summary })),
      geoLabel(geoNodeIdOf(worldId)),
      progressLogger(worldId, h, "triage"),
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
    const verdicts = await prescreenRegional(
      items.map((it) => ({ id: it.id, title: it.title, summary: it.summary })),
      placeLabelFor(cc),
      progressLogger(worldId, h, "triage"),
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
    const verdicts = await detectClickbait(items, progressLogger(worldId, h, "triage"));
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
 * Network phase: fetch a rotating SUBSET of sources, then prescreen ONLY the freshest chunk
 * synchronously so the cold-start feed lands FAST even when a pool floods with
 * thousands of items. The remainder is queued on the world state; a (pull-based)
 * backfill batch prescreens the rest a chunk at a time. Deep analysis is likewise
 * chunked downstream. Returns how many genuinely-new (never-seen, in-window) items
 * this fetch surfaced, so the caller can decide whether to backfill older news.
 */
async function refreshSources(
  worldId: string,
  // Priority for THIS refresh's first-chunk triage. Server-driven refreshes (auto TTL
  // re-fetch, navigation, manual, and coldFill's follow-up subset pulls) MUST be
  // "background" so they yield to user-facing requests via the gate's reserved interactive
  // slot. Only the genuine COLD first paint (a reader waiting on an empty pool) is
  // "interactive" — see buildPool. Defaulting to background is the safe choice.
  priority: "interactive" | "background" = "background",
): Promise<{ newCount: number }> {
  const state = ws(worldId);
  const st = getStore(worldId);
  const allSources = sourcesForWorld(worldId);
  // Fetch only a SUBSET (config.feed.sourceFetchBudget) of the sources per refresh, split
  // into a FRESH half (no-repeat deck → breadth: every source visited once per cycle) and a
  // REPEAT half (config.feed.sourceRepeatRatio → re-fetch least-recently-fetched sources so
  // we keep moving through TIME, not just sampling the present). Items from sources not
  // fetched this turn persist in the store until their turn; a cold open repeats this via
  // coldFill() until there's a decent backlog, so it never bursts every source at once.
  const byId = new Map(allSources.map((s) => [s.id, s]));
  const ids = dealNextBatch(
    state.rotation,
    allSources.map((s) => s.id),
    config.feed.sourceFetchBudget,
    { repeatRatio: config.feed.sourceRepeatRatio },
  );
  const picked = ids.map((id) => byId.get(id)).filter((s): s is Source => !!s);
  const sources = picked.length > 0 ? picked : allSources;
  const started = Date.now();
  console.log(
    `[feed:${worldId}] refresh — fetching ${sources.length}/${allSources.length} sources ` +
      `(rotating subset, ${state.rotation.queue.length} left this cycle)…`,
  );
  // The network fetch is a visible stage of its own ("Fetching sources").
  const raw = await withActivity(worldId, "fetching", () => fetchAll(sources));
  const cutoff = analyzeCutoff();
  // Never-seen items inside the recency window are all that need triage, FRESHEST
  // first so the synchronous first chunk prescreens the most recent news.
  const untriaged = raw
    .filter((it) => !st.has(it.id) && it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  const newCount = untriaged.length;
  const ago = (t?: number) => (t ? `${((started - t) / 3_600_000).toFixed(1)}h` : "—");
  console.log(
    `[feed:${worldId}] fetched ${raw.length}; ${untriaged.length} new & recent to triage ` +
      `(newest ${ago(untriaged[0]?.publishedAt)}, oldest ${ago(untriaged.at(-1)?.publishedAt)}; ` +
      `window ${(config.feed.analyzeMaxAgeMs / 3_600_000).toFixed(0)}h); ${st.size()} in store`,
  );

  if (untriaged.length > 0) {
    // Fail fast if the model is down: we can't prescreen now, so QUEUE everything (capped)
    // for later instead of dropping it — the backlog survives until the model returns and a
    // flush drains it.
    if (!(await aiReachable())) {
      console.warn(
        `[feed:${worldId}] AI endpoint unreachable — queued ${untriaged.length} for later triage.`,
      );
      enqueuePrescreen(worldId, untriaged);
      state.lastBuildAt = Date.now();
      return { newCount };
    }
    // Only the FIRST chunk is awaited (one cheap model round) so the response isn't held by a
    // flood; the rest is MERGED into the queue (not replacing it) so older un-prescreened
    // items from earlier refreshes aren't dropped when this refresh lands mid-flush.
    const firstN = config.feed.prescreenChunk > 0 ? config.feed.prescreenChunk : untriaged.length;
    await withActivity(worldId, "triage", (h) =>
      withModelPriority(priority, () =>
        prescreenAndStore(worldId, untriaged.slice(0, firstN), h),
      ),
    );
    enqueuePrescreen(worldId, untriaged.slice(firstN));
  } else {
    // Nothing new this refresh — KEEP (and re-filter) the existing backlog rather than
    // clearing it; a later flush still has older items to drain.
    enqueuePrescreen(worldId, []);
  }

  const removed = st.prune();
  if (removed > 0) console.log(`[feed:${worldId}] pruned ${removed} stale item(s)`);
  st.save();
  state.lastBuildAt = Date.now();
  // Phase bookkeeping is automatic now: the fetch + triage activities above ended with their
  // withActivity scopes, so the indicator already reflects "done with this fetch". Any backfill
  // that follows registers its own activities; a fetch that does NO model work simply leaves
  // the registry empty → the indicator reads idle, instead of being stuck "refreshing".
  console.log(
    `[feed:${worldId}] refresh done in ${state.lastBuildAt - started}ms ` +
      `(${state.prescreenQueue.length} queued for background prescreen)`,
  );
  return { newCount };
}

/**
 * Merge freshly-fetched, un-prescreened items into the world's prescreen queue WITHOUT
 * dropping the un-drained remainder from earlier refreshes. (The queue used to be REPLACED
 * each refresh, so when a new refresh landed before the background flush finished, older
 * queued items were silently lost.) Dedups by id (the rotation's repeat half can re-fetch an
 * already-queued source), drops anything already prescreened+stored or fallen out of the
 * analysis window, keeps the queue FRESHEST-FIRST (its drain order), and BOUNDS it
 * (config.feed.prescreenQueueMax) — over the cap the OLDEST are dropped, lowest-priority and
 * about to age out anyway.
 */
export function mergePrescreenQueue(
  existing: FeedItem[],
  incoming: FeedItem[],
  opts: { isStored: (id: string) => boolean; cutoff: number; cap: number },
): FeedItem[] {
  const seen = new Set<string>();
  const merged: FeedItem[] = [];
  for (const it of [...existing, ...incoming]) {
    if (seen.has(it.id) || opts.isStored(it.id) || it.publishedAt < opts.cutoff) continue;
    seen.add(it.id);
    merged.push(it);
  }
  // Freshest-first: prescreenPending drains from the FRONT, so recent news is triaged first.
  merged.sort((a, b) => b.publishedAt - a.publishedAt);
  return opts.cap > 0 && merged.length > opts.cap ? merged.slice(0, opts.cap) : merged;
}

function enqueuePrescreen(worldId: string, incoming: FeedItem[]): void {
  const state = ws(worldId);
  const st = getStore(worldId);
  state.prescreenQueue = mergePrescreenQueue(state.prescreenQueue, incoming, {
    isStored: (id) => st.has(id),
    cutoff: analyzeCutoff(),
    cap: config.feed.prescreenQueueMax,
  });
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
    await withActivity(worldId, "triage", (h) =>
      withModelPriority("background", () => prescreenAndStore(worldId, chunk, h)),
    );
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
    countries: a.countries,
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
 * Plan a GEO or TOPICAL pool's deep analysis: near-clone DEDUP the in-window survivors,
 * rank clusters by representative coarse (prescreen) importance, keep the TOP-N (keep=0
 * = no cap, the full backlog for topical worlds), and return those that still have
 * un-analyzed members. The cut is over ALL survivors (analyzed + pending) so it's stable
 * like topLocalBacklog, but at CLUSTER granularity — identical wire copy is analyzed once
 * and fanned out to the rest.
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
 * Deep-analyze ONE chunk of a GEO or TOPICAL pool. We only call the model on each
 * cluster's REPRESENTATIVE (capped to maxItems), then fan its analysis out to the
 * cluster's clones — so N near-identical copies cost ONE deep pass. Clusters whose rep
 * is already analyzed but still have un-analyzed clones are resolved for free.
 */
async function analyzeGeoChunk(
  worldId: string,
  state: WorldState,
  st: ReturnType<typeof getStore>,
  h: ActivityHandle,
): Promise<{ remaining: number; progressed: number }> {
  const plan = planGeoAnalysis(worldId, analyzeKeepFor(worldId));
  if (plan.length === 0) return { remaining: 0, progressed: 0 };
  if (!(await aiReachable())) return { remaining: plan.length, progressed: 0 };

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
      `[feed:${worldId}] deep analysis: ${items.length} representative(s) ` +
        `(of ${plan.length} clusters) in ${batches} batch(es)…`,
    );
    analyses = await analyzeItems(items, new Map(), progressLogger(worldId, h, "analyze"));
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
        countries: c.rep.countries ?? [],
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

  const remaining = planGeoAnalysis(worldId, analyzeKeepFor(worldId)).length;
  console.log(
    `[feed:${worldId}] analyzed ${progressed} item(s) ` +
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
  state.analyzeInFlight = withActivity(worldId, "analyzing", async (h) => {
    // GEO + TOPICAL pools dedup near-clones and analyze one representative per cluster
    // (fanning its analysis to the clones); only REGIONAL pools take the per-item path.
    if (!isPlaceWorldId(worldId)) return analyzeGeoChunk(worldId, state, st, h);
    const pending = pendingForAnalysis(worldId);
    if (pending.length === 0) return { remaining: 0, progressed: 0 };
    if (!(await aiReachable())) return { remaining: pending.length, progressed: 0 };

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
    const analyses = await analyzeItems(items, new Map(), progressLogger(worldId, h, "analyze"));

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
        countries: a.countries,
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
    console.log(`[feed:${worldId}] analyzed ${progressed}/${items.length}; ${remaining} still pending`);
    return { remaining, progressed };
  }).finally(() => {
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
  let endActivity: (() => void) | null = null;
  state.embedInFlight = (async () => {
    const pending = pendingForEmbedding(worldId);
    if (pending.length === 0) return { remaining: 0, progressed: 0 };
    const act = beginActivity(worldId, "embedding");
    endActivity = act.end;
    const h = act.handle;

    // Reuse the analysis chunk size for the embedding chunk.
    const slice = config.ai.maxItems > 0 ? pending.slice(0, config.ai.maxItems) : pending;
    const texts = slice.map((s) => itemEmbedText(s.item.title, s.summary, s.keywords));
    h.progress(0, slice.length);
    console.log(`[feed:${worldId}] embedding ${slice.length} of ${pending.length} item(s)…`);
    const vecs = await withModelPriority("background", () => embedTexts(texts));

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
    h.progress(progressed, slice.length);
    console.log(`[feed:${worldId}] embedded ${progressed}/${slice.length}; ${remaining} still need embeddings`);
    return { remaining, progressed };
  })().finally(() => {
    endActivity?.();
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
 * Reactive SIDE coverage, sourced from the DISCOVERED registry (placeSources) —
 * the single source of truth for outlets. For the COUNTRIES the live stories are
 * about (the model-emitted `countries` on each analyzed item), fetch each country's
 * own discovered outlets, keep the articles related to those stories, and queue them
 * as PENDING items tagged with their country code (in `zone`). They then analyze and
 * cluster into the story, where the synthesis compares how each side frames it.
 * Bounded: maxZonesPerBuild countries/build, capped sources/country, per-country TTL.
 * Returns how many articles were queued; does NOT analyze.
 */
async function addSideCoverage(worldId: string): Promise<number> {
  if (!config.zones.enabled) return 0;
  const st = getStore(worldId);
  const now = Date.now();
  const cutoff = analyzeCutoff();
  const state = ws(worldId);

  // Seeds: the most important, recent, NON-reactive analyzed items (the stories
  // currently in play). Reactive (already country-tagged) items don't re-seed.
  const seeds = st
    .all()
    .filter(
      (s) =>
        s.analyzed &&
        !s.clickbait &&
        !s.cloneOf && // seed from REPRESENTATIVES only, so attachTo points at a clustered item
        !s.item.zone &&
        s.importance >= config.zones.minSeedImportance &&
        now - s.item.publishedAt <= config.zones.sourceMaxAgeMs,
    )
    .sort((a, b) => b.importance - a.importance || b.item.publishedAt - a.item.publishedAt)
    .slice(0, config.zones.seedItems);
  if (seeds.length === 0) return 0;

  // Accumulate involved COUNTRIES (the model-emitted ISO-2 codes) + the salient
  // tokens AND embeddings of the stories that named each. Tokens relate English
  // coverage; embeddings relate ORIGINAL-LANGUAGE coverage (cross-lingual) that
  // shares no Latin tokens with the seed.
  const involved = new Map<
    string,
    {
      score: number;
      tokens: Set<string>;
      embeddings: number[][];
      seeds: { id: string; tokens: Set<string>; emb?: number[] }[];
    }
  >();
  for (const s of seeds) {
    const ccs = s.countries ?? [];
    if (ccs.length === 0) continue;
    const seedToks = titleTokens(s.item.title, s.keywords);
    for (const cc of ccs) {
      const cur =
        involved.get(cc) ?? { score: 0, tokens: new Set<string>(), embeddings: [], seeds: [] };
      cur.score += 1;
      for (const t of seedToks) cur.tokens.add(t);
      if (s.embedding && s.embedding.length > 0) cur.embeddings.push(s.embedding);
      cur.seeds.push({ id: s.item.id, tokens: seedToks, emb: s.embedding });
      involved.set(cc, cur);
    }
  }
  if (involved.size === 0) return 0;

  // Strongest countries first, skipping any fetched within the TTL, capped per build.
  const chosen = [...involved.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .filter(([cc]) => now - (state.zoneFetchedAt.get(cc) ?? 0) >= config.zones.zoneTtlMs)
    .slice(0, config.zones.maxZonesPerBuild);
  if (chosen.length === 0) return 0;

  let added = 0;
  for (const [cc, info] of chosen) {
    // The country's DISCOVERED outlets (the source of truth). Cap the number fetched
    // per pass so reactively pulling a large country (dozens of feeds) stays bounded.
    const sources = placeSourcesFor(cc).slice(0, config.zones.maxSourcesPerCountry);
    if (sources.length === 0) continue; // discovery hasn't catalogued this country yet
    state.zoneFetchedAt.set(cc, now);
    let raw: FeedItem[];
    try {
      raw = await fetchAll(sources);
    } catch (e) {
      console.warn(`[sides:${worldId}] fetch failed for "${cc}":`, e);
      continue;
    }
    // Candidates: NEW, recent articles from this country's outlets, kept only when
    // RELATED to the triggering stories — by shared salient tokens (English) OR by
    // cross-lingual embedding similarity (original-language) — so we get this
    // country's take on THESE stories, not its entire feed.
    const candidates = raw.filter((it) => !st.has(it.id) && it.publishedAt >= cutoff);
    // Embed candidate titles ONCE — reused for BOTH the relatedness gate (vs the union of
    // this country's seeds) AND picking the single best-matching seed to ATTACH each to.
    let vecs: (number[] | null)[] = [];
    if (config.ai.embeddingsEnabled && info.embeddings.length > 0 && candidates.length > 0) {
      vecs = await embedTexts(candidates.map((c) => c.title));
    }
    const scored = candidates.map((it, i) => {
      const toks = articleTokens(it.title);
      const v = vecs[i];
      // GATE relatedness vs the UNION of the country's seeds (keeps recall unchanged).
      let shared = 0;
      for (const t of toks) if (info.tokens.has(t)) shared += 1;
      let sim = 0;
      if (v && v.length > 0) for (const e of info.embeddings) sim = Math.max(sim, cosineSim(v, e));
      // ATTACH to the single best-matching seed, so this article force-joins THAT story.
      let attachTo = info.seeds[0]?.id;
      let bestSeedScore = -1;
      for (const sd of info.seeds) {
        let sShared = 0;
        for (const t of toks) if (sd.tokens.has(t)) sShared += 1;
        let sSim = 0;
        if (v && v.length > 0 && sd.emb && sd.emb.length > 0) sSim = cosineSim(v, sd.emb);
        const sc = sSim * 2 + sShared * 0.1; // embedding dominates; tokens break ties
        if (sc > bestSeedScore) {
          bestSeedScore = sc;
          attachTo = sd.id;
        }
      }
      return { it, shared, sim, attachTo };
    });
    const related = scored
      .filter((x) => x.shared >= config.zones.minSharedTokens || x.sim >= config.zones.minRelevance)
      .sort((a, b) => b.sim - a.sim || b.shared - a.shared || b.it.publishedAt - a.it.publishedAt)
      .slice(0, config.zones.perZoneItemCap);

    for (const { it, attachTo } of related) {
      st.upsert({
        // Tag the item with the COUNTRY it represents (its "side" vantage) — placeSources
        // outlets carry no zone, so we set it here — AND with `attachTo`: the seed story it
        // was fetched for, so the planner FORCE-JOINS it onto that story (the "dive deeper"
        // behaviour as the normal path) rather than leaving it to the same-event clustering bar.
        item: { ...it, zone: cc },
        clickbait: false,
        analyzed: false, // full analysis pending, same as any item
        topic: it.topic,
        lean: it.lean,
        importance: 0,
        summary: "",
        keywords: [],
        analyzedAt: 0,
        ...(config.zones.forceJoin && attachTo ? { attachTo } : {}),
      });
      added += 1;
    }
    if (related.length > 0) {
      console.log(
        `[sides:${worldId}] queued ${related.length} "${countryLabel(cc)}" article(s) for analysis`,
      );
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
    const analyses = await analyzeItems(
      withT.map((s) => s.item),
      transcripts,
      () => {},
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
 * one runs per world. Model passes share the bounded request gate (ai.ts).
 */
function augmentReactively(worldId: string): Promise<void> {
  const state = ws(worldId);
  if (state.augmentInFlight) return state.augmentInFlight;

  // The WHOLE augmentation runs under one activity so the indicator never blinks off during
  // it (the old `active` heuristic ignored augmentInFlight entirely — a key cause of the
  // "disappears mid-work" bug). Its stage tracks what it's actually doing.
  state.augmentInFlight = withActivity(worldId, "transcripts", async (h) => {
    // Deferred transcript enrichment for important video/podcast items (all pools).
    // If anything was re-analyzed, its embedding was cleared — re-embed in the bg.
    const enriched = await enrichTranscripts(worldId);
    if (enriched > 0) runBackfillBatch(worldId);

    // GEO pools show everything their own outlets report — no geo-scope filtering,
    // and no YouTube/zone augmentation (those extend TOPICAL worlds). Nothing more.
    if (isGeoPoolId(worldId)) return;
    // Regional pool: classify geo-scope (no YouTube/zones — those are international).
    if (isPlaceWorldId(worldId)) {
      h.stage("analyzing");
      await classifyRegionalScope(worldId);
      return;
    }
    h.stage("fetching");
    let added = 0;
    added += await addYouTubePending(worldId);
    added += await addSideCoverage(worldId);
    if (added === 0) return;

    getStore(worldId).save();

    // Analyze the newly-added items (chained so the cascade completes). analyzePending
    // is per-world re-entrancy-guarded and its model passes share the bounded request
    // gate (ai.ts), so this needs no cross-world lock.
    runBackfillBatch(worldId);
  })
    .catch((e) => {
      console.warn(`[augment:${worldId}] reactive augmentation failed:`, e);
    })
    .finally(() => {
      state.augmentInFlight = null;
    });
  return state.augmentInFlight;
}

/**
 * FLUSH the backlog: drain a chunk of the prescreen queue (so more provisional items
 * enter the feed), then deep-analyze + embed a chunk of what's ready — newest first —
 * and KEEP running batches while progress is made AND the reader is still on this pool.
 * Once articles are fetched they're analyzed to completion: we never leave new articles
 * un-analyzed (deep analysis is the stream's "flush"). Deep analysis is itself capped per
 * pool by deepAnalyzeKeep, and the chain winds down when the backlog clears or the reader
 * navigates away.
 *
 * Self-guarded: ONE batch at a time (the re-entrancy guard below), and only ever kicked
 * off by buildPool — which runs solely on a TTL-gated feed fetch, never on a bare status
 * poll — so the UI's polling can't re-arm or stack a flush.
 *
 * When the deep-analysis backlog empties, reactively extend the stories (YouTube +
 * per-zone coverage). Model passes share the bounded gate (ai.ts), below interactive.
 */
function runBackfillBatch(worldId: string): void {
  const state = ws(worldId);
  // ONE drain chain at a time. The chain holds `draining` for its WHOLE life — including the
  // inter-batch delays below — so the indicator stays lit between batches instead of blinking
  // off (each pass also registers its own activity, which refines the displayed stage).
  if (state.draining) return;
  state.draining = true;
  void (async () => {
    try {
      for (;;) {
        // Space batches out so a provisional response can land first and the model isn't
        // pinned; the `draining` keep-alive covers this gap in the indicator.
        await sleep(config.feed.catchUpDelayMs);
        // The WHOLE drain is BACKGROUND priority — deep analysis included. This is what makes
        // the gate's reserved interactive slot (config.ai.reserveInteractive) genuinely keep an
        // instance free for user-facing requests; otherwise the bulk backlog (which defaults to
        // interactive) fills every instance and the reader's search/briefing waits behind it.
        const { p, a, e } = await withModelPriority("background", async () => ({
          p: await prescreenPending(worldId),
          a: await analyzePending(worldId),
          e: await embedPending(worldId),
        }));
        const progressed = p.progressed + a.progressed + e.progressed;
        const pending = p.remaining + a.remaining + e.remaining;
        console.log(
          `[feed:${worldId}] backfill batch: ` +
            `+${p.progressed} prescreened, +${a.progressed} analyzed, +${e.progressed} embedded ` +
            `(${pending} still pending)`,
        );
        // Mark a successful batch — a navigation refresh won't start a fresh round until
        // config.feed.navBatchTtlMs after this.
        if (progressed > 0) state.lastBatchAt = Date.now();
        // Keep draining while there's progress to make AND the reader is still here.
        if (progressed > 0 && pending > 0 && isWatched(worldId)) continue;
        // Deep-analysis backlog cleared — reactively extend the stories (YouTube + per-zone
        // coverage); whatever it adds starts its OWN drain once this one releases `draining`.
        if (a.progressed > 0 && a.remaining === 0)
          void withModelPriority("background", () => augmentReactively(worldId));
        break;
      }
    } catch (err) {
      console.warn(`[feed:${worldId}] backfill drain failed:`, err);
    } finally {
      state.draining = false;
    }
  })();
}

/** How much in-window material a pool currently has to show/analyze: prescreened
 *  survivors already in the store PLUS items fetched-but-not-yet-triaged (the prescreen
 *  queue). coldFill uses this to decide when a freshly-opened pool has a "decent backlog"
 *  and can stop pulling further source subsets. */
function coldBacklogSize(worldId: string): number {
  const cutoff = analyzeCutoff();
  let servable = 0;
  for (const s of getStore(worldId).all()) {
    if (s.clickbait || s.global === true || s.item.publishedAt < cutoff) continue;
    servable += 1;
  }
  return servable + ws(worldId).prescreenQueue.length;
}

/**
 * COLD-FILL. A freshly-opened pool is just a warm refresh that KEEPS pulling further
 * rotating source subsets — one at a time, never every source at once — until there's a
 * decent backlog of in-window material (config.feed.coldBacklogTarget), or it has cycled
 * through all sources once, or the reader navigates away. Then it hands off to the normal
 * chained backfill that progressively deep-analyzes the pool while watched. The FIRST
 * subset was already fetched by buildPool, so this continues from the second.
 */
async function coldFill(worldId: string): Promise<void> {
  const allCount = sourcesForWorld(worldId).length;
  const budget = config.feed.sourceFetchBudget;
  // Cap at one full pass of the deck so a quiet pool can't loop forever; subset 1 is done.
  const maxFetches = budget > 0 && budget < allCount ? Math.ceil(allCount / budget) : 1;
  let fetches = 1;
  try {
    while (
      fetches < maxFetches &&
      isWatched(worldId) &&
      coldBacklogSize(worldId) < config.feed.coldBacklogTarget
    ) {
      await refreshSources(worldId); // pull the next rotating subset
      fetches += 1;
    }
  } catch (e) {
    console.warn(`[feed:${worldId}] cold-fill fetch loop failed:`, e);
  }
  console.log(
    `[feed:${worldId}] cold-fill: pulled ${fetches} subset(s), backlog ${coldBacklogSize(worldId)} ` +
      `(target ${config.feed.coldBacklogTarget}) — handing off to backfill`,
  );
  // Hand off to the same flush every pool uses: deep-analyze the backlog while watched.
  runBackfillBatch(worldId);
}

/** What kicked off a pool (re)build — governs whether it starts a deep-analysis round. */
export type RefreshTrigger = "manual" | "navigation" | "auto";

/**
 * Bring a world's store up to date: fetch a rotating source SUBSET and cheap-triage the
 * freshest chunk so PROVISIONAL items are immediately servable. Whether it then FLUSHES (a
 * deep-analysis round — AI_MAX_ITEMS per batch, chained through the backlog while watched)
 * depends on the TRIGGER:
 *  - COLD open (empty pool): always — coldFill pulls rotating subsets until there's a decent
 *    backlog, then flushes. You need SOMETHING to show.
 *  - MANUAL refresh (button / pull-to-refresh): always flush.
 *  - NAVIGATION (switching to a pool): flush only if it's been >= navBatchTtlMs since the
 *    last batch — so flipping between pools doesn't re-kick processing every time.
 *  - AUTO (live reload / quiet TTL re-fetch): never flush — fetch + triage only. The new
 *    items show provisionally and deep-analyze on the next manual / eligible navigation.
 *
 * buildPool runs only on an actual (TTL-gated) feed fetch — a bare status poll never
 * triggers it — and runBackfillBatch is single-flight, so polling can't re-arm or stack a
 * flush, and each flush ends on its own once the backlog is empty.
 */
async function buildPool(
  worldId: string,
  opts: { cold: boolean; trigger: RefreshTrigger },
): Promise<void> {
  const state = ws(worldId);
  // Only a COLD first paint (reader waiting on an empty pool) earns interactive triage; a
  // WARM refresh (auto/navigation/manual) is server-driven and runs background so it never
  // occupies the gate's reserved interactive slot and delays the reader's search/briefing.
  await refreshSources(worldId, opts.cold ? "interactive" : "background");
  // A (re)build means the reader is here — seed the watch gate so the flush chain isn't
  // cut off before the client's first status poll lands.
  markWatched(worldId);

  if (opts.cold) {
    // Cold always processes: coldFill keeps pulling rotating subsets until a decent backlog,
    // then flushes. Fire-and-forget — the first subset's provisional items already serve.
    state.lastBatchAt = Date.now();
    void coldFill(worldId);
    return;
  }

  // Warm rebuild: start a deep-analysis round only when the trigger allows it.
  const sinceBatch = Date.now() - state.lastBatchAt;
  const flush =
    opts.trigger === "manual" ||
    (opts.trigger === "navigation" && sinceBatch >= config.feed.navBatchTtlMs);
  if (flush) {
    state.lastBatchAt = Date.now();
    runBackfillBatch(worldId);
  } else {
    console.log(
      `[feed:${worldId}] ${opts.trigger} refresh — fetched + triaged; deep-analysis batch deferred` +
        (opts.trigger === "navigation"
          ? ` (last batch ${(sinceBatch / 60000).toFixed(0)}m ago < ${(config.feed.navBatchTtlMs / 60000).toFixed(0)}m)`
          : ""),
    );
  }
}

/**
 * Ensure a world's pool is fresh (TTL) or forced. Each world builds INDEPENDENTLY
 * now (model passes share the bounded request gate in ai.ts), so worlds never block each
 * other — switching is responsive. `busyWith` is always null, kept only for API
 * compatibility with the client/status shape.
 */
async function ensurePool(
  worldId: string,
  trigger: RefreshTrigger,
): Promise<{ busyWith: string | null }> {
  const state = ws(worldId);
  const st = getStore(worldId);
  // Only a MANUAL refresh bypasses the freshness TTL; navigation/auto respect it.
  const force = trigger === "manual";
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

  // cold = nothing to show yet (coldFill keeps pulling rotating subsets until a decent
  // backlog, then flushes). For a warm rebuild, buildPool decides whether to FLUSH (run a
  // deep-analysis round) from the TRIGGER: manual always; navigation only if it's been
  // >= navBatchTtlMs since the last batch; automatic/live-reload never (fetch + triage only).
  const build = buildPool(worldId, { cold: !hasContent, trigger }).finally(() => {
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
  trigger: RefreshTrigger = "navigation",
  interest = config.feed.interest,
): Promise<FeedResult> {
  const { busyWith } = await ensurePool(worldId, trigger);
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
  // The briefing reads the pool the feed built — it must never kick off a processing round
  // on its own (the feed's getFeed is the sole driver); only honor an explicit force.
  await ensurePool(worldId, force ? "manual" : "auto");
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
  await ensurePool(worldId, "auto");
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

/** The persisted (last-session) synthesized stories for a store key, served as a STALE
 *  set immediately on a cold in-memory cache (e.g. right after a server restart) while a
 *  fresh build runs in the background — so /api/stories returns the last-built set instead
 *  of an empty array. Developing-first then most-recent, capped to a live result's size. */
function persistedStories(storeKey: string): Story[] {
  return getStoryStore(storeKey)
    .all()
    .map((e) => e.story)
    .sort((a, b) => {
      const da = a.developing ? 1 : 0;
      const db = b.developing ? 1 : 0;
      if (db !== da) return db - da;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, config.stories.maxStories);
}

/** Snapshot config.stories into the plain, serializable shape the (worker-run) story
 *  planner needs — keeping computeStoryPlan pure and free of any config/env access. */
function storyPlanConfig(): StoryPlanConfig {
  const s = config.stories;
  return {
    simThreshold: s.simThreshold,
    textSimThreshold: s.textSimThreshold,
    windowMs: s.windowMs,
    issueSimThreshold: s.issueSimThreshold,
    issueTextSimThreshold: s.issueTextSimThreshold,
    issueWindowMs: s.issueWindowMs,
    issueMinSpanMs: s.issueMinSpanMs,
    issueMinEvents: s.issueMinEvents,
    issueMinSources: s.issueMinSources,
    issueActiveMs: s.issueActiveMs,
    maxIssues: s.maxIssues,
    minSources: s.minSources,
    maxStories: s.maxStories,
  };
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
  // Stories are a secondary consumer too — don't let them start a processing round (the
  // feed does); honor only an explicit force.
  const { busyWith } = await ensurePool(worldId, force ? "manual" : "auto");
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
  // Per-language persistent store so EN and ES syntheses don't cross-pollinate.
  const storeKey = lang === "en" ? worldId : `${worldId}__${lang}`;
  // Stale set to serve IMMEDIATELY while a (re)build runs: the in-memory result if we have
  // one, else the PERSISTED stories from disk — so right after a server restart we return
  // the last-built set instead of an empty array until synthesis finishes.
  const stale = cachedForLang?.stories ?? persistedStories(storeKey);

  // A (re)build for this language is already running: return the stale set now and let it
  // finish in the background. We must NOT await it — synthesis is dozens of slow LLM calls,
  // and blocking the response on it is what made /api/stories hang for minutes while the
  // feed/status endpoints stayed responsive.
  if (state.storiesInFlight.get(lang)) {
    return { stories: stale, busyWith, synthesizing: true };
  }
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
      // FORCE-JOIN: reactive side coverage carries the seed story it was fetched for, so
      // computeStoryPlan attaches it to that story's cluster past the same-event bar.
      attachTo: s.attachTo,
    }));

    // Cluster + plan OFF the event loop (worker thread). The O(n^2) clustering that used
    // to run synchronously right here is what froze the whole server on a switch; now we
    // await a lightweight plan (article-id groupings) and map ids back to StoredItems.
    const { specs: planSpecs, stats } = await runStoryPlan(inputs, storyPlanConfig());
    const toStoredIds = (ids: string[]): StoredItem[] =>
      ids.map((id) => byId.get(id)).filter((s): s is StoredItem => !!s);

    // Target story specs (deterministic; no model calls yet) — ids mapped back to items.
    type Spec = {
      kind: StoryKind;
      members: StoredItem[];
      /** Sub-events (for an issue's timeline); undefined for event stories. */
      events?: StoredItem[][];
      centroid: number[] | null;
    };
    const specs: Spec[] = planSpecs
      .map((spec): Spec => ({
        kind: spec.kind,
        members: toStoredIds(spec.memberIds),
        events: spec.eventIds?.map(toStoredIds).filter((e) => e.length > 0),
        centroid: spec.centroid,
      }))
      .filter((s) => s.members.length > 0);

    console.log(
      `[stories:${worldId}] eligible=${stats.eligible} clusters=${stats.clusters} ` +
        `issues=${stats.issues} developing=${stats.developing} events=${stats.topEvents} ` +
        `kept=${specs.length} (failed gates events:${stats.failEvents} span:${stats.failSpan} ` +
        `sources:${stats.failSources} active:${stats.failActive})`,
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
    // Story synthesis is dozens of slow LLM calls — surface it as its own stage with a live
    // count so a reader on the Stories tab sees real progress, not a frozen spinner.
    const synthAct = toSynth.length > 0 ? beginActivity(worldId, "synthesizing") : null;
    synthAct?.handle.progress(0, toSynth.length);
    let synthDone = 0;
    // Synthesis is dozens of slow LLM calls — run it at BACKGROUND priority so it yields the
    // gate's reserved interactive slot to user-facing requests instead of monopolizing instances.
    const synthed = await withModelPriority("background", () =>
      withConcurrency(
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
          synthAct?.handle.progress(++synthDone, toSynth.length);
          return { story, centroid: t.spec.centroid, tokens: storyTokens(story) };
        }),
        config.ai.concurrency,
      ),
    ).finally(() => synthAct?.end());

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
  return { stories: stale, busyWith, synthesizing: true };
}

/**
 * STREAMING stories: push the cached/persisted set IMMEDIATELY (so the Stories tab paints
 * the instant you switch pools), then — if a fresh build is running in the background —
 * await it and push the fresh set when it lands. No client polling; the synthesis stays
 * background-priority so it never steals an instance from a waiting reader. `onUpdate` is
 * called once (cache hit) or twice (stale now, fresh later).
 */
export async function getStoriesStream(
  worldId: string = DEFAULT_WORLD_ID,
  lang: Lang = "en",
  force = false,
  onUpdate: (stories: Story[], synthesizing: boolean) => void = () => {},
): Promise<void> {
  // getStories returns the stale set immediately AND kicks off the single-flight build.
  const first = await getStories(worldId, force, lang);
  onUpdate(first.stories, first.synthesizing);
  if (!first.synthesizing) return;
  // A build is running — await THAT promise and push its fresh, sorted result.
  const inFlight = ws(worldId).storiesInFlight.get(lang);
  if (!inFlight) return;
  const fresh = await inFlight.catch(() => null);
  if (fresh) onUpdate(fresh, false);
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

/** One verbose progress line streamed by `deepenStory`, for the in-app debug log. */
export interface DeepenLog {
  level: "info" | "step" | "ok" | "warn";
  msg: string;
}

/**
 * "DIVE DEEPER" on a single story (debug + on-demand enrichment): re-derive the COUNTRIES
 * the story is about, reactively pull each country's DISCOVERED placeSources, keep the
 * coverage related to THIS story, analyze it, FORCE-JOIN it onto the story's member set
 * (bypassing the same-event clustering bar — that's the point of the manual deepen), and
 * RE-SYNTHESIZE so the cross-country SIDES recompute. Every step is reported via `onLog`
 * so the reader can see exactly what the server looked for. Returns the rebuilt story
 * (also persisted + swapped into the in-memory cache), or null when it can't be resolved.
 */
export async function deepenStory(
  worldId: string,
  id: string,
  lang: Lang,
  onLog: (entry: DeepenLog) => void,
): Promise<Story | null> {
  const log = (level: DeepenLog["level"], msg: string) => onLog({ level, msg });
  const storeKey = lang === "en" ? worldId : `${worldId}__${lang}`;
  const storyStore = getStoryStore(storeKey);
  const entry = storyStore.get(id);
  if (!entry) {
    log("warn", `Story "${id}" isn't in the store (it may have aged out). Nothing to deepen.`);
    return null;
  }
  log("info", `Story: "${entry.story.title}"`);
  log("info", `Kind: ${entry.kind} · ${entry.memberIds.length} contributing article(s).`);

  const st = getStore(worldId);
  const members = entry.memberIds
    .map((mid) => st.get(mid))
    .filter((s): s is StoredItem => !!s);
  if (members.length === 0) {
    log("warn", "None of the contributing articles are still in the pool — cannot deepen.");
    return null;
  }

  // 1) Which COUNTRIES is the story about? The model tags each article's `countries`; we
  //    also fold in any existing side zones + the protagonist nation. This is the input
  //    to side detection, so surfacing it is the first debug signal.
  const countryScore = new Map<string, number>();
  for (const m of members) for (const cc of m.countries ?? []) {
    countryScore.set(cc, (countryScore.get(cc) ?? 0) + 1);
  }
  for (const side of entry.story.sides ?? []) for (const z of side.zones) {
    if (/^[a-z]{2}$/.test(z)) countryScore.set(z, (countryScore.get(z) ?? 0) + 1);
  }
  const proto = entry.story.protagonist?.iso2;
  if (proto && /^[a-z]{2}$/.test(proto)) countryScore.set(proto, (countryScore.get(proto) ?? 0) + 1);
  const countries = [...countryScore.entries()].sort((a, b) => b[1] - a[1]).map(([cc]) => cc);
  if (countries.length === 0) {
    log(
      "warn",
      "No countries detected on the contributing articles (the model tagged none), so no " +
        "foreign side coverage can be fetched and no sides can form.",
    );
  } else {
    log("step", `Detected countries: ${countries.map((cc) => `${countryLabel(cc)} [${cc}]`).join(", ")}`);
  }

  // Relatedness seeds from the story's members: salient tokens (English) + embeddings
  // (cross-lingual), so a fetched country article is kept only if it's about THIS story.
  const seedTokens = new Set<string>();
  const seedEmb: number[][] = [];
  for (const m of members) {
    for (const tk of titleTokens(m.item.title, m.keywords)) seedTokens.add(tk);
    if (m.embedding && m.embedding.length > 0) seedEmb.push(m.embedding);
  }

  const cutoff = analyzeCutoff();
  const newItems: FeedItem[] = [];
  for (const cc of countries.slice(0, config.zones.maxZonesPerBuild)) {
    const sources = placeSourcesFor(cc).slice(0, config.zones.maxSourcesPerCountry);
    if (sources.length === 0) {
      log("warn", `${countryLabel(cc)} [${cc}]: no discovered outlets in the registry — skipped.`);
      continue;
    }
    log("step", `${countryLabel(cc)} [${cc}]: fetching ${sources.length} discovered outlet(s)…`);
    let raw: FeedItem[] = [];
    try {
      raw = await fetchAll(sources);
    } catch (e) {
      log("warn", `${countryLabel(cc)}: fetch failed — ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const fresh = raw.filter((it) => !st.has(it.id) && it.publishedAt >= cutoff);
    log("info", `${countryLabel(cc)}: ${raw.length} fetched, ${fresh.length} new & recent.`);
    const scored = fresh.map((it) => {
      let shared = 0;
      for (const tk of articleTokens(it.title)) if (seedTokens.has(tk)) shared += 1;
      return { it, shared, sim: 0 };
    });
    if (config.ai.embeddingsEnabled && seedEmb.length > 0 && scored.length > 0) {
      const vecs = await embedTexts(scored.map((x) => x.it.title));
      scored.forEach((x, i) => {
        const v = vecs[i];
        if (!v || v.length === 0) return;
        let best = 0;
        for (const e of seedEmb) best = Math.max(best, cosineSim(v, e));
        x.sim = best;
      });
    }
    const related = scored
      .filter((x) => x.shared >= config.zones.minSharedTokens || x.sim >= config.zones.minRelevance)
      .sort((a, b) => b.sim - a.sim || b.shared - a.shared || b.it.publishedAt - a.it.publishedAt)
      .slice(0, config.zones.perZoneItemCap);
    log(
      related.length > 0 ? "ok" : "warn",
      `${countryLabel(cc)}: kept ${related.length} related of ${fresh.length} ` +
        `(gate: ≥${config.zones.minSharedTokens} shared tokens OR ≥${config.zones.minRelevance} similarity).`,
    );
    for (const { it, shared, sim } of related) {
      newItems.push({ ...it, zone: cc });
      log("info", `   • ${it.sourceTitle}: "${it.title.slice(0, 90)}" (shared ${shared}, sim ${sim.toFixed(2)})`);
    }
  }

  // 2) Analyze the new side coverage so it carries summary/keywords/lean like any item.
  const newMembers: StoredItem[] = [];
  if (newItems.length > 0) {
    log("step", `Analyzing ${newItems.length} new article(s)…`);
    const analyses = await analyzeItems(newItems, new Map());
    const now = Date.now();
    for (const it of newItems) {
      const a = analyses.get(it.id);
      const stored: StoredItem = a
        ? {
            item: it,
            clickbait: false,
            analyzed: true,
            topic: a.topic,
            lean: a.lean ?? it.lean,
            leanSource: "source",
            importance: a.importance,
            summary: a.summary,
            keywords: a.keywords,
            countries: a.countries,
            analyzedAt: now,
          }
        : {
            item: it,
            clickbait: false,
            analyzed: false,
            topic: it.topic,
            lean: it.lean,
            importance: 0,
            summary: "",
            keywords: [],
            analyzedAt: 0,
          };
      st.upsert(stored);
      if (a) newMembers.push(stored);
    }
    st.save();
    log("ok", `Analyzed ${newMembers.length} of ${newItems.length}.`);
  } else {
    log("warn", "No new side coverage found to add.");
  }

  // 3) FORCE-JOIN the new coverage onto the story and re-synthesize, so the SIDES recompute.
  const expanded = [...members, ...newMembers];
  const vantages = new Set(expanded.map((m) => m.item.zone).filter((z): z is string => !!z));
  log(
    "step",
    `Re-synthesizing with ${expanded.length} article(s) — foreign vantages present: ` +
      `${vantages.size > 0 ? [...vantages].map((cc) => countryLabel(cc)).join(", ") : "none (home coverage only)"}.`,
  );
  let rebuilt: Story;
  if (entry.kind === "issue") {
    const inputs: ClusterInput[] = expanded.map((m) => ({
      id: m.item.id,
      sourceId: m.item.sourceId,
      publishedAt: m.item.publishedAt,
      topic: m.topic,
      importance: m.importance,
      title: m.item.title,
      keywords: m.keywords,
      embedding: m.embedding,
      coveredBy: m.coveredBy,
    }));
    const byId = new Map(expanded.map((m) => [m.item.id, m]));
    const events = clusterItems(inputs, {
      simThreshold: config.stories.simThreshold,
      textSimThreshold: config.stories.textSimThreshold,
      windowMs: config.stories.issueWindowMs,
    })
      .map((c) => c.members.map((x) => byId.get(x.id)).filter((s): s is StoredItem => !!s))
      .filter((e) => e.length > 0)
      .sort(
        (a, b) =>
          Math.min(...a.map((x) => x.item.publishedAt)) -
          Math.min(...b.map((x) => x.item.publishedAt)),
      );
    rebuilt = await buildDevelopingStory(events.length > 0 ? events : [expanded], lang);
  } else {
    rebuilt = await buildStory(expanded, lang);
  }
  rebuilt.id = entry.id; // keep continuity across the re-synthesis

  const memberIds = expanded.map((m) => m.item.id).sort();
  storyStore.upsert({
    id: entry.id,
    kind: entry.kind,
    memberIds,
    story: rebuilt,
    builtAt: Date.now(),
    updatedAt: rebuilt.updatedAt,
  });
  storyStore.save();
  // Swap the rebuilt story into the in-memory cache so the next /api/stories reflects it.
  const cache = ws(worldId).storiesCache.get(lang);
  if (cache) {
    const idx = cache.stories.findIndex((s) => s.id === entry.id);
    if (idx >= 0) cache.stories[idx] = rebuilt;
  }

  if (rebuilt.sides && rebuilt.sides.length > 0) {
    log(
      "ok",
      `Sides formed (${rebuilt.sides.length}): ` +
        rebuilt.sides
          .map((s) => `${s.label} [${s.zones.length > 0 ? s.zones.join(",") : "—"}]`)
          .join("  |  "),
    );
  } else {
    log(
      "warn",
      "No sides formed — synthesis needs ≥1 foreign-country outlet AND ≥2 distinct vantage " +
        "points. Check the country detection + fetched coverage above.",
    );
  }
  log("ok", "Done.");
  return rebuilt;
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
