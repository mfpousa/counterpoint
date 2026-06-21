// Synthesizes a short "what's happening & where it's headed" briefing from the
// top of the analyzed pool, steered by the reader's interest. One LLM call;
// degrades gracefully (returns null) if the model is unreachable or replies
// with nothing usable.

import type { Briefing, BriefingThread, FeedItem, Lang } from "../src/types";
import { chatJsonObject, type JsonSchema } from "./ai";
import { config } from "./config";
import { langDirective } from "./lang";

// Constrained-decoding schema so the local model emits a valid, complete briefing
// object and STOPS — without this, a non-stopping model rambles/truncates and the
// reply fails to parse (no briefing).
const BRIEFING_SCHEMA: JsonSchema = {
  name: "briefing",
  schema: {
    type: "object",
    properties: {
      mood: { type: "string" },
      threads: {
        type: "array",
        items: {
          type: "object",
          properties: { title: { type: "string" }, detail: { type: "string" } },
          required: ["title", "detail"],
          additionalProperties: false,
        },
      },
      outlook: { type: "string" },
    },
    required: ["mood", "threads", "outlook"],
    additionalProperties: false,
  },
};

const BASE_RULES =
  "You are a sharp, neutral news editor writing a brief daily digest for a reader. " +
  "Using ONLY the provided recent items (title + one-line summary + topic + age), " +
  "synthesize what is happening now and the recent trajectory — the overall 'vibe' " +
  "and where things appear to be headed. Be specific and grounded in the items; do " +
  "NOT invent facts or name events not present. Stay calm and analytical, not " +
  "sensational. Output ONLY a JSON object with this exact shape:\n" +
  '{\n  "mood": "ONE sentence (<= 30 words) capturing the overall vibe/direction right now",\n' +
  '  "threads": [ { "title": "<= 6 word storyline label", "detail": "ONE sentence (<= 28 words) on what is happening and why it matters" } ],\n' +
  '  "outlook": "ONE sentence (<= 30 words) on where things appear to be headed next"\n}\n' +
  "Provide 3 to 5 threads, ordered by significance. No prose outside the JSON.";

function steer(interest: string): string {
  return interest
    ? `\n\nThe reader cares specifically about: "${interest}". Center the mood, threads, ` +
        "and outlook on developments relevant to these interests; you may include one " +
        "broader item for essential context, but keep the focus tight."
    : "\n\nNo specific reader interests — give a balanced general digest across the items.";
}

function relativeAge(publishedAt: number, now: number): string {
  const h = Math.max(0, Math.round((now - publishedAt) / 3_600_000));
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function coerceThreads(raw: unknown): BriefingThread[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefingThread[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const title = typeof r["title"] === "string" ? r["title"].trim() : "";
    const detail = typeof r["detail"] === "string" ? r["detail"].trim() : "";
    if (title || detail) out.push({ title, detail });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Generate a briefing from already-ranked items (best first). Returns null if
 * there's nothing to summarize or the model gives no usable answer.
 */
export async function generateBriefing(
  interest: string,
  items: FeedItem[],
  lang: Lang = "en",
): Promise<Briefing | null> {
  if (items.length === 0) return null;

  const now = Date.now();
  const payload = items.slice(0, 40).map((it) => ({
    title: it.title,
    summary: (it.aiReason ?? it.summary ?? "").slice(0, 220),
    topic: it.topic,
    age: relativeAge(it.publishedAt, now),
  }));

  const obj = await chatJsonObject(BASE_RULES + steer(interest) + langDirective(lang), payload, {
    maxTokens: 900,
    schema: BRIEFING_SCHEMA,
  });
  if (!obj) return null;

  const mood = typeof obj["mood"] === "string" ? obj["mood"].trim() : "";
  const outlook = typeof obj["outlook"] === "string" ? obj["outlook"].trim() : "";
  const threads = coerceThreads(obj["threads"]);
  if (!mood && threads.length === 0 && !outlook) return null;

  return {
    generatedAt: now,
    interest: interest.slice(0, config.feed.maxInterestLen),
    mood,
    threads,
    outlook,
    basedOn: payload.length,
  };
}
