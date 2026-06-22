import { storyChange, lastMinuteStories, milestoneIsNew } from "../src/lib/storyUpdates";
import type { Story, StorySource, StoryView } from "../src/types";

function src(id: string): StorySource {
  return {
    id,
    title: `Article ${id}`,
    sourceTitle: "Outlet",
    url: `https://example.com/${id}`,
    lean: 0,
    leanSource: "source",
    publishedAt: 1_000,
  };
}

function story(over: Partial<Story> = {}): Story {
  return {
    id: "s1",
    title: "A developing story",
    summary: "",
    synthesis: [],
    topic: "world",
    lean: 0,
    severity: 0.5,
    sources: [src("a"), src("b")],
    angles: [],
    contradictions: [],
    relatedIds: [],
    updatedAt: 2_000,
    generatedAt: 2_000,
    developing: true,
    ...over,
  };
}

describe("storyChange", () => {
  it("treats a never-seen story as not changed", () => {
    expect(storyChange(story(), undefined)).toEqual({
      seen: false,
      hasUpdates: false,
      newSources: 0,
      seenAt: null,
    });
  });

  it("reports no updates when nothing moved since last seen", () => {
    const view: StoryView = { seenAt: 5_000, updatedAt: 2_000, sourceCount: 2 };
    const c = storyChange(story(), view);
    expect(c).toMatchObject({ seen: true, hasUpdates: false, newSources: 0, seenAt: 5_000 });
  });

  it("counts new articles since last seen", () => {
    const view: StoryView = { seenAt: 5_000, updatedAt: 2_000, sourceCount: 1 };
    const c = storyChange(story({ sources: [src("a"), src("b"), src("c")] }), view);
    expect(c.hasUpdates).toBe(true);
    expect(c.newSources).toBe(2);
  });

  it("flags fresher coverage even when the source count is unchanged", () => {
    const view: StoryView = { seenAt: 5_000, updatedAt: 1_000, sourceCount: 2 };
    const c = storyChange(story({ updatedAt: 9_000 }), view);
    expect(c.hasUpdates).toBe(true);
    expect(c.newSources).toBe(0);
  });
});

describe("lastMinuteStories", () => {
  it("returns only changed stories, developing first then most recent", () => {
    const a = story({ id: "a", developing: false, updatedAt: 100, sources: [src("x")] });
    const b = story({ id: "b", developing: true, updatedAt: 200, sources: [src("y")] });
    const c = story({ id: "c", developing: true, updatedAt: 300, sources: [src("z")] });
    const views: Record<string, StoryView> = {
      a: { seenAt: 1, updatedAt: 50, sourceCount: 0 }, // changed (non-developing)
      b: { seenAt: 1, updatedAt: 50, sourceCount: 0 }, // changed (developing)
      c: { seenAt: 1, updatedAt: 50, sourceCount: 0 }, // changed (developing, newest)
    };
    const out = lastMinuteStories([a, b, c], views);
    expect(out.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("excludes unseen and unchanged stories", () => {
    const a = story({ id: "a", updatedAt: 100 });
    const b = story({ id: "b", updatedAt: 100 });
    const views: Record<string, StoryView> = {
      b: { seenAt: 1, updatedAt: 100, sourceCount: 2 }, // seen, unchanged
    };
    expect(lastMinuteStories([a, b], views)).toEqual([]);
  });

  it("promotes unseen stories with recent activity (within the window)", () => {
    const now = 10_000_000;
    const recentMs = 2 * 60 * 60 * 1000;
    const recent = story({ id: "r", updatedAt: now - 1000, sources: [src("x")] }); // never seen
    const stale = story({ id: "s", updatedAt: now - 5 * 60 * 60 * 1000, sources: [src("y")] });
    const out = lastMinuteStories([recent, stale], {}, recentMs, now);
    expect(out.map((s) => s.id)).toEqual(["r"]);
  });
});

describe("milestoneIsNew", () => {
  const m = { at: 500, title: "x", detail: "", sourceIds: [] };
  it("is new only when it happened after the last view", () => {
    expect(milestoneIsNew(m, 400)).toBe(true);
    expect(milestoneIsNew(m, 600)).toBe(false);
    expect(milestoneIsNew(m, null)).toBe(false);
  });
});
