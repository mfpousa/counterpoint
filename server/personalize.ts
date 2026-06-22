// Personalization: turn interest-INDEPENDENT analysis into a per-reader
// relevance score, deterministically and cheaply (no LLM call). This is what
// makes switching interests instant — the expensive analysis is reused and we
// only recompute a match score + re-rank.
//
// Match = how many of the reader's interest "concepts" appear in an item's
// keywords/title/summary/topic, with a small synonym expansion so e.g. "AI"
// also matches "machine learning" / "LLM".

import type { FeedItem } from "../src/types";
import { cosineSim } from "./embeddings";
import { decodeEntities } from "../src/lib/rss";
import type { StoredItem } from "./store";

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one",
  "our", "out", "his", "has", "had", "him", "she", "its", "who", "get", "got", "via", "per",
  "about", "with", "from", "into", "that", "this", "your", "their", "what", "when", "more",
  "of", "to", "in", "is", "it", "on", "as", "at", "by", "an", "or", "be", "we", "do",
]);

// Minimal, extensible synonym expansion for common interest concepts. Each key
// is matched if the key itself OR any synonym appears in the item.
const SYNONYMS: Record<string, string[]> = {
  ai: ["artificial", "intelligence", "llm", "llms", "ml", "machine", "learning", "neural", "gpt", "openai", "anthropic", "model", "models", "agent", "agents", "chatbot"],
  ml: ["machine", "learning", "ai", "model", "models"],
  llm: ["ai", "language", "model", "models", "gpt"],
  scientific: ["science", "research", "study", "physics", "biology", "chemistry"],
  science: ["scientific", "research", "study", "physics", "biology", "chemistry"],
  progress: ["breakthrough", "advance", "advances", "innovation", "development"],
  geopolitics: ["geopolitical", "diplomacy", "foreign", "war", "conflict", "sanctions", "nato"],
  economics: ["economy", "economic", "markets", "market", "inflation", "trade", "fiscal", "monetary"],
  markets: ["market", "stocks", "stock", "economy", "economic", "trading"],
  climate: ["warming", "carbon", "emissions", "renewable", "environment", "sustainability"],
  energy: ["nuclear", "solar", "wind", "renewable", "grid", "battery", "oil", "gas"],
  health: ["medicine", "medical", "disease", "longevity", "biotech", "clinical"],
  space: ["nasa", "rocket", "satellite", "orbital", "spacex", "astronomy"],
};

/** Lowercase word tokens, dropping stopwords and 1-char noise. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** The reader's distinct interest concepts (token set). */
export function interestTokens(interest: string): Set<string> {
  return new Set(tokenize(interest));
}

