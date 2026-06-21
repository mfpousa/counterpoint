// On-demand "AI rewrite" reader. Given a stored feed item, fetch the original
// article (or, for YouTube videos, its transcript), then have the local LLM
// rewrite it into clean, faithful, readable prose for in-app reading.
//
// Constrained decoding (JSON schema) guarantees a valid, complete reply and
// makes the model STOP — the same fix used by analysis/briefing. Results are
// cached in memory (per item) so re-opening an article is instant.

import type { RewrittenArticle } from "../src/types";
import { aiReachable, chatJsonObject, chatRaw, type JsonSchema } from "./ai";
import { config } from "./config";
import { extractReadable, htmlToText } from "./readability";
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

const DEGRADED_RULES =
  "You are a news editor. The full article text is UNAVAILABLE (paywall or a " +
  "page we couldn't read). Using ONLY the headline and the short feed summary " +
  "provided, write a brief, neutral overview of what the story is about. STRICT " +
  "RULES:\n" +
  "- Use ONLY the supplied headline/summary. Do NOT invent facts, quotes, " +
  "numbers, names, or details that are not present.\n" +
  "- It is fine to be short: 1-3 small paragraphs. Do not pad.\n" +
  "- Neutral tone; no speculation, no editorializing.\n" +
  "- Do NOT claim to have read the full article.\n" +
  'Output ONLY a JSON object {"title": "clean headline", "paragraphs": ["para 1", ' +
  '...]}. No markdown, no prose outside the JSON.';

interface CacheEntry {
  at: number;
  article: RewrittenArticle;
}
const cache = new Map<string, CacheEntry>();

/** Strip code fences / stray markdown a weak model sometimes wraps text in. */
function stripFences(s: string): string {
  return s
    .replace(/```+\s*json\b/gi, "")
    .replace(/```+/g, "")
    .trim();
}

/**
 * True when a "paragraph" is actually JSON scaffolding the model leaked into its
 * own output (lone keys, braces, fences) rather than real prose. Local models
 * occasionally echo a malformed `{ title ... paragraphs ... }` dump INTO the
 * paragraphs array even under constrained decoding; this keeps that garbage out
 * of the reader.
 */
