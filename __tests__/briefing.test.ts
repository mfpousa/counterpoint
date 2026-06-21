import { parseBriefingText } from "../server/briefing";

describe("parseBriefingText", () => {
  it("parses a well-formed plain briefing", () => {
    const raw = [
      "Markets are jittery as rate-cut hopes fade.",
      "",
      "- Rates: Central banks signal a longer hold, pressuring equities.",
      "- Energy: Oil climbs on supply worries.",
      "",
      "Outlook: Expect choppy trading until the next inflation print.",
    ].join("\n");
    const { mood, threads, outlook } = parseBriefingText(raw);
    expect(mood).toBe("Markets are jittery as rate-cut hopes fade.");
    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({
      title: "Rates",
      detail: "Central banks signal a longer hold, pressuring equities.",
    });
    expect(outlook).toBe("Expect choppy trading until the next inflation print.");
  });

  it("handles bullets without a label", () => {
    const { threads } = parseBriefingText("Mood line.\n- A plain bullet with no colon label here");
    expect(threads).toEqual([{ title: "", detail: "A plain bullet with no colon label here" }]);
  });

  it("strips code fences and caps threads at 5", () => {
    const raw =
      "```\nMood.\n- a: 1\n- b: 2\n- c: 3\n- d: 4\n- e: 5\n- f: 6\nOutlook: done\n```";
    const { mood, threads, outlook } = parseBriefingText(raw);
    expect(mood).toBe("Mood.");
    expect(threads).toHaveLength(5);
    expect(outlook).toBe("done");
  });

  it("returns empty fields for empty input", () => {
    expect(parseBriefingText("")).toEqual({ mood: "", threads: [], outlook: "" });
  });
});
