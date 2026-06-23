// Pure: place ONGOING (developing) stories onto the globe as "alert" markers, sized
// and coloured by their gravity (Story.severity 0..1). Stories carry no explicit
// coordinates, so we locate one two ways, best-first:
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

/** A located ongoing story, ready to render as a pulsing globe marker. */
export interface GeoAlert {
  id: string;
  title: string;
  topic: string;
  /** 0..1 gravity — drives marker size + colour intensity. */
  severity: number;
  /** Unit direction on the sphere for the marker. */
  dir: Vec3;
}

/** Lookups used to geolocate a story (all built from the bundled country borders). */
export interface AlertPlaceIndex {
  /** ISO-2 (lowercase) → unit centroid direction. */
  centroidByIso2: Map<string, Vec3>;
  /** Lowercase country name/alias → unit centroid direction. */
  centroidByName: Map<string, Vec3>;
  /** Affiliation zone id (e.g. "ukraine") → ISO-2 (e.g. "ua"). */
  zoneToIso2: Record<string, string>;
}

/** Best-effort unit position for a story, or null when it can't be located. */
export function locateStory(story: Story, idx: AlertPlaceIndex): Vec3 | null {
  // 1. Zones the model tagged on the story (most reliable for conflicts).
  const zones = new Set<string>();
  for (const side of story.sides ?? []) for (const z of side.zones) zones.add(z);
  for (const s of story.sources) if (s.zone) zones.add(s.zone);
  for (const z of zones) {
    const iso = idx.zoneToIso2[z];
    const dir = iso ? idx.centroidByIso2.get(iso) : undefined;
    if (dir) return dir;
  }
  // 2. Longest country name/alias appearing in the headline or dek.
  const hay = `${story.title} ${story.summary}`.toLowerCase();
  let best: { len: number; dir: Vec3 } | null = null;
  for (const [name, dir] of idx.centroidByName) {
    if (name.length < 4) continue; // avoid spurious matches like "us"/"mali" fragments
    if (hay.includes(name) && (!best || name.length > best.len)) best = { len: name.length, dir };
  }
  return best?.dir ?? null;
}

/** Locate every ongoing story we can, strongest gravity first (capped by `max`). */
export function buildAlerts(
  stories: Story[],
  idx: AlertPlaceIndex,
  opts: { minSeverity?: number; max?: number } = {},
): GeoAlert[] {
  const minSeverity = opts.minSeverity ?? 0;
  const out: GeoAlert[] = [];
  for (const s of stories) {
    if (!s.developing) continue; // alerts = ONGOING issues
    const severity = typeof s.severity === "number" ? s.severity : 0.5;
    if (severity < minSeverity) continue;
    const dir = locateStory(s, idx);
    if (!dir) continue;
    out.push({ id: s.id, title: s.title, topic: s.topic, severity, dir });
  }
  out.sort((a, b) => b.severity - a.severity);
  return typeof opts.max === "number" ? out.slice(0, opts.max) : out;
}
