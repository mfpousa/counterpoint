import { buildFeed, feedLeanBreakdown } from "../src/lib/buildFeed";
import type { DailyProgress, FeedItem, Preferences, Topic } from "../src/types";

let counter = 0;
function makeItem(over: Partial<FeedItem> = {}): FeedItem {
  counter += 1;
  return {
    id: `i${counter}`,
    sourceId: "s",
    sourceTitle: "Src",
    title: `t${counter}`,
    summary: "",
    url: `https://x/${counter}`,
    publishedAt: 1000 - counter, // stable, descending recency
    kind: "news",
    topic: "politics",
    lean: 0,
    confidence: 0.8,
    leanSource: "source",
    estMinutes: 10,
    ...over,
  };
}

const ALL_TOPICS: Topic[] = [
  "world",
  "politics",
  "economics",
  "science",
  "technology",
  "history",
  "health",
  "culture",
];

function makePrefs(over: Partial<Preferences> = {}): Preferences {
  return {
    dailyQuotaMin: 100,
    enabledTopics: ALL_TOPICS,
    includeKinds: ["news", "podcast", "video"],
    llmTaggingEnabled: false,
    interestPrompt: "",
    driftThreshold: 0.25,
    onboarded: true,
    ...over,
  };
}

function emptyProgress(over: Partial<DailyProgress> = {}): DailyProgress {
  return {
    date: "2026-01-01",
    consumedMin: 0,
    completedItemIds: [],
    leanWeightSum: 0,
    leanMinutesSum: 0,
    leftMinutesSum: 0,
    rightMinutesSum: 0,
    ...over,
  };
}

beforeEach(() => {
  counter = 0;
});

describe("buildFeed", () => {
  it("returns an empty feed when quota is already met", () => {
    const items = [makeItem({ lean: -0.5 }), makeItem({ lean: 0.5 })];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 30 }),
      progress: emptyProgress({ consumedMin: 30 }),
      now: 100000,
    });
    expect(feed).toEqual([]);
  });

  it("balances left and right political content roughly 50/50", () => {
    const items = [
      ...Array.from({ length: 10 }, () => makeItem({ lean: -0.6 })),
      ...Array.from({ length: 10 }, () => makeItem({ lean: 0.6 })),
    ];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 100 }),
      progress: emptyProgress(),
      now: 100000,
    });
    const { leftMin, rightMin } = feedLeanBreakdown(feed);
    // Within one item's worth of minutes of perfect balance.
    expect(Math.abs(leftMin - rightMin)).toBeLessThanOrEqual(10);
    expect(leftMin).toBeGreaterThan(0);
    expect(rightMin).toBeGreaterThan(0);
  });

  it("counter-weights toward the under-consumed side when drifting", () => {
    // Already consumed left-leaning content today -> feed should lead with right.
    const items = [
      ...Array.from({ length: 10 }, () => makeItem({ lean: -0.6 })),
      ...Array.from({ length: 10 }, () => makeItem({ lean: 0.6 })),
    ];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 200 }),
      progress: emptyProgress({
        consumedMin: 60,
        leanWeightSum: -36,
        leanMinutesSum: 60,
        leftMinutesSum: 60,
        rightMinutesSum: 0,
      }),
      now: 100000,
    });
    expect(feed[0].lean as number).toBeGreaterThan(0);
  });

  it("excludes already-completed items", () => {
    const done = makeItem({ lean: -0.5 });
    const items = [done, makeItem({ lean: 0.5 })];
    const feed = buildFeed({
      items,
      prefs: makePrefs(),
      progress: emptyProgress({ completedItemIds: [done.id] }),
      now: 100000,
    });
    expect(feed.find((i) => i.id === done.id)).toBeUndefined();
  });

  it("respects topic and kind filters", () => {
    const items = [
      makeItem({ topic: "science", lean: null }),
      makeItem({ topic: "politics", lean: -0.5, kind: "podcast" }),
      makeItem({ topic: "politics", lean: 0.5, kind: "news" }),
    ];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ enabledTopics: ["politics"], includeKinds: ["news"] }),
      progress: emptyProgress(),
      now: 100000,
    });
    expect(feed.every((i) => i.topic === "politics" && i.kind === "news")).toBe(true);
  });

  it("does not wildly overshoot the quota", () => {
    const items = Array.from({ length: 30 }, (_, n) =>
      makeItem({ lean: n % 2 === 0 ? -0.5 : 0.5, estMinutes: 12 }),
    );
    const remaining = 100;
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: remaining }),
      progress: emptyProgress(),
      now: 100000,
    });
    const total = feed.reduce((a, i) => a + i.estMinutes, 0);
    expect(total).toBeLessThanOrEqual(remaining + 12 * 0.5);
    expect(total).toBeGreaterThan(remaining * 0.6);
  });

  it("mixes in non-political learning when available", () => {
    const items = [
      ...Array.from({ length: 8 }, () => makeItem({ lean: -0.5 })),
      ...Array.from({ length: 8 }, () => makeItem({ lean: 0.5 })),
      ...Array.from({ length: 8 }, () => makeItem({ lean: null, topic: "science" })),
    ];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 150 }),
      progress: emptyProgress(),
      now: 100000,
    });
    expect(feed.some((i) => i.lean === null)).toBe(true);
    expect(feed.some((i) => i.lean !== null)).toBe(true);
  });

  it("spreads coverage across topics instead of letting one topic monopolize", () => {
    // A flood of recent culture items plus a few of other disciplines.
    const items = [
      ...Array.from({ length: 30 }, () => makeItem({ lean: null, topic: "culture" })),
      makeItem({ lean: null, topic: "science" }),
      makeItem({ lean: null, topic: "technology" }),
      makeItem({ lean: null, topic: "history" }),
      makeItem({ lean: null, topic: "health" }),
    ];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 100 }),
      progress: emptyProgress(),
      now: 100000,
    });
    const topics = new Set(feed.map((i) => i.topic));
    // The scarce non-culture topics must each surface before culture repeats.
    expect(topics.size).toBeGreaterThanOrEqual(4);
    const cultureCount = feed.filter((i) => i.topic === "culture").length;
    expect(cultureCount).toBeLessThan(feed.length);
  });

  it("excludes stale items older than the recency window", () => {
    const now = 100 * 24 * 60 * 60 * 1000; // day 100
    const fresh = makeItem({ lean: -0.5, publishedAt: now - 1000 });
    const stale = makeItem({ lean: 0.5, publishedAt: now - 30 * 24 * 60 * 60 * 1000 });
    const undated = makeItem({ lean: -0.5, publishedAt: 0 });
    const feed = buildFeed({
      items: [fresh, stale, undated],
      prefs: makePrefs(),
      progress: emptyProgress(),
      now,
    });
    expect(feed.find((i) => i.id === fresh.id)).toBeDefined();
    expect(feed.find((i) => i.id === stale.id)).toBeUndefined();
    expect(feed.find((i) => i.id === undated.id)).toBeUndefined();
  });

  it("attaches a reason to every selected item", () => {
    const items = [makeItem({ lean: -0.5 }), makeItem({ lean: 0.5 })];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 50 }),
      progress: emptyProgress(),
      now: 100000,
    });
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every((i) => typeof i.reason === "string" && i.reason.length > 0)).toBe(true);
  });
});
