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
}

/** User preferences, persisted locally. */
export interface Preferences {
  /** Daily learning quota in minutes. */
  dailyQuotaMin: number;
  enabledTopics: Topic[];
  includeKinds: Kind[];
  /** Opt-in: refine per-item lean via an LLM (needs an API key). */
  llmTaggingEnabled: boolean;
  llmApiKey?: string;
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
