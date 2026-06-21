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
  properties: { id: { type: "string" }, junk: { type: "boolean" } },
  required: ["id", "junk"],
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
  "You are a ruthless news-quality filter. For EACH headline decide if it is " +
  "CLICKBAIT or low-signal junk. Junk includes: vague curiosity-gap teasers " +
  '("you won\'t believe", "this one trick"), ragebait, listicles, horoscopes, ' +
  "sponsored/ads, celebrity gossip, and individual accidents/crime-blotter or " +
  "deaths with no wider significance. Substantive reporting and analysis is NOT " +
  'junk. Output ONLY a JSON object {"items": [ {"id": echo the id, "junk": ' +
  "true|false}, ... ]}, same order as input. No prose.";

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

async function triageBatch(batch: FeedItem[]): Promise<Set<string>> {
  const junk = new Set<string>();
  const payload = batch.map((it) => ({ id: it.id, source: it.sourceTitle, title: it.title }));
  // Each verdict is tiny ({id, junk}); cap output so a non-stopping model can't
  // run away and overflow the context window.
  const rows = await chatJsonArray(TRIAGE_PROMPT, payload, {
    maxTokens: batch.length * 24 + 64,
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
    if (v === true || v === "true") junk.add(id);
  });
  return junk;
}

/** Reports cumulative items processed out of the total for a phase. */
export type ProgressFn = (done: number, total: number) => void;

/** Return the set of item ids judged clickbait/junk (title-only, cheap). */
export async function detectClickbait(
  items: FeedItem[],
  onProgress?: ProgressFn,
): Promise<Set<string>> {
  const junk = new Set<string>();
  if (items.length === 0) return junk;
  const batches = chunk(items, config.ai.triageBatchSize);
  let done = 0;
  const sets = await withConcurrency(
    batches.map((b) => async () => {
      const s = await triageBatch(b);
      done += b.length;
      onProgress?.(done, items.length);
      return s;
    }),
    config.ai.concurrency,
  );
  for (const s of sets) for (const id of s) junk.add(id);
  return junk;
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
