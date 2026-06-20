// On-demand "AI rewrite" reader. Given a stored feed item, fetch the original
// article (or, for YouTube videos, its transcript), then have the local LLM
// rewrite it into clean, faithful, readable prose for in-app reading.
//
// Constrained decoding (JSON schema) guarantees a valid, complete reply and
// makes the model STOP — the same fix used by analysis/briefing. Results are
// cached in memory (per item) so re-opening an article is instant.

import type { RewrittenArticle } from "../src/types";
import { aiReachable, chatJsonObject, type JsonSchema } from "./ai";
import { config } from "./config";
import { extractArticle } from "./readability";
import type { StoredItem } from "./store";
import { fetchYouTubeTranscript, isYouTube, youTubeVideoId } from "./transcripts";

const REWRITE_SCHEMA: JsonSchema = {
  name: "article",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      paragraphs: { type: "array", items: { type: "string" } },
    },
    required: ["title", "paragraphs"],
    additionalProperties: false,
  },
};

const REWRITE_RULES =
  "You are a skilled editor producing a clean, readable version of a news article " +
  "for distraction-free in-app reading. Rewrite the provided source faithfully in " +
  "clear, neutral, well-structured prose. STRICT RULES:\n" +
  "- Preserve ALL key facts, names, numbers, quotes and the original meaning.\n" +
  "- Do NOT invent, speculate, or add information not present in the source.\n" +
  "- Remove boilerplate, ads, navigation, newsletter/subscription prompts and " +
  "related-article clutter.\n" +
  "- Use plain, calm language; short paragraphs (2-4 sentences each).\n" +
  "- Neutral tone; do not editorialize or take sides.\n" +
  'Output ONLY a JSON object {"title": "clean headline", "paragraphs": ["para 1", ' +
  '"para 2", ...] }. No markdown, no prose outside the JSON.';

/** ~200 wpm reading speed -> whole minutes (min 1). */
function readMinutes(paragraphs: string[]): number {
  const words = paragraphs.join(" ").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

interface CacheEntry {
  at: number;
  article: RewrittenArticle;
}
const cache = new Map<string, CacheEntry>();

/** Fetch the best available source text for an item (article HTML or transcript). */
async function sourceText(stored: StoredItem): Promise<{ text: string; fallbackTitle: string } | null> {
  const { item } = stored;
  if (isYouTube(item)) {
    const id = youTubeVideoId(item.url);
    const transcript = id ? await fetchYouTubeTranscript(id) : null;
    if (transcript && transcript.length >= config.reader.minChars) {
      return { text: transcript.slice(0, config.reader.maxChars), fallbackTitle: item.title };
    }
    return null;
  }
  const extracted = await extractArticle(item.url);
  if (!extracted) return null;
  return { text: extracted.text, fallbackTitle: extracted.title || item.title };
}

/**
 * Produce (and cache) a clean, AI-rewritten version of a stored item for in-app
 * reading. Returns null when the model is unreachable, the page can't be fetched
 * (paywall/JS-only), or the model gives nothing usable.
 */
export async function rewriteArticle(stored: StoredItem): Promise<RewrittenArticle | null> {
  const { item } = stored;

  const cached = cache.get(item.id);
  if (cached && Date.now() - cached.at < config.reader.cacheTtlMs) return cached.article;

  if (!(await aiReachable())) return null;

  const src = await sourceText(stored);
  if (!src) return null;

  const payload = {
    sourceTitle: item.sourceTitle,
    originalTitle: item.title,
    kind: item.kind,
    content: src.text,
  };
  const obj = await chatJsonObject(REWRITE_RULES, payload, {
    maxTokens: config.reader.maxTokens,
    schema: REWRITE_SCHEMA,
  });
  if (!obj) return null;

  const title =
    (typeof obj["title"] === "string" && obj["title"].trim()) || src.fallbackTitle || item.title;
  const paragraphs = Array.isArray(obj["paragraphs"])
    ? (obj["paragraphs"] as unknown[])
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  if (paragraphs.length === 0) return null;

  const article: RewrittenArticle = {
    id: item.id,
    title,
    paragraphs,
    sourceTitle: item.sourceTitle,
    url: item.url,
    kind: item.kind,
    estMinutes: readMinutes(paragraphs),
  };
  cache.set(item.id, { at: Date.now(), article });
  return article;
}
