import {
  aliasHits,
  isPlaceRelevant,
  placeAliases,
  placeBoostedRelevance,
  placeLabel,
  resolveChain,
  scorePlace,
  PLACE_LEVEL_WEIGHT,
} from "../src/lib/places";
import type { PlaceNode } from "../src/types";

// A tiny hermetic gazetteer fixture (no network / generated file needed).
const NODES: PlaceNode[] = [
  {
    id: "es",
    level: "country",
    label: "Spain",
    country: "es",
    aliases: ["spain", "spanish", "españa", "madrid"], // "madrid" also a national shorthand
  },
  {
    id: "es-md",
    parent: "es",
    level: "region",
    label: "Comunidad de Madrid",
    country: "es",
    aliases: ["comunidad de madrid", "madrid region", "madrileño"],
  },
  {
    id: "es-md-mostoles",
    parent: "es-md",
    level: "locality",
    label: "Móstoles",
    country: "es",
    aliases: ["móstoles", "mostoles"],
    population: 207095,
  },
];

describe("aliasHits", () => {
  it("matches single-word aliases as whole tokens only", () => {
    expect(aliasHits("Tensions rise in Spain", ["spain"])).toBe(1);
    // "leon" must NOT fire inside "napoleon"
    expect(aliasHits("A study of Napoleon", ["leon"])).toBe(0);
  });

  it("matches multi-word aliases as substrings", () => {
    expect(aliasHits("the comunidad de madrid budget", ["comunidad de madrid"])).toBe(1);
  });

  it("counts DISTINCT aliases and dedupes repeats", () => {
    expect(aliasHits("Madrid, madrid, MADRID", ["madrid", "madrid"])).toBe(1);
    expect(aliasHits("spain and españa", ["spain", "españa"])).toBe(2);
  });

  it("is accent-sensitive on the alias as written", () => {
    expect(aliasHits("noticias de Móstoles hoy", ["móstoles"])).toBe(1);
  });
});

describe("resolveChain", () => {
  it("returns [country] for a country-only place", () => {
    const chain = resolveChain({ country: "es" }, NODES);
    expect(chain.map((n) => n.id)).toEqual(["es"]);
  });

  it("returns [country, region] when a region is set", () => {
    const chain = resolveChain({ country: "es", region: "es-md" }, NODES);
    expect(chain.map((n) => n.id)).toEqual(["es", "es-md"]);
  });

  it("resolves a free-text locality to its gazetteer node (accent-insensitive)", () => {
    const chain = resolveChain({ country: "es", region: "es-md", locality: "Mostoles" }, NODES);
    expect(chain.map((n) => n.id)).toEqual(["es", "es-md", "es-md-mostoles"]);
  });

  it("synthesizes an ad-hoc locality node for an unknown place", () => {
    const chain = resolveChain({ country: "es", locality: "Villarriba" }, NODES);
    expect(chain).toHaveLength(2); // country + synthesized locality
    const loc = chain[1];
    expect(loc.level).toBe("locality");
    expect(loc.aliases).toContain("villarriba");
  });
});

describe("placeAliases", () => {
  it("unions aliases across the whole chain", () => {
    const aliases = placeAliases({ country: "es", region: "es-md", locality: "Móstoles" }, NODES);
    expect(aliases).toEqual(expect.arrayContaining(["spain", "comunidad de madrid", "móstoles"]));
  });
});

describe("scorePlace", () => {
  it("returns 0 for text unrelated to the place", () => {
    expect(scorePlace("A football match in Tokyo", { country: "es" }, NODES)).toBe(0);
  });

  it("weights a locality hit above a country hit", () => {
    const text = "The Móstoles council met today";
    const localityScore = scorePlace(text, { country: "es", region: "es-md", locality: "Móstoles" }, NODES);
    const countryScore = scorePlace("Spain debated the budget", { country: "es" }, NODES);
    // locality weight (3) > country weight (1)
    expect(localityScore).toBeGreaterThanOrEqual(PLACE_LEVEL_WEIGHT.locality);
    expect(localityScore).toBeGreaterThan(countryScore);
  });

  it("accumulates across levels when multiple match", () => {
    // mentions the country shorthand AND the locality
    const text = "In Spain, the town of Móstoles voted";
    const score = scorePlace(text, { country: "es", region: "es-md", locality: "Móstoles" }, NODES);
    // country alias "spain" (1*1) + locality alias "móstoles" (3*1) = 4
    expect(score).toBe(4);
  });
});

describe("isPlaceRelevant", () => {
  it("is true at/above the threshold and false below", () => {
    const place = { country: "es", region: "es-md", locality: "Móstoles" };
    expect(isPlaceRelevant("Móstoles news", place, NODES)).toBe(true);
    expect(isPlaceRelevant("Unrelated story", place, NODES)).toBe(false);
  });
});

describe("placeLabel", () => {
  it("joins the chain labels for a UI chip", () => {
    expect(placeLabel({ country: "es", region: "es-md", locality: "Móstoles" }, NODES)).toBe(
      "Spain · Comunidad de Madrid · Móstoles",
    );
  });
});

describe("placeBoostedRelevance", () => {
  it("returns relevance unchanged when there is no place match", () => {
    expect(placeBoostedRelevance(0.4, 0)).toBe(0.4);
  });

  it("returns relevance unchanged when the boost is disabled", () => {
    expect(placeBoostedRelevance(0.4, 5, { boostWeight: 0 })).toBe(0.4);
  });

  it("lifts relevance toward 1 (never above) and never lowers it", () => {
    const boosted = placeBoostedRelevance(0.5, 3, { boostWeight: 0.5, saturateAt: 3 });
    // 0.5 + 0.5 * 1 * (1 - 0.5) = 0.75
    expect(boosted).toBeCloseTo(0.75, 5);
    expect(boosted).toBeGreaterThan(0.5);
    expect(placeBoostedRelevance(0.9, 100)).toBeLessThanOrEqual(1);
  });

  it("scales with match strength up to saturation", () => {
    const weak = placeBoostedRelevance(0.5, 1, { boostWeight: 0.6, saturateAt: 3 });
    const strong = placeBoostedRelevance(0.5, 3, { boostWeight: 0.6, saturateAt: 3 });
    expect(strong).toBeGreaterThan(weak);
    // Beyond saturation it doesn't keep growing.
    const past = placeBoostedRelevance(0.5, 9, { boostWeight: 0.6, saturateAt: 3 });
    expect(past).toBeCloseTo(strong, 5);
  });
});
