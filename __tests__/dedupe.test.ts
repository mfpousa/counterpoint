import { dedupeNearClones, type DedupeInput } from "../server/dedupe";

const DAY = 24 * 60 * 60 * 1000;
const OPTS = { jaccardThreshold: 0.6, windowMs: 2 * DAY };

let n = 0;
function item(over: Partial<DedupeInput> = {}): DedupeInput {
  n += 1;
  return {
    id: `i${n}`,
    sourceId: `s${n}`,
    title: `headline ${n}`,
    summary: "",
    publishedAt: 1_000_000,
    ...over,
  };
}

describe("dedupeNearClones", () => {
  it("partitions every input into exactly one cluster", () => {
    const items = [item(), item(), item()];
    const clusters = dedupeNearClones(items, OPTS);
    const seen = clusters.flatMap((c) => c.memberIds);
    expect(seen.sort()).toEqual(items.map((i) => i.id).sort());
  });

  it("merges near-identical wire copy across outlets into one cluster", () => {
    const title = "Spain approves new climate law after marathon debate";
    const items = [
      item({ id: "a", sourceId: "elpais", title, summary: "Madrid — lawmakers passed the bill." }),
      item({ id: "b", sourceId: "lavoz", title, summary: "Lawmakers passed the climate bill today." }),
      item({ id: "c", sourceId: "rtve", title: "Spain approves new climate law after long debate" }),
      item({ id: "d", sourceId: "faro", title: "Local fishing fleet returns to Vigo port" }),
    ];
    const clusters = dedupeNearClones(items, OPTS);
    const wire = clusters.find((c) => c.memberIds.includes("a"))!;
    expect(wire.memberIds.sort()).toEqual(["a", "b", "c"]);
    expect(wire.sourceCount).toBe(3);
    // The unrelated Vigo story is its own singleton cluster.
    const vigo = clusters.find((c) => c.memberIds.includes("d"))!;
    expect(vigo.memberIds).toEqual(["d"]);
    // Far fewer deep-analysis calls than inputs.
    expect(clusters.length).toBe(2);
  });

  it("does not merge items outside the time window", () => {
    const title = "Identical breaking headline word for word";
    const items = [
      item({ id: "x", title, publishedAt: 0 }),
      item({ id: "y", title, publishedAt: 5 * DAY }),
    ];
    const clusters = dedupeNearClones(items, OPTS);
    expect(clusters.length).toBe(2);
  });

  it("picks the representative deterministically (importance, then richer summary)", () => {
    const title = "Council votes on the new harbor budget tonight";
    const items = [
      item({ id: "thin", title, summary: "short", importance: 0.4 }),
      item({ id: "rich", title, summary: "a much longer and more complete write-up of the vote", importance: 0.4 }),
      item({ id: "important", title, summary: "mid", importance: 0.9 }),
    ];
    const clusters = dedupeNearClones(items, OPTS);
    expect(clusters.length).toBe(1);
    expect(clusters[0].representativeId).toBe("important"); // highest importance wins
  });

  it("is stable: same input → same representative & members", () => {
    const title = "Exactly the same headline for the stability check";
    const mk = () => [
      item({ id: "p", sourceId: "p", title, summary: "alpha" }),
      item({ id: "q", sourceId: "q", title, summary: "beta beta" }),
    ];
    const a = dedupeNearClones(mk(), OPTS);
    const b = dedupeNearClones(mk(), OPTS);
    expect(a).toEqual(b);
  });
});
