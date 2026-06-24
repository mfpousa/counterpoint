import { coerceLinks } from "../server/synthesize";

describe("coerceLinks (place-to-place flow arcs)", () => {
  it("keeps valid ISO-2 from→to pairs, lowercased, with the kind (default 'other')", () => {
    expect(coerceLinks([{ from: "CD", to: "fr", kind: "spread" }])).toEqual([
      { from: "cd", to: "fr", kind: "spread" },
    ]);
    // Missing/unknown kind falls back to "other".
    expect(coerceLinks([{ from: "ru", to: "ua" }])).toEqual([
      { from: "ru", to: "ua", kind: "other" },
    ]);
    expect(coerceLinks([{ from: "ru", to: "ua", kind: "bogus" }])).toEqual([
      { from: "ru", to: "ua", kind: "other" },
    ]);
  });

  it("drops self-links, non-ISO-2 endpoints, and duplicates", () => {
    expect(
      coerceLinks([
        { from: "us", to: "us", kind: "attack" }, // self → dropped
        { from: "usa", to: "fr", kind: "trade" }, // 3 letters → dropped
        { from: "cd", to: "fr", kind: "spread" }, // ok
        { from: "cd", to: "fr", kind: "spread" }, // duplicate → dropped
        { from: "ru", to: "ua", kind: "attack" }, // ok
      ]),
    ).toEqual([
      { from: "cd", to: "fr", kind: "spread" },
      { from: "ru", to: "ua", kind: "attack" },
    ]);
  });

  it("caps at `max` (default 4)", () => {
    const pairs = [
      { from: "aa", to: "bb", kind: "other" },
      { from: "cc", to: "dd", kind: "other" },
      { from: "ee", to: "ff", kind: "other" },
      { from: "gg", to: "hh", kind: "other" },
      { from: "ii", to: "jj", kind: "other" },
    ];
    expect(coerceLinks(pairs)).toHaveLength(4);
    expect(coerceLinks(pairs, 2)).toHaveLength(2);
  });

  it("returns [] for non-arrays / junk rows", () => {
    expect(coerceLinks(null)).toEqual([]);
    expect(coerceLinks("nope")).toEqual([]);
    expect(coerceLinks([{}, 3, null, { from: "x" }])).toEqual([]);
  });
});
