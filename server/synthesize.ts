// Turns a cluster of same-event articles into ONE neutral synthesized story.
//
// The model is given each outlet's headline + one-line summary + lean, and asked
// to (a) write a neutral synthesis, (b) describe how each outlet FRAMED the story
// differently, and (c) flag contradictions across outlets. Built defensively:
// constrained JSON schema, the degeneracy sanitizer, and a graceful fallback that
// stitches the source summaries together when the model is offline or unusable.

import type {
  Lang,
  Lean,
  LinkKind,
  Story,
  StoryAngle,
  StoryMilestone,
  StorySide,
  StorySource,
  StorySpectrum,
  Topic,
} from "../src/types";
import { chatJsonObject, type JsonSchema } from "./ai";
import { sanitizeModelText } from "./analysis";
import { config } from "./config";
import { langDirective } from "./lang";
import { decodeEntities } from "../src/lib/rss";
import { countryLabel } from "../src/lib/countries";
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
      sides: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            outlets: { type: "array", items: { type: "string" } },
            framing: { type: "string" },
          },
          required: ["label", "outlets", "framing"],
          additionalProperties: false,
        },
      },
      contradictions: { type: "array", items: { type: "string" } },
      protagonist: {
        type: "object",
        properties: { name: { type: "string" }, iso2: { type: "string" } },
        required: ["name", "iso2"],
        additionalProperties: false,
      },
      links: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            kind: {
              type: "string",
              enum: ["attack", "spread", "trade", "migration", "aid", "transport"],
            },
          },
          required: ["from", "to", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "summary", "synthesis", "angles", "sides", "contradictions", "protagonist", "links"],
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
  '  "sides": [ { "label": "<short side label, e.g. \'Western media\', \'Russian media\', \'Ukrainian media\'>", "outlets": ["<exact outlet names on this side>"], "framing": "1-2 sentences on how THIS side frames/emphasizes the story" } ],\n' +
  '  "contradictions": ["specific points where the outlets disagree or report differently; [] if none are evident"],\n' +
  '  "protagonist": { "name": "the central actor/subject the story is MOST about (a country, organisation, or person)", "iso2": "if that protagonist IS a country or a national government/actor, its ISO 3166-1 alpha-2 code in lowercase (e.g. us, es, ua); otherwise an empty string" },\n' +
  '  "links": [ { "from": "<ISO-2 ORIGIN>", "to": "<ISO-2 DESTINATION>", "kind": "attack|spread|trade|migration|aid|transport" } ]\n' +
  "}\n" +
  "For 'links', emit a DIRECTED connection ONLY when the story describes a PHYSICAL link or " +
  "movement between two DISTINCT countries, from an ORIGIN ('from') to a DESTINATION ('to'), both " +
  "ISO 3166-1 alpha-2 lowercase, each with a 'kind': 'attack' (military strike/invasion/cross-border " +
  "attack), 'spread' (disease/contagion), 'trade' (shipment/exports/energy/supply/pipeline), " +
  "'migration' (people/refugees/evacuation), 'aid' (humanitarian or military assistance), " +
  "'transport' (flight/route/travel). Only emit a link you can classify into ONE of these " +
  "SPECIFIC kinds; if the relationship doesn't clearly fit one, OMIT that link (do NOT guess or " +
  "use a generic kind). Return [] when the story is not about a place-to-place connection. " +
  "For 'protagonist', pick the single entity the story most centres on and name it; set 'iso2' ONLY " +
  "when that protagonist is a nation/national actor (use \"\" for organisations, people, or anything " +
  "non-national). Each outlet has a geographic/affiliation 'zone'. For 'sides', GROUP the outlets into the " +
  "opposing vantage points actually PRESENT (by zone) and describe how each side frames the story " +
  "\u2014 e.g. Western vs Ukrainian vs Russian media. Do NOT invent sides: use only zones present in " +
  "the reports, and return [] when all outlets share one vantage point. " +
  "Base 'angles', 'sides', and 'contradictions' only on differences evident across the provided " +
  "reports. If the reports are consistent, return an empty contradictions array. No prose outside the JSON.";

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

