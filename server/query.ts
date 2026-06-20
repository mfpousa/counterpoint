// Search-query understanding. A reader's free-text search ("AI but not crypto",
// "not israel or iran") is turned into a structured filter:
//   - positive: a clean phrase describing what they WANT (embedded for semantic
//     matching). Empty when the query is purely exclusionary.
//   - exclude:  topics/entities they do NOT want (hard-filtered out of the feed).
//
// Negation is the key reason this exists: embeddings CANNOT express "not X" — the
// vector for "not israel" sits right next to "israel" — so we must strip excluded
// terms out and filter on them explicitly.
//
// Primary path is the local LLM (handles paraphrase/synonyms/intent); if it's
// unreachable we fall back to a small deterministic negation parser so the common
// "X but not Y" / "not Y" cases still work offline.

import { aiReachable, chatJsonObject, type JsonSchema } from "./ai";
import { config } from "./config";

export interface ParsedQuery {
  /** What the reader wants, for semantic/keyword matching. May be empty. */
  positive: string;
  /** Lowercased topics/entities to exclude from the feed. */
  exclude: string[];
}

const QUERY_SCHEMA: JsonSchema = {
  name: "query",
  schema: {
    type: "object",
    properties: {
      positive: { type: "string" },
      exclude: { type: "array", items: { type: "string" } },
    },
    required: ["positive", "exclude"],
    additionalProperties: false,
  },
};

const QUERY_RULES =
  "You convert a user's free-text NEWS search into a structured filter. Return a " +
  "JSON object with two fields:\n" +
  '- "positive": a short phrase describing the topics the user WANTS, for ' +
  "semantic matching. Expand obvious intent (e.g. 'AI' -> 'artificial " +
  "intelligence'). If the user ONLY expresses what to avoid, use an empty string.\n" +
  '- "exclude": an array of topics/entities the user does NOT want. Lowercase. ' +
  "Include sensible variants (e.g. 'crypto' -> ['crypto','cryptocurrency','bitcoin']). " +
  "Handle negation cues: not, no, without, except, excluding, minus, leading '-'.\n" +
  "Examples:\n" +
  '"not israel or iran" -> {"positive":"","exclude":["israel","iran"]}\n' +
  '"AI but not crypto" -> {"positive":"artificial intelligence","exclude":["crypto","cryptocurrency","bitcoin"]}\n' +
  '"climate science" -> {"positive":"climate science","exclude":[]}\n' +
  '"world news without sports or celebrity gossip" -> {"positive":"world news","exclude":["sports","celebrity","gossip"]}\n' +
  "Output ONLY the JSON object. No prose, no markdown.";

const NEGATION_CUES = /\b(?:not|no|without|except|excluding|minus|sans|avoid)\b/i;

/** Deterministic fallback parser (used when the model is unavailable). Splits a
 *  query at the first negation cue: text before is positive, text after is a
 *  list of excluded terms. Also handles leading "-term" tokens. */
export function parseNegation(raw: string): ParsedQuery {
  const exclude = new Set<string>();

  // "-term"? Only single tokens for the dash form.
  const work = raw.replace(/(^|\s)-([a-z0-9][\w'-]*)/gi, (_m, _pre, term: string) => {
    exclude.add(term.toLowerCase());
    return " ";
  });

  let positive = work;
  const cue = work.match(NEGATION_CUES);
  if (cue && typeof cue.index === "number") {
    positive = work.slice(0, cue.index);
    const tail = work.slice(cue.index + cue[0].length);
    for (const term of splitList(tail)) exclude.add(term);
  }

  return { positive: positive.trim(), exclude: [...exclude] };
}

/** Split a negation tail ("israel or iran, syria and lebanon") into clean terms. */
function splitList(tail: string): string[] {
  return tail
    .split(/\s*(?:,|\bor\b|\band\b|\/|;)\s*/i)
    .map((t) => t.replace(/[^\w'\- ]+/g, " ").trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

function sanitize(p: ParsedQuery): ParsedQuery {
  const exclude = [...new Set(p.exclude.map((e) => e.trim().toLowerCase()).filter((e) => e.length >= 2))];
  return { positive: p.positive.trim(), exclude };
}

// Per-process cache (interest -> parse). Interests repeat across requests, and
// the LLM call is the expensive part of each search.
const cache = new Map<string, ParsedQuery>();

/**
 * Interpret a reader's search into { positive, exclude }. Uses the LLM when
 * available (and structured output is enabled), else a deterministic fallback.
 * Always resolves — never throws — so search never breaks.
 */
export async function interpretQuery(interest: string): Promise<ParsedQuery> {
  const key = interest.trim().toLowerCase();
  if (!key) return { positive: "", exclude: [] };
  const hit = cache.get(key);
  if (hit) return hit;

  // No negation cue and no dash -> nothing to interpret; positive is the query.
  const mightNegate = NEGATION_CUES.test(key) || /(^|\s)-[a-z0-9]/i.test(key);

  let parsed: ParsedQuery | null = null;
  if (mightNegate && config.ai.structuredOutput && (await aiReachable())) {
    const obj = await chatJsonObject(QUERY_RULES, interest, { maxTokens: 200, schema: QUERY_SCHEMA });
    if (obj) {
      const positive = typeof obj["positive"] === "string" ? obj["positive"] : "";
      const exclude = Array.isArray(obj["exclude"])
        ? (obj["exclude"] as unknown[]).filter((e): e is string => typeof e === "string")
        : [];
      parsed = sanitize({ positive, exclude });
    }
  }

  if (!parsed) parsed = mightNegate ? sanitize(parseNegation(interest)) : { positive: interest.trim(), exclude: [] };
  if (parsed.exclude.length > 0) {
    console.log(`[query] "${interest}" -> positive="${parsed.positive}" exclude=[${parsed.exclude.join(", ")}]`);
  }
  cache.set(key, parsed);
  return parsed;
}