function isJsonScaffolding(p: string): boolean {
  const t = p.trim();
  if (!t) return true;
  // Only quotes / commas / colons / brackets — no actual words.
  if (/^["'\s,:{}\[\]]*$/.test(t)) return true;
  // A bare schema key, e.g. `title`, `"paragraphs":`, `title:`.
  if (/^["']?(title|paragraphs|content)["']?\s*:?\s*[{[]?$/i.test(t)) return true;
  // A leftover fence marker like `json, {`.
  if (/^json\b[\s,{[]*$/i.test(t)) return true;
  return false;
}

/**
 * Parse the model's {title, paragraphs} reply into clean paragraphs: strip
 * fences, drop leaked JSON scaffolding, and de-dupe echoed paragraphs. Returns
 * [] when nothing substantive survives, so the caller fails cleanly (graceful
 * error + "Open original") instead of rendering corrupted text.
 */
export function parseParagraphs(obj: Record<string, unknown>, title = ""): string[] {
  const raw = Array.isArray(obj["paragraphs"])
    ? (obj["paragraphs"] as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const titleNorm = title.trim().toLowerCase();
  const cleaned: string[] = [];
  for (const p of raw) {
    const s = stripFences(p);
    if (!s || isJsonScaffolding(s)) continue;
    // A leaked title VALUE (e.g. the headline echoed as a paragraph) reads like
    // prose but isn't body text — drop it when it equals the title.
    if (titleNorm && s.toLowerCase() === titleNorm) continue;
    cleaned.push(s);
  }
  // Drop consecutive duplicate paragraphs (models sometimes echo themselves).
  const deduped = cleaned.filter((p, i) => i === 0 || p !== cleaned[i - 1]);
  // Require at least one real prose paragraph; else treat the reply as garbage.
  return deduped.some((p) => p.length >= 40 && /\s/.test(p)) ? deduped : [];
}

/** Clean a model-provided title, falling back when it's missing/scaffolding. */
export function cleanTitle(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const t = stripFences(raw).replace(/^["']|["']$/g, "").trim();
  return t.length > 0 && !isJsonScaffolding(t) ? t : fallback;
}

/**
 * Build a clearly-labeled SHORT brief from just the headline + feed summary when
 * no full article body could be retrieved. Returns null if the model is unusable
 * or we have too little context to say anything meaningful (avoids title-only
 * filler). The result is marked `degraded` so the reader can flag it.
 */
async function degradedBrief(stored: StoredItem): Promise<RewrittenArticle | null> {
  if (!config.reader.degradedFallback) return null;
  const { item } = stored;
  const summary = (item.summary || stored.summary || "").trim();
  const keywords = stored.keywords?.length ? stored.keywords.join(", ") : "";
  // Without a real summary, a "brief" would just paraphrase the title — skip it.
  if (summary.length < 60 && keywords.length < 20) return null;

  const payload = {
    headline: item.title,
    sourceTitle: item.sourceTitle,
    feedSummary: summary,
    keywords,
  };
  const obj = await chatJsonObject(DEGRADED_RULES, payload, {
    maxTokens: 600,
    schema: REWRITE_SCHEMA,
  });
  if (!obj) return null;
  const title = cleanTitle(obj["title"], item.title);
  const paragraphs = parseParagraphs(obj, title);
  if (paragraphs.length === 0) return null;

  const article: RewrittenArticle = {
    id: item.id,
    title,
    paragraphs,
    sourceTitle: item.sourceTitle,
    url: item.url,
    kind: item.kind,
    estMinutes: readMinutes(paragraphs),
    degraded: true,
  };
  console.log(`[reader] degraded brief for ${item.url} (no full body available)`);
  return article;
}

/**
 * Find the best available FULL source text for an item, in order:
 *   1. YouTube transcript (videos).
 *   2. Live page extraction — publisher direct, then reader proxies.
 *   3. The feed's own full-content body (content:encoded), when shipped.
 * Returns null only when no full body is obtainable (caller may then fall back
 * to a clearly-labeled degraded brief).
 */
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

  const extracted = await extractReadable(item.url);
  if (extracted) return { text: extracted.text, fallbackTitle: extracted.title || item.title };

  // Last resort before degrading: the feed may have shipped the full body itself.
  if (item.content) {
    const text = htmlToText(item.content);
    if (text.length >= config.reader.minChars) {
      console.log(`[reader] using feed content (${text.length} chars) for ${item.url}`);
      return { text: text.slice(0, config.reader.maxChars), fallbackTitle: item.title };
    }
  }
  return null;
}

// Plain-prose prompts for the STREAMING path: the model writes readable text we
// can forward token-by-token (no JSON to incrementally parse). Headline on the
// first line, blank line, then short body paragraphs separated by blank lines.
const PLAIN_RULES =
  REWRITE_RULES.replace(
    /Output ONLY a JSON object[\s\S]*$/,
    "Output the clean HEADLINE on the first line, then a blank line, then the article " +
      "body as short paragraphs separated by blank lines. No markdown, no JSON, no preamble.",
  );
const PLAIN_DEGRADED_RULES =
  DEGRADED_RULES.replace(
    /Output ONLY a JSON object[\s\S]*$/,
    "Output the headline on the first line, then a blank line, then 1-3 short paragraphs " +
      "separated by blank lines. No markdown, no JSON, no preamble.",
  );

/** Parse the streamed plain-prose reply into a clean {title, paragraphs}. */
function parsePlainArticle(
  raw: string,
  fallbackTitle: string,
): { title: string; paragraphs: string[] } | null {
  const text = stripFences(raw).trim();
  if (!text) return null;
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (blocks.length === 0) return null;
  let title = fallbackTitle;
  let body = blocks;
  const first = blocks[0].replace(/^#+\s*/, "").replace(/^["']|["']$/g, "").trim();
  if (first.length <= 120 && blocks.length > 1) {
    title = first;
    body = blocks.slice(1);
  }
  const paragraphs = body.filter((p) => !isJsonScaffolding(p));
  if (!paragraphs.some((p) => p.length >= 40 && /\s/.test(p))) return null;
  return { title: title || fallbackTitle, paragraphs };
}

/**
 * STREAMING rewrite: forwards the model's tokens to `onDelta` as they generate
 * (so the reader can show the AI writing live), then returns the cleaned, cached
 * article. Falls back to a degraded brief when no full body is available. Returns
 * null when the model is unreachable or replies with nothing usable. A cached
 * article is replayed in one delta so re-opens are instant.
 */
export async function rewriteArticleStream(
  stored: StoredItem,
  onDelta: (delta: string) => void,
  onReasoning?: (delta: string) => void,
): Promise<RewrittenArticle | null> {
  const { item } = stored;

  const cached = cache.get(item.id);
  if (cached && Date.now() - cached.at < config.reader.cacheTtlMs) {
    onDelta(`${cached.article.title}\n\n${cached.article.paragraphs.join("\n\n")}`);
    return cached.article;
  }

  if (!(await aiReachable())) return null;

  const src = await sourceText(stored);
  let degraded = false;
  let system: string;
  let payload: Record<string, unknown>;
  if (src) {
    system = PLAIN_RULES;
    payload = { sourceTitle: item.sourceTitle, originalTitle: item.title, kind: item.kind, content: src.text };
  } else {
    if (!config.reader.degradedFallback) return null;
    const summary = (item.summary || stored.summary || "").trim();
    const keywords = stored.keywords?.length ? stored.keywords.join(", ") : "";
    if (summary.length < 60 && keywords.length < 20) return null;
    degraded = true;
    system = PLAIN_DEGRADED_RULES;
    payload = { headline: item.title, sourceTitle: item.sourceTitle, feedSummary: summary, keywords };
  }

  const full = await chatRaw(system, payload, { maxTokens: config.reader.maxTokens, onDelta, onReasoning });
  const parsed = parsePlainArticle(full, src?.fallbackTitle || item.title);
  if (!parsed) return null;

  const article: RewrittenArticle = {
    id: item.id,
    title: parsed.title,
    paragraphs: parsed.paragraphs,
    sourceTitle: item.sourceTitle,
    url: item.url,
    kind: item.kind,
    estMinutes: readMinutes(parsed.paragraphs),
    degraded,
  };
  cache.set(item.id, { at: Date.now(), article });
  return article;
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
  if (!src) {
    // No full body anywhere (hard paywall / JS-only). Don't dead-end — fall back
    // to a clearly-labeled short brief built from the headline + feed summary.
    const brief = await degradedBrief(stored);
    if (brief) cache.set(item.id, { at: Date.now(), article: brief });
    return brief;
  }

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

  const title = cleanTitle(obj["title"], src.fallbackTitle || item.title);
  const paragraphs = parseParagraphs(obj, title);
  if (paragraphs.length === 0) {
    console.warn(`[reader] discarded unusable/garbled rewrite for ${item.url}`);
    return null;
  }

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
