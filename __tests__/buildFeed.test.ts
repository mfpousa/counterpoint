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
    interestPrompt: "",
    driftThreshold: 0.25,
    onboarded: true,
    worldId: "frontpage",
    language: "en",
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

  it("keeps already-completed items visible, after the fresh picks", () => {
    const done = makeItem({ lean: -0.5 });
    const fresh = makeItem({ lean: 0.5 });
    const items = [done, fresh];
    const feed = buildFeed({
      items,
      prefs: makePrefs(),
      progress: emptyProgress({ completedItemIds: [done.id] }),
      now: 100000,
    });
    // The read item is still shown so it can be revisited...
    const completed = feed.find((i) => i.id === done.id);
    expect(completed).toBeDefined();
    // ...but it is appended after the freshly-built (unread) picks.
    expect(feed.findIndex((i) => i.id === fresh.id)).toBeLessThan(
      feed.findIndex((i) => i.id === done.id),
    );
  });

  it("shows completed items even when the daily quota is exhausted", () => {
    const done = makeItem({ lean: -0.5 });
    const feed = buildFeed({
      items: [done, makeItem({ lean: 0.5 })],
      prefs: makePrefs({ dailyQuotaMin: 30 }),
      progress: emptyProgress({ completedItemIds: [done.id], consumedMin: 60 }),
      now: 100000,
    });
    expect(feed.map((i) => i.id)).toEqual([done.id]);
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

  it("interest/search mode orders by relevance and lets relevant items override the political quota", () => {
    const items = [
      makeItem({ lean: null, topic: "technology", relevance: 0.95 }),
      makeItem({ lean: null, topic: "science", relevance: 0.9 }),
      makeItem({ lean: -0.6, topic: "politics", relevance: 0.2 }),
      makeItem({ lean: 0.6, topic: "politics", relevance: 0.15 }),
    ];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ interestPrompt: "ai", dailyQuotaMin: 40 }),
      progress: emptyProgress(),
      now: 100000,
    });
    // Highest-relevance items surface first, even though they're non-political
    // (the balance-first engine would have forced a political item to the top).
    expect(feed[0].relevance).toBe(0.95);
    expect(feed[1].relevance).toBe(0.9);
    expect(feed[0].lean).toBeNull();
    // Every pick is reason-tagged as an interest match.
    expect(feed.every((i) => (i.reason ?? "").startsWith('Matches "ai"'))).toBe(true);
  });

  it("without an interest, behavior is unchanged (balance-first, no relevance reordering)", () => {
    // Same items as above but no interest: the engine should still enforce
    // political/topic balance rather than relevance ordering.
    const items = [
      makeItem({ lean: null, topic: "technology", relevance: 0.95 }),
      makeItem({ lean: -0.6, topic: "politics", relevance: 0.2 }),
      makeItem({ lean: 0.6, topic: "politics", relevance: 0.15 }),
    ];
    const feed = buildFeed({
      items,
      prefs: makePrefs({ interestPrompt: "", dailyQuotaMin: 60 }),
      progress: emptyProgress(),
      now: 100000,
    });
    // Political content is present (would be excluded if relevance led).
    expect(feed.some((i) => i.lean !== null)).toBe(true);
    expect(feed.every((i) => !(i.reason ?? "").startsWith("Matches"))).toBe(true);
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

  it("never labels a same-side (reinforcing) pick as a counterweight", () => {
    // Drifting RIGHT today, but ONLY right-leaning items are available. The
    // engine must still surface them, but must NOT claim a right article
    // "balances" a right-leaning day.
    const items = Array.from({ length: 6 }, () => makeItem({ lean: 0.6 }));
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 100 }),
      progress: emptyProgress({
        consumedMin: 60,
        leanWeightSum: 36,
        leanMinutesSum: 60,
        leftMinutesSum: 0,
        rightMinutesSum: 60,
      }),
      now: 100000,
    });
    const rightPicks = feed.filter((i) => (i.lean as number) > 0);
    expect(rightPicks.length).toBeGreaterThan(0);
    for (const i of rightPicks) {
      expect(i.reason ?? "").not.toMatch(/balance your day/);
      expect(i.reason ?? "").not.toMatch(/Counterweight/);
      // Honestly described by its actual side.
      expect(i.reason ?? "").toContain("right-leaning take");
    }
  });

  it("labels center political picks as center, not as a leaning view", () => {
    const items = Array.from({ length: 5 }, () => makeItem({ lean: 0, topic: "politics" }));
    const feed = buildFeed({
      items,
      prefs: makePrefs({ dailyQuotaMin: 100 }),
      progress: emptyProgress(),
      now: 100000,
    });
    const centerPicks = feed.filter((i) => i.lean === 0);
    expect(centerPicks.length).toBeGreaterThan(0);
    for (const i of centerPicks) {
      expect(i.reason ?? "").not.toMatch(/leaning view|leaning take|balance your day/);
      expect(i.reason ?? "").toContain("center take");
    }
  });

  it("reserves the 'balance your day' message for genuine leaning counterweights", () => {
    // Drifting LEFT; both sides available. As the feed rebalances, the running
    // tally can flip which side is under-consumed, so EITHER side may legitimately
    // carry the balance message — but a CENTER pick never should.
    const items = [
      ...Array.from({ length: 6 }, () => makeItem({ lean: -0.6 })),
      ...Array.from({ length: 6 }, () => makeItem({ lean: 0.6 })),
      ...Array.from({ length: 4 }, () => makeItem({ lean: 0 })),
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
    const balancing = feed.filter((i) => (i.reason ?? "").includes("balance your day"));
    expect(balancing.length).toBeGreaterThan(0);
    for (const i of balancing) {
      // A counterweight is always a real left/right view, never a center item.
      expect(i.lean as number).not.toBe(0);
      expect(i.reason ?? "").toMatch(/(left|right)-leaning view/);
    }
  });
});
