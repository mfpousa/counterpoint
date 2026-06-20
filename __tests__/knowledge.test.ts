import { computeProfile, pickCandidates, PASS_SCORE } from "../src/lib/knowledge";
import type { FeedItem, StoredSummary, SummaryGrade, Topic } from "../src/types";

function grade(score: number, missed: string[] = [], inaccuracies: string[] = []): SummaryGrade {
  return { score, verdict: "", correct: [], missed, inaccuracies, lesson: "" };
}

function summary(over: Partial<StoredSummary> & { topic: Topic; score: number }): StoredSummary {
  const g = grade(over.score, over.grade?.missed, over.grade?.inaccuracies);
  return {
    id: over.id ?? `${over.topic}-${over.score}-${Math.random()}`,
    title: over.title ?? "A headline",
    sourceTitle: over.sourceTitle ?? "Src",
    topic: over.topic,
    url: over.url ?? "https://example.com",
    summary: over.summary ?? "my summary",
    grade: over.grade ? { ...g, ...over.grade } : g,
    passed: over.score >= PASS_SCORE,
    gradedAt: over.gradedAt ?? 0,
  };
}

function feedItem(over: Partial<FeedItem> & { id: string; topic: Topic }): FeedItem {
  return {
    id: over.id,
    sourceId: "src",
    sourceTitle: "Src",
    title: over.title ?? "Title",
    summary: over.summary ?? "",
    url: over.url ?? "https://example.com",
    publishedAt: over.publishedAt ?? 0,
    kind: "news",
    topic: over.topic,
    lean: null,
    confidence: 1,
    leanSource: "llm",
    estMinutes: 3,
    relevance: over.relevance,
  };
}

describe("computeProfile", () => {
  it("returns an empty profile with no summaries", () => {
    const p = computeProfile([]);
    expect(p.totalGraded).toBe(0);
    expect(p.avgScore).toBe(0);
    expect(p.topics).toEqual([]);
  });

  it("averages scores overall and per topic", () => {
    const p = computeProfile([
      summary({ topic: "science", score: 80 }),
      summary({ topic: "science", score: 60 }),
      summary({ topic: "world", score: 90 }),
    ]);
    expect(p.totalGraded).toBe(3);
    expect(p.avgScore).toBe(Math.round((80 + 60 + 90) / 3));
    const sci = p.topics.find((t) => t.topic === "science");
    expect(sci).toMatchObject({ count: 2, avgScore: 70 });
  });

  it("flags poorly-recalled topics and uncovered topics as weak", () => {
    const p = computeProfile([
      summary({ topic: "science", score: 50 }), // below pass -> weak
      summary({ topic: "world", score: 95 }), // strong -> not weak
    ]);
    expect(p.weakTopics).toContain("science");
    expect(p.weakTopics).not.toContain("world");
    // A topic never covered should also surface as a gap.
    expect(p.weakTopics).toContain("politics");
  });

  it("surfaces recurring missed concepts (frequency >= 2)", () => {
    const p = computeProfile([
      summary({ topic: "economics", score: 60, grade: { missed: ["inflation targets"] } as SummaryGrade }),
      summary({ topic: "economics", score: 55, grade: { missed: ["inflation outlook"] } as SummaryGrade }),
    ]);
    expect(p.weakConcepts).toContain("inflation");
  });
});

describe("pickCandidates", () => {
  it("prefers weak-topic items and excludes already-summarized ones", () => {
    const summaries = [summary({ id: "seen1", topic: "science", score: 40 })];
    const profile = computeProfile(summaries);
    const pool = [
      feedItem({ id: "seen1", topic: "science" }), // already summarized -> excluded
      feedItem({ id: "sci-new", topic: "science", title: "New science result" }), // weak topic -> included
      feedItem({ id: "world-strong", topic: "world" }), // not weak, no concept hit
    ];
    const picks = pickCandidates(pool, profile, summaries);
    const ids = picks.map((p) => p.id);
    expect(ids).toContain("sci-new");
    expect(ids).not.toContain("seen1");
  });
});
