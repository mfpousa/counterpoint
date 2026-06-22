// Editorial analysis of feed items via the local LLM. Two passes, both batched
// and concurrency-limited, and BOTH interest-independent (so results can be
// cached/persisted and reused across every reader interest):
//
//   1. Clickbait triage  — cheap, title-only. Flags low-signal junk so we never
//      spend the expensive pass on it.
//   2. Deep analysis     — topic, political lean, general importance, a concrete
//      one-line summary, and topical keywords used later to match interests.

import type { FeedItem, Topic } from "../src/types";
import { chatJsonArray, clampNum, withConcurrency, type JsonSchema } from "./ai";
import { config } from "./config";

const TOPIC_VALUES = [
  "world",
  "politics",
  "economics",
  "science",
  "technology",
  "history",
  "health",
  "culture",
] as const;

/** Wrap a per-item schema in the { "items": [...] } envelope (strict needs an object root). */
function arraySchema(name: string, item: Record<string, unknown>): JsonSchema {
  return {
    name,
    schema: {
      type: "object",
      properties: { items: { type: "array", items: item } },
      required: ["items"],
      additionalProperties: false,
    },
  };
}

const TRIAGE_SCHEMA = arraySchema("triage", {
  type: "object",
  properties: {
    id: { type: "string" },
    junk: { type: "boolean" },
    importance: { type: "number" },
  },
  required: ["id", "junk", "importance"],
  additionalProperties: false,
});

const GEOSCOPE_SCHEMA = arraySchema("geoscope", {
  type: "object",
  properties: { id: { type: "string" }, global: { type: "boolean" } },
  required: ["id", "global"],
  additionalProperties: false,
});

const PRESCREEN_SCHEMA = arraySchema("prescreen", {
  type: "object",
  properties: {
    id: { type: "string" },
    junk: { type: "boolean" },
    global: { type: "boolean" },
    importance: { type: "number" },
  },
  required: ["id", "junk", "global", "importance"],
  additionalProperties: false,
});

const GEO_PRESCREEN_SCHEMA = arraySchema("geoprescreen", {
  type: "object",
  properties: {
    id: { type: "string" },
    junk: { type: "boolean" },
    importance: { type: "number" },
  },
  required: ["id", "junk", "importance"],
  additionalProperties: false,
});

// Item-level lean refinement (judge THIS item's framing + explain it) is opt-out.
// When enabled we add a `leanRationale` field to the analysis schema/prompt.
const LEAN_REFINE = config.ai.leanRefine;

