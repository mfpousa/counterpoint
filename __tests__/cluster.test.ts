import {
  clusterItems,
  distinctSources,
  jaccard,
  rankClusters,
  titleTokens,
  type ClusterInput,
} from "../server/cluster";
import { storyId } from "../server/synthesize";

const DAY = 24 * 60 * 60 * 1000;
const OPTS = { simThreshold: 0.82, textSimThreshold: 0.3, windowMs: 2 * DAY };

let n = 0;
function item(over: Partial<ClusterInput> = {}): ClusterInput {
  n += 1;
  return {
    id: `i${n}`,
    sourceId: `s${n}`,
    publishedAt: 1_000_000,
    topic: "world",
    importance: 0.5,
    title: `headline ${n}`,
    keywords: [],
    ...over,
  };
}

beforeEach(() => {
  n = 0;
});

describe("titleTokens / jaccard", () => {
  it("keeps content words, drops stopwords and short noise", () => {
    expect([...titleTokens("The Senate passes a budget bill")].sort()).toEqual(
      ["bill", "budget", "passes", "senate"].sort(),
    );
  });

  it("includes keywords and computes overlap", () => {
    const a = titleTokens("Budget bill passes Senate", ["fiscal"]);
    const b = titleTokens("Senate passes the budget bill");
    expect(jaccard(a, b)).toBeGreaterThan(0.5);
    expect(jaccard(titleTokens("Volcano erupts Iceland"), b)).toBe(0);
  });
});

describe("clusterItems (embedding mode)", () => {
  it("groups semantically similar, recent articles and separates dissimilar ones", () => {
    const a1 = item({ sourceId: "s1", embedding: [1, 0] });
    const a2 = item({ sourceId: "s2", embedding: [0.98, 0.05] });
    const b = item({ sourceId: "s3", embedding: [0, 1] });
    const clusters = clusterItems([a1, a2, b], OPTS);
    // a1+a2 together, b alone.
    const sizes = clusters.map((c) => c.members.length).sort();
    expect(sizes).toEqual([1, 2]);
    const big = clusters.find((c) => c.members.length === 2)!;
    expect(new Set(big.members.map((m) => m.id))).toEqual(new Set([a1.id, a2.id]));
  });

  it("does NOT merge similar articles published outside the time window", () => {
    const a1 = item({ sourceId: "s1", embedding: [1, 0], publishedAt: 0 });
    const a2 = item({ sourceId: "s2", embedding: [1, 0], publishedAt: 5 * DAY });
    const clusters = clusterItems([a1, a2], OPTS);
    expect(clusters).toHaveLength(2);
  });
});

describe("clusterItems (text fallback, no embeddings)", () => {
  it("clusters by title/keyword overlap when no vectors are present", () => {
    const a1 = item({ sourceId: "s1", title: "Senate passes budget bill" });
    const a2 = item({ sourceId: "s2", title: "Budget bill passes the Senate" });
    const b = item({ sourceId: "s3", title: "Volcano erupts in Iceland" });
    const clusters = clusterItems([a1, a2, b], OPTS);
    const sizes = clusters.map((c) => c.members.length).sort();
    expect(sizes).toEqual([1, 2]);
  });
});

describe("distinctSources / rankClusters", () => {
  it("counts distinct sources (not raw members)", () => {
    const members = [item({ sourceId: "x" }), item({ sourceId: "x" }), item({ sourceId: "y" })];
    expect(distinctSources(members)).toBe(2);
  });

  it("ranks clusters with more outlets first, then importance", () => {
    const small = { members: [item({ sourceId: "a", importance: 0.9 })], centroid: null };
    const big = {
      members: [item({ sourceId: "b" }), item({ sourceId: "c" }), item({ sourceId: "d" })],
      centroid: null,
    };
    const ranked = rankClusters([small, big]);
    expect(ranked[0]).toBe(big);
  });
});

describe("storyId", () => {
  it("is stable and order-independent", () => {
    expect(storyId(["b", "a", "c"])).toBe(storyId(["c", "b", "a"]));
    expect(storyId(["a"])).toMatch(/^story_[0-9a-f]+$/);
    expect(storyId(["a", "b"])).not.toBe(storyId(["a", "c"]));
  });
});
