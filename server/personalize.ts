// Personalization: turn interest-INDEPENDENT analysis into a per-reader
// relevance score, deterministically and cheaply (no LLM call). This is what
// makes switching interests instant — the expensive analysis is reused and we
// only recompute a match score + re-rank.
//
// Match = how many of the reader's interest "concepts" appear in an item's
// keywords/title/summary/topic, with a small synonym expansion so e.g. "AI"
// also matches "machine learning" / "LLM".

import type { FeedItem } from "../src/types";
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
  return false;
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

/** Materialize a ranked-feed FeedItem from a stored analysis + reader interest. */
export function toFeedItem(s: StoredItem, tokens: Set<string>, hasInterest: boolean): FeedItem {
  const match = interestMatch(tokens, s);
  const relevance = personalizedRelevance(s.importance, match, hasInterest);
  return {
    ...s.item,
    topic: s.topic,
    lean: s.lean,
    leanSource: "llm",
    relevance,
    aiReason: s.summary || undefined,
  };
}
