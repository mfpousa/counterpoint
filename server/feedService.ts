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
import type { AnalysisStatus, Briefing, FeedItem, Lang, Place, Story } from "../src/types";
import { DEFAULT_WORLD_ID, isPlaceWorldId, placeCountryOf, worldSources } from "../src/data/worlds";
import { ZONES, ZONES_BY_ID } from "../src/data/zones";
import { detectZones } from "../src/lib/zones";
import { placeBoostedRelevance, scorePlace } from "../src/lib/places";
import { gazetteerFor } from "./places";
import { placeSourcesFor } from "./placeSources";
import type { Source } from "../src/types";
import { aiReachable, withConcurrency } from "./ai";
import { analyzeItems, classifyGlobalScope, detectClickbait } from "./analysis";
import { generateBriefing, generateBriefingStream } from "./briefing";
import {
  clusterItems,
  distinctSources,
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
import { getStore, type StoredItem } from "./store";
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
type BuildPhase = "idle" | "fetching" | "triage" | "transcripts" | "analyzing";

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
  storiesCache: Map<string, { builtAt: number; stories: Story[] }>;
  storiesInFlight: Map<string, Promise<Story[]>>;
  buildInFlight: Promise<void> | null;
  analyzeInFlight: Promise<{ remaining: number; progressed: number }> | null;
  embedInFlight: Promise<{ remaining: number; progressed: number }> | null;
  /** Reactive augmentation pass — YouTube + intl zones (fire-and-forget, one per world). */
  augmentInFlight: Promise<void> | null;
  /** Per-zone last fetch time (epoch ms), for the reactive-load TTL. */
  zoneFetchedAt: Map<string, number>;
  catchUpTimer: ReturnType<typeof setTimeout> | null;
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
      buildInFlight: null,
      analyzeInFlight: null,
      embedInFlight: null,
      augmentInFlight: null,
      zoneFetchedAt: new Map(),
      catchUpTimer: null,
    };
    worldStates.set(worldId, s);
  }
  return s;
}

// GLOBAL single-build lock: deep analysis is expensive, so only ONE world may be
// building (foreground OR draining its backlog) at any moment. While held,
// requests for a DIFFERENT world serve that world's existing pool and report
// `busyWith` instead of starting a competing build.
let buildingWorld: string | null = null;

function setPhase(state: WorldState, phase: BuildPhase, done = 0, total = 0): void {
  state.status = { phase, done, total };
}

