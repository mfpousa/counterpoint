// Free-text news search over the WHOLE fetched database ("ask"). The reader types
// something like "fires" or "Donald Trump" and the SAME model both ANSWERS and
// decides HOW to show it: when the matter has a geographic spread it lists located
// places (the globe drops markers — mode "map"); otherwise it's just a synopsis
// (mode "answer"). The synopsis streams token-by-token while it generates.
//
// Retrieval is AGENTIC and two-phase, so it works whether or not embeddings have
// warmed up (closing the cold/warm gap):
//   1. SELECT — build a compact INDEX of available headlines (cheap & cold-safe:
//      lexical overlap + recency, enriched by embedding similarity when present)
//      and let the model PICK, by number, the items it actually wants to read.
//   2. ANSWER — gather the FULL content of just those picks and feed them to the
//      streamed synopsis+places generation.
// Everything degrades gracefully: no corpus → empty result; planner unavailable or
// unhelpful → we fall back to the cheap top of the candidate index.

import type { AskPlace, AskResult, Lang } from "../src/types";
import { chatJsonObject, chatRaw, type JsonSchema } from "./ai";
import { config } from "./config";
import { cosineSim, embedQuery } from "./embeddings";
import { langDirective } from "./lang";
import { storedAcrossPools, type StoredItem } from "./store";
import { tokenize } from "./personalize";

/** Cap the candidate set (most-recent first) before scoring, to bound cost on a
 *  process that has fetched a lot of pools. */
const MAX_CANDIDATES = 6000;
/** How many headlines go in the index the model picks from. The planner sees TITLES
 *  only, so this can be generous (good recall) without blowing the context. */
const INDEX_MAX = 150;
/** Most items the planner is allowed to request. */
const SELECT_MAX = 40;
/** Most full items we feed the ANSWER call (the planner's picks, capped). */
const ANSWER_MAX = 30;

const ASK_RULES =
  "You are a sharp, neutral news analyst answering a reader's question using ONLY the " +
  "provided recent news items (each: title, one-line summary, source, topic, age). Be " +
  "specific and grounded in the items; do NOT invent facts, places, or events that are " +
  "not present. If the items don't actually support an answer, say so in one sentence.\n" +
  "Write PLAIN TEXT (no JSON) in EXACTLY this structure:\n" +
  "1) A SYNOPSIS of 1-3 sentences that answers the question from the items.\n" +
  "2) THEN, whenever the answer involves things happening in specific PLACES (conflicts, " +
  "disasters, protests, elections, outbreaks, attacks, etc.), a blank line, then ONE line " +
  "per place, each formatted EXACTLY like these examples:\n" +
  "- Ukraine (UA): Russia's full-scale invasion grinds on along the eastern front.\n" +
  "- Gaza (PS): Israeli operations and a fragile truce dominate the coverage.\n" +
  "- Sudan (SD): The army–RSF war drives the world's largest displacement crisis.\n" +
  "Place-line rules: start with '- ', then the place NAME, then its ISO 3166-1 alpha-2 " +
  "COUNTRY code in parentheses (TWO letters, e.g. (US), (FR), (CN), (IL)), then ': ', then " +
  "ONE sentence on what's happening THERE. ALWAYS include the two-letter code. List up to " +
  "8 places, most significant first. Use a country code even for a sub-national place " +
  "(e.g. a city's country). Only omit the place lines when the topic has NO geographic " +
  "dimension at all (a pure concept or a single person).\n" +
  "Output nothing else — no preamble, no headings, no closing remarks.";

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

// --- Phase 1: SELECT (the model picks from a headline index) ----------------

const SELECT_SCHEMA: JsonSchema = {
  name: "selection",
  schema: {
    type: "object",
    properties: { ids: { type: "array", items: { type: "integer" } } },
    required: ["ids"],
    additionalProperties: false,
  },
};

const SELECT_RULES =
  "You are a news researcher. Below is a NUMBERED index of available recent news " +
  "headlines (title, topic, age). The reader asks a question. Pick the headlines whose " +
  "articles would actually help answer it: be inclusive of EVERY clearly relevant item " +
  "(covering all the places / sides / angles involved) but leave out unrelated ones. " +
  'Respond with ONLY a JSON object {"ids": [...]} listing the chosen numbers, most ' +
  "relevant first, at most " +
  SELECT_MAX +
  '. If nothing is relevant, return {"ids": []}.';

/** Build the candidate index: a cheap, COLD-SAFE recall pool (lexical overlap +
 *  recency) enriched by embedding similarity when vectors are present, deduped and
 *  capped to INDEX_MAX. These are the headlines the model gets to choose from. */
