import { topLocalBacklog } from "../server/feedService";
import type { StoredItem } from "../server/store";
import type { FeedItem } from "../src/types";

let counter = 0;
function stored(over: { prescreen?: number; analyzed?: boolean; publishedAt?: number } = {}): StoredItem {
  counter += 1;
  const item = {
    id: `i${counter}`,
    sourceId: "s",
    sourceTitle: "Src",
    title: `t${counter}`,
    summary: "",
    url: `https://x/${counter}`,
    publishedAt: over.publishedAt ?? 1000 - counter,
    kind: "news",
    topic: "politics",
    lean: 0,
    confidence: 0.8,
    estMinutes: 10,
  } as unknown as FeedItem;
  return {
    item,
    clickbait: false,
    analyzed: over.analyzed ?? false,
    topic: "politics",
    lean: 0,
    importance: 0,
    summary: "",
    keywords: [],
    analyzedAt: 0,
    prescreenImportance: over.prescreen,
  };
}

describe("topLocalBacklog (regional deep-analysis gate)", () => {
  it("returns the un-analyzed members of the TOP-keep by coarse importance, importance-first", () => {
    const a = stored({ prescreen: 0.9 });
    const b = stored({ prescreen: 0.8 });
    const c = stored({ prescreen: 0.3 });
    const d = stored({ prescreen: 0.1 });
    const out = topLocalBacklog([d, b, a, c], 2);
    expect(out.map((s) => s.item.id)).toEqual([a.item.id, b.item.id]);
  });

  it("never exceeds keep total: analyzed items in the top-N still occupy their slot", () => {
    // Top-2 are the 0.9 (already analyzed) and 0.8 (pending). Only the 0.8 is
    // returned — the 0.5 below the cut is NOT topped up into the freed slot.
    const top = stored({ prescreen: 0.9, analyzed: true });
    const mid = stored({ prescreen: 0.8 });
    const low = stored({ prescreen: 0.5 });
    const out = topLocalBacklog([low, top, mid], 2);
    expect(out.map((s) => s.item.id)).toEqual([mid.item.id]);
  });

  it("treats missing coarse importance as the neutral 0.5 default", () => {
    const known = stored({ prescreen: 0.6 });
    const unknown = stored({}); // undefined -> 0.5
    const out = topLocalBacklog([unknown, known], 5);
    expect(out.map((s) => s.item.id)).toEqual([known.item.id, unknown.item.id]);
  });

  it("keep <= 0 means no cap (analyze every un-analyzed survivor)", () => {
    const items = [stored({ prescreen: 0.2 }), stored({ prescreen: 0.9, analyzed: true }), stored({ prescreen: 0.4 })];
    const out = topLocalBacklog(items, 0);
    expect(out).toHaveLength(2); // both un-analyzed kept
  });
});