/** Snapshot of build/analysis progress for a world, for the UI. */
export function getStatus(worldId: string = DEFAULT_WORLD_ID): AnalysisStatus {
  const state = ws(worldId);
  const st = getStore(worldId);
  const cutoff = analyzeCutoff();
  let pending = 0;
  let analyzed = 0;
  for (const s of st.all()) {
    if (s.clickbait || s.item.publishedAt < cutoff) continue;
    if (s.analyzed) analyzed += 1;
    else pending += 1;
  }
  const active =
    state.status.phase !== "idle" ||
    state.buildInFlight !== null ||
    state.analyzeInFlight !== null ||
    buildingWorld === worldId;
  const busyWith = buildingWorld && buildingWorld !== worldId ? buildingWorld : null;
  return {
    phase: state.status.phase,
    active,
    done: state.status.done,
    total: state.status.total,
    pending,
    analyzed,
    world: worldId,
    busyWith,
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

/** The recency-ordered backlog of items still needing deep analysis. Items the
 *  cheap triage pass already judged GLOBAL (in a regional pool) are excluded —
 *  they'd be filtered out of the local feed anyway, so we never pay the expensive
 *  pass on them. */
function pendingForAnalysis(worldId: string): StoredItem[] {
  const cutoff = analyzeCutoff();
  return getStore(worldId)
    .all()
    .filter((s) => !s.clickbait && !s.analyzed && s.global !== true && s.item.publishedAt >= cutoff)
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt);
}

/**
 * The source set for a pool. Topical worlds use their curated sources; a REGIONAL
 * pool (`place-<cc>`) is fed EXCLUSIVELY by that country's locally-discovered
 * outlets — the "International vs Regional" dataset switch.
 */
function sourcesForWorld(worldId: string): Source[] {
  const cc = placeCountryOf(worldId);
  return cc ? placeSourcesFor(cc) : worldSources(worldId);
}

/**
 * Network phase: fetch all sources, triage brand-new & recent items, and store
 * them — junk flagged, survivors marked PENDING (analyzed:false). Deep analysis
 * is deferred to analyzePending() so the build is chunked, not a multi-hour block.
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
  // Never-seen items inside the recency window are all that need triage.
  const untriaged = raw.filter((it) => !st.has(it.id) && it.publishedAt >= cutoff);
  console.log(
    `[feed:${worldId}] fetched ${raw.length}; ${untriaged.length} new & recent to triage; ${st.size()} in store`,
  );

  if (untriaged.length > 0) {
    // Fail fast if the model is down: don't store half-processed items; retry later.
    if (!(await aiReachable())) {
      console.warn(`[feed:${worldId}] AI endpoint unreachable — skipping triage this refresh.`);
      state.lastBuildAt = Date.now();
      setPhase(state, "idle");
      return;
    }
    let junk = new Set<string>();
    if (config.feed.clickbaitFilter) {
      const batches = Math.ceil(untriaged.length / config.ai.triageBatchSize);
      console.log(`[feed:${worldId}] triage: ${untriaged.length} headline(s) in ${batches} batch(es)…`);
      junk = await detectClickbait(untriaged, progressLogger(state, "triage"));
      console.log(`[feed:${worldId}] triage flagged ${junk.size}/${untriaged.length} as clickbait/junk`);
    }

    // REGIONAL pools: judge local-vs-global from the HEADLINE now (cheap, title-
    // only) and drop the obvious internationals BEFORE the expensive deep pass —
    // local outlets republish a lot of globally-covered news. Conservative: the
    // prompt keeps anything it's unsure about. Only non-junk items are worth the
    // check. Topical worlds skip this (global flag stays undefined).
    const cc = placeCountryOf(worldId);
    let globals = new Set<string>();
    if (cc && config.place.sourcesEnabled) {
      const localCandidates = untriaged.filter((it) => !junk.has(it.id));
      if (localCandidates.length > 0) {
        console.log(`[feed:${worldId}] geo-scope: classifying ${localCandidates.length} headline(s) local/global…`);
        globals = await classifyGlobalScope(
          localCandidates.map((it) => ({ id: it.id, title: it.title, summary: it.summary })),
          placeLabelFor(cc),
          progressLogger(state, "triage"),
        );
        console.log(
          `[feed:${worldId}] geo-scope flagged ${globals.size}/${localCandidates.length} as global ` +
            `(dropped before deep analysis)`,
        );
      }
    }

    for (const it of untriaged) {
      st.upsert({
        item: it,
        clickbait: junk.has(it.id),
        // Set at triage for regional pools so the global stories are excluded from
        // the deep-analysis backlog (pendingForAnalysis) and the local feed.
        global: cc ? globals.has(it.id) : undefined,
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

  const removed = st.prune();
  if (removed > 0) console.log(`[feed:${worldId}] pruned ${removed} stale item(s)`);
  st.save();
  state.lastBuildAt = Date.now();
  console.log(`[feed:${worldId}] refresh done in ${state.lastBuildAt - started}ms`);
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

    setPhase(state, "transcripts", 0, items.length);
    console.log(`[feed:${worldId}] fetching transcripts for up to ${items.length} item(s)…`);
    const transcripts = await fetchTranscripts(items);
    if (transcripts.size > 0) console.log(`[feed:${worldId}] fetched ${transcripts.size} transcript(s)`);

    const batches = Math.ceil(items.length / config.ai.batchSize);
    console.log(
      `[feed:${worldId}] deep analysis: ${items.length} of ${pending.length} pending in ${batches} batch(es)` +
        ` (concurrency ${config.ai.concurrency})…`,
    );
    const analyses = await analyzeItems(items, transcripts, progressLogger(state, "analyze"));

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
    console.log(`[feed:${worldId}] embedding ${slice.length} of ${pending.length} item(s)…`);
    const vecs = await embedTexts(texts);

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
 * Run the reactive augmentations after a build. TOPICAL worlds get YouTube
 * discovery + international zones; a REGIONAL pool instead gets the geo-scope
 * pass (drop global stories from local outlets). Fire-and-forget; guarded so only
 * one runs per world. To honor the GLOBAL single-build invariant, analysis runs
 * only when the build lock is free; otherwise new items stay pending for the next
 * drain.
 */
function augmentReactively(worldId: string): Promise<void> {
  const state = ws(worldId);
  if (state.augmentInFlight) return state.augmentInFlight;

  state.augmentInFlight = (async () => {
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

    // Analyze the new items exactly like any other pending item, under the lock.
    if (buildingWorld) return; // busy elsewhere; the next drain will pick them up
    buildingWorld = worldId;
    try {
      const a = await analyzePending(worldId);
      const e = await embedPending(worldId);
      const moreWork =
        (a.remaining > 0 && a.progressed > 0) || (e.remaining > 0 && e.progressed > 0);
      if (moreWork) scheduleCatchUp(worldId);
      else if (buildingWorld === worldId) buildingWorld = null;
    } catch (err) {
      if (buildingWorld === worldId) buildingWorld = null;
      throw err;
    }
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
 *  embedding backlogs. Holds the GLOBAL build lock until the backlog clears. */
function scheduleCatchUp(worldId: string): void {
  const state = ws(worldId);
  if (state.catchUpTimer) return;
  state.catchUpTimer = setTimeout(() => {
    state.catchUpTimer = null;
    void (async () => {
      try {
        const a = await analyzePending(worldId);
        // Only embed once a chunk's analysis is in (embedding needs the summary).
        const e = await embedPending(worldId);
        const moreWork =
          (a.remaining > 0 && a.progressed > 0) || (e.remaining > 0 && e.progressed > 0);
        if (moreWork) {
          scheduleCatchUp(worldId);
        } else {
          if (a.remaining > 0) console.warn(`[feed:${worldId}] catch-up stalled with ${a.remaining} pending`);
          else console.log(`[feed:${worldId}] analysis + embedding backlog cleared`);
          // Backlog drained (or stalled) — release the global build lock so
          // another world may refresh.
          if (buildingWorld === worldId) buildingWorld = null;
          // The pool is now fully analyzed — reactively extend the stories with
          // relevant YouTube videos and international (per-zone) coverage.
          void augmentReactively(worldId);
        }
      } catch (err) {
        console.warn(`[feed:${worldId}] catch-up failed:`, err);
        if (buildingWorld === worldId) buildingWorld = null;
      }
    })();
  }, config.feed.catchUpDelayMs);
}

/**
 * Bring a world's store up to date, then analyze the FIRST chunk so the feed is
 * usable quickly. Any remaining backlog is drained in the background (which keeps
 * the global build lock held until it clears).
 */
async function buildPool(worldId: string): Promise<void> {
  await refreshSources(worldId);
  const a = await analyzePending(worldId);
  const e = await embedPending(worldId);
  const moreWork = (a.remaining > 0 && a.progressed > 0) || (e.remaining > 0 && e.progressed > 0);
  if (moreWork) {
    console.log(
      `[feed:${worldId}] backlog — ${a.remaining} to analyze, ${e.remaining} to embed; continuing in background`,
    );
    scheduleCatchUp(worldId);
  } else if (buildingWorld === worldId) {
    // No background work scheduled — release the lock now.
    buildingWorld = null;
    // Pool fully analyzed in one pass — run reactive augmentation in the background.
    void augmentReactively(worldId);
  }
}

/**
 * Ensure a world's pool is fresh (TTL) or forced, honoring the GLOBAL single-build
 * lock. Returns which OTHER world (if any) is currently busy — in which case THIS
 * world was NOT rebuilt and serves whatever it already has.
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

  // A DIFFERENT world holds the global build lock — we can't rebuild right now;
  // serve whatever this world already has and report who's busy.
  if (buildingWorld && buildingWorld !== worldId) return { busyWith: buildingWorld };

  // A build for THIS world is already running (cold foreground or background
  // catch-up). Block ONLY on a cold start (nothing to show yet); otherwise
  // return immediately and let the in-flight build surface progress live.
  if (state.buildInFlight || buildingWorld === worldId) {
    if (!hasContent && state.buildInFlight) await state.buildInFlight;
    return { busyWith: null };
  }

  // Acquire the global lock and (re)build.
  buildingWorld = worldId;
  const build = buildPool(worldId).finally(() => {
    state.buildInFlight = null;
  });
  state.buildInFlight = build;
  // Cold start must wait so the response has something to return. A WARM refresh
  // rebuilds in the background so the current feed remains instantly available.
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
/** Stable cache-key suffix for a place lens (empty when no place is set). */
function placeKey(place?: Place | null): string {
  if (!place?.country) return "";
  return `|@${place.country}/${place.region ?? ""}/${(place.locality ?? "").toLowerCase()}`;
}

function assembleView(
  worldId: string,
  interest: string,
  parsed: ParsedQuery,
  queryVec?: number[] | null,
  place?: Place | null,
): FeedResult {
  const state = ws(worldId);
  const st = getStore(worldId);
  // Key per interest AND place so an unlensed and a place-lensed view (or two
  // different places) don't clobber each other in the cache.
  const key = interestKey(interest) + placeKey(place);
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

  // Geographic relevance BOOST: lift items whose text mentions the reader's place
  // so genuinely local news rises through the ranking — from ANY feed, not just a
  // local outlet. Interest-orthogonal; applied on the materialized relevance so
  // the pure ranker (rank.ts) stays unchanged. `kept` and `pool` are index-aligned.
  let boosted = 0;
  if (place?.country && config.place.boostWeight > 0) {
    const nodes = gazetteerFor(place.country);
    if (nodes.length > 0) {
      kept.forEach((s, i) => {
        const text = `${s.item.title} ${s.item.summary} ${s.summary} ${s.keywords.join(" ")}`;
        const score = scorePlace(text, place, nodes);
        if (score > 0) {
          pool[i].relevance = placeBoostedRelevance(pool[i].relevance ?? 0.5, score, config.place);
          boosted += 1;
        }
      });
    }
  }

  const ranked = rankItems(pool);
  const result: FeedResult = {
    items: ranked,
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
  const placeNote = place?.country ? `, place-boosted ${boosted}` : "";
  console.log(
    `[feed:${worldId}] view "${key}" (${mode}) -> ${ranked.length} items from ${pool.length} eligible${exNote}${placeNote}` +
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
  place?: Place | null,
): Promise<FeedResult> {
  const { busyWith } = await ensurePool(worldId, force);
  const parsed = await interpretQuery(interest);
  // Embed the POSITIVE intent (not the raw query): embedding "not israel" would
  // sit right next to Israel coverage, which is the opposite of what's wanted.
  const queryVec = await embedQuery(parsed.positive);
  const result = assembleView(worldId, interest, parsed, queryVec, place);
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
 *  WIDER of the event/issue windows so multi-day developing issues are covered. */
function storyEligible(worldId: string, now = Date.now()): StoredItem[] {
  const window = Math.min(
    config.feed.retentionMs,
    Math.max(config.stories.windowMs, config.stories.issueWindowMs),
  );
  return getStore(worldId)
    .all()
    .filter(
      (s) => !s.clickbait && s.analyzed && now - s.item.publishedAt <= window,
    );
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
): Promise<{ stories: Story[]; busyWith: string | null }> {
  const { busyWith } = await ensurePool(worldId, force);
  if (!config.stories.enabled) return { stories: [], busyWith };

  const state = ws(worldId);
  const cachedForLang = state.storiesCache.get(lang);
  if (cachedForLang && cachedForLang.builtAt === state.lastBuildAt) {
    return { stories: cachedForLang.stories, busyWith };
  }
  const inFlight = state.storiesInFlight.get(lang);
  if (inFlight) return { stories: await inFlight, busyWith };

  // Per-language persistent store so EN and ES syntheses don't cross-pollinate.
  const storeKey = lang === "en" ? worldId : `${worldId}__${lang}`;
  const builtAtSnapshot = state.lastBuildAt;
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
        const sa = distinctSources(a.members);
        const sb = distinctSources(b.members);
        if (sb !== sa) return sb - sa;
        return b.latestAt - a.latestAt;
      })
      .slice(0, config.stories.maxIssues);

    // Every multi-source cluster becomes an event story — INCLUDING those that
    // belong to a developing issue. We no longer hide issue members; instead the
    // client tags each story/article with a link up to its ongoing issue. The
    // issue itself is still emitted as its own umbrella story (with the timeline).
    const eventCandidates = clusters.filter(
      (c) => distinctSources(c.members) >= config.stories.minSources,
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
      state.storiesCache.set(lang, { builtAt: builtAtSnapshot, stories: [] });
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
    state.storiesCache.set(lang, { builtAt: builtAtSnapshot, stories: result });
    return result;
  })().finally(() => {
    state.storiesInFlight.delete(lang);
  });

  state.storiesInFlight.set(lang, p);
  return { stories: await p, busyWith };
}

/** A single synthesized story by id (builds the set if needed). Null if gone. */
export async function getStory(
  worldId: string = DEFAULT_WORLD_ID,
  id: string,
  lang: Lang = "en",
): Promise<Story | null> {
  const { stories } = await getStories(worldId, false, lang);
  return stories.find((s) => s.id === id) ?? null;
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
