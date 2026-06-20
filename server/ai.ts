// OpenAI-compatible enrichment client.
//
// Talks to ANY local runtime that exposes /chat/completions (LM Studio, Ollama,
// llama.cpp, vLLM, ...). For each article it asks the model to assign a topic,
// a political lean, a relevance score, and a one-line rationale. Calls are
// BATCHED (many articles per request) and run with bounded concurrency, since
// local GPUs are the bottleneck. Everything degrades gracefully: a failed or
// malformed response simply leaves items un-enriched (the caller keeps the
// source-level priors).

import type { FeedItem, Topic } from "../src/types";
import { config } from "./config";

export interface Enrichment {
  topic: Topic;
  /** Item-level political lean -1..1, or null for non-political content. */
  lean: number | null;
  /** 0..1 importance/newsworthiness for an informed general reader. */
  relevance: number;
  /** One-sentence relevance summary naming the core subject (<= ~22 words). */
  reason: string;
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

const SYSTEM_PROMPT =
  "You are a neutral editor curating a high-signal, politically balanced reading feed. " +
  "For EACH article you receive, judge it on its own merits and output an object with:\n" +
  '- "id": echo the article id exactly.\n' +
  '- "topic": one of world|politics|economics|science|technology|history|health|culture.\n' +
  '- "lean": the political lean of THIS item from -1.0 (strongly left) to +1.0 ' +
  "(strongly right), 0 for centrist; use null if the item is non-political " +
  "(science/tech/history/health/culture explainers).\n" +
  '- "relevance": 0.0..1.0 how newsworthy/substantive/important it is to an informed ' +
  "general reader. Penalize clickbait, ads, thin listicles, and pure horse-race noise.\n" +
  '- "reason": ONE plain sentence (<= 22 words) summarizing what the item is actually ' +
  "about — name the core subject/topic — and why it is relevant or worth the reader's time. " +
  "Be specific and concrete (e.g. 'Breakdown of the new EU AI Act and what it means for startups'), " +
  "not generic ('an interesting article about technology').\n" +
  "Some articles (videos/podcasts) include a \"transcript\" of the actual spoken content — " +
  "weigh it heavily over the title/summary when judging topic, lean, and relevance.\n" +
  "Respond with ONLY a JSON array of these objects, in the same order as the input. No prose.";

/** Pull the first JSON array/object out of a model response (handles ``` fences). */
function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : content).trim();
  // Prefer an array; fall back to an object wrapper like { "items": [...] }.
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function coerceEnrichment(raw: Record<string, unknown>, fallback: FeedItem): Enrichment {
  const topicRaw = String(raw["topic"] ?? "").toLowerCase();
  const topic = (VALID_TOPICS.has(topicRaw) ? topicRaw : fallback.topic) as Topic;

  let lean: number | null;
  if (raw["lean"] === null || raw["lean"] === undefined || raw["lean"] === "null") {
    lean = fallback.lean; // keep source prior when model abstains
  } else {
    lean = clamp(raw["lean"], -1, 1, fallback.lean ?? 0);
  }

  const relevance = clamp(raw["relevance"], 0, 1, 0.5);
  const reason = typeof raw["reason"] === "string" ? (raw["reason"] as string).trim() : "";
  return { topic, lean, relevance, reason };
}

/** One LLM round-trip for a batch. Returns id -> Enrichment (partial on error). */
async function classifyBatch(
  batch: FeedItem[],
  transcripts: Map<string, string>,
): Promise<Map<string, Enrichment>> {
  const out = new Map<string, Enrichment>();
  if (batch.length === 0) return out;

  const userPayload = batch.map((it) => {
    const transcript = transcripts.get(it.id);
    return {
      id: it.id,
      source: it.sourceTitle,
      title: it.title,
      summary: it.summary.slice(0, 500),
      ...(transcript ? { transcript } : {}),
    };
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[ai] classify batch failed: HTTP ${res.status}`);
      return out;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(content);
    const rows: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.["items"])
        ? ((parsed as Record<string, unknown>)["items"] as unknown[])
        : [];

    const byId = new Map(batch.map((it) => [it.id, it]));
    rows.forEach((row, i) => {
      if (!row || typeof row !== "object") return;
      const r = row as Record<string, unknown>;
      // Match by echoed id when present, else fall back to positional order.
      const item = (typeof r["id"] === "string" && byId.get(r["id"] as string)) || batch[i];
      if (!item) return;
      out.set(item.id, coerceEnrichment(r, item));
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "timeout" : String(e);
    console.warn(`[ai] classify batch error: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/** Run async tasks with a bounded number in flight (order-independent). */
async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Enrich items in batches. Caps the number of items sent to the model
 * (config.ai.maxItems) for latency/cost; the rest are returned unchanged.
 * Returns NEW items; the effective topic/lean are overwritten where the model
 * spoke, and relevance/aiReason are attached.
 */
export async function enrichItems(
  items: FeedItem[],
  transcripts: Map<string, string> = new Map(),
): Promise<FeedItem[]> {
  const slice = items.slice(0, config.ai.maxItems);
  const rest = items.slice(config.ai.maxItems);

  const batches: FeedItem[][] = [];
  for (let i = 0; i < slice.length; i += config.ai.batchSize) {
    batches.push(slice.slice(i, i + config.ai.batchSize));
  }

  const maps = await withConcurrency(
    batches.map((b) => () => classifyBatch(b, transcripts)),
    config.ai.concurrency,
  );
  const enrichment = new Map<string, Enrichment>();
  for (const m of maps) for (const [id, e] of m) enrichment.set(id, e);

  const applied = slice.map((it) => {
    const e = enrichment.get(it.id);
    if (!e) return it; // model didn't speak for this one — keep source prior
    return {
      ...it,
      topic: e.topic,
      lean: e.lean,
      leanSource: "llm" as const,
      relevance: e.relevance,
      aiReason: e.reason || undefined,
    };
  });

  return [...applied, ...rest];
}

/** True if the configured AI endpoint answers a models list (used by /health). */
export async function aiReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${config.ai.baseUrl}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
