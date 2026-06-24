import { createRotation, dealNextBatch } from "../server/sourceRotation";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);

// Deterministic rng for reproducible shuffles in tests.
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 0xffffffff;
  };
}

describe("dealNextBatch — no-repeat rotation (repeatRatio 0)", () => {
  it("covers every source exactly once per cycle, with no repeats", () => {
    const all = ids(10);
    const state = createRotation();
    const dealt: string[] = [];
    // ceil(10/3) = 4 deals span one full cycle (the deck reshuffles mid-4th deal, so the
    // first 10 dealt are exactly cycle 1).
    for (let i = 0; i < 4; i++) dealt.push(...dealNextBatch(state, all, 3, { rng: seeded(1) }));
    const cycle1 = dealt.slice(0, 10);
    expect(new Set(cycle1).size).toBe(10); // no duplicates within the cycle
    expect(new Set(cycle1)).toEqual(new Set(all)); // every source covered
  });

  it("gives a different, non-overlapping subset on the next refresh", () => {
    const all = ids(12);
    const state = createRotation();
    const first = dealNextBatch(state, all, 4, { rng: seeded(7) });
    const second = dealNextBatch(state, all, 4, { rng: seeded(7) });
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    // Within a cycle the deck is consumed, so the two batches cannot overlap.
    expect(first.filter((x) => second.includes(x))).toEqual([]);
  });

  it("reshuffles into a new cycle after the deck is exhausted", () => {
    const all = ids(6);
    const state = createRotation();
    const cycle1: string[] = [];
    for (let i = 0; i < 2; i++) cycle1.push(...dealNextBatch(state, all, 3, { rng: seeded(3) }));
    expect(new Set(cycle1)).toEqual(new Set(all));
    const cycle2: string[] = [];
    for (let i = 0; i < 2; i++) cycle2.push(...dealNextBatch(state, all, 3, { rng: seeded(99) }));
    expect(new Set(cycle2)).toEqual(new Set(all));
  });

  it("returns ALL sources when budget is 0 (rotation disabled) or >= count", () => {
    const all = ids(5);
    const state = createRotation();
    expect(dealNextBatch(state, all, 0).sort()).toEqual([...all].sort());
    expect(dealNextBatch(state, all, 5).sort()).toEqual([...all].sort());
    expect(dealNextBatch(state, all, 99).sort()).toEqual([...all].sort());
  });

  it("rebuilds the deck when the source set changes", () => {
    const state = createRotation();
    dealNextBatch(state, ids(8), 3, { rng: seeded(5) });
    const sigAfterFirst = state.sig;
    // A different set → new signature → fresh deck (no stale ids dealt).
    const out = dealNextBatch(state, ["a", "b", "c", "d", "e"], 2, { rng: seeded(5) });
    expect(state.sig).not.toBe(sigAfterFirst);
    expect(out.every((x) => ["a", "b", "c", "d", "e"].includes(x))).toBe(true);
  });

  it("never mutates the input ids array", () => {
    const all = ids(7);
    const snapshot = [...all];
    const state = createRotation();
    dealNextBatch(state, all, 3, { rng: seeded(2) });
    expect(all).toEqual(snapshot);
  });

  it("handles an empty source list", () => {
    expect(dealNextBatch(createRotation(), [], 3)).toEqual([]);
  });
});

describe("dealNextBatch — fresh/repeat split (repeatRatio > 0)", () => {
  it("splits the budget into fresh + repeat once enough sources are seen", () => {
    const all = ids(8);
    const state = createRotation();
    // First deal: nothing seen yet, so the whole budget falls back to fresh.
    const d1 = dealNextBatch(state, all, 4, { repeatRatio: 0.5, rng: seeded(1) });
    expect(d1).toHaveLength(4);
    expect(new Set(d1).size).toBe(4);
    // Second deal: round(4*0.5)=2 repeats (from d1) + 2 fresh (new deck sources).
    const d2 = dealNextBatch(state, all, 4, { repeatRatio: 0.5, rng: seeded(1) });
    expect(d2).toHaveLength(4);
    const repeats = d2.filter((x) => d1.includes(x));
    const fresh = d2.filter((x) => !d1.includes(x));
    expect(repeats).toHaveLength(2);
    expect(fresh).toHaveLength(2);
  });

  it("repeats the LEAST-recently-fetched sources first", () => {
    const all = ids(12);
    const state = createRotation();
    const rng = seeded(11);
    dealNextBatch(state, all, 4, { repeatRatio: 0.5, rng });
    dealNextBatch(state, all, 4, { repeatRatio: 0.5, rng });
    const before = new Map(state.seen); // last-dealt sequence per source, pre-deal
    const d = dealNextBatch(state, all, 4, { repeatRatio: 0.5, rng });
    const repeated = d.filter((x) => before.has(x));
    const skipped = [...before.keys()].filter((x) => !d.includes(x));
    expect(repeated.length).toBeGreaterThan(0);
    expect(skipped.length).toBeGreaterThan(0);
    // Every repeated source was dealt no more recently than every skipped already-seen one.
    const newestRepeated = Math.max(...repeated.map((x) => before.get(x)!));
    const oldestSkipped = Math.min(...skipped.map((x) => before.get(x)!));
    expect(newestRepeated).toBeLessThanOrEqual(oldestSkipped);
  });

  it("still covers every source despite repeats (breadth preserved)", () => {
    const all = ids(20);
    const state = createRotation();
    const rng = seeded(5);
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const id of dealNextBatch(state, all, 4, { repeatRatio: 0.5, rng })) seen.add(id);
    }
    expect(seen).toEqual(new Set(all));
  });

  it("each deal stays within budget and has no intra-batch duplicates", () => {
    const all = ids(15);
    const state = createRotation();
    const rng = seeded(3);
    for (let i = 0; i < 10; i++) {
      const d = dealNextBatch(state, all, 5, { repeatRatio: 0.8, rng });
      expect(d.length).toBeLessThanOrEqual(5);
      expect(new Set(d).size).toBe(d.length);
    }
  });
});
