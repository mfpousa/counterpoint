import { extractJson, extractJsonObject } from "../server/ai";

describe("extractJson", () => {
  it("parses a plain JSON array", () => {
    expect(extractJson('[{"id":"a","junk":false}]')).toEqual([{ id: "a", junk: false }]);
  });

  it("unwraps a ```json fenced array", () => {
    const out = extractJson('```json\n[{"id":"a"}]\n```');
    expect(out).toEqual([{ id: "a" }]);
  });

  it("salvages complete objects from a TRUNCATED array (model hit max_tokens)", () => {
    // Second object is cut off mid-string — the whole array is unparseable, but
    // the first complete object must still be recovered.
    const truncated = '[{"id":"a","summary":"done"},{"id":"b","summary":"half';
    expect(extractJson(truncated)).toEqual([{ id: "a", summary: "done" }]);
  });

  it("returns null on irrecoverable garbage", () => {
    expect(extractJson("not json at all")).toBeNull();
  });
});

describe("extractJsonObject", () => {
  it("pulls the { items: [...] } envelope out of fenced prose", () => {
    const out = extractJsonObject('Here you go:\n```json\n{"items":[{"id":"a"}]}\n```');
    expect(out).toEqual({ items: [{ id: "a" }] });
  });
});