const ANALYZE_SCHEMA = arraySchema("analysis", {
  type: "object",
  properties: {
    id: { type: "string" },
    topic: { type: "string", enum: [...TOPIC_VALUES] },
    lean: { type: ["number", "null"] },
    ...(LEAN_REFINE ? { leanRationale: { type: "string" } } : {}),
    importance: { type: "number" },
    summary: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: [
    "id",
    "topic",
    "lean",
    ...(LEAN_REFINE ? ["leanRationale"] : []),
    "importance",
    "summary",
    "keywords",
  ],
  additionalProperties: false,
});

/** Interest-INDEPENDENT analysis we compute once per item and persist. */
export interface ItemAnalysis {
  topic: Topic;
  /** Political lean -1..1, or null for non-political content. */
  lean: number | null;
  /** True when the MODEL assigned a usable numeric lean for THIS item (vs the
   *  analysis falling back to the item's source-level prior). Drives provenance. */
  leanRefined: boolean;
  /** Model's one-line justification for the lean (when refined). May be empty. */
  leanRationale: string;
  /** 0..1 general newsworthiness/substance (NOT personalized). */
  importance: number;
  /** One concrete sentence naming the subject and why it matters. */
  summary: string;
  /** Lowercase topical keywords/entities, used to match reader interests. */
  keywords: string[];
}

const VALID_TOPICS: ReadonlySet<string> = new Set<Topic>([
  "world",
  "politics",
  "economics",
  "science",
  "technology",
  "history",
  "health",
  "culture",
]);

const TRIAGE_PROMPT =
  "You are a ruthless news-quality filter. For EACH headline output two judgments:\n" +
  '- "junk": true if CLICKBAIT or low-signal junk — vague curiosity-gap teasers ' +
  '("you won\'t believe", "this one trick"), ragebait, listicles, horoscopes, ' +
  "sponsored/ads, celebrity gossip, and individual accidents/crime-blotter or " +
  "deaths with no wider significance. Substantive reporting and analysis is NOT junk.\n" +
  '- "importance": 0.0..1.0 coarse newsworthiness for an informed, curious reader ' +
  "— reward consequential, forward-looking, widely-relevant stories; penalize thin " +
  "filler. A rough estimate from the headline alone is fine.\n" +
  'Output ONLY a JSON object {"items": [ {"id": echo the id, "junk": true|false, ' +
  '"importance": number}, ... ]}, same order as input. No prose.';

const ANALYZE_PROMPT =
  "You are a neutral editor building a high-signal, politically balanced feed. " +
  "For EACH article output an object with:\n" +
  '- "id": echo the article id exactly.\n' +
  '- "topic": one of world|politics|economics|science|technology|history|health|culture.\n' +
  '- "lean": political lean of THIS item from -1.0 (strongly left) to +1.0 ' +
  "(strongly right), 0 centrist; null if non-political. Judge the framing/word " +
  "choice of THIS item, not the outlet's reputation.\n" +
  (LEAN_REFINE
    ? '- "leanRationale": ONE short clause (<= 16 words) explaining the lean ' +
      "judgment for THIS item, citing its framing/word choice/sourcing " +
      "(e.g. 'frames tax cuts as growth-boosting, downplays deficit'). Empty " +
      "string if non-political.\n"
    : "") +
  '- "importance": 0.0..1.0 general newsworthiness/substance for an informed, ' +
  "curious reader who wants to understand the world and where it is heading. " +
  "Reward consequential, forward-looking, explanatory journalism; penalize thin filler.\n" +
  '- "summary": ONE concrete sentence (<= 22 words) naming the core subject and ' +
  "why it matters. Specific (e.g. 'EU AI Act explained and its impact on startups'), " +
  "not generic ('an article about technology').\n" +
  '- "keywords": 3-8 lowercase topical keywords/entities capturing the subject ' +
  '(e.g. ["artificial intelligence","llm","regulation"]). Be substantive — these ' +
  "are used to match reader interests.\n" +
  'Some items include a "transcript" of spoken content — weigh it heavily.\n' +
  'Respond with ONLY a JSON object {"items": [ ...one object per article... ]}, ' +
  "same order as input. No prose.";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
}

