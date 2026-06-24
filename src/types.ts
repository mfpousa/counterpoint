// Core domain types for Counterpoint.

/** What kind of media an item is. */
export type Kind = "video" | "podcast" | "news";

/** UI + AI-output language. The UI is localized to this and the backend is asked
 *  to write article rewrites / briefings / stories in it, regardless of the
 *  source article's language. */
export type Lang = "en" | "es";

/**
 * Editorial topic / discipline. Used to guarantee breadth across the feed so
 * no single subject dominates. "politics" / "world" are the contested topics
 * where lean balancing matters most.
 */
export type Topic =
  | "world"
  | "politics"
  | "economics"
  | "science"
  | "technology"
  | "history"
  | "health"
  | "culture";

/**
 * A perspective lean on the continuous spectrum.
 *  -1.0 = far-left, 0 = center, +1.0 = far-right.
 * `null` means the content is non-political (science, history, how-to, ...)
 * and is therefore EXCLUDED from the left/right balance math.
 */
export type Lean = number | null;

/** Where an item's lean tag came from. */
export type LeanSource = "source" | "llm";

/**
 * A curated content source (an RSS/Atom feed). Lean is assigned ONCE here,
 * cross-referenced against published media-bias data, and items inherit it.
 */
export interface Source {
  id: string;
  title: string;
  /** RSS/Atom feed URL (key-less, free). */
  url: string;
  kind: Kind;
  topic: Topic;
  /** Source-level lean prior on -1..+1, or null for non-political sources. */
  lean: Lean;
  /** 0..1 confidence in the lean rating. */
  confidence: number;
  /** Human-readable justification + citation for the lean rating (auditable). */
  leanRationale: string;
  /** Relative sampling weight (higher = drawn more often). Default 1. */
  weight?: number;
  /**
   * ISO 639-1 language of the feed's content (e.g. "en", "ru", "uk", "ar").
   * Defaults to "en" when absent. Set on reactive international sources so we can
   * report coverage by language and surface ORIGINAL-language reporting (the model
   * reads it directly; summaries are produced in the reader's language).
   */
  lang?: string;
  /**
   * Legacy geographic/affiliation zone of an outlet. The discovered placeSources
   * outlets carry NO zone — reactive SIDE coverage is tagged with the outlet's COUNTRY
   * code on the FeedItem at fetch time (see feedService.addSideCoverage), not here.
   * Kept optional for back-compat; absent on every current source.
   */
  zone?: string;
  /**
   * Top-level subnational REGION this outlet is based in, as an ISO 3166-2 code
   * (e.g. "ES-GA" for Galicia). Set by the discovery pipeline (Wikidata) so the
   * geographic drill-down can serve region-specific outlets. Absent when unknown.
   */
  region?: string;
  /** Human-readable label for `region` (e.g. "Galicia"). */
  regionLabel?: string;
}

/**
 * A reader's chosen PLACE: a geographic lens layered OVER any world (orthogonal
 * to the topical world). All levels below `country` are optional, so a reader can
 * be as broad as a country or as narrow as a local council. Persisted locally.
 */
export interface Place {
  /** ISO 3166-1 alpha-2, lowercased ("es", "us", "gb"). Required when set. */
  country: string;
  /** Registry id of a first-level admin division ("es-md" = Comunidad de Madrid). */
  region?: string;
  /** Free-text locality / council ("Móstoles"). Matched via the gazetteer. */
  locality?: string;
}

/**
 * One node in the place GAZETTEER: a country, region, or locality with the alias
 * tokens whose presence in a story marks it as relevant to that place. The
 * `aliases` power a relevance BOOST (so local stories surface from any feed),
 * mirroring how `Zone.aliases` work for international zones. Generated from open
 * datasets (GeoNames + Wikidata) by `scripts/buildGazetteer.ts` — never hand-kept.
 */
