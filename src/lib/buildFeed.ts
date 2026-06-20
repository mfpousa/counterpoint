// The feed engine. Pure & deterministic (no Math.random) so it is unit-testable.
//
// Goals, in order:
//  1. Fill ~the remaining daily quota (never wildly overshoot).
//  2. Balance the POLITICAL subset toward 50/50 left vs right, counter-weighted
//     by what you've already consumed today (pulls you back from drift).
//  3. Keep topics diverse (avoid same-topic back-to-back; spread disciplines).
//  4. Attach a human-readable "chosen because..." reason to every item.

import type { DailyProgress, FeedItem, Preferences } from "../types";
import { CONTESTED_TOPICS, isPolitical } from "./lean";

export interface BuildFeedInput {
  items: FeedItem[];
  prefs: Preferences;
  progress: DailyProgress;
  now?: number;
}

/** Share of feed minutes we aim to allocate to political/contested content. */
const POLITICAL_TARGET_SHARE = 0.55;
/** Allow the last item to overshoot the quota by at most this fraction of itself. */
const OVERSHOOT_TOLERANCE = 0.5;
/**
 * Only consider items published within this trailing window. Keeps the feed
 * relevant (no months-old posts) and prevents undated items — which the RSS
 * layer floors to epoch 0 — from leaking in.
 */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type Side = "left" | "right";

function sideOf(lean: number): Side | "center" {
  if (lean < 0) return "left";
  if (lean > 0) return "right";
  return "center";
}

/**
 * Seed the running left/right minutes from today's already-consumed directional
 * tally so the feed counter-weights toward the side you've under-consumed.
 */
function seedSides(progress: DailyProgress): { left: number; right: number } {
  return { left: progress.leftMinutesSum ?? 0, right: progress.rightMinutesSum ?? 0 };
}

