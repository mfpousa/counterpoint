// Grade a reader's RECALL SUMMARY of an article against the article itself, and
// return teaching feedback. The reference text is the AI-rewritten article (which
// is already cached server-side, so re-grading is cheap); if that's unavailable
// we fall back to the analyzed summary + keywords. The goal is not to nitpick but
// to confirm the reader genuinely understood the piece — and to TEACH when they
// didn't.

import type { Lang, SummaryGrade } from "../src/types";
import { aiReachable, chatJsonObject, type JsonSchema } from "./ai";
import { config } from "./config";
import { langDirective } from "./lang";
import { rewriteArticle } from "./rewrite";
import type { StoredItem } from "./store";

const GRADE_SCHEMA: JsonSchema = {
  name: "grade",
  schema: {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      verdict: { type: "string" },
      correct: { type: "array", items: { type: "string" } },
      missed: { type: "array", items: { type: "string" } },
      inaccuracies: { type: "array", items: { type: "string" } },
      lesson: { type: "string" },
    },
    required: ["score", "verdict", "correct", "missed", "inaccuracies", "lesson"],
    additionalProperties: false,
  },
};

const GRADE_RULES =
  "You are a patient teacher checking whether a reader actually understood a news " +
  "article from their own recall summary. You are given the ARTICLE (reference) and " +
  "the reader's SUMMARY. Grade how accurately and completely the summary captures " +
  "the article's KEY POINTS. Rules:\n" +
  "- Judge substance, not wording or length. A short summary that nails the main " +
  "points scores high. Reward correct understanding of the central facts.\n" +
  "- score (0-100): overall accuracy + coverage of the key points. ~70+ means the " +
  "reader genuinely got the gist; below that they missed or misunderstood the core.\n" +
  "- correct: specific key points the reader got right (paraphrase briefly).\n" +
  "- missed: important points from the article the reader left out.\n" +
  "- inaccuracies: claims in the summary that are wrong or misleading vs the article. " +
  "Empty if none.\n" +
  "- lesson: 1-2 sentences that teach/correct the reader so they learn what they " +
  "got wrong or missed. If they did well, reinforce the single most important point.\n" +
  "- Use ONLY the article as ground truth. Do not invent facts not present.\n" +
  "Output ONLY the JSON object. No markdown, no prose outside the JSON.";

/** Build the reference text the summary is graded against. */
async function referenceText(
  stored: StoredItem,
  lang: Lang,
): Promise<{ title: string; body: string } | null> {
  const article = await rewriteArticle(stored, lang);
  if (article && article.paragraphs.length > 0) {
    return {
      title: article.title || stored.item.title,
      body: article.paragraphs.join("\n\n").slice(0, config.reader.maxChars),
    };
  }
  // Fallback: the analyzed one-liner + keywords (thin, but better than nothing).
  const body = [stored.summary, stored.keywords.join(", ")].filter(Boolean).join(". ").trim();
  if (body.length >= 40) return { title: stored.item.title, body };
  return null;
}

function clampScore(n: unknown): number {
  const v = typeof n === "number" ? n : 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
}

/**
 * Grade a reader's recall summary of an item. Returns null when the model is
 * unreachable or there's no reference text to grade against (so the caller can
 * surface a clear error instead of a bogus score).
 */
export async function gradeSummary(
  stored: StoredItem,
  userSummary: string,
  lang: Lang = "en",
): Promise<SummaryGrade | null> {
  const summary = userSummary.trim();
  if (summary.length < 10) return null;
  if (!(await aiReachable())) return null;

  const ref = await referenceText(stored, lang);
  if (!ref) return null;

  const payload = {
    article: { title: ref.title, body: ref.body },
    readerSummary: summary,
  };
  const obj = await chatJsonObject(GRADE_RULES + langDirective(lang), payload, {
    maxTokens: 700,
    schema: GRADE_SCHEMA,
  });
  if (!obj) return null;

  return {
    score: clampScore(obj["score"]),
    verdict: typeof obj["verdict"] === "string" ? obj["verdict"].trim() : "",
    correct: strArray(obj["correct"]),
    missed: strArray(obj["missed"]),
    inaccuracies: strArray(obj["inaccuracies"]),
    lesson: typeof obj["lesson"] === "string" ? obj["lesson"].trim() : "",
  };
}
