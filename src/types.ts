// Core domain types for Counterpoint.

/** What kind of media an item is. */
export type Kind = "video" | "podcast" | "news";

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

/** Live backend build/analysis progress, surfaced from GET /api/status. */
export interface AnalysisStatus {
  /** Current phase: idle | fetching | triage | transcripts | analyzing. */
  phase: "idle" | "fetching" | "triage" | "transcripts" | "analyzing";
  /** Whether a build/analysis is currently running. */
  active: boolean;
  /** Items completed in the current pass. */
  done: number;
  /** Items in the current pass. */
  total: number;
  /** Items still awaiting deep analysis (within the recency window). */
  pending: number;
  /** Items analyzed and eligible for the feed (within the recency window). */
  analyzed: number;
  /** The world this status is for. */
  world?: string;
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
