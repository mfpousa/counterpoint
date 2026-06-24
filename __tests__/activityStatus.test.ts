import { dominantActivity, type ActivityStage } from "../server/feedService";

// A tiny factory matching the shape getStatus feeds dominantActivity.
const task = (stage: ActivityStage, done = 0, total = 0) => ({ stage, done, total });

describe("dominantActivity (which running pass the indicator headlines)", () => {
  it("returns null when nothing is running", () => {
    expect(dominantActivity([])).toBeNull();
  });

  it("surfaces the only running stage", () => {
    expect(dominantActivity([task("fetching")])?.stage).toBe("fetching");
    expect(dominantActivity([task("embedding")])?.stage).toBe("embedding");
  });

  it("prefers deep analysis over a concurrent fetch", () => {
    expect(dominantActivity([task("fetching"), task("analyzing")])?.stage).toBe("analyzing");
  });

  it("prefers triage over embedding", () => {
    expect(dominantActivity([task("embedding"), task("triage")])?.stage).toBe("triage");
  });

  it("prefers synthesizing over bare fetching", () => {
    expect(dominantActivity([task("fetching"), task("synthesizing")])?.stage).toBe("synthesizing");
  });

  it("prefers transcripts over embedding", () => {
    expect(dominantActivity([task("embedding"), task("transcripts")])?.stage).toBe("transcripts");
  });

  it("respects the full priority order regardless of insertion order", () => {
    const tasks = [
      task("fetching"),
      task("synthesizing"),
      task("embedding"),
      task("transcripts"),
      task("triage"),
      task("analyzing"),
    ];
    expect(dominantActivity(tasks)?.stage).toBe("analyzing");
    // Drop analyzing → triage wins; then transcripts; then embedding; then synthesizing.
    expect(dominantActivity(tasks.filter((t) => t.stage !== "analyzing"))?.stage).toBe("triage");
    expect(
      dominantActivity(tasks.filter((t) => !["analyzing", "triage"].includes(t.stage)))?.stage,
    ).toBe("transcripts");
  });

  it("returns the actual task object (with its live progress) so the bar can read done/total", () => {
    const dom = dominantActivity([task("fetching"), task("analyzing", 5, 40)]);
    expect(dom).toEqual({ stage: "analyzing", done: 5, total: 40 });
  });
});
