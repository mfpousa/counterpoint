import { jaccardIds, pickBestMatch, type CachedStory } from "../server/storyStore";
import type { Story } from "../src/types";

function entry(id: string, kind: "issue" | "event", memberIds: string[]): CachedStory {
  return {
    id,
    kind,
    memberIds: memberIds.slice().sort(),
    story: { id } as unknown as Story,
    builtAt: 0,
    updatedAt: 0,
  };
}

describe("jaccardIds", () => {
  it("scores overlap, 1 for identical sets, 0 for disjoint", () => {
    expect(jaccardIds(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccardIds(["a", "b"], ["a", "c"])).toBeCloseTo(1 / 3);
    expect(jaccardIds(["a"], ["b"])).toBe(0);
    expect(jaccardIds([], ["a"])).toBe(0);
  });
});

describe("pickBestMatch (incremental story reuse)", () => {
  const NONE = new Set<string>();
  const T = 0.5;

  it("reuses verbatim when the article set is unchanged (equal)", () => {
    const cached = [entry("s1", "issue", ["a", "b", "c"])];
    const m = pickBestMatch(cached, "issue", ["c", "b", "a"], NONE, T);
    expect(m?.entry.id).toBe("s1");
    expect(m?.equal).toBe(true);
  });

  it("matches the SAME development when it gains an article (not equal)", () => {
    const cached = [entry("s1", "issue", ["a", "b", "c"])];
    const m = pickBestMatch(cached, "issue", ["a", "b", "c", "d"], NONE, T);
    expect(m?.entry.id).toBe("s1"); // identity preserved -> re-synthesize, keep id
    expect(m?.equal).toBe(false);
  });

  it("treats a barely-overlapping cluster as a NEW story", () => {
    const cached = [entry("s1", "issue", ["a", "b", "c", "d"])];
    // overlap {a} -> jaccard 1/4 < 0.5
    const m = pickBestMatch(cached, "issue", ["a", "x", "y"], NONE, T);
    expect(m).toBeNull();
  });

  it("never cross-matches an issue to an event", () => {
    const cached = [entry("e1", "event", ["a", "b"])];
    expect(pickBestMatch(cached, "issue", ["a", "b"], NONE, T)).toBeNull();
    expect(pickBestMatch(cached, "event", ["a", "b"], NONE, T)?.entry.id).toBe("e1");
  });

  it("does not reuse an entry already claimed this round", () => {
    const cached = [entry("s1", "issue", ["a", "b", "c"])];
    const used = new Set<string>(["s1"]);
    expect(pickBestMatch(cached, "issue", ["a", "b", "c"], used, T)).toBeNull();
  });

  it("picks the strongest overlap among candidates", () => {
    const cached = [
      entry("weak", "issue", ["a", "z", "y", "w"]),
      entry("strong", "issue", ["a", "b", "c"]),
    ];
    const m = pickBestMatch(cached, "issue", ["a", "b", "c", "d"], NONE, T);
    expect(m?.entry.id).toBe("strong");
  });
});