async function buildCandidates(q: string): Promise<StoredItem[]> {
  const items = corpus();
  if (items.length === 0) return [];
  const lex = lexicalRank(items, q); // best lexical first (cold-safe; may be empty)
  const qv = await embedQuery(q); // null when embeddings are cold/disabled
  const sem = qv
    ? items
        .filter((s) => s.embedding && s.embedding.length > 0)
        .map((s) => ({ s, score: cosineSim(qv, s.embedding as number[]) }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s)
    : [];
  // Interleave lexical + semantic for breadth, then top up with most-recent items.
  const merged: StoredItem[] = [];
  const seen = new Set<string>();
  const add = (s?: StoredItem) => {
    if (s && !seen.has(s.item.id)) {
      seen.add(s.item.id);
      merged.push(s);
    }
  };
  const pairs = Math.max(lex.length, sem.length);
  for (let i = 0; i < pairs && merged.length < INDEX_MAX; i++) {
    add(lex[i]);
    add(sem[i]);
  }
  for (let i = 0; i < items.length && merged.length < INDEX_MAX; i++) add(items[i]);
  return merged.slice(0, INDEX_MAX);
}

/** Validate the planner's chosen numbers against the index: keep in-range, unique,
 *  ordered as given, capped at `max`. Pure + unit-tested. */
export function pickIds(raw: unknown, count: number, max: number): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const r of arr) {
    const n = typeof r === "number" ? r : parseInt(String(r), 10);
    if (!Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/** Phase 1: show the model the headline index and let it choose the items it wants.
 *  Falls back to the cheap top of the index if the planner is unavailable/unhelpful. */
async function selectRelevant(q: string, candidates: StoredItem[]): Promise<StoredItem[]> {
  if (candidates.length === 0) return [];
  const now = Date.now();
  const index = candidates
    .map(
      (s, i) =>
        `${i + 1}. ${s.item.title.slice(0, 120)} (${s.topic}, ${relativeAge(s.item.publishedAt, now)})`,
    )
    .join("\n");
  const obj = await chatJsonObject(
    SELECT_RULES,
    { question: q, index },
    { maxTokens: 300, schema: SELECT_SCHEMA },
  );
  const picked = pickIds(obj?.["ids"], candidates.length, ANSWER_MAX).map((n) => candidates[n - 1]);
  // Planner gave nothing usable → fall back to the cheap top of the index so the
  // reader still gets an answer (the ANSWER call itself says so if it's irrelevant).
  return picked.length > 0 ? picked : candidates.slice(0, ANSWER_MAX);
}

// A list item: bullet (-, *, •) OR number ("1.", "2)"), capturing the rest. Models
// answer "list the X" with either style, so we accept both.
const LIST_LINE = /^(?:[-*•]|\d+[.)])\s+(.+)$/;
// A 2-letter ISO code anywhere in the line, in parens or brackets: (UA) or [UA].
const CODE = /[([]([A-Za-z]{2})[)\]]/;

/** Strip light markdown (bold/italic/inline-code) without touching content. */
function stripMd(s: string): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .trim();
}

/**
 * Parse the streamed plain-prose answer back into a synopsis + located places.
 *
 * Tolerant by design: a "place" is any LIST item (bulleted OR numbered, with or
 * without markdown). Its ISO code is taken from a (XX)/[XX] token if present (else
 * left blank for the client to resolve by name); the label is the text before the
 * first ":" / " - " separator and the blurb is the rest. Everything before the first
 * list item (minus blanks) is the synopsis. Forgiving of stray markdown fences.
 */
export function parseAsk(raw: string): { synopsis: string; places: AskPlace[] } {
  const text = raw.replace(/```+[ \t]*\w*/g, "").replace(/```+/g, "").trim();
  const synopsisParts: string[] = [];
  const places: AskPlace[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripMd(rawLine.trim());
    if (!line) continue;
    const lm = line.match(LIST_LINE);
    if (lm && places.length < 8) {
      const content = lm[1].trim();
      const cm = content.match(CODE);
      const iso2 = cm ? cm[1].toLowerCase() : "";
      // Drop the code token so it doesn't pollute the label.
      const noCode = cm
        ? (content.slice(0, cm.index) + content.slice((cm.index ?? 0) + cm[0].length)).trim()
        : content;
      // Split label : blurb on the first ":" (preferred) or a spaced dash.
      let sep = noCode.indexOf(":");
      if (sep < 0) sep = noCode.search(/\s[–—-]\s/);
      const label = (sep >= 0 ? noCode.slice(0, sep) : noCode).replace(/[\s:–—-]+$/, "").trim();
      const blurb = (sep >= 0 ? noCode.slice(sep + 1) : "").replace(/^[–—:\-\s]+/, "").trim();
      if (label) places.push({ label, iso2, blurb });
      continue;
    }
    // Non-list line: part of the synopsis (until/unless list items have started).
    if (places.length === 0) synopsisParts.push(line);
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

  // Phase 1 — SELECT: build the headline index and let the model pick what it wants.
  const candidates = await buildCandidates(q);
  if (candidates.length === 0) return empty;
  const selected = await selectRelevant(q, candidates);
  if (selected.length === 0) return empty;

  // Phase 2 — ANSWER: feed the FULL content of just the picks to the streamed answer.
  const now = Date.now();
  const payload = {
    question: q,
    items: selected.map((s) => ({
      title: s.item.title,
      summary: (s.summary || s.item.summary || "").slice(0, 280),
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
    itemIds: selected.map((s) => s.item.id),
    basedOn: selected.length,
  };
}
