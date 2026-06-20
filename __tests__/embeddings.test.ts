import { cosineSim, itemEmbedText } from "../server/embeddings";
import { interestTokens, semanticMatch, toFeedItem } from "../server/personalize";
import type { StoredItem } from "../server/store";
import type { Topic } from "../src/types";

describe("cosineSim", () => {
  it("is 1 for identical direction, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSim([1, 0], [2, 0])).toBeCloseTo(1, 5);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it("returns 0 when either vector is degenerate", () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
    expect(cosineSim([1, 1], [])).toBe(0);
  });
});

describe("semanticMatch", () => {
  it("stretches cosine [0.2,0.8] onto [0,1] and clamps", () => {
    // cosine 0.2 -> 0, 0.8 -> 1, 0.5 -> 0.5
    expect(semanticMatch([1, 0], [1, 0])).toBe(1); // cosine 1 -> clamp 1
    // Build vectors with a known cosine of 0.5 (60 degrees).
    const a = [1, 0];
    const b = [0.5, Math.sqrt(3) / 2]; // cosine = 0.5
    expect(semanticMatch(a, b)).toBeCloseTo(0.5, 5);
    // Orthogonal -> cosine 0 -> below floor -> 0.
    expect(semanticMatch([1, 0], [0, 1])).toBe(0);
  });
});

function makeStored(over: { embedding?: number[]; importance?: number; topic?: Topic }): StoredItem {
  const topic = over.topic ?? "technology";
  return {
    item: {
      id: "1",
      sourceId: "src",
      sourceTitle: "Src",
      title: "A headline",
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
    importance: over.importance ?? 0.5,
    summary: "",
    keywords: [],
    analyzedAt: 0,
    embedding: over.embedding,
  };
}

describe("toFeedItem semantic path", () => {
  it("uses cosine similarity when a query vector and item embedding are present", () => {
    const queryVec = [1, 0];
    const item = makeStored({ embedding: [1, 0], importance: 0.5 });
    const fi = toFeedItem(item, interestTokens("anything"), true, queryVec);
    // match=1 (cosine 1 -> 1), relevance = 0.6*1 + 0.4*0.5 = 0.8
    expect(fi.relevance).toBeCloseTo(0.8, 5);
  });

  it("falls back to keyword matching when the item has no embedding", () => {
    const item = makeStored({ embedding: undefined, importance: 0.5 });
    // No keyword overlap -> match 0 -> relevance = 0.4*importance
    const fi = toFeedItem(item, interestTokens("nuclear fusion"), true, [1, 0]);
    expect(fi.relevance).toBeCloseTo(0.2, 5);
  });
});

describe("itemEmbedText", () => {
  it("joins title, summary, and keywords into one capped string", () => {
    expect(itemEmbedText("Title", "Summary here", ["a", "b"])).toBe("Title. Summary here. a, b");
    expect(itemEmbedText("Title", "", [])).toBe("Title");
  });
});
