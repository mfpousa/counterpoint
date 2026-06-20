// OPTIONAL, opt-in item-level lean refinement.
//
// Off by default. When the user enables it and supplies an API key, we classify
// each item's headline+summary and OVERRIDE the source-level prior. Results are
// cached per item id so we never re-pay. Provenance is recorded as "llm".
//
// We deliberately surface (in the UI) that the model has its OWN bias; this is a
// refinement, not a source of truth.

import type { FeedItem } from "../types";
import { isPolitical } from "./lean";

const CACHE: Map<string, { lean: number; confidence: number }> = new Map();

const SYSTEM_PROMPT =
  "You are a neutral media-bias classifier. Given a headline and summary, return a " +
  "JSON object {\"lean\": number, \"confidence\": number} where lean is the political " +
  "lean of the ITEM on a scale from -1.0 (strongly left) to +1.0 (strongly right), 0 " +
  "for centrist/neutral, and confidence is 0..1. Judge the framing of THIS item, not " +
  "the outlet. Respond with JSON only.";

interface RefineOptions {
  apiKey: string;
  /** OpenAI-compatible chat completions endpoint. */
  endpoint?: string;
  model?: string;
  /** Max items to classify per call (cost guard). */
  limit?: number;
}

function cacheKey(item: FeedItem): string {
  return item.id;
}

async function classifyOne(
  item: FeedItem,
  opts: RefineOptions,
): Promise<{ lean: number; confidence: number } | null> {
  const cached = CACHE.get(cacheKey(item));
  if (cached) return cached;

  const endpoint = opts.endpoint ?? "https://api.openai.com/v1/chat/completions";
  const model = opts.model ?? "gpt-4o-mini";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Headline: ${item.title}\nSummary: ${item.summary.slice(0, 600)}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { lean?: unknown; confidence?: unknown };
    const lean = Number(parsed.lean);
    const confidence = Number(parsed.confidence);
    if (Number.isNaN(lean)) return null;
    const clamped = Math.max(-1, Math.min(1, lean));
    const conf = Number.isNaN(confidence) ? 0.5 : Math.max(0, Math.min(1, confidence));
    const out = { lean: clamped, confidence: conf };
    CACHE.set(cacheKey(item), out);
    return out;
  } catch {
    return null;
  }
}

/**
 * Refine the lean of the given items via the LLM, returning NEW items with
 * `leanSource: "llm"` where classification succeeded. Items the source already
 * marks non-political are skipped (we don't politicize neutral content).
 * Never throws; failed items keep their source prior.
 */
export async function refineLean(items: FeedItem[], opts: RefineOptions): Promise<FeedItem[]> {
  if (!opts.apiKey) return items;
  const limit = opts.limit ?? 30;
  let budget = limit;
  const out: FeedItem[] = [];
  for (const item of items) {
    if (budget <= 0 || !isPolitical(item)) {
      out.push(item);
      continue;
    }
    budget -= 1;
    const r = await classifyOne(item, opts);
    if (r) {
      out.push({ ...item, lean: r.lean, confidence: r.confidence, leanSource: "llm" });
    } else {
      out.push(item);
    }
  }
  return out;
}

/** Test/seam helper: prime the cache (used to avoid network in tests). */
export function __primeCache(id: string, lean: number, confidence = 0.8): void {
  CACHE.set(id, { lean, confidence });
}

export function __clearCache(): void {
  CACHE.clear();
}
