// Backend configuration, resolved once from the environment.
//
// All values have safe defaults so the server boots without a .env file.
// The AI target is a generic OpenAI-compatible endpoint (LM Studio, Ollama,
// llama.cpp, vLLM, ...) so nothing here is vendor-specific.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader (no dependency). Does not override real env vars. */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env file — fall back to defaults / real env.
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Like num() but allows an explicit 0 (used for "unlimited" sentinels). */
function numOrZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function bool(name: string): boolean {
  const v = (process.env[name] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// Corporate TLS-interception (Zscaler/Netskope/etc.) presents a self-signed
// root CA that Node doesn't trust by default, causing SELF_SIGNED_CERT_IN_CHAIN
// on most HTTPS feed fetches. The SECURE fix is NODE_EXTRA_CA_CERTS=<root.pem>
// (read by Node at startup). As a local-dev convenience ONLY, ALLOW_INSECURE_TLS
// disables certificate verification process-wide. Never use it in production.
if (bool("ALLOW_INSECURE_TLS")) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn(
    "[config] ALLOW_INSECURE_TLS is set — TLS certificate verification is DISABLED. " +
      "Use NODE_EXTRA_CA_CERTS with your corporate root CA for a secure setup.",
  );
}

export const config = {
  ai: {
    baseUrl: str("AI_BASE_URL", "http://localhost:1234/v1"),
    model: str("AI_MODEL", "local-model"),
    apiKey: str("AI_API_KEY", "not-needed"),
    batchSize: num("AI_BATCH_SIZE", 8),
    // Larger batches for the cheap title-only clickbait triage pass.
    triageBatchSize: num("AI_TRIAGE_BATCH_SIZE", 40),
    concurrency: num("AI_CONCURRENCY", 2),
    // Items deeply analyzed per CHUNK. The first chunk makes the feed usable
    // fast; the rest of the backlog is drained in the background. 0 = no chunk
    // cap (one big, blocking pass). Results are persisted either way.
    maxItems: numOrZero("AI_MAX_ITEMS", 200),
    // INACTIVITY timeout for an LLM call: resets on every streamed chunk, so a
    // model that's actively generating is never cut off. Must comfortably exceed
    // worst-case prompt-ingestion / time-to-first-token on your hardware.
    timeoutMs: num("AI_TIMEOUT_MS", 120_000),
    // Use constrained decoding (response_format json_schema) so the model emits
    // valid, complete JSON and STOPS — essential for local models that otherwise
    // ramble past valid JSON. Disable with AI_STRUCTURED_OUTPUT_OFF=1 if your
    // runtime rejects response_format.
    structuredOutput: !bool("AI_STRUCTURED_OUTPUT_OFF"),
    // Item-level political-lean refinement. When ON (default), the deep-analysis
    // model judges THIS item's framing to assign its lean (overriding the curated
    // source-level prior) and supplies a short rationale shown in the UI; such
    // items are marked `leanSource: "llm"`. When OFF (AI_LEAN_REFINE_OFF=1), items
    // keep their source's curated lean + rationale and are marked `"source"`.
    leanRefine: !bool("AI_LEAN_REFINE_OFF"),
    // Semantic interest matching via embeddings (POST /v1/embeddings). Each item
    // is embedded once; a search is matched by cosine similarity (meaning, not
    // keywords). Requires an embedding model loaded in your runtime. Falls back
    // to keyword matching automatically if unavailable. Disable with
    // AI_EMBEDDINGS_OFF=1. Set AI_EMBED_MODEL to your loaded embedding model id.
    embeddingsEnabled: !bool("AI_EMBEDDINGS_OFF"),
    embedModel: str("AI_EMBED_MODEL", "text-embedding-nomic-embed-text-v1.5"),
    embedBatchSize: num("AI_EMBED_BATCH_SIZE", 32),
  },
  server: {
    port: num("PORT", 8787),
    feedTtlMs: num("FEED_TTL_MS", 600_000),
  },
  feed: {
    // Default steering interests used for the startup warm-up and when a client
    // sends none. Clients normally override this per request (Settings prompt).
    interest: str("FEED_INTEREST", ""),
    // Hard cap on the interest text we accept/forward to the model.
    maxInterestLen: num("FEED_INTEREST_MAX_LEN", 400),
    // Run a cheap title-only clickbait/quality triage and DROP flagged items
    // before the (expensive) deep analysis. Disable with CLICKBAIT_FILTER_OFF=1.
    clickbaitFilter: !bool("CLICKBAIT_FILTER_OFF"),
    // On-disk store of analyzed items so restarts don't re-pay the model and
    // interest changes rebuild instantly. Relative paths resolve from cwd.
    storePath: str("FEED_STORE_PATH", ".cache/feed-store.json"),
    // Drop analyzed items older than this (also the feed's relevance window).
    retentionMs: num("FEED_RETENTION_MS", 14 * 24 * 60 * 60 * 1000),
    // Hard cap on stored items (oldest pruned first) to bound memory/disk.
    maxStored: num("FEED_MAX_STORED", 8000),
    // Only items published within this window are eligible for analysis. Keeps
    // the first run from chewing through a two-week backlog; older items are
    // simply skipped (the feed is recency-oriented anyway).
    analyzeMaxAgeMs: num("FEED_ANALYZE_MAX_AGE_MS", 3 * 24 * 60 * 60 * 1000),
    // Gap between background analysis chunks while draining the backlog.
    catchUpDelayMs: num("FEED_CATCHUP_DELAY_MS", 1500),
  },
  place: {
    // Geographic relevance BOOST. When a reader sets a place (country → region →
    // locality), stories whose text mentions it get their relevance lifted toward
    // 1 so genuinely local news surfaces from ANY feed — orthogonal to the world.
    // 0 disables. See src/lib/places.ts (scorePlace / placeBoostedRelevance).
    boostWeight: num("PLACE_BOOST_WEIGHT", 0.5),
    // Place score at which the boost saturates. A locality alias hit scores 3
    // (PLACE_LEVEL_WEIGHT.locality), so the default = one strong local mention.
    saturateAt: num("PLACE_BOOST_SATURATE_AT", 3),
    // Reactive LOCAL SOURCES. When a reader sets a place, fetch that country's
    // locally-discovered outlets (src/data/placeSources/<cc>.json, generated by
    // scripts/buildPlaceSources.ts) on demand and queue their recent articles for
    // analysis — so genuinely local news enters the pool, not just a boost on
    // existing feeds. Disable with PLACE_SOURCES_OFF=1.
    sourcesEnabled: !bool("PLACE_SOURCES_OFF"),
    // A requested place stays "active" (eligible for local fetch) this long after
    // its last request — bounds fetching to places readers actually use.
    activeTtlMs: num("PLACE_ACTIVE_TTL_MS", 24 * 60 * 60 * 1000),
    // Re-fetch the same country's local sources at most this often (ms).
    fetchTtlMs: num("PLACE_FETCH_TTL_MS", 3 * 60 * 60 * 1000),
    // Max recent local articles queued per country per augmentation pass.
    perBuildItemCap: num("PLACE_PER_BUILD_ITEMS", 40),
    // Local outlets flood the pool (thousands/day) but only a few hundred ever
    // reach the reader. The cheap title-only PRESCREEN scores coarse importance;
    // we then deep-analyze only the top-N LOCAL items by that score, skipping the
    // long tail (kept in store, never analyzed → excluded from the feed). This is
    // the main throughput lever for a token-bound local model. 0 = no cap
    // (analyze every local survivor, as before).
    deepAnalyzeKeep: numOrZero("PLACE_DEEP_ANALYZE_KEEP", 600),
  },
  geo: {
    // GEOGRAPHIC POOLS (geo-<nodeId>): world → continent → country → region →
    // province → locality. Each pool is fed by its node's own outlets (see
    // server/sourceRegistry.ts) and shows EVERYTHING they report.
    //
    // Throughput lever: a cheap title-only prescreen scores coarse importance,
    // we near-clone DEDUP the survivors (so identical wire copy is analyzed once),
    // and then deep-analyze only the top-N CLUSTERS by that score — ~200 is
    // "plenty" for any level. 0 = no cap.
    deepAnalyzeKeep: numOrZero("GEO_DEEP_ANALYZE_KEEP", 200),
    // Min title Jaccard for two items to count as the SAME story (near-clone).
    dedupeJaccard: num("GEO_DEDUPE_JACCARD", 0.7),
    // Max publish-time gap (ms) for two items to be considered clones.
    dedupeWindowMs: num("GEO_DEDUPE_WINDOW_MS", 2 * 24 * 60 * 60 * 1000),
  },
  reader: {
    // In-app "AI rewrite" reader. The backend fetches the article, extracts the
    // text, and the LLM rewrites it into a clean, readable version.
    // Min usable extracted chars (below this we assume paywall/JS-only page).
    minChars: num("READER_MIN_CHARS", 600),
    // Max article chars sent to the model (keeps the rewrite prompt in budget).
    maxChars: num("READER_MAX_CHARS", 12_000),
    // Cap on the rewrite reply length (constrained decoding stops earlier).
    maxTokens: num("READER_MAX_TOKENS", 2200),
    // How long a rewritten article is cached in memory (ms). Default 6h.
    cacheTtlMs: num("READER_CACHE_TTL_MS", 6 * 60 * 60 * 1000),
    // On-disk cache of rewritten articles, SHARED across all users and surviving
    // restarts so the LLM never re-rewrites an article another reader (or a prior
    // process) already did. Keyed by item id + language. Relative paths from cwd.
    cachePath: str("READER_CACHE_PATH", ".cache/rewrite-cache.json"),
    // How long a persisted rewrite stays valid on disk. Article rewrites don't go
    // stale (the source is immutable), so this is generous to maximize reuse and
    // minimize model spend. Default 14 days.
    diskTtlMs: num("READER_DISK_TTL_MS", 14 * 24 * 60 * 60 * 1000),
    // When direct extraction fails (bot-wall / JS-only page), retry via reader
    // proxies (r.jina.ai renders JS; CORS proxies re-fetch the HTML). In practice
    // the free proxies are captcha-gated/flaky and don't beat hard paywalls, while
    // adding up to ~60s of futile fetches per article — so they're OPT-IN now
    // (fail fast by default). Re-enable with READER_PROXY_ON=1.
    proxyEnabled: bool("READER_PROXY_ON"),
    // r.jina.ai API key. The free tier now rate-limits/captcha-gates anonymous
    // traffic (HTTP 403); an authenticated request (Authorization: Bearer <key>)
    // restores reliable access and higher limits. Get one at https://jina.ai/reader.
    jinaApiKey: str("READER_JINA_API_KEY", ""),
    // If even proxies yield no body, synthesize a SHORT brief from the headline +
    // feed summary instead of failing — clearly labeled in the reader. The model
    // is instructed to use only the provided text (no fabrication). Disable with
    // READER_DEGRADED_OFF=1 to show the plain error + "Open original" instead.
    degradedFallback: !bool("READER_DEGRADED_OFF"),
    // Known HARD-paywall domains: skip live extraction entirely (no wasted fetch)
    // and go straight to the feed body / degraded brief. Comma-separated override
    // via READER_PAYWALL_DOMAINS (matches the host and any subdomain).
    paywallDomains: str(
      "READER_PAYWALL_DOMAINS",
      "nytimes.com,wsj.com,ft.com,economist.com,bloomberg.com,washingtonpost.com,newyorker.com,theatlantic.com,wired.com,businessinsider.com,thetimes.co.uk,telegraph.co.uk,theinformation.com,foreignpolicy.com,seekingalpha.com",
    )
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  },
  stories: {
    // Synthesized cross-source "Stories": cluster same-event articles across
    // outlets (dedupe), then write ONE neutral synthesis citing each source plus
    // a per-outlet framing breakdown and contradictions. Disable with STORIES_OFF=1.
    enabled: !bool("STORIES_OFF"),
    // Cosine-similarity threshold for two articles to be considered the same
    // event (when embeddings are available). Higher = tighter clusters.
    simThreshold: num("STORIES_SIM_THRESHOLD", 0.82),
    // Title/keyword Jaccard threshold used as a fallback when embeddings are off.
    textSimThreshold: num("STORIES_TEXT_SIM_THRESHOLD", 0.3),
    // Two articles only cluster if published within this window of each other.
    windowMs: num("STORIES_WINDOW_MS", 3 * 24 * 60 * 60 * 1000),
    // A cluster must reach this many distinct sources to become a synthesized
    // Story (the cross-outlet comparison needs more than one outlet).
    minSources: num("STORIES_MIN_SOURCES", 2),
    // Most synthesized stories to produce per world (bounds LLM cost).
    maxStories: num("STORIES_MAX", 12),
    // Cap on source articles fed into a single synthesis prompt (keeps it in budget).
    maxClusterSources: num("STORIES_MAX_SOURCES", 6),
    // How many related stories to cross-link from each story.
    relatedCount: num("STORIES_RELATED", 4),
    // Cap on the synthesis reply length (constrained decoding stops earlier).
    maxTokens: num("STORIES_MAX_TOKENS", 1400),

    // --- Developing ISSUES (second-level grouping) ---
    // Event clusters are grouped into broader ongoing storylines (e.g. a conflict
    // spanning strikes, a blockade, talks). These use a LOOSER similarity and a
    // WIDER time window than same-event clustering.
    issueSimThreshold: num("STORIES_ISSUE_SIM_THRESHOLD", 0.6),
    issueTextSimThreshold: num("STORIES_ISSUE_TEXT_SIM_THRESHOLD", 0.18),
    issueWindowMs: num("STORIES_ISSUE_WINDOW_MS", 10 * 24 * 60 * 60 * 1000),
    // An issue is treated as DEVELOPING only if it spans at least this long,
    // contains at least `issueMinEvents` distinct sub-events from at least
    // `issueMinSources` outlets, and is still active within `issueActiveMs`.
    issueMinSpanMs: num("STORIES_ISSUE_MIN_SPAN_MS", 18 * 60 * 60 * 1000),
    issueMinEvents: num("STORIES_ISSUE_MIN_EVENTS", 2),
    issueMinSources: num("STORIES_ISSUE_MIN_SOURCES", 3),
    issueActiveMs: num("STORIES_ISSUE_ACTIVE_MS", 36 * 60 * 60 * 1000),
    // Persisted, INCREMENTAL synthesis: synthesized stories are cached on disk
    // (like analyzed articles) and reused across refreshes/restarts. On rebuild
    // we only (re)synthesize stories whose article membership CHANGED; unchanged
    // ones are reused as-is, so a refresh never re-computes everything.
    storePath: str("STORIES_STORE_PATH", ".cache/story-store.json"),
    // A new cluster/issue is treated as the SAME story as a cached one when their
    // article sets overlap by at least this Jaccard ratio (so a development that
    // gains an article keeps its identity instead of becoming a brand-new story).
    matchThreshold: num("STORIES_MATCH_THRESHOLD", 0.5),
    // Most developing-issue stories to synthesize per world.
    maxIssues: num("STORIES_MAX_ISSUES", 6),
    // Cap on sub-events (timeline milestones) fed into an issue synthesis prompt.
    maxIssueEvents: num("STORIES_MAX_ISSUE_EVENTS", 10),
    // Cap on the developing-issue synthesis reply length.
    issueMaxTokens: num("STORIES_ISSUE_MAX_TOKENS", 2200),
  },
  transcripts: {
    // Fetch YouTube caption transcripts (via yt-dlp) so the model understands a
    // video's actual content, not just its description. On by default; degrades
    // gracefully if yt-dlp isn't installed. Disable with TRANSCRIPTS_OFF=1.
    enabled: !bool("TRANSCRIPTS_OFF"),
    // Path/command for the yt-dlp binary.
    ytDlpPath: str("YT_DLP_PATH", "yt-dlp"),
    // yt-dlp has its own bundled CA store (it won't see NODE_EXTRA_CA_CERTS),
    // so mirror our TLS strategy: pass --no-check-certificates when insecure,
    // or hand it the corporate CA via SSL_CERT_FILE when one is configured.
    insecureTls: bool("ALLOW_INSECURE_TLS"),
    caFile: str("NODE_EXTRA_CA_CERTS", ""),
    // Max transcript characters sent to the model (keeps prompts in budget).
    maxChars: num("TRANSCRIPT_MAX_CHARS", 6000),
    // Parallel yt-dlp processes (each spawns a child + network; keep low).
    concurrency: num("TRANSCRIPT_CONCURRENCY", 2),
    timeoutMs: num("TRANSCRIPT_TIMEOUT_MS", 30_000),
  },
  youtube: {
    // Story-driven YouTube SEARCH. Instead of relying on raw channel feeds (whose
    // unfiltered output is mostly noise), we search YouTube for the headlines the
    // OUTLETS are already covering and, when a relevant longer-form news/podcast
    // video turns up, add it to the pool as a tagged video "article" (channel name
    // as the source). Keyless via yt-dlp's `ytsearch`. Discovered videos are then
    // analyzed like ANY other item (transcript + model summary/topic/keywords/lean)
    // — search only adds candidates; it doesn't shortcut the analysis. The search
    // step itself is bounded + cached so discovery stays cheap. Disable with
    // YT_SEARCH_OFF=1. Shared across users + cached server-side.
    searchEnabled: !bool("YT_SEARCH_OFF"),
    // Max distinct headline queries searched per build (bounds yt-dlp load/time).
    maxQueries: num("YT_SEARCH_MAX_QUERIES", 6),
    // Results requested per query (we keep at most ONE, the most relevant).
    resultsPerQuery: num("YT_SEARCH_RESULTS", 10),
    // Only seed queries from source items at least this important (0..1) and no
    // older than the source-age window (keeps searches on live, substantive news).
    minSourceImportance: num("YT_SEARCH_MIN_IMPORTANCE", 0.55),
    sourceMaxAgeMs: num("YT_SEARCH_SOURCE_MAX_AGE_MS", 2 * 24 * 60 * 60 * 1000),
    // Relevance gate: min cosine similarity between a candidate's title embedding
    // and the source headline's embedding to accept it (filters off-topic noise).
    minRelevance: num("YT_SEARCH_MIN_RELEVANCE", 0.5),
    // Duration gate (seconds): exclude shorts/clips and multi-hour livestreams so
    // we keep substantive news segments / podcast episodes (applied when known).
    minDurationSec: num("YT_SEARCH_MIN_DURATION_SEC", 180),
    maxDurationSec: num("YT_SEARCH_MAX_DURATION_SEC", 4 * 60 * 60),
    // Re-search the same query at most this often (ms) — server-side, shared.
    queryTtlMs: num("YT_SEARCH_QUERY_TTL_MS", 12 * 60 * 60 * 1000),
    // yt-dlp search timeout (ms).
    searchTimeoutMs: num("YT_SEARCH_TIMEOUT_MS", 25_000),
  },
  zones: {
    // Reactive INTERNATIONAL coverage. When a live story is detected to involve a
    // foreign zone (e.g. Russia/Ukraine), load THAT zone's outlets on demand,
    // relate their articles to the story, analyze them like any other item, and
    // let the synthesis surface how each side frames it. Avoids fetching the whole
    // world on every build. Disable with ZONES_OFF=1.
    enabled: !bool("ZONES_OFF"),
    // Min distinct alias hits for a zone to count as involved (precision guard so
    // a single passing mention doesn't drag in a whole region's outlets).
    minAliasHits: num("ZONES_MIN_ALIAS_HITS", 2),
    // Max zones loaded per augmentation pass (bounds reactive fetching cost).
    maxZonesPerBuild: num("ZONES_MAX_PER_BUILD", 3),
    // Consider only the top-N most important recent items as story seeds.
    seedItems: num("ZONES_SEED_ITEMS", 40),
    // Min importance (0..1) for an analyzed item to seed zone detection.
    minSeedImportance: num("ZONES_MIN_IMPORTANCE", 0.55),
    // Only seed zone detection from items no older than this (live stories).
    sourceMaxAgeMs: num("ZONES_SOURCE_MAX_AGE_MS", 3 * 24 * 60 * 60 * 1000),
    // Max reactive articles kept per zone per pass (then fully analyzed).
    perZoneItemCap: num("ZONES_PER_ZONE_ITEMS", 6),
    // Relatedness gate: min shared salient tokens between a fetched zone article
    // and the story's seed tokens to keep it (we don't want ALL of a region's news).
    // English feeds match here; ORIGINAL-LANGUAGE feeds (different script) won't, so
    // they're matched by embedding similarity instead (minRelevance below).
    minSharedTokens: num("ZONES_MIN_SHARED_TOKENS", 2),
    // Embedding relatedness gate (cross-lingual): min cosine between a fetched zone
    // article's title and a seed story's embedding to keep it. This is what lets
    // original-language coverage attach to a story when token overlap can't.
    minRelevance: num("ZONES_MIN_RELEVANCE", 0.5),
    // Re-fetch the same zone at most this often (ms) — bounds repeated loads.
    zoneTtlMs: num("ZONES_TTL_MS", 6 * 60 * 60 * 1000),
  },
} as const;

export type Config = typeof config;