export interface PlaceNode {
  /** Hierarchical id: "es", "es-md", "es-md-mostoles". */
  id: string;
  /** Parent node id ("es-md".parent = "es"); absent for countries. */
  parent?: string;
  level: "country" | "region" | "locality";
  /** Display label, e.g. "Comunidad de Madrid". */
  label: string;
  /** ISO 3166-1 alpha-2 this node belongs to (denormalized for cheap filtering). */
  country: string;
  /**
   * Lowercase signal tokens (names, demonyms, multilingual aliases, key local
   * figures/landmarks) marking the place as involved in a story's text.
   */
  aliases: string[];
  /** Population, when known — used to bound/rank localities. */
  population?: number;
}

/**
 * A "world": a self-contained news universe with its OWN curated source set and
 * its OWN analyzed pool. The default world is the broad front page; niche worlds
 * surface coverage the mainstream feed crowds out (creative, deep science, ...).
 * Because deep analysis is expensive, only one world refreshes at a time.
 */
export interface World {
  id: string;
  title: string;
  /** One-line description shown in the world switcher. */
  description: string;
  /** Ionicons glyph name for the switcher chip. */
  icon: string;
  /** The RSS/Atom sources that make up this world. */
  sources: Source[];
}

/** A single normalized piece of content drawn from a source's feed. */
export interface FeedItem {
  id: string;
  sourceId: string;
  sourceTitle: string;
  title: string;
  summary: string;
  url: string;
  thumbnail?: string;
  publishedAt: number; // epoch ms
  kind: Kind;
  topic: Topic;
  /** Effective lean (may be overridden by the LLM layer). */
  lean: Lean;
  confidence: number;
  /** Provenance of the effective lean. */
  leanSource: LeanSource;
  /**
   * Short, human-readable justification for the lean tag, shown in the UI so the
   * reader can audit WHY an item was placed left/right. For `leanSource: "llm"`
   * it's the model's per-item rationale (judging this item's framing); for
   * `"source"` it's the curated source-level rationale. Absent for non-political
   * items.
   */
  leanRationale?: string;
  /** Estimated time-to-consume in minutes. */
  estMinutes: number;
  /** Populated by buildFeed: why this item was chosen. */
  reason?: string;
  /**
   * AI-assigned relevance/importance on 0..1 (set by the backend enrichment
   * pass). Higher = more newsworthy/substantive. Absent if not yet enriched.
   */
  relevance?: number;
  /** Short AI-written rationale for why this item is worth your time. */
  aiReason?: string;
  /**
   * Raw article body HTML captured from the feed's content:encoded/<content>
   * element, if the publisher ships full text. Used SERVER-SIDE only as a
   * fallback source for the in-app rewrite when live page extraction fails
   * (bot-walls, JS-only pages). Stripped before items are sent to the client.
   */
  content?: string;
  /**
   * True when this item was DISCOVERED by story-driven YouTube search rather than
   * pulled from a curated RSS source — i.e. we searched YouTube for a headline the
   * outlets were covering and found a relevant news/podcast video. `sourceTitle`
   * holds the channel name. The UI shows a bespoke "YouTube" tag so these are
   * never confused with traditional articles.
   */
  youtubeSearch?: boolean;
  /**
   * The ISO 3166-1 alpha-2 COUNTRY code of the outlet behind this item, set when it
   * was pulled as REACTIVE side coverage (the server fetched that country's discovered
   * placeSources because a live story named it). Absent for default front-page items.
   * Used to group coverage into conflict SIDES inside a story.
   */
  zone?: string;
  /**
   * How many outlets carried this same story (>=1). Set by pre-analysis near-clone
   * dedup: only the representative copy is deep-analyzed, and its analysis is fanned
   * out to the clones, so the UI can show "also covered by N outlets". Absent/1 when
   * the item stands alone.
   */
  coveredBy?: number;
  /**
   * Enrichment stage of this item, for reactive (progressive) loading:
   *  - "provisional": fetched + cheaply triaged but NOT yet deep-analyzed. Carries
   *    the source headline/summary, the source-level lean prior, and a coarse
   *    importance. Shown immediately so the feed is usable in seconds; upgraded in
   *    place once analysis lands.
   *  - "analyzed": the model has produced topic/summary/refined lean/keywords.
   * Absent on older items is treated as "analyzed".
   */
  enrichment?: "provisional" | "analyzed";
}

