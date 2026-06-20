// "Worlds": distinct news universes, each with its own curated source set and
// its own analyzed pool. The default world is the broad front page; niche worlds
// surface coverage the mainstream feed crowds out. Deep analysis is expensive,
// so the server only refreshes ONE world at a time (see feedService).
//
// This module is shared: the client imports the world METADATA (id/title/icon)
// for the switcher; the server uses `sources` to know what to fetch per world.

import type { Source, World } from "../types";
import SOURCES from "./sources";

const yt = (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

/** Art / design / film / music / writing — the creative beat, free keyless RSS. */
const CREATIVE_SOURCES: Source[] = [
  {
    id: "hyperallergic",
    title: "Hyperallergic",
    url: "https://hyperallergic.com/feed/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: contemporary art news & criticism.",
  },
  {
    id: "colossal",
    title: "Colossal",
    url: "https://www.thisiscolossal.com/feed/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.85,
    leanRationale: "Non-political: visual art, design and craft.",
  },
  {
    id: "openculture",
    title: "Open Culture",
    url: "https://www.openculture.com/feed",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: cultural & educational media.",
  },
  {
    id: "pitchfork-news",
    title: "Pitchfork — News",
    url: "https://pitchfork.com/feed/feed-news/rss",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: music news & reviews.",
  },
  {
    id: "smashing-magazine",
    title: "Smashing Magazine",
    url: "https://www.smashingmagazine.com/feed/",
    kind: "news",
    topic: "technology",
    lean: null,
    confidence: 0.85,
    leanRationale: "Non-political: web design & front-end craft.",
  },
  {
    id: "kottke",
    title: "kottke.org",
    url: "https://feeds.kottke.org/main",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.75,
    leanRationale: "Non-political: eclectic arts & culture blog.",
  },
  {
    id: "boingboing",
    title: "Boing Boing",
    url: "https://boingboing.net/feed",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.7,
    leanRationale: "Non-political: wonderful things, makers & culture.",
  },
  {
    id: "aeon-essays",
    title: "Aeon",
    url: "https://aeon.co/feed.rss",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: philosophy and ideas essays.",
  },
  {
    id: "yt-nerdwriter",
    title: "Nerdwriter1",
    url: yt("UCJkMlOu7faDgqh4PfzbpLdg"),
    kind: "video",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: video essays on art & film.",
  },
];

/** Reuse the front page's non-political disciplines for a slower, deeper world. */
const CURIOUS_TOPICS = new Set(["science", "technology", "history"]);
const CURIOUS_SOURCES: Source[] = SOURCES.filter((s) => CURIOUS_TOPICS.has(s.topic));

export const WORLDS: World[] = [
  {
    id: "frontpage",
    title: "Front Page",
    description: "The most relevant news across world, politics, economics, science and tech.",
    icon: "newspaper",
    sources: SOURCES,
  },
  {
    id: "creative",
    title: "Creative & Indie",
    description: "Art, design, film, music and ideas the mainstream feed crowds out.",
    icon: "color-palette",
    sources: CREATIVE_SOURCES,
  },
  {
    id: "curious",
    title: "Science & Curiosity",
    description: "Deep science, technology and history — things worth slowing down for.",
    icon: "planet",
    sources: CURIOUS_SOURCES,
  },
];

export const DEFAULT_WORLD_ID = "frontpage";

/** Resolve a world by id, falling back to the default (front page). */
export function worldById(id: string | undefined | null): World {
  return WORLDS.find((w) => w.id === id) ?? WORLDS[0];
}

/** The source set for a world id (defaults to the front page's sources). */
export function worldSources(id: string | undefined | null): Source[] {
  return worldById(id).sources;
}

/** True if the id names a known world. */
export function isWorldId(id: string | undefined | null): boolean {
  return !!id && WORLDS.some((w) => w.id === id);
}

export default WORLDS;
