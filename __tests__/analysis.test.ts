import { coerceAnalysis } from "../server/analysis";
import type { FeedItem } from "../src/types";

function fallback(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "1",
    sourceId: "src",
    sourceTitle: "Src",
    title: "A headline",
    summary: "",
    url: "https://example.com/a",
    publishedAt: 0,
    kind: "news",
    topic: "politics",
    lean: -0.5,
    confidence: 0.8,
    leanSource: "source",
    estMinutes: 3,
    ...over,
  };
}

describe("coerceAnalysis — lean provenance + rationale", () => {
  it("marks leanRefined when the model returns a usable numeric lean", () => {
    const a = coerceAnalysis(
      {
        id: "1",
        topic: "politics",
        lean: 0.4,
        leanRationale: "frames tax cuts as growth, downplays deficit",
        importance: 0.7,
        summary: "A budget story.",
        keywords: ["budget", "tax"],
      },
      fallback(),
    );
    expect(a.lean).toBeCloseTo(0.4, 5);
    expect(a.leanRefined).toBe(true);
    expect(a.leanRationale).toBe("frames tax cuts as growth, downplays deficit");
  });

  it("falls back to the source prior (not refined) when lean is null", () => {
    const a = coerceAnalysis(
      { id: "1", topic: "politics", lean: null, leanRationale: "", importance: 0.5, summary: "x", keywords: [] },
      fallback({ lean: -0.5 }),
    );
    expect(a.lean).toBe(-0.5);
    expect(a.leanRefined).toBe(false);
    expect(a.leanRationale).toBe("");
  });

  it("clamps an out-of-range lean and still counts as refined", () => {
    const a = coerceAnalysis(
      { id: "1", topic: "politics", lean: 5, leanRationale: "strongly partisan", importance: 0.5, summary: "x", keywords: [] },
      fallback(),
    );
    expect(a.lean).toBe(1);
    expect(a.leanRefined).toBe(true);
  });

  it("treats a non-political null lean (non-political source) as not refined", () => {
    const a = coerceAnalysis(
      { id: "1", topic: "science", lean: null, importance: 0.6, summary: "x", keywords: [] },
      fallback({ lean: null, topic: "science" }),
    );
    expect(a.lean).toBeNull();
    expect(a.leanRefined).toBe(false);
    expect(a.leanRationale).toBe("");
  });
});
