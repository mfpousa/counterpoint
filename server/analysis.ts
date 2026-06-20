// Editorial analysis of feed items via the local LLM. Two passes, both batched
// and concurrency-limited, and BOTH interest-independent (so results can be
// cached/persisted and reused across every reader interest):
//
//   1. Clickbait triage  — cheap, title-only. Flags low-signal junk so we never
//      spend the expensive pass on it.
//   2. Deep analysis     — topic, political lean, general importance, a concrete
//      one-line summary, and topical keywords used later to match interests.

import type { FeedItem, Topic } from "../src/types";
import { chatJsonArray, clampNum, withConcurrency } from "./ai";
import { config } from "./config";

/** Interest-INDEPENDENT analysis we compute once per item and persist. */
export interface ItemAnalysis {
  topic: Topic;
  /** Political lean -1..1, or null for non-political content. */
  lean: number | null;
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
  'junk. Output ONLY a JSON array of objects {"id": echo the id, "junk": ' +
  "true|false}, same order as input. No prose.";

const ANALYZE_PROMPT =
  "You are a neutral editor building a high-signal, politically balanced feed. " +
  "For EACH article output an object with:\n" +
  '- "id": echo the article id exactly.\n' +
  '- "topic": one of world|politics|economics|science|technology|history|health|culture.\n' +
  '- "lean": political lean of THIS item from -1.0 (strongly left) to +1.0 ' +
  "(strongly right), 0 centrist; null if non-political.\n" +
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
  "Respond with ONLY a JSON array, same order as input. No prose.";

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
  const rows = await chatJsonArray(TRIAGE_PROMPT, payload);
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

/** Return the set of item ids judged clickbait/junk (title-only, cheap). */
export async function detectClickbait(items: FeedItem[]): Promise<Set<string>> {
  const junk = new Set<string>();
  if (items.length === 0) return junk;
  const batches = chunk(items, config.ai.triageBatchSize);
  const sets = await withConcurrency(
    batches.map((b) => () => triageBatch(b)),
    config.ai.concurrency,
  );
  for (const s of sets) for (const id of s) junk.add(id);
  return junk;
}

// --- Pass 2: deep analysis ---------------------------------------------------

function coerceAnalysis(raw: Record<string, unknown>, fallback: FeedItem): ItemAnalysis {
  const topicRaw = String(raw["topic"] ?? "").toLowerCase();
  const topic = (VALID_TOPICS.has(topicRaw) ? topicRaw : fallback.topic) as Topic;

  let lean: number | null;
  const lv = raw["lean"];
  if (lv === null || lv === undefined || lv === "null") lean = fallback.lean;
  else lean = clampNum(lv, -1, 1, fallback.lean ?? 0);

  const importance = clampNum(raw["importance"], 0, 1, 0.5);
  const summary = typeof raw["summary"] === "string" ? (raw["summary"] as string).trim() : "";
  const keywords = Array.isArray(raw["keywords"])
    ? (raw["keywords"] as unknown[])
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];

  return { topic, lean, importance, summary, keywords };
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
  const rows = await chatJsonArray(ANALYZE_PROMPT, payload);
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
): Promise<Map<string, ItemAnalysis>> {
  const out = new Map<string, ItemAnalysis>();
  if (items.length === 0) return out;
  const batches = chunk(items, config.ai.batchSize);
  const maps = await withConcurrency(
    batches.map((b) => () => analyzeBatch(b, transcripts)),
    config.ai.concurrency,
  );
  for (const m of maps) for (const [id, a] of m) out.set(id, a);
  return out;
}
