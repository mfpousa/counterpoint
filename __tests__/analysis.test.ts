import { coerceAnalysis, looksDegenerate, sanitizeModelText } from "../server/analysis";
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

  it("blanks degenerate summary/rationale (model repetition loops)", () => {
    const a = coerceAnalysis(
      {
        id: "1",
        topic: "politics",
        lean: 0.3,
        leanRationale: "We……………………………………………JSON…………...",
        importance: 0.5,
        summary: "...???…??..………………………………………………………",
        keywords: ["budget", "…..……", "tax"],
      },
      fallback(),
    );
    expect(a.summary).toBe("");
    expect(a.leanRationale).toBe("");
    // Degenerate keyword dropped, real ones kept.
    expect(a.keywords).toEqual(["budget", "tax"]);
    // The numeric lean itself is still usable.
    expect(a.lean).toBeCloseTo(0.3, 5);
  });
});

describe("looksDegenerate / sanitizeModelText", () => {
  it("flags repeated-punctuation and symbol-soup runs from the logs", () => {
    expect(looksDegenerate("...???…??..………………………………………………………")).toBe(true);
    expect(looksDegenerate("We……………………………………………JSON…………...")).toBe(true);
    expect(looksDegenerate("Weird …..……………………………………??………a…………………………………………?")).toBe(true);
    expect(looksDegenerate("…………")).toBe(true);
  });

  it("keeps legitimate prose", () => {
    const ok = "Frames tax cuts as growth-boosting while downplaying the deficit.";
    expect(looksDegenerate(ok)).toBe(false);
    expect(sanitizeModelText(ok)).toBe(ok);
  });

  it("keeps a normal summary with ordinary punctuation", () => {
    const s = "EU AI Act explained: its impact on startups and what comes next.";
    expect(sanitizeModelText(s)).toBe(s);
  });

  it("strips fences/whitespace and returns '' for non-strings or degenerate input", () => {
    expect(sanitizeModelText("```json The cabinet approved the long-delayed budget today.```")).toBe(
      "The cabinet approved the long-delayed budget today.",
    );
    expect(sanitizeModelText(undefined)).toBe("");
    expect(sanitizeModelText("?????????")).toBe("");
  });
});
