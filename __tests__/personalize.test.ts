import {
  interestMatch,
  interestTokens,
  personalizedRelevance,
  toFeedItem,
  tokenize,
} from "../server/personalize";
import type { StoredItem } from "../server/store";
import type { Topic } from "../src/types";

function makeStored(over: {
  title?: string;
  keywords?: string[];
  importance?: number;
  topic?: Topic;
  summary?: string;
  publishedAt?: number;
  prescreenImportance?: number;
}): StoredItem {
  const topic = over.topic ?? "technology";
  return {
    item: {
      id: "1",
      sourceId: "src",
      sourceTitle: "Src",
      title: over.title ?? "A headline",
      summary: "",
      url: "https://example.com/a",
      publishedAt: over.publishedAt ?? 0,
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
    leanSource: "llm",
    importance: over.importance ?? 0.8,
    summary: over.summary ?? "",
    keywords: over.keywords ?? [],
    analyzedAt: 0,
    ...(over.prescreenImportance !== undefined
      ? { prescreenImportance: over.prescreenImportance }
      : {}),
  };
}

describe("tokenize", () => {
  it("drops stopwords and 1-char noise but keeps short concepts like 'ai'", () => {
    expect(tokenize("The future of AI and a bit")).toEqual(["future", "ai", "bit"]);
  });
});

describe("interestMatch", () => {
  it("matches via synonym expansion (ai -> machine learning)", () => {
    const tokens = interestTokens("AI");
    const item = makeStored({ keywords: ["machine learning", "neural networks"] });
    expect(interestMatch(tokens, item)).toBe(1);
  });

  it("is 0 when no interest concept appears", () => {
    const tokens = interestTokens("climate energy");
    const item = makeStored({ title: "Quarterly earnings beat estimates", keywords: ["stocks"] });
    expect(interestMatch(tokens, item)).toBe(0);
  });

  it("is a fraction when only some concepts match", () => {
    const tokens = interestTokens("ai economics"); // 2 concepts
    const item = makeStored({ keywords: ["large language model"], topic: "technology" });
    expect(interestMatch(tokens, item)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for an empty interest", () => {
    expect(interestMatch(interestTokens(""), makeStored({ keywords: ["ai"] }))).toBe(0);
  });
});

describe("personalizedRelevance", () => {
  it("returns raw importance when there is no interest", () => {
    expect(personalizedRelevance(0.7, 0.9, false)).toBe(0.7);
  });

  it("lets interest match dominate while importance still counts", () => {
    expect(personalizedRelevance(0.5, 1, true)).toBeCloseTo(0.8, 5); // 0.6*1 + 0.4*0.5
    expect(personalizedRelevance(0.5, 0, true)).toBeCloseTo(0.2, 5); // off-interest sinks
  });
});

describe("toFeedItem", () => {
  it("attaches personalized relevance, ai summary, and llm provenance", () => {
    const tokens = interestTokens("ai");
    const item = makeStored({ keywords: ["artificial intelligence"], importance: 0.6, summary: "About AI." });
    const fi = toFeedItem(item, tokens, true);
    expect(fi.leanSource).toBe("llm");
    expect(fi.aiReason).toBe("About AI.");
    expect(fi.relevance).toBeCloseTo(0.6 * 1 + 0.4 * 0.6, 5);
  });

  it("uses importance directly when no interest is set", () => {
    const fi = toFeedItem(makeStored({ importance: 0.42 }), interestTokens(""), false);
    expect(fi.relevance).toBe(0.42);
  });

  it("tags analyzed items with enrichment 'analyzed'", () => {
    const fi = toFeedItem(makeStored({ importance: 0.5 }), interestTokens(""), false);
    expect(fi.enrichment).toBe("analyzed");
  });

  it("scores a PROVISIONAL item from its prescreen importance, capped below 0.6", () => {
    // importance is ignored for provisional; prescreen 0.9 saturates the 0.6 cap.
    const item = makeStored({ importance: 0, prescreenImportance: 0.9, summary: "" });
    const fi = toFeedItem(item, interestTokens(""), false, null, true);
    expect(fi.enrichment).toBe("provisional");
    expect(fi.relevance).toBe(0.6);
    // No deep summary yet → no AI reason fabricated.
    expect(fi.aiReason).toBeUndefined();
  });

  it("falls back to a modest 0.4 relevance for provisional items without a prescreen score", () => {
    const fi = toFeedItem(makeStored({ importance: 0 }), interestTokens(""), false, null, true);
    expect(fi.relevance).toBe(0.4);
  });
});