/** One storyline within the daily briefing. */
export interface BriefingThread {
  /** Short label for the storyline (a few words). */
  title: string;
  /** One sentence on what's happening and why it matters. */
  detail: string;
}

/**
 * An AI-synthesized digest of what's happening now and where things are headed,
 * generated from the analyzed feed pool and steered by the reader's interest.
 */
export interface Briefing {
  generatedAt: number;
  /** The interest this briefing was tuned to ("" = general). */
  interest: string;
  /** One sentence capturing the overall vibe / direction right now. */
  mood: string;
  /** 3-5 key storylines. */
  threads: BriefingThread[];
  /** One sentence on where things appear to be headed next. */
  outlook: string;
  /** How many items the briefing was synthesized from. */
  basedOn: number;
}

/** One located place surfaced by an AI news search ("ask"): where something is
 *  happening, with a one-line read on it. The client maps `iso2` (or `label`) to
 *  a globe centroid to drop a marker. */
export interface AskPlace {
  /** Human place name, e.g. "California" or "Spain". */
  label: string;
  /** ISO 3166-1 alpha-2 (lowercase) for centroid lookup; "" if the model gave none. */
  iso2: string;
  /** One sentence on what's happening there (grounded in the matched items). */
  blurb: string;
}

/** A source article the AI answer was grounded in, so the reader can OPEN it and
 *  verify what's written — both in the prose box and per pin. */
export interface AskSource {
  /** FeedItem id. */
  id: string;
  /** Article headline. */
  title: string;
  /** Outlet name. */
  sourceTitle: string;
  /** Original article URL (opened to verify). */
  url: string;
  /** One-line summary — used client-side to attribute a source to specific places. */
  summary: string;
}

/**
 * The AI's answer to a free-text news search over the whole fetched database. The
 * SAME model both answers AND decides how to show it: `map` when the topic has a
 * geographic spread (places get globe markers), else `answer` (just the synopsis).
 * The synopsis is also streamed token-by-token while it's generated.
 */
export interface AskResult {
  /** The query this answers. */
  query: string;
  /** How the client should display it: drop markers on the globe, or just the text. */
  mode: "map" | "answer";
  /** The prose synopsis (the streamed answer), grounded in the matched items. */
  synopsis: string;
  /** Located places to mark on the globe (empty for a pure `answer`). */
  places: AskPlace[];
  /** The source articles the answer was grounded in (most-relevant first), so the
   *  reader can open + verify them — overall and per pin. */
  sources: AskSource[];
  /** How many items were searched / matched, for a "based on N" affordance. */
  basedOn: number;
}

/** One source article that contributed to a synthesized story. */
export interface StorySource {
  /** FeedItem id (so the reader can open the AI-rewrite or original). */
  id: string;
  title: string;
  sourceTitle: string;
  url: string;
  /** This source's effective lean, for coloring & balance display. */
  lean: Lean;
  leanSource: LeanSource;
  publishedAt: number;
  /** Geographic/affiliation zone of the outlet, when known (reactive sources). */
  zone?: string;
}

/**
 * One SIDE of a conflict as identified by the model on a case-by-case basis —
 * NOT a pre-set category. Groups the outlets reporting from a shared geographic /
 * affiliation vantage point and captures how that side frames the story, so the
 * reader can compare e.g. Western vs Ukrainian vs Russian coverage of one event.
 */
