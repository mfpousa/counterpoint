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

describe("dealNextBatch (source rotation)", () => {
  it("covers every source exactly once per cycle, with no repeats", () => {
    const all = ids(10);
    const state = createRotation();
    const budget = 3;
    const seen: string[] = [];
    // ceil(10/3) = 4 deals make one full cycle (3+3+3+1).
    for (let i = 0; i < 4; i++) seen.push(...dealNextBatch(state, all, budget, seeded(1)));
    expect(seen.length).toBe(10);
    expect(new Set(seen).size).toBe(10); // no duplicates within the cycle
    expect(new Set(seen)).toEqual(new Set(all)); // every source covered
  });

  it("gives a different subset on the next refresh (rotates)", () => {
    const all = ids(12);
    const state = createRotation();
    const first = dealNextBatch(state, all, 4, seeded(7));
    const second = dealNextBatch(state, all, 4, seeded(7));
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    // Within a cycle the deck is consumed, so the two batches cannot overlap.
    expect(first.filter((x) => second.includes(x))).toEqual([]);
  });

  it("reshuffles into a new cycle after the deck is exhausted", () => {
    const all = ids(6);
    const state = createRotation();
    const cycle1: string[] = [];
    for (let i = 0; i < 2; i++) cycle1.push(...dealNextBatch(state, all, 3, seeded(3)));
    expect(new Set(cycle1)).toEqual(new Set(all));
    // Next deal begins a fresh cycle covering all again.
    const cycle2: string[] = [];
    for (let i = 0; i < 2; i++) cycle2.push(...dealNextBatch(state, all, 3, seeded(99)));
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
    dealNextBatch(state, ids(8), 3, seeded(5));
    const sigAfterFirst = state.sig;
    // A different set → new signature → fresh deck (no stale ids dealt).
    const out = dealNextBatch(state, ["a", "b", "c", "d", "e"], 2, seeded(5));
    expect(state.sig).not.toBe(sigAfterFirst);
    expect(out.every((x) => ["a", "b", "c", "d", "e"].includes(x))).toBe(true);
  });

  it("never mutates the input ids array", () => {
    const all = ids(7);
    const snapshot = [...all];
    const state = createRotation();
    dealNextBatch(state, all, 3, seeded(2));
    expect(all).toEqual(snapshot);
  });

  it("handles an empty source list", () => {
    expect(dealNextBatch(createRotation(), [], 3)).toEqual([]);
  });
});
