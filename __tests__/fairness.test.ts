import { interleaveByProvider, interleaveByRecencyBuckets } from "../server/fairness";

interface Row {
  id: string;
  src: string;
  score: number;
}

const key = (r: Row) => r.src;
const bestFirst = (a: Row, b: Row) => b.score - a.score;
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("interleaveByProvider", () => {
  it("returns the input unchanged when there is 0 or 1 item", () => {
    expect(interleaveByProvider([], key, bestFirst)).toEqual([]);
    const one = [{ id: "x", src: "A", score: 1 }];
    expect(ids(interleaveByProvider(one, key, bestFirst))).toEqual(["x"]);
  });

  it("round-robins so a prolific provider can't bury others", () => {
    // A publishes 3, B publishes 1. A pure importance sort would push B's item
    // to the very end; round-robin surfaces it in the first round instead.
    const items: Row[] = [
      { id: "A1", src: "A", score: 0.9 },
      { id: "A2", src: "A", score: 0.8 },
      { id: "A3", src: "A", score: 0.7 },
      { id: "B1", src: "B", score: 0.5 },
    ];
    expect(ids(interleaveByProvider(items, key, bestFirst))).toEqual(["A1", "B1", "A2", "A3"]);
  });

  it("orders each round by the comparator (most important provider leads)", () => {
    const items: Row[] = [
      { id: "B1", src: "B", score: 0.6 },
      { id: "A1", src: "A", score: 0.9 },
      { id: "A2", src: "A", score: 0.4 },
      { id: "B2", src: "B", score: 0.3 },
    ];
    // Round 1 heads A1(0.9),B1(0.6) -> A1,B1; round 2 heads A2(0.4),B2(0.3) -> A2,B2.
    expect(ids(interleaveByProvider(items, key, bestFirst))).toEqual(["A1", "B1", "A2", "B2"]);
  });

  it("honors a per-source cap (drops a provider's long tail)", () => {
    const items: Row[] = [
      { id: "A1", src: "A", score: 0.9 },
      { id: "A2", src: "A", score: 0.8 },
      { id: "A3", src: "A", score: 0.7 },
      { id: "B1", src: "B", score: 0.5 },
    ];
    const out = ids(interleaveByProvider(items, key, bestFirst, { perSourceCap: 2 }));
    expect(out).toEqual(["A1", "B1", "A2"]);
    expect(out).not.toContain("A3");
  });

  it("breaks score ties by first-seen provider (deterministic)", () => {
    const items: Row[] = [
      { id: "A1", src: "A", score: 0.5 },
      { id: "B1", src: "B", score: 0.5 },
    ];
    expect(ids(interleaveByProvider(items, key, bestFirst))).toEqual(["A1", "B1"]);
  });
});

interface TimedRow extends Row {
  ageMs: number;
}

const HOUR = 60 * 60 * 1000;

describe("interleaveByRecencyBuckets", () => {
  const ageOf = (r: TimedRow) => r.ageMs;
  const tkey = (r: TimedRow) => r.src;
  const tcmp = (a: TimedRow, b: TimedRow) => b.score - a.score;

  it("emits the freshest bucket first, even when older items are more important", () => {
    // A very important but 5h-old story must still come AFTER fresh (<2h) ones.
    const items: TimedRow[] = [
      { id: "old-big", src: "A", score: 0.99, ageMs: 5 * HOUR },
      { id: "fresh-small", src: "B", score: 0.2, ageMs: 0.5 * HOUR },
    ];
    const out = ids(interleaveByRecencyBuckets(items, ageOf, tkey, tcmp, 2 * HOUR));
    expect(out).toEqual(["fresh-small", "old-big"]);
  });

  it("steps backwards bucket by bucket, provider-fair within each band", () => {
    // Bucket 0 (<2h): A0, B0 ; bucket 1 (2-4h): A1 ; bucket 2 (4-6h): A2.
    const items: TimedRow[] = [
      { id: "A2", src: "A", score: 0.9, ageMs: 5 * HOUR },
      { id: "A0", src: "A", score: 0.5, ageMs: 1 * HOUR },
      { id: "B0", src: "B", score: 0.4, ageMs: 1.5 * HOUR },
      { id: "A1", src: "A", score: 0.8, ageMs: 3 * HOUR },
    ];
    const out = ids(interleaveByRecencyBuckets(items, ageOf, tkey, tcmp, 2 * HOUR));
    // Fresh band first (A0 before B0 by score), then 2-4h, then 4-6h.
    expect(out).toEqual(["A0", "B0", "A1", "A2"]);
  });
});
