import {
  clusterItems,
  distinctSources,
  groupIntoIssues,
  isDevelopingIssue,
  jaccard,
  rankClusters,
  titleTokens,
  type Cluster,
  type ClusterInput,
} from "../server/cluster";
import { severityOf, storyId } from "../server/synthesize";
import type { StoredItem } from "../server/store";

const DAY = 24 * 60 * 60 * 1000;
const OPTS = { simThreshold: 0.82, textSimThreshold: 0.3, windowMs: 2 * DAY };
const ISSUE_OPTS = { simThreshold: 0.6, textSimThreshold: 0.18, windowMs: 10 * DAY };

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

describe("groupIntoIssues (hierarchical, level 2)", () => {
  const BASE = 10 * DAY;
  // Build an event cluster from explicit members.
  const cl = (members: ClusterInput[]): Cluster<ClusterInput> => ({ members, centroid: null });

  it("groups distinct sub-events of one storyline into a single issue", () => {
    // Conflict storyline: three DISTINCT events (strikes / blockade / talks) that
    // are too dissimilar to be the same event (cosine < 0.82) but close enough to
    // be the same ISSUE (cosine >= 0.6), spread across days.
    const strikes = cl([
      item({ sourceId: "a1", embedding: [1, 0], publishedAt: BASE }),
      item({ sourceId: "a2", embedding: [1, 0], publishedAt: BASE + DAY / 2 }),
    ]);
    const blockade = cl([
      item({ sourceId: "b1", embedding: [0.8, 0.6], publishedAt: BASE + DAY }),
      item({ sourceId: "b2", embedding: [0.8, 0.6], publishedAt: BASE + DAY }),
    ]);
    const talks = cl([
      item({ sourceId: "c1", embedding: [0.75, 0.66], publishedAt: BASE + 2 * DAY }),
      item({ sourceId: "c2", embedding: [0.75, 0.66], publishedAt: BASE + 2 * DAY }),
    ]);
    // An unrelated event (orthogonal embedding) must NOT join the conflict issue.
    const sports = cl([
      item({ sourceId: "x1", embedding: [0, 1], publishedAt: BASE + DAY }),
      item({ sourceId: "x2", embedding: [0, 1], publishedAt: BASE + DAY }),
    ]);

    const issues = groupIntoIssues([strikes, blockade, talks, sports], ISSUE_OPTS);
    expect(issues).toHaveLength(2);

    const conflict = issues.find((i) => i.clusters.length === 3)!;
    expect(conflict).toBeTruthy();
    expect(distinctSources(conflict.members)).toBe(6);
    // Clusters are returned earliest-first for the timeline.
    const firsts = conflict.clusters.map((c) => Math.min(...c.members.map((m) => m.publishedAt)));
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
  });

  it("does not merge events separated by more than the issue window", () => {
    const e1 = cl([item({ sourceId: "a", embedding: [1, 0], publishedAt: BASE })]);
    const e2 = cl([item({ sourceId: "b", embedding: [1, 0], publishedAt: BASE + 30 * DAY })]);
    const issues = groupIntoIssues([e1, e2], ISSUE_OPTS);
    expect(issues).toHaveLength(2);
  });
});

describe("isDevelopingIssue", () => {
  const BASE = 10 * DAY;
  const cl = (members: ClusterInput[]): Cluster<ClusterInput> => ({ members, centroid: null });
  const opts = { minSpanMs: 12 * 3600 * 1000, minEvents: 2, minSources: 3, activeMs: DAY, now: BASE + 2 * DAY };

  it("flags a multi-event, multi-source, still-active storyline as developing", () => {
    const issues = groupIntoIssues(
      [
        cl([item({ sourceId: "a1", embedding: [1, 0], publishedAt: BASE })]),
        cl([item({ sourceId: "b1", embedding: [0.8, 0.6], publishedAt: BASE + DAY })]),
        cl([item({ sourceId: "c1", embedding: [0.75, 0.66], publishedAt: BASE + 2 * DAY })]),
      ],
      ISSUE_OPTS,
    );
    expect(issues).toHaveLength(1);
    expect(isDevelopingIssue(issues[0], opts)).toBe(true);
  });

  it("rejects a single-event issue and a stale one", () => {
    const single = groupIntoIssues(
      [cl([item({ sourceId: "a1", embedding: [1, 0], publishedAt: BASE + 2 * DAY })])],
      ISSUE_OPTS,
    )[0];
    expect(isDevelopingIssue(single, opts)).toBe(false);

    const stale = groupIntoIssues(
      [
        cl([item({ sourceId: "a1", embedding: [1, 0], publishedAt: BASE })]),
        cl([item({ sourceId: "b1", embedding: [0.8, 0.6], publishedAt: BASE + DAY })]),
        cl([item({ sourceId: "c1", embedding: [0.75, 0.66], publishedAt: BASE + 2 * DAY })]),
      ],
      ISSUE_OPTS,
    )[0];
    // now far in the future -> not active.
    expect(isDevelopingIssue(stale, { ...opts, now: BASE + 30 * DAY })).toBe(false);
  });
});

describe("severityOf", () => {
  const si = (importance: number, sourceId: string): StoredItem =>
    ({ importance, item: { sourceId } } as unknown as StoredItem);

  it("rises with importance and breadth, and gets a developing boost", () => {
    const low = severityOf([si(0.1, "a")]);
    const high = severityOf([si(0.9, "a"), si(0.8, "b"), si(0.7, "c"), si(0.6, "d")]);
    expect(high).toBeGreaterThan(low);

    const event = severityOf([si(0.5, "a"), si(0.5, "b")]);
    const developing = severityOf([si(0.5, "a"), si(0.5, "b")], true);
    expect(developing).toBeGreaterThan(event);
  });

  it("stays within [0,1]", () => {
    const s = severityOf([si(1, "a"), si(1, "b"), si(1, "c"), si(1, "d")], true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("storyId", () => {
  it("is stable and order-independent", () => {
    expect(storyId(["b", "a", "c"])).toBe(storyId(["c", "b", "a"]));
    expect(storyId(["a"])).toMatch(/^story_[0-9a-f]+$/);
    expect(storyId(["a", "b"])).not.toBe(storyId(["a", "c"]));
  });
});
