import { htmlToText, pickTitle } from "../server/readability";

describe("pickTitle", () => {
  it("prefers og:title, then h1, then <title>", () => {
    expect(
      pickTitle('<meta property="og:title" content="OG Headline"><title>Site</title>'),
    ).toBe("OG Headline");
    expect(pickTitle("<h1>The <em>Big</em> Story</h1><title>Site</title>")).toBe("The Big Story");
    expect(pickTitle("<title>Just A Title</title>")).toBe("Just A Title");
    expect(pickTitle("<p>no title here</p>")).toBe("");
  });
});

describe("htmlToText", () => {
  it("keeps paragraph structure, strips tags, drops tiny fragments", () => {
    const html =
      "<p>This is the first substantial paragraph of the article body text.</p>" +
      "<p>Share</p>" + // too short -> dropped
      "<p>Here is the second substantial paragraph with more real content here.</p>";
    const out = htmlToText(html);
    expect(out).toBe(
      "This is the first substantial paragraph of the article body text.\n\n" +
        "Here is the second substantial paragraph with more real content here.",
    );
  });

  it("decodes entities and collapses whitespace", () => {
    const out = htmlToText("<p>Markets   rose &amp; fell sharply over the    course of the day.</p>");
    expect(out).toBe("Markets rose & fell sharply over the course of the day.");
  });
});
