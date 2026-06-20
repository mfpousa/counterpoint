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
