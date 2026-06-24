// PURE story-planning pipeline: cluster the analyzed pool into same-event groups,
// roll those into ongoing issues, keep the developing ones, and pick the top event
// stories — returning lightweight SPECS (article-id groupings + centroids), NOT the
// articles themselves. No I/O, no model calls, no config/env reads: everything it
// needs is passed in. That makes it (a) trivially unit-testable and (b) safe to run
// inside a worker_threads worker (see clusterWorker.ts / clusterPool.ts), so the
// O(n^2) clustering never blocks the server's event loop during a view switch.

import {
  clusterItems,
  coverageOf,
  groupIntoIssues,
  isDevelopingIssue,
  rankClusters,
  type ClusterInput,
} from "./cluster";
import type { StoryKind } from "./storyStore";

/** Every threshold computeStoryPlan needs, passed explicitly so the function stays pure
 *  (and serializable across the worker boundary). Mirrors config.stories.* one-to-one. */
export interface StoryPlanConfig {
  simThreshold: number;
  textSimThreshold: number;
  windowMs: number;
  issueSimThreshold: number;
  issueTextSimThreshold: number;
  issueWindowMs: number;
  issueMinSpanMs: number;
  issueMinEvents: number;
  issueMinSources: number;
  issueActiveMs: number;
  maxIssues: number;
  minSources: number;
  maxStories: number;
}

/** A planned story, by article ID (the caller maps ids back to its StoredItems). */
export interface PlanSpec {
  kind: StoryKind;
  /** All article ids in the story (sorted-independent; caller sorts for matching). */
  memberIds: string[];
  /** For an ISSUE: its sub-events as id groups, earliest-first (the timeline). */
  eventIds?: string[][];
  /** Mean embedding for ranking/relating; null in text-only mode. */
  centroid: number[] | null;
}

/** Diagnostics for the per-build log line (why issues passed/failed the developing gate). */
export interface StoryPlanStats {
  eligible: number;
  clusters: number;
  issues: number;
  developing: number;
  topEvents: number;
  failEvents: number;
  failSpan: number;
  failSources: number;
  failActive: number;
}

export interface StoryPlan {
  specs: PlanSpec[];
  stats: StoryPlanStats;
}

/**
 * Deterministic, model-free plan: inputs (one per eligible article) -> story specs.
 * `now` is injectable so the developing-recency gate is testable. Identical output to
 * the previous inline pipeline in getStories — only relocated so it can run off-thread.
 */
export function computeStoryPlan(
  inputs: ClusterInput[],
  cfg: StoryPlanConfig,
  now: number = Date.now(),
): StoryPlan {
  // Level 1: dedupe into same-event clusters.
  const clusters = clusterItems(inputs, {
    simThreshold: cfg.simThreshold,
    textSimThreshold: cfg.textSimThreshold,
    windowMs: cfg.windowMs,
  });

  // Level 2: group event clusters into broader ongoing issues, keep the DEVELOPING ones.
  const issues = groupIntoIssues(clusters, {
    simThreshold: cfg.issueSimThreshold,
    textSimThreshold: cfg.issueTextSimThreshold,
    windowMs: cfg.issueWindowMs,
  });
  const developing = issues
    .filter((iss) =>
      isDevelopingIssue(iss, {
        minSpanMs: cfg.issueMinSpanMs,
        minEvents: cfg.issueMinEvents,
        minSources: cfg.issueMinSources,
        activeMs: cfg.issueActiveMs,
        now,
      }),
    )
    .sort((a, b) => {
      const sa = coverageOf(a.members);
      const sb = coverageOf(b.members);
      if (sb !== sa) return sb - sa;
      return b.latestAt - a.latestAt;
    })
    .slice(0, cfg.maxIssues);

  // Which developing gate rejected each failing issue (for the diagnostic log).
  let failEvents = 0;
  let failSpan = 0;
  let failSources = 0;
  let failActive = 0;
  for (const iss of issues) {
    const okEvents = iss.clusters.length >= cfg.issueMinEvents;
    const okSpan = iss.latestAt - iss.earliestAt >= cfg.issueMinSpanMs;
    const okSources = coverageOf(iss.members) >= cfg.issueMinSources;
    const okActive = now - iss.latestAt <= cfg.issueActiveMs;
    if (!(okEvents && okSpan && okSources && okActive)) {
      if (!okEvents) failEvents += 1;
      if (!okSpan) failSpan += 1;
      if (!okSources) failSources += 1;
      if (!okActive) failActive += 1;
    }
  }

  // Every multi-source cluster becomes an event story (including issue members — the
  // client links each up to its umbrella issue). Issues get the remaining slots first.
  const eventCandidates = clusters.filter((c) => coverageOf(c.members) >= cfg.minSources);
  const remainingSlots = Math.max(0, cfg.maxStories - developing.length);
  const topEvents = rankClusters(eventCandidates).slice(0, remainingSlots);

  const specs: PlanSpec[] = [
    ...developing.map(
      (iss): PlanSpec => ({
        kind: "issue",
        memberIds: iss.members.map((m) => m.id),
        eventIds: iss.clusters
          .map((c) => c.members.map((m) => m.id))
          .filter((e) => e.length > 0),
        centroid: iss.centroid,
      }),
    ),
    ...topEvents.map(
      (c): PlanSpec => ({
        kind: "event",
        memberIds: c.members.map((m) => m.id),
        centroid: c.centroid,
      }),
    ),
  ].filter((s) => s.memberIds.length > 0);

  return {
    specs,
    stats: {
      eligible: inputs.length,
      clusters: clusters.length,
      issues: issues.length,
      developing: developing.length,
      topEvents: topEvents.length,
      failEvents,
      failSpan,
      failSources,
      failActive,
    },
  };
}