export interface StorySide {
  /** AI-written label, e.g. "Western media", "Russian media", "Ukrainian media". */
  label: string;
  /** Zone ids that compose this side (from the contributing items' tags). */
  zones: string[];
  /** One to two sentences: how THIS side frames / emphasizes the story. */
  framing: string;
  /** Contributing outlet names on this side (for display). */
  outlets: string[];
}

/**
 * How one outlet framed the shared story differently — the heart of the
 * cross-source comparison (what each outlet emphasized or downplayed).
 */
export interface StoryAngle {
  /** The outlet (sourceTitle) this framing describes. */
  outlet: string;
  /** That outlet's lean, for coloring. */
  lean: Lean;
  /** One sentence on how this outlet framed/emphasized the story. */
  framing: string;
}

/**
 * One milestone in a developing issue's timeline — a distinct sub-event in the
 * larger storyline (e.g. for an ongoing conflict: a strike, a closure, talks).
 */
export interface StoryMilestone {
  /** Epoch ms of the sub-event (earliest contributing article). */
  at: number;
  /** Short milestone label. */
  title: string;
  /** One sentence on what changed at this point. */
  detail: string;
  /** Contributing source-article ids (open in the in-app reader). */
  sourceIds: string[];
}

/**
 * How coverage of an issue differs across the political spectrum, aggregated to
 * left / center / right. Empty strings where a side isn't represented.
 */
export interface StorySpectrum {
  left: string;
  center: string;
  right: string;
}

/**
 * An AI-synthesized story aggregating multiple outlets' coverage of ONE event.
 * The synthesis is neutral and cites every contributing source; `angles` and
 * `contradictions` surface HOW the reporting differs across outlets.
 */
export interface Story {
  /** Stable id derived from the contributing article ids. */
  id: string;
  /** Neutral synthesized headline. */
  title: string;
  /** One-line dek summarizing the event. */
  summary: string;
  /**
   * Representative image for the story (the most newsworthy contributing
   * article's thumbnail, if any). Lets a story card present like an article.
   */
  thumbnail?: string;
  /** The neutral synthesized article, one entry per paragraph. */
  synthesis: string[];
  topic: Topic;
  /** Importance-weighted aggregate lean of the contributing coverage, or null. */
  lean: Lean;
  /**
   * 0..1 attention weight ("severity") combining newsworthiness, how widely it's
   * covered, and developing status. Drives the color intensity of the issue tag
   * so bigger stories pull more attention.
   */
  severity: number;
  /** The deduped source articles that fed the synthesis. */
  sources: StorySource[];
  /** Per-outlet framing differences. */
  angles: StoryAngle[];
  /** Notable factual contradictions/disagreements across outlets. */
  contradictions: string[];
  /**
   * The central actor/subject the story is most about, as tagged by the analysis —
   * with its ISO 3166-1 alpha-2 code when that protagonist is a NATION (so the globe
   * can fly its flag to show a country's influence at a glance).
   */
  protagonist?: { name: string; iso2?: string };
  /** Ids of related stories (other clusters), for cross-linking. */
  relatedIds: string[];
  /** Most recent contributing article time (epoch ms). */
  updatedAt: number;
  /** When this story was synthesized (epoch ms). */
  generatedAt: number;
  /**
   * True for an ONGOING ISSUE: a broader storyline grouping several sub-events
   * over time (vs a single settled event). Developing stories carry a `timeline`
   * and `spectrum` and are highlighted inline in the feed.
   */
  developing?: boolean;
  /** Earliest contributing article time (epoch ms) — the issue's start. */
  startedAt?: number;
  /** Ordered sub-events for a developing issue (empty for single events). */
  timeline?: StoryMilestone[];
  /** Left/center/right framing comparison for a developing issue. */
  spectrum?: StorySpectrum;
  /**
   * AI-detected conflict SIDES (geographic/affiliation vantage points) and how
   * each frames the story — populated case-by-case when the coverage spans
   * opposing zones (e.g. Western vs Ukrainian vs Russian media). Absent when the
   * story isn't a multi-side conflict or no foreign coverage was gathered.
   */
  sides?: StorySide[];
  /**
   * True when synthesis is a graceful FALLBACK (model offline/failed): built
   * from the source one-line summaries without cross-outlet analysis. The UI
   * surfaces this so the distinction is never hidden.
   */
  degraded?: boolean;
}

