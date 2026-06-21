import {
  parseSearchOutput,
  filterHits,
  cleanHeadlineQuery,
  type YouTubeHit,
} from "../server/youtubeSearch";

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe("parseSearchOutput", () => {
  it("parses valid entries and normalizes fields", () => {
    const out = parseSearchOutput(
      [
        line({
          id: "abcdefghij1",
          title: "Big News Tonight",
          channel: "PBS NewsHour",
          duration: 620,
          upload_date: "20240115",
          thumbnails: [{ url: "http://t/1.jpg" }],
        }),
        line({ id: "klmnopqrst2", title: "Pod Talk", uploader: "Some Pod", duration: 3600 }),
      ].join("\n"),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      videoId: "abcdefghij1",
      channel: "PBS NewsHour",
      durationSec: 620,
      url: "https://www.youtube.com/watch?v=abcdefghij1",
      thumbnail: "http://t/1.jpg",
      uploadedAt: Date.UTC(2024, 0, 15),
    });
    // Falls back to `uploader` when `channel` is absent.
    expect(out[1].channel).toBe("Some Pod");
    // Synthesizes a thumbnail when none is supplied.
    expect(out[1].thumbnail).toContain("klmnopqrst2");
  });

  it("skips malformed, private, and invalid-id lines", () => {
    const out = parseSearchOutput(
      [
        "this is not json",
        line({ id: "short", title: "bad id" }),
        line({ id: "abcdefghij1", title: "[Private video]" }),
        line({ title: "no id at all" }),
      ].join("\n"),
    );
    expect(out).toHaveLength(0);
  });
});

describe("filterHits", () => {
  const hit = (videoId: string, durationSec: number | null): YouTubeHit => ({
    videoId,
    title: videoId,
    channel: "c",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    durationSec,
  });

  it("drops shorts and over-long videos, dedupes, keeps unknown durations", () => {
    const kept = filterHits([
      hit("aaaaaaaaaaa", 600), // ok
      hit("bbbbbbbbbbb", 30), // too short
      hit("ccccccccccc", 5 * 60 * 60), // too long
      hit("ddddddddddd", null), // unknown duration -> kept
      hit("aaaaaaaaaaa", 600), // duplicate
    ]);
    expect(kept.map((h) => h.videoId)).toEqual(["aaaaaaaaaaa", "ddddddddddd"]);
  });
});

describe("cleanHeadlineQuery", () => {
  it("strips a trailing outlet/site suffix", () => {
    expect(cleanHeadlineQuery("Markets tumble on rate fears - The New York Times")).toBe(
      "Markets tumble on rate fears",
    );
    expect(cleanHeadlineQuery("Senate passes the bill | Reuters")).toBe("Senate passes the bill");
  });

  it("strips surrounding quotes and caps the length", () => {
    expect(cleanHeadlineQuery('"Quoted headline"')).toBe("Quoted headline");
    expect(cleanHeadlineQuery("x".repeat(200))).toHaveLength(120);
  });
});
