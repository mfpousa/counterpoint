import {
  estimateMinutes,
  parseDurationToSeconds,
  readMinutesFromText,
} from "../src/lib/duration";

describe("parseDurationToSeconds", () => {
  it("parses HH:MM:SS", () => {
    expect(parseDurationToSeconds("01:02:03")).toBe(3723);
  });
  it("parses MM:SS", () => {
    expect(parseDurationToSeconds("12:30")).toBe(750);
  });
  it("parses raw seconds string", () => {
    expect(parseDurationToSeconds("90")).toBe(90);
  });
  it("parses raw seconds number", () => {
    expect(parseDurationToSeconds(45)).toBe(45);
  });
  it("returns null for empty/invalid", () => {
    expect(parseDurationToSeconds("")).toBeNull();
    expect(parseDurationToSeconds(null)).toBeNull();
    expect(parseDurationToSeconds("abc")).toBeNull();
    expect(parseDurationToSeconds(0)).toBeNull();
  });
});

describe("readMinutesFromText", () => {
  it("estimates ~200 wpm with a 1-min floor", () => {
    expect(readMinutesFromText("word ".repeat(200))).toBe(1);
    expect(readMinutesFromText("word ".repeat(600))).toBe(3);
    expect(readMinutesFromText("")).toBe(1);
  });
});

describe("estimateMinutes", () => {
  it("prefers explicit duration when present", () => {
    expect(estimateMinutes({ kind: "podcast", durationRaw: "30:00" })).toBe(30);
  });
  it("estimates news read time from summary", () => {
    expect(estimateMinutes({ kind: "news", summary: "word ".repeat(400) })).toBe(2);
  });
  it("falls back by kind when no duration/summary", () => {
    expect(estimateMinutes({ kind: "podcast" })).toBe(35);
    expect(estimateMinutes({ kind: "video" })).toBe(12);
    expect(estimateMinutes({ kind: "news" })).toBe(4);
  });
});