/**
 * 0..1 attention weight for a story: blends peak newsworthiness with how widely
 * it's covered (more outlets = bigger story), nudged up for developing issues.
 */
export function severityOf(members: StoredItem[], developing = false): number {
  const maxImp = members.reduce((m, s) => Math.max(m, s.importance), 0);
  const sources = new Set(members.map((s) => s.item.sourceId)).size;
  const breadth = Math.min(1, sources / 8);
  let sev = 0.6 * maxImp + 0.4 * breadth;
  if (developing) sev += 0.15;
  return Math.max(0, Math.min(1, sev));
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
      title: decodeEntities(m.item.title),
      sourceTitle: m.item.sourceTitle,
      url: m.item.url,
      lean: m.lean,
      leanSource: m.leanSource ?? "source",
      publishedAt: m.item.publishedAt,
      ...(m.item.zone ? { zone: m.item.zone } : {}),
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

/** Parse the model's `protagonist` ({ name, iso2 }) — the central actor and, when it's
 *  a nation, its ISO 3166-1 alpha-2 code (so the globe can fly its flag). Returns
 *  undefined when there's no usable name. */
function coerceProtagonist(raw: unknown): { name: string; iso2?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const name = sanitizeModelText(r["name"]);
  if (!name) return undefined;
  const code = typeof r["iso2"] === "string" ? r["iso2"].trim().toLowerCase() : "";
  const iso2 = /^[a-z]{2}$/.test(code) ? code : undefined;
  return iso2 ? { name, iso2 } : { name };
}

/**
 * Parse the model's place-to-place LINKS — directed physical connections between two
 * DISTINCT countries (a spread, route, shipment, migration, evacuation, aid, attack, …).
 * Validates ISO 3166-1 alpha-2 endpoints, drops self/degenerate + duplicate links, DROPS
 * links the model couldn't classify into a SPECIFIC kind (no generic catch-all), and caps
 * the count. The globe draws a flowing arc per link (origin → destination).
 */
const LINK_KINDS = new Set<LinkKind>([
  "attack",
  "spread",
  "trade",
  "migration",
  "aid",
  "transport",
]);

export function coerceLinks(
  raw: unknown,
  max = 4,
): { from: string; to: string; kind: LinkKind }[] {
  if (!Array.isArray(raw)) return [];
  const out: { from: string; to: string; kind: LinkKind }[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const from = typeof r["from"] === "string" ? r["from"].trim().toLowerCase() : "";
    const to = typeof r["to"] === "string" ? r["to"].trim().toLowerCase() : "";
    if (!/^[a-z]{2}$/.test(from) || !/^[a-z]{2}$/.test(to) || from === to) continue;
    // A link is only VALID when the model classified it into a SPECIFIC kind. A missing,
    // unknown, or catch-all kind means the relationship couldn't be determined → drop it
    // rather than draw a generic, meaningless connection.
    const k = typeof r["kind"] === "string" ? (r["kind"].trim().toLowerCase() as LinkKind) : null;
    if (!k || !LINK_KINDS.has(k)) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to, kind: k });
    if (out.length >= max) break;
  }
  return out;
}

/** Resolve an outlet name the model returned back to a contributing member. */
function findMember(outlet: string, members: StoredItem[]): StoredItem | undefined {
  const want = outlet.trim().toLowerCase();
  if (!want) return undefined;
  const exact = members.find((m) => m.item.sourceTitle.toLowerCase() === want);
  if (exact) return exact;
  // Loose contains-match (model may abbreviate "The Guardian — World" -> "The Guardian").
  return members.find(
    (m) =>
      m.item.sourceTitle.toLowerCase().includes(want) ||
      want.includes(m.item.sourceTitle.toLowerCase()),
  );
}

/** Resolve an outlet name the model returned back to a member's lean. */
function leanForOutlet(outlet: string, members: StoredItem[]): Lean {
  return findMember(outlet, members)?.lean ?? null;
}