/**
 * An article rewritten by the AI into clean, readable prose for in-app reading.
 * Produced on demand by the backend from the original article (or, for videos,
 * its transcript).
 */
export interface RewrittenArticle {
  id: string;
  /** Clean headline. */
  title: string;
  /** Readable body, one entry per paragraph. */
  paragraphs: string[];
  sourceTitle: string;
  /** Original article/video URL (for "open original"). */
  url: string;
  kind: Kind;
  /** Estimated read time in minutes. */
  estMinutes: number;
  /**
   * True when the full article body could not be retrieved (hard paywall /
   * JS-only page) and this is a SHORT brief synthesized only from the headline
   * and the feed's summary. The reader surfaces a banner so the distinction is
   * never hidden.
   */
  degraded?: boolean;
}

/**
 * Per-reader record of when a developing story was last VIEWED, plus a snapshot
 * of its state at that time. Comparing the live story against this snapshot tells
 * us what changed since (new articles / fresher coverage), powering the "last
 * minute" section and the per-card "new" indicator. Persisted locally; keyed by
 * story id.
 */
export interface StoryView {
  /** When the reader last opened this story (epoch ms). */
  seenAt: number;
  /** The story's `updatedAt` (most recent article time) as of that view. */
  updatedAt: number;
  /** The story's source-article count as of that view (delta -> new articles). */
  sourceCount: number;
}

/** Live backend build/analysis progress, surfaced from GET /api/status. */
export interface AnalysisStatus {
  /** Current pipeline stage, in order: fetching sources → triage (scan headlines)
   *  → analyzing (deep read) → embedding → synthesizing (stories) → idle. */
  phase: "idle" | "fetching" | "triage" | "transcripts" | "analyzing" | "embedding" | "synthesizing";
  /** Whether a build/analysis is currently running. */
  active: boolean;
  /** Items completed in the current pass. */
  done: number;
  /** Items in the current pass. */
  total: number;
  /** Items still awaiting deep analysis (the REAL remaining work, capped/deduped). */
  pending: number;
  /** Items analyzed and eligible for the feed (within the recency window). */
  analyzed: number;
  /** The world this status is for. */
  world?: string;
  /** Human-readable name of the PLACE/world currently getting updates (e.g. "Galicia",
   *  "Spain", "Front page") — shown in the indicator as "Updating <label>". */
  label?: string;
  /** If a DIFFERENT world is currently refreshing (only one runs at a time),
   *  its id; else null. The UI uses this to show a 'busy' banner. */
  busyWith?: string | null;
}

/** User preferences, persisted locally. */
export interface Preferences {
  /** Daily learning quota in minutes. */
  dailyQuotaMin: number;
  enabledTopics: Topic[];
  includeKinds: Kind[];
  /**
   * Free-text steering prompt sent to the backend AI to personalize relevance
   * (e.g. "AI and AI-related scientific progress"). Empty = general importance.
   */
  interestPrompt: string;
  /**
   * Absolute weighted-mean-lean above which the app warns you are drifting
   * (e.g. 0.25). Also drives feed counter-weighting.
   */
  driftThreshold: number;
  /** Set true once the user has completed onboarding. */
  onboarded: boolean;
  /** The active news world (set of sources). Defaults to the front page. */
  worldId: string;
  /**
   * Selected GEOGRAPHIC POOL id (`geo-<nodeId>`) from the coverage-map drill-down
   * (world → continent → country → region → province → locality). When set, it is
   * the EFFECTIVE pool — its node's own outlets feed it and everything they report
   * is shown. Overrides `worldId`. Absent = use the topical world.
   */
  geoPool?: string;
  /**
   * HOME geographic node id (`geo` tree node, e.g. "es-galicia-pontevedra-vigo").
   * Purely positional: it sets where the coverage-map navigator OPENS by default
   * when no pool is actively selected. It does NOT filter or boost results.
   */
  geoHome?: string;
  /** UI + AI-output language (the app is shown in this; AI writes in it too). */
  language: Lang;
  /** How the feed's topic sections are ordered. Defaults to relevance. */
  feedSort?: "relevance" | "recency";
}