function conceptMatched(token: string, hay: Set<string>): boolean {
  if (hay.has(token)) return true;
  for (const syn of SYNONYMS[token] ?? []) if (hay.has(syn)) return true;
  // Word-form match: tie together shared stems (e.g. "humanity"~"human",
  // "economics"~"economic", "future"~"futures"). Prefix-based and length-guarded
  // to catch plurals/derivations without the false positives of substring search.
  if (token.length >= 5) {
    for (const h of hay) {
      if (h.length >= 5 && (h.startsWith(token) || token.startsWith(h))) return true;
    }
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiled word-boundary matcher for one exclude term (null if unusable). */
function excludeRegex(term: string): RegExp | null {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return null;
  // \b around the whole (possibly multi-word) term; tolerate internal spaces.
  return new RegExp(`\\b${escapeRegExp(t).replace(/\s+/g, "\\s+")}\\b`, "i");
}

/** The text we scan for excluded terms: title + summary + keywords + topic. */
function exclusionHaystack(s: StoredItem): string {
  return [s.item.title, s.summary, s.keywords.join(" "), s.topic].join(" ").toLowerCase();
}

/**
 * True if an item mentions any of the reader's EXCLUDED terms (from a negated
 * search like "not israel or iran"). Word-boundary matching so "iran" won't hit
 * "tirana" by accident. Embeddings can't express negation, so we filter on these
 * terms explicitly.
 */
export function excludedByQuery(s: StoredItem, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const hay = exclusionHaystack(s);
  for (const term of exclude) {
    const re = excludeRegex(term);
    if (re && re.test(hay)) return true;
  }
  return false;
}

export interface ExclusionResult {
  kept: StoredItem[];
  /** How many items were removed by exclusion. */
  removed: number;
  /** Exclude terms IGNORED for being too broad (matched > maxFraction of pool). */
  skipped: string[];
  /** Per active-term removal counts, for visibility/logging. */
  counts: Record<string, number>;
}

/**
 * Partition items into kept vs excluded, with a safety valve: any single exclude
 * term that matches MORE than `maxFraction` of the pool is treated as too broad
 * (e.g. an ambiguous "us"/"war", or a term that swallows the whole feed) and is
 * IGNORED rather than gutting the feed. This stops a negated search from quietly
 * hiding "a huge amount of news" because of one over-eager term, while still
 * honoring focused exclusions like "israel"/"iran".
 */
export function partitionByExclusion(
  items: StoredItem[],
  exclude: string[],
  maxFraction = 0.6,
): ExclusionResult {
  if (exclude.length === 0 || items.length === 0) {
    return { kept: items, removed: 0, skipped: [], counts: {} };
  }

  const hays = items.map(exclusionHaystack);
  const limit = Math.floor(items.length * maxFraction);

  const active: { term: string; re: RegExp }[] = [];
  const skipped: string[] = [];
  const counts: Record<string, number> = {};
  for (const term of exclude) {
    const re = excludeRegex(term);
    if (!re) continue;
    const hits = hays.reduce((n, h) => (re.test(h) ? n + 1 : n), 0);
    if (hits > limit) {
      skipped.push(term);
    } else if (hits > 0) {
      active.push({ term, re });
      counts[term] = hits;
    }
  }

  const kept = items.filter((_, i) => !active.some((a) => a.re.test(hays[i])));
  return { kept, removed: items.length - kept.length, skipped, counts };
}

/** 0..1 — fraction of the reader's interest concepts present in the item. */
export function interestMatch(tokens: Set<string>, s: StoredItem): number {
  if (tokens.size === 0) return 0;
  const hay = new Set<string>();
  for (const k of s.keywords) for (const t of tokenize(k)) hay.add(t);
  for (const t of tokenize(s.item.title)) hay.add(t);
  for (const t of tokenize(s.summary)) hay.add(t);
  hay.add(s.topic);

  let matched = 0;
  for (const t of tokens) if (conceptMatched(t, hay)) matched += 1;
  return Math.min(1, matched / tokens.size);
}

/**
 * Blend general importance with interest match. With no interest, relevance is
 * pure importance. With an interest, the match dominates (so off-interest items
 * sink) while importance still rewards substance and breaks ties.
 */
export function personalizedRelevance(
  importance: number,
  match: number,
  hasInterest: boolean,
): number {
  if (!hasInterest) return importance;
  return Math.max(0, Math.min(1, 0.6 * match + 0.4 * importance));
}

/**
 * Map a cosine similarity (typically ~0.2..0.85 for sentence embeddings) onto a
 * 0..1 match score, stretching the useful band so relevant items separate
 * clearly from background noise.
 */
export function semanticMatch(queryVec: number[], itemVec: number[]): number {
  const sim = cosineSim(queryVec, itemVec);
  return Math.max(0, Math.min(1, (sim - 0.2) / 0.6));
}

/**
 * Materialize a ranked-feed FeedItem from a stored analysis + reader interest.
 * When a query embedding AND the item's embedding are present, relevance is
 * SEMANTIC (cosine similarity). Otherwise it falls back to keyword matching.
 */
export function toFeedItem(
  s: StoredItem,
  tokens: Set<string>,
  hasInterest: boolean,
  queryVec?: number[] | null,
): FeedItem {
  const match =
    hasInterest && queryVec && s.embedding
      ? semanticMatch(queryVec, s.embedding)
      : interestMatch(tokens, s);
  const relevance = personalizedRelevance(s.importance, match, hasInterest);
  return {
    ...s.item,
    // Decode any leftover HTML entities (e.g. `&#039;`) so titles/summaries read
    // cleanly even for items analyzed before the parser fix.
    title: decodeEntities(s.item.title),
    summary: s.item.summary ? decodeEntities(s.item.summary) : s.item.summary,
    // Full article HTML is a server-only rewrite fallback; never ship it to
    // clients (it would bloat every /api/feed response).
    content: undefined,
    topic: s.topic,
    lean: s.lean,
    // Honest provenance: "llm" only when the model actually refined this item's
    // lean; otherwise it kept the curated source prior. Older stored items
    // (pre-refinement) have no leanSource — treat those as "source".
    leanSource: s.leanSource ?? "source",
    leanRationale: s.leanRationale,
    relevance,
    aiReason: s.summary || undefined,
    // "Covered by N outlets" — only meaningful when several carried the story.
    coveredBy: s.coveredBy && s.coveredBy > 1 ? s.coveredBy : undefined,
  };
}
