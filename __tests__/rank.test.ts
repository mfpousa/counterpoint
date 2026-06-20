import { rankItems } from "../server/rank";
import type { FeedItem } from "../src/types";

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
    publishedAt: 1000 - counter,
    kind: "news",
    topic: "politics",
    lean: 0,
    confidence: 0.8,
    leanSource: "llm",
    estMinutes: 5,
    relevance: 0.5,
    ...over,
  };
}

beforeEach(() => {
  counter = 0;
});

describe("rankItems", () => {
  it("returns all items by default and is deterministic", () => {
    const items = [makeItem(), makeItem(), makeItem()];
    const a = rankItems(items, { now: 100000 });
    const b = rankItems(items, { now: 100000 });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(a).toHaveLength(3);
  });

  it("surfaces higher-relevance items first (recencyWeight 0)", () => {
    const low = makeItem({ relevance: 0.1, sourceId: "a", topic: "world" });
    const high = makeItem({ relevance: 0.9, sourceId: "b", topic: "science" });
    const ranked = rankItems([low, high], { now: 100000, recencyWeight: 0 });
    expect(ranked[0].id).toBe(high.id);
  });

  it("spreads topics instead of clustering one subject", () => {
    // Five high-relevance politics items + one each of three other topics.
    const items = [
      ...Array.from({ length: 5 }, () =>
        makeItem({ topic: "politics", sourceId: "p", relevance: 0.9 }),
      ),
      makeItem({ topic: "science", sourceId: "s1", relevance: 0.7 }),
      makeItem({ topic: "technology", sourceId: "s2", relevance: 0.7 }),
      makeItem({ topic: "history", sourceId: "s3", relevance: 0.7 }),
    ];
    const top4 = rankItems(items, { now: 100000, recencyWeight: 0 }).slice(0, 4);
    const topics = new Set(top4.map((i) => i.topic));
    // Variety: the non-politics topics surface despite lower relevance.
    expect(topics.size).toBeGreaterThanOrEqual(3);
  });

  it("balances left/right rather than stacking one side", () => {
    const items = [
      ...Array.from({ length: 6 }, () =>
        makeItem({ lean: -0.6, topic: "politics", sourceId: "L", relevance: 0.9 }),
      ),
      ...Array.from({ length: 6 }, () =>
        makeItem({ lean: 0.6, topic: "world", sourceId: "R", relevance: 0.6 }),
      ),
    ];
    const top6 = rankItems(items, { now: 100000, recencyWeight: 0 }).slice(0, 6);
    const left = top6.filter((i) => (i.lean as number) < 0).length;
    const right = top6.filter((i) => (i.lean as number) > 0).length;
    // Despite left items being more "relevant", the side penalty keeps it mixed.
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  });

  it("respects the limit argument", () => {
    const items = Array.from({ length: 10 }, () => makeItem());
    expect(rankItems(items, { now: 100000 }, 3)).toHaveLength(3);
  });
});
