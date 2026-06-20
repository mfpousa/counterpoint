import { excludedByQuery, partitionByExclusion } from "../server/personalize";
import { parseNegation } from "../server/query";
import type { StoredItem } from "../server/store";
import type { Topic } from "../src/types";

describe("parseNegation", () => {
  it("treats a pure negation as exclude-only with empty positive", () => {
    const p = parseNegation("not israel or iran");
    expect(p.positive).toBe("");
    expect(p.exclude.sort()).toEqual(["iran", "israel"]);
  });

  it("splits positive intent from excluded terms", () => {
    const p = parseNegation("AI but not crypto");
    expect(p.positive.toLowerCase()).toContain("ai");
    expect(p.exclude).toEqual(["crypto"]);
  });

  it("handles -term dash exclusions", () => {
    const p = parseNegation("climate -sports");
    expect(p.positive).toBe("climate");
    expect(p.exclude).toEqual(["sports"]);
  });

  it("splits a multi-term tail on or/and/commas", () => {
    const p = parseNegation("world news without sports, celebrity or gossip");
    expect(p.positive).toBe("world news");
    expect(p.exclude.sort()).toEqual(["celebrity", "gossip", "sports"]);
  });

  it("leaves a plain query untouched", () => {
    const p = parseNegation("climate science");
    expect(p.positive).toBe("climate science");
    expect(p.exclude).toEqual([]);
  });
});

function makeStored(over: { title?: string; summary?: string; keywords?: string[]; topic?: Topic }): StoredItem {
  const topic = over.topic ?? "world";
  return {
    item: {
      id: "1",
      sourceId: "src",
      sourceTitle: "Src",
      title: over.title ?? "A headline",
      summary: "",
      url: "https://example.com/a",
      publishedAt: 0,
      kind: "news",
      topic,
      lean: null,
      confidence: 1,
      leanSource: "llm",
      estMinutes: 3,
    },
    clickbait: false,
    analyzed: true,
    topic,
    lean: null,
    importance: 0.5,
    summary: over.summary ?? "",
    keywords: over.keywords ?? [],
    analyzedAt: 0,
  };
}

describe("excludedByQuery", () => {
  it("excludes items mentioning an excluded term in the title", () => {
    const s = makeStored({ title: "Israel and Hamas reach a ceasefire" });
    expect(excludedByQuery(s, ["israel", "iran"])).toBe(true);
  });

  it("matches excluded terms in summary and keywords too", () => {
    expect(excludedByQuery(makeStored({ summary: "Tensions with Iran escalate" }), ["iran"])).toBe(true);
    expect(excludedByQuery(makeStored({ keywords: ["nuclear", "iran"] }), ["iran"])).toBe(true);
  });

  it("uses word boundaries (no accidental substring hits)", () => {
    // "iran" should not match inside "tirana" / "iranian-free" text.
    expect(excludedByQuery(makeStored({ title: "Tirana hosts a summit" }), ["iran"])).toBe(false);
  });

  it("keeps items when nothing is excluded", () => {
    expect(excludedByQuery(makeStored({ title: "Markets rally" }), [])).toBe(false);
    expect(excludedByQuery(makeStored({ title: "Markets rally" }), ["israel"])).toBe(false);
  });
});

describe("partitionByExclusion (over-broad safety valve)", () => {
  function pool(matches: number, total: number, term: string): StoredItem[] {
    return Array.from({ length: total }, (_v, i) =>
      makeStored({ title: i < matches ? `News about ${term} today` : `Unrelated story number ${i}` }),
    );
  }

  it("removes items for a focused term and reports counts", () => {
    const res = partitionByExclusion(pool(3, 10, "israel"), ["israel"]);
    expect(res.removed).toBe(3);
    expect(res.kept).toHaveLength(7);
    expect(res.skipped).toEqual([]);
    expect(res.counts).toEqual({ israel: 3 });
  });

  it("IGNORES an over-broad term that would gut the feed (>60%)", () => {
    const res = partitionByExclusion(pool(8, 10, "us"), ["us"]);
    expect(res.removed).toBe(0);
    expect(res.kept).toHaveLength(10);
    expect(res.skipped).toEqual(["us"]);
  });

  it("applies focused terms but skips over-broad ones in the same query", () => {
    // 2/10 mention "iran" (focused), 9/10 mention "report" (over-broad).
    const items = Array.from({ length: 10 }, (_v, i) =>
      makeStored({
        title:
          (i < 2 ? "Iran update " : "Daily ") + (i < 9 ? "report on local events" : "weather notes"),
      }),
    );
    const res = partitionByExclusion(items, ["iran", "report"]);
    expect(res.skipped).toEqual(["report"]);
    expect(res.counts).toEqual({ iran: 2 });
    expect(res.removed).toBe(2);
  });

  it("is a no-op with no exclude terms", () => {
    const items = pool(5, 5, "x");
    const res = partitionByExclusion(items, []);
    expect(res.kept).toBe(items);
    expect(res.removed).toBe(0);
  });
});
