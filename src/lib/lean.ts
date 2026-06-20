// Pure helpers for the perspective-lean spectrum and the consumed-lean tracker.

import type { DailyProgress, FeedItem, Lean, LeanHistoryPoint, Topic } from "../types";

/** Topics where left/right balancing is meaningful. */
export const CONTESTED_TOPICS: Topic[] = ["politics", "world", "economics"];

export type LeanBucket = "left" | "lean-left" | "center" | "lean-right" | "right";

/** Map a continuous lean (-1..+1) to a display bucket. */
export function leanBucket(lean: Lean): LeanBucket | "non-political" {
  if (lean === null || Number.isNaN(lean)) return "non-political";
  if (lean <= -0.6) return "left";
  if (lean <= -0.2) return "lean-left";
  if (lean < 0.2) return "center";
  if (lean < 0.6) return "lean-right";
  return "right";
}

export function leanBucketLabel(bucket: LeanBucket | "non-political"): string {
  switch (bucket) {
    case "left":
      return "Left";
    case "lean-left":
      return "Lean left";
    case "center":
      return "Center";
    case "lean-right":
      return "Lean right";
    case "right":
      return "Right";
    case "non-political":
      return "Non-political";
  }
}

/** True if an item participates in left/right balance math. */
export function isPolitical(item: { lean: Lean }): boolean {
  return item.lean !== null && !Number.isNaN(item.lean as number);
}

/**
 * Weighted mean lean of completed political content.
 * Returns null when no political content has been consumed.
 */
export function meanLean(weightSum: number, minutesSum: number): number | null {
  if (minutesSum <= 0) return null;
  return weightSum / minutesSum;
}

export type DriftStatus = {
  mean: number | null;
  /** "balanced" | "left" | "right" — which way you're drifting. */
  direction: "balanced" | "left" | "right";
  /** True when |mean| exceeds the threshold. */
  warn: boolean;
  /** 0..1 share of consumed political minutes that were left-leaning. */
  leftShare: number;
  rightShare: number;
};

/**
 * Assess drift from a 50/50 balance given a weighted tally and a threshold.
 * `leftShare`/`rightShare` are computed from the directional split of minutes.
 */
export function assessDrift(
  weightSum: number,
  minutesSum: number,
  leftMinutes: number,
  rightMinutes: number,
  threshold: number,
): DriftStatus {
  const mean = meanLean(weightSum, minutesSum);
  const sided = leftMinutes + rightMinutes;
  const leftShare = sided > 0 ? leftMinutes / sided : 0.5;
  const rightShare = sided > 0 ? rightMinutes / sided : 0.5;
  let direction: DriftStatus["direction"] = "balanced";
  let warn = false;
  if (mean !== null && Math.abs(mean) > threshold) {
    warn = true;
    direction = mean < 0 ? "left" : "right";
  }
  return { mean, direction, warn, leftShare, rightShare };
}

/**
 * Fold a completed item into a progress tally. Pure: returns a NEW progress.
 * Non-political items advance consumedMin only (they don't touch lean math).
 */
export function applyCompletion(progress: DailyProgress, item: FeedItem): DailyProgress {
  if (progress.completedItemIds.includes(item.id)) return progress;
  const next: DailyProgress = {
    ...progress,
    consumedMin: progress.consumedMin + item.estMinutes,
    completedItemIds: [...progress.completedItemIds, item.id],
  };
  if (isPolitical(item)) {
    const lean = item.lean as number;
    next.leanWeightSum = progress.leanWeightSum + lean * item.estMinutes;
    next.leanMinutesSum = progress.leanMinutesSum + item.estMinutes;
    if (lean < 0) {
      next.leftMinutesSum = progress.leftMinutesSum + item.estMinutes;
    } else if (lean > 0) {
      next.rightMinutesSum = progress.rightMinutesSum + item.estMinutes;
    } else {
      // Exactly-center content contributes equally to both sides.
      next.leftMinutesSum = progress.leftMinutesSum + item.estMinutes / 2;
      next.rightMinutesSum = progress.rightMinutesSum + item.estMinutes / 2;
    }
  }
  return next;
}

/** Aggregate a trailing window of daily history into a single drift status. */
export function windowDrift(history: LeanHistoryPoint[], threshold: number): DriftStatus {
  const weightSum = history.reduce((a, h) => a + h.leanWeightSum, 0);
  const minutesSum = history.reduce((a, h) => a + h.leanMinutesSum, 0);
  const leftMin = history.reduce((a, h) => a + (h.leftMinutesSum ?? 0), 0);
  const rightMin = history.reduce((a, h) => a + (h.rightMinutesSum ?? 0), 0);
  return assessDrift(weightSum, minutesSum, leftMin, rightMin, threshold);
}
