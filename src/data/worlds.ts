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

/** Video games — news, reviews and criticism. Free keyless RSS. */
const GAMES_SOURCES: Source[] = [
  {
    id: "eurogamer",
    title: "Eurogamer",
    url: "https://www.eurogamer.net/feed",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: video game news & reviews.",
  },
  {
    id: "polygon-games",
    title: "Polygon",
    url: "https://www.polygon.com/rss/index.xml",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: games & entertainment coverage.",
  },
  {
    id: "rock-paper-shotgun",
    title: "Rock Paper Shotgun",
    url: "https://www.rockpapershotgun.com/feed",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: PC gaming news & features.",
  },
  {
    id: "pcgamer",
    title: "PC Gamer",
    url: "https://www.pcgamer.com/rss/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: PC gaming news & reviews.",
  },
  {
    id: "gamespot-news",
    title: "GameSpot — News",
    url: "https://www.gamespot.com/feeds/news/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: video game news.",
  },
  {
    id: "nintendo-life",
    title: "Nintendo Life",
    url: "https://www.nintendolife.com/feeds/latest",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.75,
    leanRationale: "Non-political: Nintendo-focused gaming coverage.",
  },
];

/** Film — reviews, criticism and industry coverage. Free keyless RSS. */
const FILM_SOURCES: Source[] = [
  {
    id: "indiewire",
    title: "IndieWire",
    url: "https://www.indiewire.com/feed/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: film news & criticism.",
  },
  {
    id: "the-film-stage",
    title: "The Film Stage",
    url: "https://thefilmstage.com/feed/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: film reviews & festival coverage.",
  },
  {
    id: "slashfilm",
    title: "/Film",
    url: "https://www.slashfilm.com/feed/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: movie news & features.",
  },
  {
    id: "roger-ebert",
    title: "RogerEbert.com",
    url: "https://www.rogerebert.com/feed",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.85,
    leanRationale: "Non-political: film criticism & reviews.",
  },
  {
    id: "collider",
    title: "Collider",
    url: "https://collider.com/feed/",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.75,
    leanRationale: "Non-political: film & TV news.",
  },
  {
    id: "nofilmschool",
    title: "No Film School",
    url: "https://nofilmschool.com/rss.xml",
    kind: "news",
    topic: "culture",
    lean: null,
    confidence: 0.8,
    leanRationale: "Non-political: filmmaking craft & industry.",
  },
];

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
  {
    id: "games",
    title: "Videogames",
    description: "Game news, reviews and criticism across PC and console.",
    icon: "game-controller",
    sources: GAMES_SOURCES,
  },
  {
    id: "films",
    title: "Films",
    description: "Movie reviews, criticism and the stories behind the screen.",
    icon: "film",
    sources: FILM_SOURCES,
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

/**
 * A synthetic "regional" pool id: `place-<cc>` (e.g. "place-es"). Regional mode
 * is a DATASET SWITCH — its pool is fed exclusively by the country's locally-
 * discovered outlets (src/data/placeSources/<cc>.json), orthogonal to the topical
 * worlds. Encoded in the worldId so all per-world plumbing (store, build, view
 * cache, status) works unchanged.
 */
export function isPlaceWorldId(id: string | undefined | null): boolean {
  return !!id && /^place-[a-z]{2}$/.test(id);
}

/** The country code of a regional pool id ("place-es" -> "es"), else null. */
export function placeCountryOf(id: string | undefined | null): string | null {
  return isPlaceWorldId(id) ? (id as string).slice(6) : null;
}

/** The regional pool id for a country code ("es" -> "place-es"). */
export function placeWorldId(country: string): string {
  return `place-${country.toLowerCase().slice(0, 2)}`;
}

export default WORLDS;
