import { coerceLinks } from "../server/synthesize";

describe("coerceLinks (place-to-place flow arcs)", () => {
  it("keeps valid ISO-2 from→to pairs, lowercased", () => {
    expect(coerceLinks([{ from: "CD", to: "fr" }])).toEqual([{ from: "cd", to: "fr" }]);
  });

  it("drops self-links, non-ISO-2 endpoints, and duplicates", () => {
    expect(
      coerceLinks([
        { from: "us", to: "us" }, // self → dropped
        { from: "usa", to: "fr" }, // 3 letters → dropped
        { from: "cd", to: "fr" }, // ok
        { from: "cd", to: "fr" }, // duplicate → dropped
        { from: "ru", to: "ua" }, // ok
      ]),
    ).toEqual([
      { from: "cd", to: "fr" },
      { from: "ru", to: "ua" },
    ]);
  });

  it("caps at `max` (default 4)", () => {
    const pairs = [
      { from: "aa", to: "bb" },
      { from: "cc", to: "dd" },
      { from: "ee", to: "ff" },
      { from: "gg", to: "hh" },
      { from: "ii", to: "jj" },
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
