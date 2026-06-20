import { parseParagraphs, cleanTitle } from "../server/rewrite";

describe("parseParagraphs (rewrite sanitizer)", () => {
  it("keeps real prose paragraphs", () => {
    const out = parseParagraphs({
      paragraphs: [
        "The article explores resistance to AI among writers, arguing it is understandable.",
        "It then suggests language is the shared element between humans and machines.",
      ],
    });
    expect(out).toHaveLength(2);
  });

  it("drops leaked JSON scaffolding + the echoed title from paragraphs", () => {
    const out = parseParagraphs(
      {
        title: "Words, words, words",
        paragraphs: [
          "The article by Martin Puchner explores the resistance to AI among writers, which is understandable.",
          "```json, {",
          "title",
          "Words, words, words",
          "paragraphs",
          "{",
          "}",
        ],
      },
      "Words, words, words",
    );
    expect(out).toEqual([
      "The article by Martin Puchner explores the resistance to AI among writers, which is understandable.",
    ]);
  });

  it("de-dupes consecutive echoed paragraphs", () => {
    const p = "This is a substantive paragraph of real prose about the topic at hand.";
    expect(parseParagraphs({ paragraphs: [p, p] })).toEqual([p]);
  });

  it("strips code fences wrapping a paragraph", () => {
    const out = parseParagraphs({
      paragraphs: ["```json The cabinet approved the budget after a long overnight session.```"],
    });
    expect(out[0]).toBe("The cabinet approved the budget after a long overnight session.");
  });

  it("returns [] when nothing substantive survives (so the caller fails cleanly)", () => {
    expect(parseParagraphs({ paragraphs: ["```json, {", "title", "paragraphs", "}"] })).toEqual([]);
    expect(parseParagraphs({})).toEqual([]);
    expect(parseParagraphs({ paragraphs: "not an array" })).toEqual([]);
  });
});

describe("cleanTitle", () => {
  it("returns a clean title", () => {
    expect(cleanTitle("Words, words, words", "fallback")).toBe("Words, words, words");
  });
  it("strips fences and surrounding quotes", () => {
    expect(cleanTitle('```json "Breaking News"```', "fallback")).toBe("Breaking News");
  });
  it("falls back for scaffolding or non-strings", () => {
    expect(cleanTitle("title", "fallback")).toBe("fallback");
    expect(cleanTitle(undefined, "fallback")).toBe("fallback");
    expect(cleanTitle("", "fallback")).toBe("fallback");
  });
});
