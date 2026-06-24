import { coerceLinks } from "../server/synthesize";

describe("coerceLinks (place-to-place flow arcs)", () => {
  it("keeps valid ISO-2 from→to pairs (lowercased) with a SPECIFIC kind", () => {
    expect(coerceLinks([{ from: "CD", to: "fr", kind: "spread" }])).toEqual([
      { from: "cd", to: "fr", kind: "spread" },
    ]);
  });

  it("drops links the model couldn't classify (missing / unknown / 'other' kind)", () => {
    // No generic fallback — an unclassifiable link is not a valid link.
    expect(coerceLinks([{ from: "ru", to: "ua" }])).toEqual([]);
    expect(coerceLinks([{ from: "ru", to: "ua", kind: "bogus" }])).toEqual([]);
    expect(coerceLinks([{ from: "ru", to: "ua", kind: "other" }])).toEqual([]);
    // A dropped link doesn't block a valid one for the same pair.
    expect(
      coerceLinks([
        { from: "ru", to: "ua", kind: "other" }, // dropped
        { from: "ru", to: "ua", kind: "attack" }, // kept
      ]),
    ).toEqual([{ from: "ru", to: "ua", kind: "attack" }]);
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
      { from: "aa", to: "bb", kind: "trade" },
      { from: "cc", to: "dd", kind: "trade" },
      { from: "ee", to: "ff", kind: "trade" },
      { from: "gg", to: "hh", kind: "trade" },
      { from: "ii", to: "jj", kind: "trade" },
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