/**
 * Parse the model's conflict SIDES, resolving each side's outlets back to the
 * contributing members and deriving the geographic zones present on that side.
 * Sides are only meaningful when the coverage actually spans opposing zones —
 * `finalizeSides` gates that.
 */
function coerceSides(raw: unknown, members: StoredItem[], max = 5): StorySide[] {
  if (!Array.isArray(raw)) return [];
  const out: StorySide[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const label = sanitizeModelText(r["label"]);
    const framing = sanitizeModelText(r["framing"]);
    if (!label || !framing) continue;
    const outletsRaw = Array.isArray(r["outlets"]) ? r["outlets"] : [];
    const outlets = new Set<string>();
    const zones = new Set<string>();
    for (const o of outletsRaw) {
      const name = sanitizeModelText(o);
      if (!name) continue;
      const m = findMember(name, members);
      if (m) {
        outlets.add(m.item.sourceTitle);
        zones.add(m.item.zone ?? "international");
      } else {
        outlets.add(name);
      }
    }
    if (outlets.size === 0) continue;
    out.push({ label, zones: [...zones], framing, outlets: [...outlets] });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Keep parsed sides only when there's a genuine cross-zone divide to show: at
 * least one contributing outlet is from a reactive foreign zone AND the model
 * resolved two or more distinct sides. Otherwise return undefined (no section).
 */
function finalizeSides(sides: StorySide[], members: StoredItem[]): StorySide[] | undefined {
  const hasForeignZone = members.some((m) => !!m.item.zone);
  if (!hasForeignZone || sides.length < 2) return undefined;
  return sides;
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

/**
 * Representative image for a story: the most newsworthy contributing article's
 * thumbnail, if any has one. Lets a story card present like an article.
 */
function pickThumbnail(members: StoredItem[]): string | undefined {
  const ranked = members.slice().sort((a, b) => b.importance - a.importance);
  for (const m of ranked) {
    const th = m.item.thumbnail;
    if (th && /^https?:\/\//i.test(th)) return th;
  }
  return undefined;
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
    title: decodeEntities(byImportance[0].item.title),
    summary: sanitizeModelText(byImportance[0].summary) || decodeEntities(byImportance[0].item.title),
    synthesis: paragraphs.length > 0 ? paragraphs : [byImportance[0].item.title],
    thumbnail: pickThumbnail(members),
    topic: majorityTopic(members),
    lean: aggregateLean(members),
    severity: severityOf(members),
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
export async function buildStory(members: StoredItem[], lang: Lang = "en"): Promise<Story> {
  if (members.length === 0) throw new Error("buildStory: empty cluster");

  // Feed the most newsworthy outlets (capped), preferring lean diversity by
  // interleaving distinct leans so the comparison spans the spectrum.
  const ranked = members.slice().sort((a, b) => b.importance - a.importance);
  const chosen = ranked.slice(0, config.stories.maxClusterSources);
  const payload = chosen.map((m) => ({
    outlet: m.item.sourceTitle,
    zone: countryLabel(m.item.zone),
    lean: leanLabel(m.lean),
    title: m.item.title,
    summary: (m.summary || m.item.summary || "").slice(0, 300),
  }));

  const obj = await chatJsonObject(SYNTH_RULES + langDirective(lang), payload, {
    maxTokens: config.stories.maxTokens,
    schema: SYNTH_SCHEMA,
  });
  if (!obj) return fallbackStory(members);

  const title = sanitizeModelText(obj["title"]);
  const summary = sanitizeModelText(obj["summary"]);
  const synthesis = coerceStringArray(obj["synthesis"], 8);
  const angles = coerceAngles(obj["angles"], members, config.stories.maxClusterSources);
  const sides = finalizeSides(coerceSides(obj["sides"], members), members);
  const contradictions = coerceStringArray(obj["contradictions"], 6);
  const links = coerceLinks(obj["links"]);

  // Nothing usable came back — fall back rather than ship an empty story.
  if (!title && synthesis.length === 0) return fallbackStory(members);

  const byImportance = members.slice().sort((a, b) => b.importance - a.importance);
  return {
    id: storyId(members.map((m) => m.item.id)),
    title: title || decodeEntities(byImportance[0].item.title),
    summary: summary || sanitizeModelText(byImportance[0].summary) || byImportance[0].item.title,
    synthesis: synthesis.length > 0 ? synthesis : [byImportance[0].item.title],
    topic: majorityTopic(members),
    lean: aggregateLean(members),
    thumbnail: pickThumbnail(members),
    severity: severityOf(members),
    sources: toSources(members),
    angles,
    ...(sides ? { sides } : {}),
    ...(links.length > 0 ? { links } : {}),
    contradictions,
    ...(coerceProtagonist(obj["protagonist"]) ? { protagonist: coerceProtagonist(obj["protagonist"]) } : {}),
    relatedIds: [],
    updatedAt: Math.max(...members.map((m) => m.item.publishedAt)),
    generatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Developing ISSUES: synthesize a broader ongoing storyline from several
// same-issue sub-events (each its own event cluster), producing a timeline and a
// left/center/right framing comparison.
// ---------------------------------------------------------------------------

const DEVELOPING_SCHEMA: JsonSchema = {
  name: "developing_issue",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      status: { type: "string", enum: ["developing", "resolved"] },
      synthesis: { type: "array", items: { type: "string" } },
      timeline: {
        type: "array",
        items: {
          type: "object",
          properties: {
            event: { type: "integer" },
            title: { type: "string" },
            detail: { type: "string" },
          },
          required: ["event", "title", "detail"],
          additionalProperties: false,
        },
      },
      spectrum: {
        type: "object",
        properties: {
          left: { type: "string" },
          center: { type: "string" },
          right: { type: "string" },
        },
        required: ["left", "center", "right"],
        additionalProperties: false,
      },
      sides: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            outlets: { type: "array", items: { type: "string" } },
            framing: { type: "string" },
          },
          required: ["label", "outlets", "framing"],
          additionalProperties: false,
        },
      },
      contradictions: { type: "array", items: { type: "string" } },
      protagonist: {
        type: "object",
        properties: { name: { type: "string" }, iso2: { type: "string" } },
        required: ["name", "iso2"],
        additionalProperties: false,
      },
      links: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            kind: {
              type: "string",
              enum: ["attack", "spread", "trade", "migration", "aid", "transport"],
            },
          },
          required: ["from", "to", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "title",
      "summary",
      "status",
      "synthesis",
      "timeline",
      "spectrum",
      "sides",
      "contradictions",
      "protagonist",
      "links",
    ],
    additionalProperties: false,
  },
};

const DEVELOPING_RULES =
  "You are a neutral wire-service editor tracking an ONGOING ISSUE that has unfolded across " +
  "several sub-events over time. You are given a JSON object with 'events' (each has an integer " +
  "'event' index, a date, the outlets covering it and their political lean, headlines, and a " +
  "one-line summary) and 'outlets' (the roster of contributing outlets, each with a geographic/" +
  "affiliation 'zone'). Synthesize the whole storyline neutrally. Use ONLY the provided facts; do " +
  "NOT invent details, numbers, names, or quotes. Output ONLY a JSON object:\n" +
  '{\n' +
  '  "title": "neutral storyline headline (<= 12 words)",\n' +
  '  "summary": "ONE neutral sentence (<= 30 words) on the issue and its current state",\n' +
  '  "status": "developing" if unresolved/still unfolding, else "resolved",\n' +
  '  "synthesis": ["2 to 4 short neutral paragraphs giving the overall picture and trajectory"],\n' +
  '  "timeline": [ { "event": <the integer index>, "title": "<= 8 word milestone label", "detail": "ONE sentence on what changed" } ],\n' +
  '  "spectrum": { "left": "how left-leaning outlets frame it", "center": "how centrist outlets frame it", "right": "how right-leaning outlets frame it" },\n' +
  '  "sides": [ { "label": "<short side label, e.g. \'Western media\', \'Russian media\', \'Ukrainian media\'>", "outlets": ["<exact outlet names on this side>"], "framing": "1-2 sentences on how THIS side frames the issue" } ],\n' +
  '  "contradictions": ["specific points where coverage disagrees; [] if none are evident"],\n' +
  '  "protagonist": { "name": "the central actor/subject the issue is MOST about (a country, organisation, or person)", "iso2": "if that protagonist IS a country or a national government/actor, its ISO 3166-1 alpha-2 code in lowercase (e.g. us, es, ua); otherwise an empty string" }\n' +
  "}\n" +
  "For 'protagonist', pick the single entity the issue most centres on and name it; set 'iso2' ONLY " +
  "when it is a nation/national actor (use \"\" otherwise). " +
  "Provide ONE timeline entry per provided event, reusing its exact 'event' index. For any spectrum " +
  "side with no outlets present, use an empty string. For 'sides', GROUP the roster outlets into the " +
  "opposing geographic/affiliation vantage points actually PRESENT (by 'zone') and describe how each " +
  "frames the issue \u2014 e.g. Western vs Ukrainian vs Russian media. Use only zones present; return [] " +
  "when all outlets share one vantage point. " +
  'Also include "links": [ { "from": "<ISO-2 ORIGIN>", "to": "<ISO-2 DESTINATION>", "kind": "attack|spread|trade|migration|aid|transport" } ] ' +
  "\u2014 a DIRECTED connection ONLY when the issue describes a PHYSICAL link or movement between two " +
  "DISTINCT countries from an ORIGIN to a DESTINATION, both lowercase, classified by 'kind' " +
  "(attack/spread/trade/migration/aid/transport). Only emit a link you can classify into ONE of " +
  "these SPECIFIC kinds; OMIT any link that doesn't clearly fit one (do NOT guess). [] when it is " +
  "not about a place-to-place connection. " +
  "No prose outside the JSON.";

function earliestAt(members: StoredItem[]): number {
  return Math.min(...members.map((m) => m.item.publishedAt));
}

function coerceSpectrum(raw: unknown): StorySpectrum {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    left: sanitizeModelText(r["left"]),
    center: sanitizeModelText(r["center"]),
    right: sanitizeModelText(r["right"]),
  };
}

/** A deterministic milestone from an event cluster (no model needed). */
function fallbackMilestone(event: StoredItem[]): StoryMilestone {
  const rep = event.slice().sort((a, b) => b.importance - a.importance)[0];
  return {
    at: earliestAt(event),
    title: decodeEntities(rep.item.title),
    detail: sanitizeModelText(rep.summary) || rep.item.title,
    sourceIds: event.map((m) => m.item.id),
  };
}

/** Build the timeline, using model titles/details when present and backfilling
 *  any event the model skipped so every sub-event is represented. */
function buildTimeline(events: StoredItem[][], raw: unknown): StoryMilestone[] {
  const byEvent = new Map<number, { title: string; detail: string }>();
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const idx = typeof r["event"] === "number" ? r["event"] : Number(r["event"]);
      if (!Number.isInteger(idx) || idx < 0 || idx >= events.length) continue;
      const title = sanitizeModelText(r["title"]);
      const detail = sanitizeModelText(r["detail"]);
      if (title || detail) byEvent.set(idx, { title, detail });
    }
  }
  return events
    .map((event, i) => {
      const m = byEvent.get(i);
      const fb = fallbackMilestone(event);
      return {
        at: fb.at,
        title: m?.title || fb.title,
        detail: m?.detail || fb.detail,
        sourceIds: fb.sourceIds,
      };
    })
    .sort((a, b) => a.at - b.at);
}

