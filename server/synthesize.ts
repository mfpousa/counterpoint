// Turns a cluster of same-event articles into ONE neutral synthesized story.
//
// The model is given each outlet's headline + one-line summary + lean, and asked
// to (a) write a neutral synthesis, (b) describe how each outlet FRAMED the story
// differently, and (c) flag contradictions across outlets. Built defensively:
// constrained JSON schema, the degeneracy sanitizer, and a graceful fallback that
// stitches the source summaries together when the model is offline or unusable.

import type { Lean, Story, StoryAngle, StorySource, Topic } from "../src/types";
import { chatJsonObject, type JsonSchema } from "./ai";
import { sanitizeModelText } from "./analysis";
import { config } from "./config";
import type { StoredItem } from "./store";

const SYNTH_SCHEMA: JsonSchema = {
  name: "story_synthesis",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      synthesis: { type: "array", items: { type: "string" } },
      angles: {
        type: "array",
        items: {
          type: "object",
          properties: { outlet: { type: "string" }, framing: { type: "string" } },
          required: ["outlet", "framing"],
          additionalProperties: false,
        },
      },
      contradictions: { type: "array", items: { type: "string" } },
    },
    required: ["title", "summary", "synthesis", "angles", "contradictions"],
    additionalProperties: false,
  },
};

const SYNTH_RULES =
  "You are a neutral wire-service editor. You are given several outlets' coverage of the " +
  "SAME news event — each with the outlet name, its political lean, a headline, and a one-line " +
  "summary. Produce a single, even-handed synthesis. Use ONLY the facts present in the provided " +
  "reports; do NOT invent details, numbers, names, or quotes. Output ONLY a JSON object:\n" +
  '{\n' +
  '  "title": "neutral headline (<= 14 words)",\n' +
  '  "summary": "ONE neutral sentence (<= 30 words) capturing the event",\n' +
  '  "synthesis": ["3 to 5 short neutral paragraphs combining what the outlets agree on and report"],\n' +
  '  "angles": [ { "outlet": "<exact outlet name>", "framing": "ONE sentence on how THIS outlet framed/emphasized it" } ],\n' +
  '  "contradictions": ["specific points where the outlets disagree or report differently; [] if none are evident"]\n' +
  "}\n" +
  "Base 'angles' and 'contradictions' only on differences evident across the provided reports. " +
  "If the reports are consistent, return an empty contradictions array. No prose outside the JSON.";

/** Short human label for a lean value, for the model payload. */
function leanLabel(lean: Lean): string {
  if (lean === null || Number.isNaN(lean as number)) return "non-political";
  const v = lean as number;
  if (v <= -0.6) return "left";
  if (v < -0.15) return "center-left";
  if (v <= 0.15) return "center";
  if (v < 0.6) return "center-right";
  return "right";
}

/** Stable id for a story from its contributing article ids (order-independent). */
export function storyId(memberIds: string[]): string {
  const key = memberIds.slice().sort().join("|");
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return `story_${h.toString(16)}`;
}

