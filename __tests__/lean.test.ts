import {
  applyCompletion,
  assessDrift,
  isPolitical,
  leanBucket,
  meanLean,
  windowDrift,
} from "../src/lib/lean";
import type { DailyProgress, FeedItem } from "../src/types";

function makeItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "i1",
    sourceId: "s1",
    sourceTitle: "Src",
    title: "t",
    summary: "",
    url: "https://x",
    publishedAt: 0,
    kind: "news",
    topic: "politics",
    lean: 0,
    confidence: 0.8,
    leanSource: "source",
    estMinutes: 10,
    ...over,
  };
}

const emptyProgress: DailyProgress = {
  date: "2026-01-01",
  consumedMin: 0,
  completedItemIds: [],
  leanWeightSum: 0,
  leanMinutesSum: 0,
  leftMinutesSum: 0,
  rightMinutesSum: 0,
};

describe("leanBucket", () => {
  it("maps the spectrum to buckets", () => {
    expect(leanBucket(-0.9)).toBe("left");
    expect(leanBucket(-0.3)).toBe("lean-left");
    expect(leanBucket(0)).toBe("center");
    expect(leanBucket(0.3)).toBe("lean-right");
    expect(leanBucket(0.9)).toBe("right");
    expect(leanBucket(null)).toBe("non-political");
  });
});

describe("isPolitical", () => {
  it("treats null lean as non-political", () => {
    expect(isPolitical({ lean: null })).toBe(false);
    expect(isPolitical({ lean: 0 })).toBe(true);
    expect(isPolitical({ lean: -0.5 })).toBe(true);
  });
});

describe("meanLean", () => {
  it("returns null with no minutes", () => {
    expect(meanLean(0, 0)).toBeNull();
  });
  it("computes the weighted mean", () => {
    expect(meanLean(-5, 10)).toBeCloseTo(-0.5);
  });
});

describe("applyCompletion", () => {
  it("advances consumed minutes and the lean tally for political items", () => {
    const item = makeItem({ lean: -0.8, estMinutes: 20 });
    const next = applyCompletion(emptyProgress, item);
    expect(next.consumedMin).toBe(20);
    expect(next.completedItemIds).toEqual(["i1"]);
    expect(next.leanMinutesSum).toBe(20);
    expect(next.leanWeightSum).toBeCloseTo(-16);
    expect(next.leftMinutesSum).toBe(20);
    expect(next.rightMinutesSum).toBe(0);
  });

  it("does not touch the lean tally for non-political items", () => {
    const item = makeItem({ lean: null, estMinutes: 15, topic: "science" });
    const next = applyCompletion(emptyProgress, item);
    expect(next.consumedMin).toBe(15);
    expect(next.leanMinutesSum).toBe(0);
    expect(next.leanWeightSum).toBe(0);
    expect(next.leftMinutesSum).toBe(0);
    expect(next.rightMinutesSum).toBe(0);
  });

  it("splits exactly-center content across both sides", () => {
    const item = makeItem({ lean: 0, estMinutes: 20 });
    const next = applyCompletion(emptyProgress, item);
    expect(next.leftMinutesSum).toBe(10);
    expect(next.rightMinutesSum).toBe(10);
  });

  it("is idempotent for an already-completed item", () => {
    const item = makeItem();
    const once = applyCompletion(emptyProgress, item);
    const twice = applyCompletion(once, item);
    expect(twice).toBe(once);
  });
});

describe("assessDrift", () => {
  it("flags left drift past the threshold", () => {
    const d = assessDrift(-6, 10, 10, 0, 0.25); // mean -0.6
    expect(d.direction).toBe("left");
    expect(d.warn).toBe(true);
    expect(d.leftShare).toBeCloseTo(1);
  });
  it("stays balanced within the threshold", () => {
    const d = assessDrift(1, 10, 5, 5, 0.25); // mean 0.1
    expect(d.warn).toBe(false);
    expect(d.direction).toBe("balanced");
  });
  it("returns null mean with no political consumption", () => {
    const d = assessDrift(0, 0, 0, 0, 0.25);
    expect(d.mean).toBeNull();
  });
});

describe("windowDrift", () => {
  it("aggregates a trailing window", () => {
    const d = windowDrift(
      [
        { date: "d1", leanWeightSum: -10, leanMinutesSum: 10, leftMinutesSum: 10, rightMinutesSum: 0 },
        { date: "d2", leanWeightSum: 2, leanMinutesSum: 10, leftMinutesSum: 0, rightMinutesSum: 10 },
      ],
      0.25,
    );
    expect(d.mean).toBeCloseTo(-0.4);
    expect(d.direction).toBe("left");
    // Shares come from the persisted directional minutes, not the mean's sign.
    expect(d.leftShare).toBeCloseTo(0.5);
    expect(d.rightShare).toBeCloseTo(0.5);
  });
});
