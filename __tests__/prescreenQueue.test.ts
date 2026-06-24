import { mergePrescreenQueue } from "../server/feedService";
import type { FeedItem } from "../src/types";

// The merge only reads `id` + `publishedAt`, so a minimal stub suffices.
const item = (id: string, publishedAt: number): FeedItem =>
  ({ id, publishedAt } as unknown as FeedItem);

const none = () => false;
const ids = (xs: FeedItem[]) => xs.map((x) => x.id);

describe("mergePrescreenQueue", () => {
  it("KEEPS older queued items when fresh items arrive (the fix: append, not replace)", () => {
    const existing = [item("old", 10), item("older", 5)];
    const incoming = [item("new", 100)];
    const out = mergePrescreenQueue(existing, incoming, { isStored: none, cutoff: 0, cap: 0 });
    // Nothing dropped; sorted freshest-first.
    expect(ids(out)).toEqual(["new", "old", "older"]);
  });

  it("dedups by id (the repeat half can re-fetch an already-queued source)", () => {
    const existing = [item("a", 5)];
    const incoming = [item("a", 5), item("b", 2)];
    const out = mergePrescreenQueue(existing, incoming, { isStored: none, cutoff: 0, cap: 0 });
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("drops items already prescreened+stored", () => {
    const existing = [item("a", 5), item("b", 3)];
    const incoming = [item("c", 4)];
    const out = mergePrescreenQueue(existing, incoming, {
      isStored: (id) => id === "a",
      cutoff: 0,
      cap: 0,
    });
    expect(ids(out)).toEqual(["c", "b"]);
  });

  it("drops items that fell out of the analysis window (publishedAt < cutoff)", () => {
    const existing = [item("fresh", 100), item("stale", 10)];
    const incoming = [item("alsoStale", 5)];
    const out = mergePrescreenQueue(existing, incoming, { isStored: none, cutoff: 50, cap: 0 });
    expect(ids(out)).toEqual(["fresh"]);
  });

  it("sorts freshest-first", () => {
    const out = mergePrescreenQueue(
      [item("mid", 50), item("old", 10)],
      [item("new", 90)],
      { isStored: none, cutoff: 0, cap: 0 },
    );
    expect(ids(out)).toEqual(["new", "mid", "old"]);
  });

  it("bounds the queue to the cap, dropping the OLDEST", () => {
    const existing = [item("a", 30), item("b", 20)];
    const incoming = [item("c", 40), item("d", 10)];
    const out = mergePrescreenQueue(existing, incoming, { isStored: none, cutoff: 0, cap: 2 });
    expect(ids(out)).toEqual(["c", "a"]); // freshest two kept, oldest (b, d) dropped
  });

  it("treats cap 0 as unbounded", () => {
    const many = Array.from({ length: 50 }, (_, i) => item(`s${i}`, i));
    const out = mergePrescreenQueue(many, [], { isStored: none, cutoff: 0, cap: 0 });
    expect(out).toHaveLength(50);
  });

  it("handles empty incoming (re-filters/preserves the existing backlog)", () => {
    const existing = [item("a", 5), item("stale", 1), item("b", 9)];
    const out = mergePrescreenQueue(existing, [], { isStored: none, cutoff: 3, cap: 0 });
    expect(ids(out)).toEqual(["b", "a"]); // stale dropped, rest kept freshest-first
  });
});