/** Majority topic among members (ties broken by first occurrence). */
function majorityTopic(members: StoredItem[]): Topic {
  const counts = new Map<Topic, number>();
  for (const m of members) counts.set(m.topic, (counts.get(m.topic) ?? 0) + 1);
  let best = members[0].topic;
  let bestN = -1;
  for (const [t, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best;
}

/** Importance-weighted mean lean over political members; null when none. */
function aggregateLean(members: StoredItem[]): Lean {
  let wsum = 0;
  let lsum = 0;
  for (const m of members) {
    if (m.lean === null) continue;
    const w = Math.max(0.1, m.importance);
    wsum += w;
    lsum += w * m.lean;
  }
  if (wsum === 0) return null;
  return Math.max(-1, Math.min(1, lsum / wsum));
}

function toSources(members: StoredItem[]): StorySource[] {
  return members
    .slice()
    .sort((a, b) => b.item.publishedAt - a.item.publishedAt)
    .map((m) => ({
      id: m.item.id,
      title: m.item.title,
      sourceTitle: m.item.sourceTitle,
      url: m.item.url,
      lean: m.lean,
      leanSource: m.leanSource ?? "source",
      publishedAt: m.item.publishedAt,
    }));
}

function coerceStringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const s = sanitizeModelText(v);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Resolve an outlet name the model returned back to a member's lean. */
function leanForOutlet(outlet: string, members: StoredItem[]): Lean {
  const want = outlet.trim().toLowerCase();
  const hit = members.find((m) => m.item.sourceTitle.toLowerCase() === want);
  if (hit) return hit.lean;
  // Loose contains-match (model may abbreviate "The Guardian — World" -> "The Guardian").
  const loose = members.find(
    (m) =>
      m.item.sourceTitle.toLowerCase().includes(want) ||
      want.includes(m.item.sourceTitle.toLowerCase()),
  );
  return loose ? loose.lean : null;
}

function coerceAngles(raw: unknown, members: StoredItem[], max: number): StoryAngle[] {
  if (!Array.isArray(raw)) return [];
  const out: StoryAngle[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const outlet = sanitizeModelText(r["outlet"]);
    const framing = sanitizeModelText(r["framing"]);
    if (!outlet || !framing) continue;
    out.push({ outlet, lean: leanForOutlet(outlet, members), framing });
    if (out.length >= max) break;
  }
  return out;
}

/** A degraded story stitched from source summaries (model offline/unusable). */
function fallbackStory(members: StoredItem[]): Story {
  const sources = toSources(members);
  const byImportance = members.slice().sort((a, b) => b.importance - a.importance);
  const paragraphs: string[] = [];
  const seen = new Set<string>();
  for (const m of byImportance) {
    const s = sanitizeModelText(m.summary);
    if (s && !seen.has(s)) {
      seen.add(s);
      paragraphs.push(`${m.item.sourceTitle}: ${s}`);
    }
  }
  return {
    id: storyId(members.map((m) => m.item.id)),
    title: byImportance[0].item.title,
    summary: sanitizeModelText(byImportance[0].summary) || byImportance[0].item.title,
    synthesis: paragraphs.length > 0 ? paragraphs : [byImportance[0].item.title],
    topic: majorityTopic(members),
    lean: aggregateLean(members),
    sources,
    angles: [],
    contradictions: [],
    relatedIds: [],
    updatedAt: Math.max(...members.map((m) => m.item.publishedAt)),
    generatedAt: Date.now(),
    degraded: true,
  };
}

/**
 * Synthesize ONE story from a cluster of same-event articles. Never throws:
 * returns a degraded (summary-stitched) story if the model is unreachable or
 * replies with nothing usable. `relatedIds` is filled in later by the service.
 */
export async function buildStory(members: StoredItem[]): Promise<Story> {
  if (members.length === 0) throw new Error("buildStory: empty cluster");

  // Feed the most newsworthy outlets (capped), preferring lean diversity by
  // interleaving distinct leans so the comparison spans the spectrum.
  const ranked = members.slice().sort((a, b) => b.importance - a.importance);
  const chosen = ranked.slice(0, config.stories.maxClusterSources);
  const payload = chosen.map((m) => ({
    outlet: m.item.sourceTitle,
    lean: leanLabel(m.lean),
    title: m.item.title,
    summary: (m.summary || m.item.summary || "").slice(0, 300),
  }));

  const obj = await chatJsonObject(SYNTH_RULES, payload, {
    maxTokens: config.stories.maxTokens,
    schema: SYNTH_SCHEMA,
  });
  if (!obj) return fallbackStory(members);

  const title = sanitizeModelText(obj["title"]);
  const summary = sanitizeModelText(obj["summary"]);
  const synthesis = coerceStringArray(obj["synthesis"], 8);
  const angles = coerceAngles(obj["angles"], members, config.stories.maxClusterSources);
  const contradictions = coerceStringArray(obj["contradictions"], 6);

  // Nothing usable came back — fall back rather than ship an empty story.
  if (!title && synthesis.length === 0) return fallbackStory(members);

  const byImportance = members.slice().sort((a, b) => b.importance - a.importance);
  return {
    id: storyId(members.map((m) => m.item.id)),
    title: title || byImportance[0].item.title,
    summary: summary || sanitizeModelText(byImportance[0].summary) || byImportance[0].item.title,
    synthesis: synthesis.length > 0 ? synthesis : [byImportance[0].item.title],
    topic: majorityTopic(members),
    lean: aggregateLean(members),
    sources: toSources(members),
    angles,
    contradictions,
    relatedIds: [],
    updatedAt: Math.max(...members.map((m) => m.item.publishedAt)),
    generatedAt: Date.now(),
  };
}
