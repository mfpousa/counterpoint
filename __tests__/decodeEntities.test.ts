import { decodeEntities } from "../src/lib/rss";

describe("decodeEntities", () => {
  it("decodes numeric entities (decimal and hex)", () => {
    expect(decodeEntities("It&#039;s here")).toBe("It's here");
    expect(decodeEntities("It&#x27;s here")).toBe("It's here");
  });

  it("decodes common named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeEntities("a &lt; b &gt; c")).toBe("a < b > c");
    expect(decodeEntities("dash &mdash; here")).toBe("dash — here");
  });

  it("handles DOUBLE-encoded entities (e.g. &amp;#039;)", () => {
    expect(decodeEntities("It&amp;#039;s")).toBe("It's");
    expect(decodeEntities("A&amp;amp;B")).toBe("A&B");
  });

  it("leaves unknown entities and plain text untouched", () => {
    expect(decodeEntities("plain text")).toBe("plain text");
    expect(decodeEntities("&unknownentity;")).toBe("&unknownentity;");
  });
});
