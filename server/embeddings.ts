// Semantic matching via embeddings. Talks to any OpenAI-compatible embeddings
// endpoint (LM Studio / Ollama / llama.cpp / ...) at POST /v1/embeddings.
//
// Each feed item is embedded once (cached in the store); a reader's interest is
// embedded per search (cached in memory). Relevance is then cosine similarity
// between the two vectors — meaning-based, not keyword-based. Everything degrades
// gracefully: if no embedding model is loaded, callers fall back to keyword
// matching and the app keeps working.

import { config } from "./config";

let warnedUnavailable = false;
function warnOnce(why: string): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(
    `[embed] embeddings unavailable (${why}) — falling back to keyword matching. ` +
      "Load an embedding model in your runtime and set AI_EMBED_MODEL, or set " +
      "AI_EMBEDDINGS_OFF=1 to silence this.",
  );
}

/** Embed one batch via /v1/embeddings. Returns one vector per input (null on failure). */
async function embedBatch(input: string[]): Promise<(number[] | null)[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${config.ai.baseUrl}/embeddings`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({ model: config.ai.embedModel, input }),
    });
    if (!res.ok) {
      warnOnce(`HTTP ${res.status}`);
      return input.map(() => null);
    }
    const json = (await res.json()) as {
      data?: { embedding?: number[]; index?: number }[];
    };
    const rows = json.data ?? [];
    // Map by the server-reported index so order is preserved even if reordered.
    const out: (number[] | null)[] = input.map(() => null);
    rows.forEach((row, i) => {
      const idx = typeof row.index === "number" ? row.index : i;
      if (Array.isArray(row.embedding) && idx >= 0 && idx < out.length) out[idx] = row.embedding;
    });
    return out;
  } catch (e) {
    warnOnce(e instanceof Error ? e.message : String(e));
    return input.map(() => null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed many texts (batched). Returns a vector per text, or null for any that
 * couldn't be embedded. Returns all-null when embeddings are disabled.
 */
export async function embedTexts(texts: string[]): Promise<(number[] | null)[]> {
  if (!config.ai.embeddingsEnabled || texts.length === 0) return texts.map(() => null);
  const out: (number[] | null)[] = [];
  const size = Math.max(1, config.ai.embedBatchSize);
  for (let i = 0; i < texts.length; i += size) {
    const vecs = await embedBatch(texts.slice(i, i + size));
    for (const v of vecs) out.push(v);
  }
  return out;
}

// Per-process cache of interest -> query vector (interests repeat across requests).
const queryCache = new Map<string, number[] | null>();

/** Embed a reader's interest text (cached). Null when empty/unavailable. */
export async function embedQuery(interest: string): Promise<number[] | null> {
  const key = interest.trim().toLowerCase();
  if (!key) return null;
  if (queryCache.has(key)) return queryCache.get(key) ?? null;
  const [vec] = await embedTexts([key]);
  queryCache.set(key, vec ?? null);
  return vec ?? null;
}

/** Cosine similarity of two vectors in [-1, 1] (0 if either is degenerate). */
export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The compact text we embed to represent an item's meaning. */
export function itemEmbedText(title: string, summary: string, keywords: string[]): string {
  return [title, summary, keywords.join(", ")].filter(Boolean).join(". ").slice(0, 1000);
}