/** A degraded developing-issue story stitched without the model. */
function fallbackDevelopingStory(events: StoredItem[][]): Story {
  const members = events.flat();
  const base = fallbackStory(members);
  return {
    ...base,
    developing: true,
    severity: severityOf(members, true),
    startedAt: earliestAt(members),
    timeline: events
      .map(fallbackMilestone)
      .sort((a, b) => a.at - b.at),
    spectrum: { left: "", center: "", right: "" },
  };
}

/**
 * Synthesize a developing ISSUE from its time-ordered sub-events (each a list of
 * same-event articles). Never throws: degrades to a stitched timeline when the
 * model is unreachable or unusable. `relatedIds` is filled in by the service.
 */
export async function buildDevelopingStory(
  events: StoredItem[][],
  lang: Lang = "en",
): Promise<Story> {
  const clean = events.filter((e) => e.length > 0);
  if (clean.length === 0) throw new Error("buildDevelopingStory: no events");

  const members = clean.flat();
  // Time-ordered events with a stable integer index for the model to reuse.
  const ordered = clean
    .map((e) => ({ event: e, at: earliestAt(e) }))
    .sort((a, b) => a.at - b.at)
    .slice(-config.stories.maxIssueEvents);

  const eventsPayload = ordered.map((ev, i) => {
    const ranked = ev.event.slice().sort((a, b) => b.importance - a.importance);
    return {
      event: i,
      date: new Date(ev.at).toISOString().slice(0, 10),
      outlets: Array.from(new Set(ranked.map((m) => m.item.sourceTitle))).slice(0, 6),
      leans: Array.from(new Set(ranked.map((m) => leanLabel(m.lean)))),
      headlines: ranked.slice(0, 3).map((m) => m.item.title),
      summary: (ranked[0].summary || ranked[0].item.summary || "").slice(0, 220),
    };
  });
  // Roster of contributing outlets with their zone, so the model can form SIDES.
  const roster = [...new Map(members.map((m) => [m.item.sourceTitle, countryLabel(m.item.zone)])).entries()]
    .map(([outlet, zone]) => ({ outlet, zone }))
    .slice(0, 40);
  const payload = { events: eventsPayload, outlets: roster };
  const orderedEvents = ordered.map((e) => e.event);

  const obj = await chatJsonObject(DEVELOPING_RULES + langDirective(lang), payload, {
    maxTokens: config.stories.issueMaxTokens,
    schema: DEVELOPING_SCHEMA,
  });
  if (!obj) return fallbackDevelopingStory(orderedEvents);

  const title = sanitizeModelText(obj["title"]);
  const summary = sanitizeModelText(obj["summary"]);
  const synthesis = coerceStringArray(obj["synthesis"], 6);
  const contradictions = coerceStringArray(obj["contradictions"], 6);
  const timeline = buildTimeline(orderedEvents, obj["timeline"]);
  const spectrum = coerceSpectrum(obj["spectrum"]);
  const sides = finalizeSides(coerceSides(obj["sides"], members), members);
  const links = coerceLinks(obj["links"]);
  const resolved = sanitizeModelText(obj["status"]).toLowerCase() === "resolved";

  if (!title && synthesis.length === 0) return fallbackDevelopingStory(orderedEvents);

  const byImportance = members.slice().sort((a, b) => b.importance - a.importance);
  return {
    id: storyId(members.map((m) => m.item.id)),
    title: title || decodeEntities(byImportance[0].item.title),
    summary: summary || sanitizeModelText(byImportance[0].summary) || byImportance[0].item.title,
    synthesis: synthesis.length > 0 ? synthesis : [byImportance[0].item.title],
    topic: majorityTopic(members),
    lean: aggregateLean(members),
    thumbnail: pickThumbnail(members),
    severity: severityOf(members, true),
    sources: toSources(members),
    angles: [],
    contradictions,
    relatedIds: [],
    updatedAt: Math.max(...members.map((m) => m.item.publishedAt)),
    generatedAt: Date.now(),
    developing: !resolved,
    startedAt: earliestAt(members),
    timeline,
    spectrum,
    ...(sides ? { sides } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(coerceProtagonist(obj["protagonist"]) ? { protagonist: coerceProtagonist(obj["protagonist"]) } : {}),
  };
}