function asRecord(row: unknown): Record<string, unknown> | null {
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

// --- Pass 1: clickbait triage ------------------------------------------------

async function triageBatch(batch: FeedItem[]): Promise<Map<string, GeoPrescreen>> {
  const out = new Map<string, GeoPrescreen>();
  const payload = batch.map((it) => ({ id: it.id, source: it.sourceTitle, title: it.title }));
  // Each verdict is tiny ({id, junk, importance}); cap output so a non-stopping
  // model can't run away and overflow the context window.
  const rows = await chatJsonArray(TRIAGE_PROMPT, payload, {
    maxTokens: batch.length * 32 + 64,
    schema: TRIAGE_SCHEMA,
  });
  const byId = new Map(batch.map((it) => [it.id, it]));
  rows.forEach((row, i) => {
    const r = asRecord(row);
    if (!r) return;
    const id =
      typeof r["id"] === "string" && byId.has(r["id"] as string)
        ? (r["id"] as string)
        : batch[i]?.id;
    if (!id) return;
    const v = r["junk"] ?? r["clickbait"];
    out.set(id, {
      junk: v === true || v === "true",
      importance: clampNum(r["importance"], 0, 1, 0.5),
    });
  });
  return out;
}

/** Reports cumulative items processed out of the total for a phase. */
export type ProgressFn = (done: number, total: number) => void;

/**
 * Cheap title-only triage for a TOPICAL world: per headline, a junk flag AND a
 * coarse 0..1 newsworthiness score. The importance lets the front page rank its
 * provisional (not-yet-deep-analyzed) items by "how big is this" instead of pure
 * recency, mirroring what geo/regional pools already get from their prescreen.
 */
export async function detectClickbait(
  items: FeedItem[],
  onProgress?: ProgressFn,
): Promise<Map<string, GeoPrescreen>> {
  const out = new Map<string, GeoPrescreen>();
  if (items.length === 0) return out;
  const batches = chunk(items, config.ai.triageBatchSize);
  let done = 0;
  const maps = await withConcurrency(
    batches.map((b) => async () => {
      const m = await triageBatch(b);
      done += b.length;
      onProgress?.(done, items.length);
      return m;
    }),
    config.ai.concurrency,
  );
  for (const m of maps) for (const [id, v] of m) out.set(id, v);
  return out;
}

// --- Geo-scope: filter GLOBAL stories out of a LOCAL feed -------------------

/** One item to geo-classify (id + the text the model judges scope from). */
export interface GeoScopeInput {
  id: string;
  title: string;
  summary: string;
}

function geoScopePrompt(placeLabel: string): string {
  return (
    `You curate a LOCAL news feed for ${placeLabel}. Local outlets also republish ` +
    `national and international stories that are ALREADY covered by global media. ` +
    `For EACH item decide if it is GLOBAL (true) — primarily about international ` +
    `affairs, other countries, or worldwide topics (foreign wars, global tech, ` +
    `another country's politics, world sport) — or LOCAL (false): genuinely about ` +
    `${placeLabel} or its regions/cities (local government, regional economy, local ` +
    `culture/events/people). When unsure, prefer false (keep it). Output ONLY a JSON ` +
    `object {"items":[{"id": echo the id, "global": true|false}, ...]}, same order. No prose.`
  );
}

async function geoScopeBatch(batch: GeoScopeInput[], placeLabel: string): Promise<Set<string>> {
  const globals = new Set<string>();
  const payload = batch.map((it) => ({ id: it.id, title: it.title, summary: it.summary.slice(0, 300) }));
  const rows = await chatJsonArray(geoScopePrompt(placeLabel), payload, {
    maxTokens: batch.length * 24 + 64,
    schema: GEOSCOPE_SCHEMA,
  });
  const byId = new Map(batch.map((it) => [it.id, it]));
  rows.forEach((row, i) => {
    const r = asRecord(row);
    if (!r) return;
    const id =
      typeof r["id"] === "string" && byId.has(r["id"] as string) ? (r["id"] as string) : batch[i]?.id;
    if (!id) return;
    const v = r["global"];
    if (v === true || v === "true") globals.add(id);
  });
  return globals;
}

/**
 * Classify which items are GLOBAL (vs local to `placeLabel`). Returns the set of
 * ids judged global — the regional feed filters these out. Batched + concurrent,
 * same as triage. Empty set on no input.
 */
export async function classifyGlobalScope(
  items: GeoScopeInput[],
  placeLabel: string,
  onProgress?: ProgressFn,
): Promise<Set<string>> {
  const globals = new Set<string>();
  if (items.length === 0) return globals;
  const batches = chunk(items, config.ai.triageBatchSize);
  let done = 0;
  const sets = await withConcurrency(
    batches.map((b) => async () => {
      const s = await geoScopeBatch(b, placeLabel);
      done += b.length;
      onProgress?.(done, items.length);
      return s;
    }),
    config.ai.concurrency,
  );
  for (const s of sets) for (const id of s) globals.add(id);
  return globals;
}

// --- Combined prescreen (REGIONAL): junk + global + coarse importance --------
// One cheap, title-only pass that folds the clickbait and geo-scope judgments
// together AND estimates coarse newsworthiness — so we scan the flood of local
// headlines ONCE and then deep-analyze only the top-N by that score. This is the
// main throughput lever for a token-bound local model.

/** Coarse per-headline verdict from the combined regional prescreen. */
export interface Prescreen {
  junk: boolean;
  global: boolean;
  /** 0..1 rough newsworthiness from the headline alone. */
  importance: number;
}

function prescreenPrompt(placeLabel: string): string {
  return (
    `You are a fast headline triage for a LOCAL news feed for ${placeLabel}. For ` +
    `EACH headline output three judgments:\n` +
    `- "junk": true if CLICKBAIT or low-signal — curiosity-gap teasers, ragebait, ` +
    `listicles, horoscopes, ads/sponsored, celebrity gossip, lone accidents or ` +
    `crime-blotter with no wider significance. Substantive reporting is NOT junk.\n` +
    `- "global": true if primarily INTERNATIONAL — foreign affairs, another ` +
    `country, or worldwide topics already covered by global media (foreign wars, ` +
    `global tech, other countries' politics, world sport). false if genuinely ` +
    `about ${placeLabel} or its regions/cities. When unsure, prefer false (keep it).\n` +
    `- "importance": 0.0..1.0 coarse newsworthiness for an informed local reader — ` +
    `reward consequential local reporting, penalize thin filler. A rough estimate ` +
    `from the headline alone is fine.\n` +
    `Output ONLY {"items":[{"id": echo the id, "junk": bool, "global": bool, ` +
    `"importance": number}, ...]}, same order as input. No prose.`
  );
}

async function prescreenBatch(
  batch: GeoScopeInput[],
  placeLabel: string,
): Promise<Map<string, Prescreen>> {
  const out = new Map<string, Prescreen>();
  // Title-only — the whole point is to avoid shipping summaries for the flood.
  const payload = batch.map((it) => ({ id: it.id, title: it.title }));
  const rows = await chatJsonArray(prescreenPrompt(placeLabel), payload, {
    maxTokens: batch.length * 32 + 64,
    schema: PRESCREEN_SCHEMA,
  });
  const byId = new Map(batch.map((it) => [it.id, it]));
  rows.forEach((row, i) => {
    const r = asRecord(row);
    if (!r) return;
    const id =
      typeof r["id"] === "string" && byId.has(r["id"] as string) ? (r["id"] as string) : batch[i]?.id;
    if (!id) return;
    out.set(id, {
      junk: r["junk"] === true || r["junk"] === "true",
      global: r["global"] === true || r["global"] === "true",
      importance: clampNum(r["importance"], 0, 1, 0.5),
    });
  });
  return out;
}

/**
 * Combined regional prescreen: returns id -> {junk, global, importance} for each
 * headline. Batched + concurrent like triage. Items missing from the model reply
 * are simply absent from the map (callers treat absence conservatively).
 */
export async function prescreenRegional(
  items: GeoScopeInput[],
  placeLabel: string,
  onProgress?: ProgressFn,
): Promise<Map<string, Prescreen>> {
  const out = new Map<string, Prescreen>();
  if (items.length === 0) return out;
  const batches = chunk(items, config.ai.triageBatchSize);
  let done = 0;
  const maps = await withConcurrency(
    batches.map((b) => async () => {
      const m = await prescreenBatch(b, placeLabel);
      done += b.length;
      onProgress?.(done, items.length);
      return m;
    }),
    config.ai.concurrency,
  );
  for (const m of maps) for (const [id, p] of m) out.set(id, p);
  return out;
}

// --- Geo-pool prescreen: junk + coarse importance (NO local/global) ----------
// Geographic pools (world → continent → country → region → province → locality)
// show EVERYTHING their outlets report — we never drop "global" stories — so the
// prescreen here only filters junk and scores coarse importance, which gates the
// expensive deep pass to the top-N. Works at any level; the optional label is
// just context for the model ("for readers of Galicia").

/** Coarse per-headline verdict for a geographic pool. */
export interface GeoPrescreen {
  junk: boolean;
  /** 0..1 rough newsworthiness from the headline alone. */
  importance: number;
}

function geoPrescreenPrompt(label?: string): string {
  const who = label ? `for readers of ${label}` : "for a general news reader";
  return (
    `You are a fast headline triage ${who}. For EACH headline output:\n` +
    `- "junk": true if CLICKBAIT or low-signal — curiosity-gap teasers, ragebait, ` +
    `listicles, horoscopes, ads/sponsored, celebrity gossip, lone accidents or ` +
    `crime-blotter with no wider significance. Substantive reporting is NOT junk.\n` +
    `- "importance": 0.0..1.0 coarse newsworthiness — reward consequential, ` +
    `informative reporting; penalize thin filler. A rough estimate from the ` +
    `headline alone is fine.\n` +
    `Output ONLY {"items":[{"id": echo the id, "junk": bool, "importance": ` +
    `number}, ...]}, same order as input. No prose.`
  );
}

async function geoPrescreenBatch(
  batch: GeoScopeInput[],
  label?: string,
): Promise<Map<string, GeoPrescreen>> {
  const out = new Map<string, GeoPrescreen>();
  const payload = batch.map((it) => ({ id: it.id, title: it.title }));
  const rows = await chatJsonArray(geoPrescreenPrompt(label), payload, {
    maxTokens: batch.length * 24 + 64,
    schema: GEO_PRESCREEN_SCHEMA,
  });
  const byId = new Map(batch.map((it) => [it.id, it]));
  rows.forEach((row, i) => {
    const r = asRecord(row);
    if (!r) return;
    const id =
      typeof r["id"] === "string" && byId.has(r["id"] as string) ? (r["id"] as string) : batch[i]?.id;
    if (!id) return;
    out.set(id, {
      junk: r["junk"] === true || r["junk"] === "true",
      importance: clampNum(r["importance"], 0, 1, 0.5),
    });
  });
  return out;
}

/**
 * Geo-pool prescreen: id -> {junk, importance}. Title-only, batched + concurrent.
 * Items absent from the model reply are absent from the map (treated as kept,
 * neutral importance by callers).
 */
export async function prescreenGeo(
  items: GeoScopeInput[],
  label?: string,
  onProgress?: ProgressFn,
): Promise<Map<string, GeoPrescreen>> {
  const out = new Map<string, GeoPrescreen>();
  if (items.length === 0) return out;
  const batches = chunk(items, config.ai.triageBatchSize);
  let done = 0;
  const maps = await withConcurrency(
    batches.map((b) => async () => {
      const m = await geoPrescreenBatch(b, label);
      done += b.length;
      onProgress?.(done, items.length);
      return m;
    }),
    config.ai.concurrency,
  );
  for (const m of maps) for (const [id, p] of m) out.set(id, p);
  return out;
}

// --- Pass 2: deep analysis ---------------------------------------------------

/** Strip model scaffolding (``` fences, stray "json") and collapse whitespace. */
function cleanField(s: string): string {
  return s
    .replace(/```+\s*json\b/gi, "")
    .replace(/```+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a model free-text field is DEGENERATE output rather than real prose:
 * long runs of repeated punctuation/ellipsis ("………", "??????"), or text that is
 * mostly non-letters. Weak local models sometimes emit these loops, which would
 * otherwise be stored and shown in the summary / lean rationale.
 */
export function looksDegenerate(s: string): boolean {
  // The same non-word char repeated 4+ times (e.g. "………", "????", "!!!!").
  if (/([^\p{L}\p{N}\s])\1{3,}/u.test(s)) return true;
  // Any run of 6+ consecutive non-word chars (mixed punctuation soup).
  if (/[^\p{L}\p{N}\s]{6,}/u.test(s)) return true;
  const nonSpace = s.replace(/\s/g, "");
  if (!nonSpace) return true;
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  // Real prose is letter-dominated; junk skews to symbols/digits.
  return letters / nonSpace.length < 0.4;
}

/** Sanitize a model free-text field: blank it when degenerate, else clean it. */
export function sanitizeModelText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s || looksDegenerate(s)) return "";
  return cleanField(s);
}

export function coerceAnalysis(raw: Record<string, unknown>, fallback: FeedItem): ItemAnalysis {
  const topicRaw = String(raw["topic"] ?? "").toLowerCase();
  const topic = (VALID_TOPICS.has(topicRaw) ? topicRaw : fallback.topic) as Topic;

  let lean: number | null;
  let leanRefined = false;
  const lv = raw["lean"];
  if (lv === null || lv === undefined || lv === "null") {
    lean = fallback.lean;
  } else {
    lean = clampNum(lv, -1, 1, fallback.lean ?? 0);
    // The model gave a usable numeric lean for this item (not a null fallback).
    leanRefined = !Number.isNaN(Number(lv));
  }
  const leanRationale = sanitizeModelText(raw["leanRationale"]);

  const importance = clampNum(raw["importance"], 0, 1, 0.5);
  const summary = sanitizeModelText(raw["summary"]);
  const keywords = Array.isArray(raw["keywords"])
    ? (raw["keywords"] as unknown[])
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.toLowerCase().trim())
        .filter((k) => k && !looksDegenerate(k))
        .slice(0, 10)
    : [];

  return { topic, lean, leanRefined, leanRationale, importance, summary, keywords };
}