/** Today's consumption progress, persisted locally and reset per day. */
export interface DailyProgress {
  /** ISO date (YYYY-MM-DD) this record is for. */
  date: string;
  consumedMin: number;
  completedItemIds: string[];
  /** Sum of (lean * estMinutes) over completed POLITICAL items. */
  leanWeightSum: number;
  /** Sum of estMinutes over completed POLITICAL items (denominator). */
  leanMinutesSum: number;
  /** Sum of estMinutes over completed LEFT-leaning (lean<0) items (center splits 50/50). */
  leftMinutesSum: number;
  /** Sum of estMinutes over completed RIGHT-leaning (lean>0) items (center splits 50/50). */
  rightMinutesSum: number;
}

/** A point in the trailing-window lean history (one per day). */
export interface LeanHistoryPoint {
  date: string;
  leanWeightSum: number;
  leanMinutesSum: number;
  leftMinutesSum: number;
  rightMinutesSum: number;
}

/**
 * The AI's assessment of a reader's recall summary, graded against the actual
 * article. `score` is 0..100; an item is considered "seen" only at/above the
 * pass threshold. The feedback fields exist to TEACH — what was right, what was
 * missed, what was wrong, and a one-line lesson.
 */
export interface SummaryGrade {
  /** Accuracy/coverage on 0..100. */
  score: number;
  /** One-line overall verdict. */
  verdict: string;
  /** Points the reader got right. */
  correct: string[];
  /** Important points the reader omitted. */
  missed: string[];
  /** Things the reader stated that are wrong/misleading. */
  inaccuracies: string[];
  /** A short, concrete lesson to correct the reader's understanding. */
  lesson: string;
}

/**
 * A reader's graded recall summary, persisted locally so it can be revisited and
 * rolled up into a knowledge profile. Carries enough item context to render the
 * Learn tab without re-fetching the (possibly aged-out) feed item.
 */
export interface StoredSummary {
  /** FeedItem id this summary is for. */
  id: string;
  title: string;
  sourceTitle: string;
  topic: Topic;
  url: string;
  /** The reader's own summary text. */
  summary: string;
  grade: SummaryGrade;
  /** Whether this summary passed the threshold (item counted as seen). */
  passed: boolean;
  gradedAt: number;
}

/** Per-topic mastery rolled up from graded summaries. */
export interface TopicMastery {
  topic: Topic;
  /** Number of graded summaries in this topic. */
  count: number;
  /** Mean score 0..100. */
  avgScore: number;
}

/**
 * Locally-computed knowledge profile: how well the reader recalls what they've
 * read, by topic, plus recurring weak concepts (things they repeatedly miss).
 */
export interface KnowledgeProfile {
  totalGraded: number;
  avgScore: number;
  topics: TopicMastery[];
  /** Topics the reader recalls poorly or has barely covered (the gaps). */
  weakTopics: Topic[];
  /** Recurring missed concepts/keywords across summaries. */
  weakConcepts: string[];
}

/** A gap-filling article suggestion with the AI's reason it helps. */
export interface KnowledgeSuggestion {
  id: string;
  reason: string;
}

/** AI-written narrative + suggestion reasons layered on the local profile. */
export interface KnowledgeInsight {
  /** A short narrative describing the reader's knowledge and gaps. */
  narrative: string;
  /** Gap-filling suggestions (subset of the candidates sent), with reasons. */
  suggestions: KnowledgeSuggestion[];
}
