// Free-text news search over the WHOLE fetched database ("ask"). The reader types
// something like "fires" or "Donald Trump" and the SAME model both ANSWERS and
// decides HOW to show it: when the matter has a geographic spread it lists located
// places (the globe drops markers — mode "map"); otherwise it's just a synopsis
// (mode "answer"). The synopsis streams token-by-token while it generates.
//
// Retrieval is semantic (embed the query, cosine-rank every analyzed item across
// ALL loaded pools), with a lexical token-overlap fallback when no embedding model
// is loaded. Everything degrades gracefully: no corpus / no model → an empty result.

import type { AskPlace, AskResult, Lang } from "../src/types";
import { chatRaw } from "./ai";
import { config } from "./config";
import { cosineSim, embedQuery } from "./embeddings";
import { langDirective } from "./lang";
import { storedAcrossPools, type StoredItem } from "./store";
import { tokenize } from "./personalize";

/** How many of the best-matching items we feed the model to ground its answer. */
const TOP_K = 30;
/** Cap the candidate set (most-recent first) before scoring, to bound cost on a
 *  process that has fetched a lot of pools. */
const MAX_CANDIDATES = 6000;

const ASK_RULES =
  "You are a sharp, neutral news analyst answering a reader's question using ONLY the " +
  "provided recent news items (each: title, one-line summary, source, topic, age). Be " +
  "specific and grounded in the items; do NOT invent facts, places, or events that are " +
  "not present. If the items don't actually support an answer, say so in one sentence.\n" +
  "Write PLAIN TEXT (no JSON, no markdown headings) in EXACTLY this structure:\n" +
  "1) A SYNOPSIS of 1-3 sentences that answers the question from the items.\n" +
  "2) THEN, only if the matter is unfolding in identifiable PLACES, a blank line followed " +
  "by one line PER place, formatted EXACTLY:\n" +
  "   - <Place name> (<ISO2>): <one sentence on what's happening THERE>\n" +
  "   where <ISO2> is the ISO 3166-1 alpha-2 COUNTRY code (e.g. US, ES, UA, FR). List up " +
  "to 8 places, most significant first. If the matter has NO meaningful geographic spread " +
  "(e.g. a person, a concept), output NO place lines — just the synopsis.\n" +
  "Output nothing else — no preamble, no closing remarks.";

function relativeAge(publishedAt: number, now: number): string {
  const h = Math.max(0, Math.round((now - publishedAt) / 3_600_000));
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Analyzed, de-duplicated items across every loaded pool, newest first (capped). */
function corpus(): StoredItem[] {
  const all = storedAcrossPools(() => true).filter(
    (s) => s.analyzed && !s.clickbait && !s.cloneOf,
  );
  const byId = new Map<string, StoredItem>();
  for (const s of all) if (!byId.has(s.item.id)) byId.set(s.item.id, s);
  return [...byId.values()]
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt)
    .slice(0, MAX_CANDIDATES);
}

/** Lexical fallback ranking (no embeddings): token overlap of the query against
 *  each item's title + summary + keywords. Best first. */
function lexicalRank(items: StoredItem[], q: string): StoredItem[] {
  const qTokens = new Set(tokenize(q));
  if (qTokens.size === 0) return [];
  const scored: { s: StoredItem; score: number }[] = [];
  for (const s of items) {
    const hay = [
      ...tokenize(s.item.title),
      ...tokenize(s.summary),
      ...s.keywords.flatMap((k) => tokenize(k)),
    ];
    let overlap = 0;
    for (const t of hay) if (qTokens.has(t)) overlap += 1;
    if (overlap > 0) scored.push({ s, score: overlap });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.s);
}

/** Rank the corpus against the query — semantic when embeddings are available,
 *  else lexical — and return the top-K grounding items. */
async function retrieve(q: string): Promise<StoredItem[]> {
  const items = corpus();
  if (items.length === 0) return [];
  const qv = await embedQuery(q);
  if (qv) {
    const scored = items
      .filter((s) => s.embedding && s.embedding.length > 0)
      .map((s) => ({ s, score: cosineSim(qv, s.embedding as number[]) }))
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) return scored.slice(0, TOP_K).map((x) => x.s);
  }
  return lexicalRank(items, q).slice(0, TOP_K);
}

const PLACE_LINE = /^[-*•]\s*(.+?)\s*\(([A-Za-z]{2})\)\s*:\s*(.+)$/;

/** Parse the streamed plain-prose answer back into a synopsis + located places.
 *  Lines shaped "- Place (ISO2): blurb" become places; everything before the first
 *  such line (minus blanks) is the synopsis. Forgiving of stray markdown fences. */
export function parseAsk(raw: string): { synopsis: string; places: AskPlace[] } {
  const text = raw.replace(/```+[ \t]*\w*/g, "").replace(/```+/g, "").trim();
  const lines = text.split(/\r?\n/);
  const synopsisParts: string[] = [];
  const places: AskPlace[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(PLACE_LINE);
    if (m) {
      const label = m[1].trim();
      const iso2 = m[2].trim().toLowerCase();
      const blurb = m[3].trim();
      if (label && blurb && places.length < 8) places.push({ label, iso2, blurb });
      continue;
    }
    // Non-place line: part of the synopsis (until/unless places have started).
    if (places.length === 0 && trimmed) synopsisParts.push(trimmed);
  }
  return { synopsis: synopsisParts.join(" ").trim(), places };
}

/**
 * Answer a free-text news query over all fetched news, streaming the synopsis to
 * `onDelta` as the model writes it. Returns the parsed result (mode + places +
 * grounding item ids). Returns an empty `answer` result when there's nothing to
 * search or the model gives nothing usable.
 */
export async function askNews(
  query: string,
  lang: Lang,
  onDelta: (delta: string) => void,
): Promise<AskResult> {
  const q = query.trim().slice(0, config.feed.maxInterestLen);
  const empty: AskResult = {
    query: q,
    mode: "answer",
    synopsis: "",
    places: [],
    itemIds: [],
    basedOn: 0,
  };
  if (!q) return empty;

  const ranked = await retrieve(q);
  if (ranked.length === 0) return empty;

  const now = Date.now();
  const payload = {
    question: q,
    items: ranked.map((s) => ({
      title: s.item.title,
      summary: (s.summary || s.item.summary || "").slice(0, 220),
      source: s.item.sourceTitle,
      topic: s.topic,
      age: relativeAge(s.item.publishedAt, now),
    })),
  };

  const full = await chatRaw(ASK_RULES + langDirective(lang), payload, {
    maxTokens: 700,
    onDelta,
  });
  const { synopsis, places } = parseAsk(full);
  return {
    query: q,
    mode: places.length > 0 ? "map" : "answer",
    synopsis,
    places,
    itemIds: ranked.map((s) => s.item.id),
    basedOn: ranked.length,
  };
}
