import { coerceLinks } from "../server/synthesize";

describe("coerceLinks (place-to-place flow arcs)", () => {
  it("keeps valid ISO-2 from→to pairs (lowercased) with a SPECIFIC kind", () => {
    expect(coerceLinks([{ from: "CD", to: "fr", kind: "spread" }])).toEqual([
      { from: "cd", to: "fr", kind: "spread" },
    ]);
    // 'tension' is a first-class link kind (conflict/standoff), not a separate provider.
    expect(coerceLinks([{ from: "ru", to: "ua", kind: "tension" }])).toEqual([
      { from: "ru", to: "ua", kind: "tension" },
    ]);
  });

  it("KEEPS a model-invented custom kind (with its icon), dropping only a MISSING kind", () => {
    // No preset fits → keep the model's own slug + chosen icon (a meaningful custom link).
    expect(
      coerceLinks([{ from: "ru", to: "ua", kind: "naval-blockade", icon: "boat" }]),
    ).toEqual([{ from: "ru", to: "ua", kind: "naval-blockade", icon: "boat" }]);
    // A KNOWN kind ignores any model icon (it has a curated visual).
    expect(coerceLinks([{ from: "cd", to: "fr", kind: "spread", icon: "skull" }])).toEqual([
      { from: "cd", to: "fr", kind: "spread" },
    ]);
    // Only a missing/empty kind is dropped — there's nothing to draw without one.
    expect(coerceLinks([{ from: "ru", to: "ua" }])).toEqual([]);
    expect(coerceLinks([{ from: "ru", to: "ua", kind: "   " }])).toEqual([]);
    // First link for a pair wins the dedupe (here the custom one).
    expect(
      coerceLinks([
        { from: "ru", to: "ua", kind: "cyberattack", icon: "bug" },
        { from: "ru", to: "ua", kind: "attack" }, // duplicate pair → dropped
      ]),
    ).toEqual([{ from: "ru", to: "ua", kind: "cyberattack", icon: "bug" }]);
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

  it("keeps the model's rationale (what the connection indicates), trimmed", () => {
    expect(
      coerceLinks([
        { from: "ru", to: "ua", kind: "attack", rationale: "  Strikes on the grid to break winter morale.  " },
      ]),
    ).toEqual([
      { from: "ru", to: "ua", kind: "attack", rationale: "Strikes on the grid to break winter morale." },
    ]);
    // No rationale supplied → omitted (the globe falls back to the headline on hover).
    expect(coerceLinks([{ from: "cd", to: "fr", kind: "spread" }])[0]).not.toHaveProperty("rationale");
  });
});
