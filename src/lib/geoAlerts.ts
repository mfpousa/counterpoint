// Pure: turn the news into a "worldview" — place MAJOR world events onto the globe,
// CLASSIFIED (conflict, diplomacy, unrest, health, tech, disaster, economy) and sized
// by gravity (Story.severity 0..1). Stories carry no explicit coordinates, so we locate
// one two ways, best-first:
//
//   1. ZONES — the affiliation zones the model attached to the story (sides[].zones
//      and each source's `zone`, e.g. "ukraine"/"russia"). Mapped to a country ISO-2
//      and that country's centroid.
//   2. NAME  — failing a zone, the longest country name/alias that appears in the
//      headline or dek (e.g. "...in Sudan...").
//
// Stories we cannot locate are dropped (no fabricated positions). Lives apart from
// three.js so the geolocation logic is unit-tested once and reused on web + native.

import type { Story } from "../types";
import type { Vec3 } from "./globeLayout";

/** A class of world EVENT we extract from the news to paint the globe's worldview. */
export type EventCategory =
  | "conflict"
  | "diplomacy"
  | "unrest"
  | "health"
  | "tech"
  | "disaster"
  | "economy"
  | "other";

/** Per-category visuals: marker COLOUR (globe) + a legend label & Ionicons glyph name
 *  (RN legend). Kept here, pure, so the globe and the legend always agree. */
export const EVENT_CATEGORIES: Record<
  EventCategory,
  { color: string; label: string; icon: string }
> = {
  conflict: { color: "#E8654E", label: "Conflict", icon: "flame" },
  unrest: { color: "#E0A94B", label: "Unrest", icon: "megaphone" },
  diplomacy: { color: "#6EA8FE", label: "Diplomacy", icon: "people-circle" },
  health: { color: "#5BD6A6", label: "Health", icon: "medkit" },
  tech: { color: "#9B8CFF", label: "Tech & science", icon: "hardware-chip" },
  disaster: { color: "#E06C9F", label: "Disaster", icon: "warning" },
  economy: { color: "#56C2D6", label: "Economy", icon: "trending-up" },
  other: { color: "#9AA4B2", label: "Other", icon: "ellipse" },
};

/** Keyword signatures per category (lowercase substrings scanned in title + dek). */
const CATEGORY_KEYWORDS: Record<Exclude<EventCategory, "other">, string[]> = {
  conflict: ["war","airstrike","air strike","drone strike","missile","troops","invasion","offensive","military","bombing","shelling","frontline","combat","militant","insurgent","artillery","occupation","gunmen","clashes","killed in"],
  disaster: ["earthquake","flood","wildfire","hurricane","tsunami","drought","eruption","volcano","landslide","typhoon","cyclone","heatwave","famine","mudslide","quake"],
  health: ["virus","outbreak","disease","pandemic","vaccine","epidemic","covid","measles","cholera","ebola","mpox","infection","health crisis","contagion"],
  unrest: ["protest","riot","coup","unrest","demonstration","rally","crackdown","uprising","walkout","election","referendum","impeach","ousted","dissident"],
  diplomacy: ["talks","summit","treaty","sanction","diplomat","negotiat","accord","envoy","ambassador","peace deal","alliance","memorandum"],
  tech: ["artificial intelligence","semiconductor","quantum","satellite","rocket","spacecraft","breakthrough","robot","startup","chipmaker","ai model"],
  economy: ["inflation","recession","stock market","tariff","trade war","gdp","currency","interest rate","bankrupt","oil price","economic"],
};

// Tie-break order: a story matching both "war" and "election" reads as CONFLICT.
const CATEGORY_PRIORITY: Exclude<EventCategory, "other">[] = [
  "conflict",
  "disaster",
  "health",
  "unrest",
  "diplomacy",
  "tech",
  "economy",
];

/** Classify a story into a world-event category by keyword signal, falling back to its
 *  topic. Heuristic + deterministic (no model call) so it's instant and unit-tested. */