async function analyzeBatch(
  batch: FeedItem[],
  transcripts: Map<string, string>,
): Promise<Map<string, ItemAnalysis>> {
  const out = new Map<string, ItemAnalysis>();
  const payload = batch.map((it) => {
    const transcript = transcripts.get(it.id);
    return {
      id: it.id,
      source: it.sourceTitle,
      title: it.title,
      summary: it.summary.slice(0, 500),
      ...(transcript ? { transcript } : {}),
    };
  });
  // Constrained decoding guarantees valid, bounded JSON; max_tokens is a generous
  // safety net (~200 tokens/item: topic/lean/importance/summary/keywords).
  const rows = await chatJsonArray(ANALYZE_PROMPT, payload, {
    maxTokens: batch.length * 200 + 256,
    schema: ANALYZE_SCHEMA,
  });
  const byId = new Map(batch.map((it) => [it.id, it]));
  rows.forEach((row, i) => {
    const r = asRecord(row);
    if (!r) return;
    const item = (typeof r["id"] === "string" && byId.get(r["id"] as string)) || batch[i];
    if (!item) return;
    out.set(item.id, coerceAnalysis(r, item));
  });
  return out;
}

/**
 * Deeply analyze items (interest-independent). Returns id -> ItemAnalysis,
 * partial on any per-batch failure. Runs over ALL provided items in batches.
 */
export async function analyzeItems(
  items: FeedItem[],
  transcripts: Map<string, string> = new Map(),
  onProgress?: ProgressFn,
): Promise<Map<string, ItemAnalysis>> {
  const out = new Map<string, ItemAnalysis>();
  if (items.length === 0) return out;
  const batches = chunk(items, config.ai.batchSize);
  let done = 0;
  const maps = await withConcurrency(
    batches.map((b) => async () => {
      const m = await analyzeBatch(b, transcripts);
      done += b.length;
      onProgress?.(done, items.length);
      return m;
    }),
    config.ai.concurrency,
  );
  for (const m of maps) for (const [id, a] of m) out.set(id, a);
  return out;
}
