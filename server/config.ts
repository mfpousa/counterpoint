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
    // When direct extraction fails (bot-wall / JS-only page), retry via reader
    // proxies (r.jina.ai renders JS; CORS proxies re-fetch the HTML). This helps
    // JS-heavy pages and SOME soft paywalls — it does NOT bypass hard paywalls.
    // Adds a third-party request per fallback; disable with READER_PROXY_OFF=1.
    proxyEnabled: !bool("READER_PROXY_OFF"),
    // If even proxies yield no body, synthesize a SHORT brief from the headline +
    // feed summary instead of failing — clearly labeled in the reader. The model
    // is instructed to use only the provided text (no fabrication). Disable with
    // READER_DEGRADED_OFF=1 to show the plain error + "Open original" instead.
    degradedFallback: !bool("READER_DEGRADED_OFF"),
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
} as const;

export type Config = typeof config;