export function classifyEvent(story: { title: string; summary: string; topic: string }): EventCategory {
  const hay = `${story.title} ${story.summary}`.toLowerCase();
  let best: EventCategory = "other";
  let bestScore = 0;
  for (const cat of CATEGORY_PRIORITY) {
    let score = 0;
    for (const kw of CATEGORY_KEYWORDS[cat]) if (hay.includes(kw)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  if (bestScore > 0) return best;
  switch (story.topic) {
    case "technology":
    case "science":
      return "tech";
    case "health":
      return "health";
    case "economics":
      return "economy";
    default:
      return "other";
  }
}

/** A located world event, ready to render on the globe's worldview map. */
export interface GeoAlert {
  id: string;
  title: string;
  topic: string;
  /** World-event category (drives the marker colour + the legend). */
  category: EventCategory;
  /** True for an ongoing/developing issue (vs a single settled event). */
  developing: boolean;
  /** Most recent contributing article time (epoch ms) — drives the RECENCY treatment
   *  (fresh chips pulse, stale ones fade) and the time-window scrubber. */
  updatedAt: number;
  /** Earliest contributing article time (epoch ms) — when the story/issue began. */
  startedAt?: number;
  /** 0..1 gravity — drives marker size + colour intensity. */
  severity: number;
  /** Unit direction on the sphere for the marker. */
  dir: Vec3;
  /** ISO-2 (lowercase) of the subject NATION, when the story is about a country —
   *  so the UI can show its flag. Absent for sub-national / non-country subjects. */
  iso2?: string;
  /** How many events collapsed onto this same location (1 = just this one). Lets the
   *  UI show "+N more" instead of stacking many pins on one country's centroid. */
  count?: number;
  /** The events collapsed onto this location (including this one, strongest first), so a
   *  tap on an aggregated marker can fan out into each story. Set by the UI declutter. */
  stacked?: { id: string; title: string }[];
}

/** Lookups used to geolocate a story (all built from the bundled country borders). */
export interface AlertPlaceIndex {
  /** ISO-2 (lowercase) → unit centroid direction. */
  centroidByIso2: Map<string, Vec3>;
  /** Lowercase country name/alias → unit centroid direction. */
  centroidByName: Map<string, Vec3>;
  /** Affiliation zone id (e.g. "ukraine") → ISO-2 (e.g. "ua"). */
  zoneToIso2: Record<string, string>;
  /** Lowercase country name → ISO-2, so a name-located story knows its nation (flag). */
  iso2ByName?: Map<string, string>;
}

/** Best-effort location for a story: the unit direction AND (when it resolves to a
 *  country) that nation's ISO-2 — for the flag. null when nothing can be inferred. */
export function locatePlace(
  story: Story,
  idx: AlertPlaceIndex,
): { dir: Vec3; iso2: string | null } | null {
  // 1. Zones the model tagged on the story (most reliable for conflicts).
  const zones = new Set<string>();
  for (const side of story.sides ?? []) for (const z of side.zones) zones.add(z);
  for (const s of story.sources) if (s.zone) zones.add(s.zone);
  for (const z of zones) {
    const iso = idx.zoneToIso2[z];
    const dir = iso ? idx.centroidByIso2.get(iso) : undefined;
    if (dir) return { dir, iso2: iso };
  }
  // 2. Longest country name/alias appearing in the headline or dek.
  const hay = `${story.title} ${story.summary}`.toLowerCase();
  let best: { len: number; dir: Vec3; name: string } | null = null;
  for (const [name, dir] of idx.centroidByName) {
    if (name.length < 4) continue; // avoid spurious matches like "us"/"mali" fragments
    if (hay.includes(name) && (!best || name.length > best.len)) {
      best = { len: name.length, dir, name };
    }
  }
  if (best) return { dir: best.dir, iso2: idx.iso2ByName?.get(best.name) ?? null };
  return null;
}

/** Best-effort unit position for a story, or null when it can't be located. */
export function locateStory(story: Story, idx: AlertPlaceIndex): Vec3 | null {
  return locatePlace(story, idx)?.dir ?? null;
}

/** Locate every MAJOR locatable event (above `minSeverity`), classify it, strongest
 *  gravity first (capped by `max`). Includes single events AND ongoing issues — the
 *  worldview is everything happening now, not just developing storylines. */
export function buildAlerts(
  stories: Story[],
  idx: AlertPlaceIndex,
  opts: { minSeverity?: number; max?: number } = {},
): GeoAlert[] {
  const minSeverity = opts.minSeverity ?? 0;
  const out: GeoAlert[] = [];
  for (const s of stories) {
    const severity = typeof s.severity === "number" ? s.severity : 0.5;
    if (severity < minSeverity) continue;
    // A FLAG flies ONLY when the analysis named a NATION as the story's protagonist:
    // anchor the pin on that country and tag its iso2 (so the globe shows a country's
    // influence at a glance). Otherwise geolocate where the story is happening and fly
    // NO flag — the located country isn't necessarily what the story is "about".
    const protoIso = s.protagonist?.iso2;
    const protoDir = protoIso ? idx.centroidByIso2.get(protoIso) : undefined;
    let dir: Vec3;
    let iso2: string | undefined;
    if (protoDir) {
      dir = protoDir;
      iso2 = protoIso;
    } else {
      const loc = locatePlace(s, idx);
      if (!loc) continue;
      dir = loc.dir;
      iso2 = undefined; // located, not a national protagonist → pin only, no flag
    }
    out.push({
      id: s.id,
      title: s.title,
      topic: s.topic,
      category: classifyEvent(s),
      developing: !!s.developing,
      updatedAt: s.updatedAt,
      startedAt: s.startedAt,
      severity,
      dir,
      iso2,
    });
  }
  out.sort((a, b) => b.severity - a.severity);
  return typeof opts.max === "number" ? out.slice(0, opts.max) : out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME DIMENSION — encode WHEN an event happened so the map distinguishes "right
// now" from "ongoing" from "fading", and let the reader scrub to a recency window.
// ─────────────────────────────────────────────────────────────────────────────

/** Time-window lens for the worldview scrubber: "all" shows everything, the rest
 *  narrow the map to events whose latest article lands inside the span. */
export type TimeWindow = "all" | "week" | "day" | "now";

/** Max age (ms, vs an event's `updatedAt`) admitted by each narrowing window. The
 *  "now" span doubles as the FRESH threshold that makes a chip pulse. */
export const TIME_WINDOW_MS: Record<Exclude<TimeWindow, "all">, number> = {
  week: 7 * 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  now: 6 * 60 * 60 * 1000,
};

/** True when an event (by its `updatedAt`) falls inside the chosen window. */
export function withinWindow(
  updatedAt: number,
  win: TimeWindow,
  now = Date.now(),
): boolean {
  return win === "all" || now - updatedAt <= TIME_WINDOW_MS[win];
}

/** Recency band of an event, driving the chip's time treatment:
 *  - `fresh`  (≤6h)         → a live pulse (breaking right now)
 *  - `recent` (≤24h)        → full strength, no pulse
 *  - `week`   (≤7d OR ongoing) → steady, slightly dimmer
 *  - `stale`  (older + settled) → faded out (history, not news) */
export type Recency = "fresh" | "recent" | "week" | "stale";

export function recencyOf(
  updatedAt: number,
  developing = false,
  now = Date.now(),
): Recency {
  const age = now - updatedAt;
  if (age <= TIME_WINDOW_MS.now) return "fresh";
  if (age <= TIME_WINDOW_MS.day) return "recent";
  if (age <= TIME_WINDOW_MS.week || developing) return "week";
  return "stale";
}

/** Chip opacity for a recency band — fresh/recent at full strength, older ones fade
 *  so the eye is drawn to what's happening now without losing the ongoing context. */
export const RECENCY_OPACITY: Record<Recency, number> = {
  fresh: 1,
  recent: 1,
  week: 0.85,
  stale: 0.45,
};
