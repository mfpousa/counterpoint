// The AI layer of the (hybrid) knowledge profile. The CLIENT computes the hard
// numbers locally (per-topic mastery, recurring weak concepts) from its graded
// summaries; here the model just (a) writes a short, encouraging narrative about
// where the reader is strong vs has gaps, and (b) picks which candidate articles
// best fill those gaps and WHY. Candidates are pre-shortlisted by the client, so
// this is a single cheap call.

import type { KnowledgeInsight, KnowledgeProfile } from "../src/types";
import { aiReachable, chatJsonObject, type JsonSchema } from "./ai";

export interface KnowledgeCandidate {
  id: string;
  title: string;
  topic: string;
  summary: string;
}

const INSIGHT_SCHEMA: JsonSchema = {
  name: "knowledge",
  schema: {
    type: "object",
    properties: {
      narrative: { type: "string" },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
          },
          required: ["id", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["narrative", "suggestions"],
    additionalProperties: false,
  },
};

const INSIGHT_RULES =
  "You are a learning coach. You are given a reader's KNOWLEDGE PROFILE (how well " +
  "they recall news they've read, by topic, plus concepts they repeatedly miss) and " +
  "a list of CANDIDATE articles that could fill their gaps. Produce:\n" +
  "- narrative: 2-3 short sentences, encouraging and concrete, describing where the " +
  "reader is strong and where their gaps are. Speak to the reader as 'you'.\n" +
  "- suggestions: choose the candidates (by their exact id) that best address the " +
  "reader's WEAK topics or missed concepts. For each, give a one-sentence reason that " +
  "ties it to a specific gap. Pick at most 6, best first. Only use ids from the " +
  "candidate list; never invent ids. If no candidates fit, return an empty array.\n" +
  "Output ONLY the JSON object. No markdown, no prose outside the JSON.";

/**
 * Produce the AI narrative + gap-filling suggestion reasons. Returns null when
 * the model is unreachable (the UI then shows the local stats alone).
 */
export async function generateKnowledgeInsight(
  profile: KnowledgeProfile,
  candidates: KnowledgeCandidate[],
): Promise<KnowledgeInsight | null> {
  if (profile.totalGraded === 0) return null;
  if (!(await aiReachable())) return null;

  const payload = { profile, candidates };
  const obj = await chatJsonObject(INSIGHT_RULES, payload, {
    maxTokens: 800,
    schema: INSIGHT_SCHEMA,
  });
  if (!obj) return null;

  const validIds = new Set(candidates.map((c) => c.id));
  const suggestions = Array.isArray(obj["suggestions"])
    ? (obj["suggestions"] as unknown[])
        .map((s) => s as { id?: unknown; reason?: unknown })
        .filter((s) => typeof s.id === "string" && validIds.has(s.id))
        .map((s) => ({ id: s.id as string, reason: typeof s.reason === "string" ? s.reason.trim() : "" }))
        .slice(0, 6)
    : [];

  return {
    narrative: typeof obj["narrative"] === "string" ? obj["narrative"].trim() : "",
    suggestions,
  };
}