/** Most-recent-first, with id as a stable tiebreaker. */
function byRecency(a: FeedItem, b: FeedItem): number {
  if (b.publishedAt !== a.publishedAt) return b.publishedAt - a.publishedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** AI relevance score, defaulting to neutral 0.5 when the item isn't enriched. */
function relevanceOf(it: FeedItem): number {
  return typeof it.relevance === "number" ? it.relevance : 0.5;
}

/**
 * Highest AI-relevance first, falling back to recency. This lets the backend's
 * relevance ranking drive what surfaces while keeping deterministic ordering
 * for un-enriched items (all 0.5 -> pure recency, preserving prior behavior).
 */
function byRelevanceThenRecency(a: FeedItem, b: FeedItem): number {
  const ra = relevanceOf(a);
  const rb = relevanceOf(b);
  if (rb !== ra) return rb - ra;
  return byRecency(a, b);
}

/**
 * Pick the best candidate to maximize topic variety.
 *
 * `pool` is pre-sorted most-recent-first, so we prefer the most recent item
 * whose topic is currently the LEAST represented in the feed so far (and, all
 * else equal, one different from the previous pick). This spreads coverage
 * across disciplines instead of letting whichever topic happens to publish most
 * often (e.g. culture) monopolize the feed.
 */
function pickDiverse(
  pool: FeedItem[],
  topicCounts: Map<string, number>,
  prevTopic: string | null,
): FeedItem | null {
  if (pool.length === 0) return null;

  let best: FeedItem | null = null;
  let bestScore = Infinity;
  for (const it of pool) {
    // Score: how many of this topic we've already taken, with a penalty for
    // repeating the immediately previous topic so we avoid back-to-back runs.
    const used = topicCounts.get(it.topic) ?? 0;
    const score = used * 2 + (it.topic === prevTopic ? 1 : 0);
    if (score < bestScore) {
      best = it;
      bestScore = score;
      if (score === 0) break; // can't do better than a fresh, non-repeating topic
    }
  }
  return best ?? pool[0];
}

export function buildFeed(input: BuildFeedInput): FeedItem[] {
  const { prefs, progress } = input;
  const now = input.now ?? Date.now();

  // 1. Filter.
  const enabledTopics = new Set(prefs.enabledTopics);
  const enabledKinds = new Set(prefs.includeKinds);
  const completed = new Set(progress.completedItemIds);
  const seen = new Set<string>();

  const candidates = input.items
    .filter((it) => {
      if (completed.has(it.id) || seen.has(it.id)) return false;
      seen.add(it.id);
      if (!enabledTopics.has(it.topic)) return false;
      if (!enabledKinds.has(it.kind)) return false;
      if (it.publishedAt > now) return false;
      if (now - it.publishedAt > MAX_AGE_MS) return false;
      return true;
    })
    .sort(byRelevanceThenRecency);

  const remaining = Math.max(0, prefs.dailyQuotaMin - progress.consumedMin);
  if (remaining <= 0 || candidates.length === 0) return [];

  const political = candidates.filter(isPolitical);
  const nonPolitical = candidates.filter((it) => !isPolitical(it));

  const seed = seedSides(progress);
  let runLeft = seed.left;
  let runRight = seed.right;
  let polMinutes = 0;
  let totalMinutes = 0;

  const result: FeedItem[] = [];
  let prevTopic: string | null = null;
  // How many items of each topic we've taken so far, to spread coverage.
  const topicCounts = new Map<string, number>();

  const take = (it: FeedItem, source: FeedItem[], reason: string) => {
    const idx = source.indexOf(it);
    if (idx >= 0) source.splice(idx, 1);
    // Push a copy so we never mutate the shared pool item (this runs in render).
    result.push({ ...it, reason });
    totalMinutes += it.estMinutes;
    prevTopic = it.topic;
    topicCounts.set(it.topic, (topicCounts.get(it.topic) ?? 0) + 1);
  };

  const fits = (it: FeedItem) => {
    const after = totalMinutes + it.estMinutes;
    return after <= remaining + it.estMinutes * OVERSHOOT_TOLERANCE;
  };

  while (totalMinutes < remaining) {
    const wantPolitical =
      political.length > 0 &&
      (nonPolitical.length === 0 ||
        polMinutes / Math.max(1, totalMinutes) < POLITICAL_TARGET_SHARE);

    let chosen: FeedItem | null = null;

    if (wantPolitical) {
      // Choose the side that reduces the left/right imbalance.
      const needSide: Side = runLeft <= runRight ? "left" : "right";
      const sided = political.filter((it) => sideOf(it.lean as number) === needSide);
      const center = political.filter((it) => sideOf(it.lean as number) === "center");
      const other = political.filter(
        (it) => sideOf(it.lean as number) !== needSide && sideOf(it.lean as number) !== "center",
      );

      chosen =
        pickDiverse(sided, topicCounts, prevTopic) ??
        pickDiverse(center, topicCounts, prevTopic) ??
        pickDiverse(other, topicCounts, prevTopic);

      if (chosen && fits(chosen)) {
        const s = sideOf(chosen.lean as number);
        if (s === "left") runLeft += chosen.estMinutes;
        else if (s === "right") runRight += chosen.estMinutes;
        else {
          runLeft += chosen.estMinutes / 2;
          runRight += chosen.estMinutes / 2;
        }
        polMinutes += chosen.estMinutes;
        const drifting = seed.left !== seed.right;
        const reason = drifting
          ? `Counterweight — a ${needSide}-leaning view to balance your day`
          : `Balancing perspectives — a ${needSide}-leaning take on ${chosen.topic}`;
        take(chosen, political, reason);
        continue;
      }
      chosen = null;
    }

    // Non-political (or political didn't fit): broaden topics.
    const npChoice = pickDiverse(nonPolitical, topicCounts, prevTopic);
    if (npChoice && fits(npChoice)) {
      take(npChoice, nonPolitical, `Broadening your learning — ${npChoice.topic}`);
      continue;
    }

    // If nothing on the preferred lane fits, try any political that fits.
    const anyPol = political.find(fits);
    if (anyPol) {
      const s = sideOf(anyPol.lean as number);
      if (s === "left") runLeft += anyPol.estMinutes;
      else if (s === "right") runRight += anyPol.estMinutes;
      else {
        runLeft += anyPol.estMinutes / 2;
        runRight += anyPol.estMinutes / 2;
      }
      polMinutes += anyPol.estMinutes;
      take(anyPol, political, `Balancing perspectives — ${anyPol.topic}`);
      continue;
    }

    break; // nothing else fits the budget
  }

  return result;
}

/** Convenience: minutes of left/right/center political content in a built feed. */
export function feedLeanBreakdown(items: FeedItem[]): {
  leftMin: number;
  rightMin: number;
  centerMin: number;
  nonPoliticalMin: number;
} {
  let leftMin = 0;
  let rightMin = 0;
  let centerMin = 0;
  let nonPoliticalMin = 0;
  for (const it of items) {
    if (!isPolitical(it)) {
      nonPoliticalMin += it.estMinutes;
      continue;
    }
    const lean = it.lean as number;
    if (lean < 0) leftMin += it.estMinutes;
    else if (lean > 0) rightMin += it.estMinutes;
    else centerMin += it.estMinutes;
  }
  return { leftMin, rightMin, centerMin, nonPoliticalMin };
}

// Re-export for callers that want the contested-topic list alongside the engine.
export { CONTESTED_TOPICS };
