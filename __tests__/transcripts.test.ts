import { vttToText, youTubeVideoId } from "../server/transcripts";

describe("youTubeVideoId", () => {
  it("extracts ids from watch / youtu.be / embed / shorts URLs", () => {
    expect(youTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://example.com/not-a-video")).toBeNull();
  });
});

describe("vttToText", () => {
  it("strips headers, timings, tags and de-duplicates rolling lines", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "Hello <00:00:00.500><c>world</c>",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "Hello world",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "It&#39;s a test &amp; more",
    ].join("\n");
    expect(vttToText(vtt)).toBe("Hello world It's a test & more");
  });

  it("returns empty string for a header-only file", () => {
    expect(vttToText("WEBVTT\n\n")).toBe("");
  });
});
