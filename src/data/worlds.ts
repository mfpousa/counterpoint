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

/**
 * Spain — national/regional news across the Spanish press. Lean priors follow
 * the mainstream Spanish media-bias consensus (left ↔ right on the national
 * political axis). All feeds are free and keyless. Items are re-classified per
 * article by the analysis pass; these are source-level priors.
 */
const SPAIN_SOURCES: Source[] = [
  {
    id: "es-elpais-espana",
    title: "El País — España",
    url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/espana/portada",
    kind: "news",
    topic: "politics",
    lean: -0.3,
    confidence: 0.8,
    leanRationale: "Center-left: Spain's leading daily, social-democratic editorial line.",
  },
  {
    id: "es-elpais-economia",
    title: "El País — Economía",
    url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/economia/portada",
    kind: "news",
    topic: "economics",
    lean: -0.2,
    confidence: 0.75,
    leanRationale: "Center-left business desk of El País.",
  },
  {
    id: "es-elmundo-espana",
    title: "El Mundo — España",
    url: "https://e00-elmundo.uecdn.es/elmundo/rss/espana.xml",
    kind: "news",
    topic: "politics",
    lean: 0.3,
    confidence: 0.8,
    leanRationale: "Center-right: liberal-conservative editorial stance.",
  },
  {
    id: "es-eldiario",
    title: "elDiario.es",
    url: "https://www.eldiario.es/rss/",
    kind: "news",
    topic: "politics",
    lean: -0.5,
    confidence: 0.8,
    leanRationale: "Left: progressive investigative outlet.",
  },
  {
    id: "es-abc-espana",
    title: "ABC — España",
    url: "https://www.abc.es/rss/feeds/abc_EspanaEspana.xml",
    kind: "news",
    topic: "politics",
    lean: 0.5,
    confidence: 0.8,
    leanRationale: "Right: conservative, monarchist editorial tradition.",
  },
  {
    id: "es-larazon",
    title: "La Razón",
    url: "https://www.larazon.es/rss/portada.xml",
    kind: "news",
    topic: "politics",
    lean: 0.6,
    confidence: 0.75,
    leanRationale: "Right: conservative national daily.",
  },
  {
    id: "es-publico",
    title: "Público",
    url: "https://www.publico.es/rss/",
    kind: "news",
    topic: "politics",
    lean: -0.6,
    confidence: 0.75,
    leanRationale: "Left: left-wing, republican editorial line.",
  },
  {
    id: "es-lavanguardia",
    title: "La Vanguardia",
    url: "https://www.lavanguardia.com/rss/home.xml",
    kind: "news",
    topic: "world",
    lean: -0.1,
    confidence: 0.7,
    leanRationale: "Center: Barcelona-based daily, broadly centrist.",
  },
  {
    id: "es-elconfidencial",
    title: "El Confidencial — España",
    url: "https://rss.elconfidencial.com/espana/",
    kind: "news",
    topic: "politics",
    lean: 0.1,
    confidence: 0.7,
    leanRationale: "Center to center-right digital native, investigative.",
  },
  {
    id: "es-20minutos",
    title: "20minutos",
    url: "https://www.20minutos.es/rss/",
    kind: "news",
    topic: "world",
    lean: 0.0,
    confidence: 0.65,
    leanRationale: "Center: mass-market general news.",
  },
  {
    id: "es-rtve",
    title: "RTVE — Noticias",
    url: "https://api2.rtve.es/rss/temas_noticias.xml",
    kind: "news",
    topic: "world",
    lean: -0.1,
    confidence: 0.7,
    leanRationale: "Center: public broadcaster, broad national coverage.",
  },
  {
    id: "es-expansion",
    title: "Expansión",
    url: "https://e00-expansion.uecdn.es/rss/portada.xml",
    kind: "news",
    topic: "economics",
    lean: 0.3,
    confidence: 0.75,
    leanRationale: "Center-right: pro-market business daily.",
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
  {
    id: "spain",
    title: "Spain",
    description: "Spanish national news across the political spectrum, left to right.",
    icon: "flag",
    sources: SPAIN_SOURCES,
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
