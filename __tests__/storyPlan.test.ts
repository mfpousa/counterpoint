import { computeStoryPlan, type StoryPlanConfig } from "../server/storyPlan";
import type { ClusterInput } from "../server/cluster";

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// Text-mode clustering (no embeddings): titles drive Jaccard similarity.
function item(id: string, sourceId: string, words: string, hoursAgo = 1): ClusterInput {
  return {
    id,
    sourceId,
    publishedAt: NOW - hoursAgo * HOUR,
    topic: "world",
    importance: 0.8,
    title: words,
    keywords: words.split(" "),
  };
}

// Loose-but-sane defaults; individual tests tighten what they care about.
const cfg = (over: Partial<StoryPlanConfig> = {}): StoryPlanConfig => ({
  simThreshold: 0.8,
  textSimThreshold: 0.5,
  windowMs: 48 * HOUR,
  issueSimThreshold: 0.5,
  issueTextSimThreshold: 0.3,
  issueWindowMs: 14 * 24 * HOUR,
  issueMinSpanMs: 6 * HOUR,
  issueMinEvents: 2,
  issueMinSources: 3,
  issueActiveMs: 7 * 24 * HOUR,
  maxIssues: 5,
  minSources: 2,
  maxStories: 10,
  ...over,
});

describe("computeStoryPlan", () => {
  it("returns nothing for an empty pool", () => {
    const { specs, stats } = computeStoryPlan([], cfg(), NOW);
    expect(specs).toEqual([]);
    expect(stats.eligible).toBe(0);
    expect(stats.clusters).toBe(0);
  });

  it("makes ONE event spec from a multi-source same-event cluster", () => {
    const inputs = [
      item("a", "s1", "central bank raises interest rates sharply"),
      item("b", "s2", "central bank raises interest rates sharply"),
      item("c", "s3", "central bank raises interest rates sharply"),
    ];
    const { specs, stats } = computeStoryPlan(inputs, cfg(), NOW);
    expect(stats.clusters).toBe(1);
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe("event");
    expect(new Set(specs[0].memberIds)).toEqual(new Set(["a", "b", "c"]));
  });

  it("drops a cluster below minSources (single outlet)", () => {
    const inputs = [
      item("a", "s1", "central bank raises interest rates sharply"),
      item("b", "s2", "central bank raises interest rates sharply"),
      item("lonely", "s9", "rare orchid blooms in remote mountain valley"),
    ];
    const { specs } = computeStoryPlan(inputs, cfg({ minSources: 2 }), NOW);
    expect(specs).toHaveLength(1);
    expect(specs[0].memberIds).not.toContain("lonely");
  });

  it("emits a DEVELOPING issue spec (with a timeline) when several sub-events span time", () => {
    // Two distinct sub-events of the same storyline, days apart, many outlets each.
    const inputs = [
      item("e1a", "s1", "border conflict troops clash at frontier", 80),
      item("e1b", "s2", "border conflict troops clash at frontier", 79),
      item("e1c", "s3", "border conflict troops clash at frontier", 78),
      item("e2a", "s1", "border conflict ceasefire talks begin", 4),
      item("e2b", "s2", "border conflict ceasefire talks begin", 3),
      item("e2c", "s4", "border conflict ceasefire talks begin", 2),
    ];
    const { specs } = computeStoryPlan(
      inputs,
      // The two sub-events share only "border conflict", so loosen the issue-merge text
      // threshold enough to roll them into one storyline.
      cfg({ issueMinEvents: 2, issueMinSources: 3, issueMinSpanMs: 6 * HOUR, issueTextSimThreshold: 0.2 }),
      NOW,
    );
    const issue = specs.find((s) => s.kind === "issue");
    expect(issue).toBeDefined();
    // The issue carries its sub-events as id groups (the timeline).
    expect(issue!.eventIds && issue!.eventIds.length).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic (same inputs -> same plan)", () => {
    const inputs = [
      item("a", "s1", "central bank raises interest rates sharply"),
      item("b", "s2", "central bank raises interest rates sharply"),
      item("c", "s3", "tech giant unveils new phone lineup"),
      item("d", "s4", "tech giant unveils new phone lineup"),
    ];
    const one = computeStoryPlan(inputs, cfg(), NOW);
    const two = computeStoryPlan(inputs, cfg(), NOW);
    expect(one).toEqual(two);
  });
});
