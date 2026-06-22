import {
  WORLDS,
  DEFAULT_WORLD_ID,
  worldById,
  worldSources,
  isWorldId,
  isPlaceWorldId,
  placeCountryOf,
  placeWorldId,
} from "../src/data/worlds";

describe("worlds", () => {
  it("includes the default front-page world", () => {
    expect(WORLDS.some((w) => w.id === DEFAULT_WORLD_ID)).toBe(true);
    expect(worldById(DEFAULT_WORLD_ID).id).toBe(DEFAULT_WORLD_ID);
  });

  it("every world has a non-empty, unique id and at least one source", () => {
    const ids = new Set<string>();
    for (const w of WORLDS) {
      expect(w.id.length).toBeGreaterThan(0);
      expect(ids.has(w.id)).toBe(false);
      ids.add(w.id);
      expect(w.sources.length).toBeGreaterThan(0);
    }
  });

  it("worldById falls back to the default for unknown/blank ids", () => {
    expect(worldById("does-not-exist").id).toBe(DEFAULT_WORLD_ID);
    expect(worldById(undefined).id).toBe(DEFAULT_WORLD_ID);
    expect(worldById(null).id).toBe(DEFAULT_WORLD_ID);
  });

  it("isWorldId recognizes known worlds only", () => {
    expect(isWorldId(DEFAULT_WORLD_ID)).toBe(true);
    expect(isWorldId("nope")).toBe(false);
    expect(isWorldId(undefined)).toBe(false);
  });

  it("worldSources returns the world's source list", () => {
    expect(worldSources(DEFAULT_WORLD_ID)).toBe(worldById(DEFAULT_WORLD_ID).sources);
  });

  it("no longer includes the retired Spain world (replaced by the place lens)", () => {
    expect(isWorldId("spain")).toBe(false);
  });

  describe("regional pool ids", () => {
    it("recognizes well-formed place-<cc> ids only", () => {
      expect(isPlaceWorldId("place-es")).toBe(true);
      expect(isPlaceWorldId("place-us")).toBe(true);
      expect(isPlaceWorldId("place-")).toBe(false);
      expect(isPlaceWorldId("place-esp")).toBe(false); // must be 2-letter
      expect(isPlaceWorldId("frontpage")).toBe(false);
      expect(isPlaceWorldId(undefined)).toBe(false);
    });

    it("a regional pool id is NOT a topical world id (orthogonal namespaces)", () => {
      expect(isWorldId("place-es")).toBe(false);
    });

    it("placeWorldId and placeCountryOf round-trip the country code", () => {
      expect(placeWorldId("es")).toBe("place-es");
      expect(placeWorldId("US")).toBe("place-us"); // normalized
      expect(placeCountryOf("place-es")).toBe("es");
      expect(placeCountryOf("frontpage")).toBeNull();
      expect(placeCountryOf(placeWorldId("fr"))).toBe("fr");
    });
  });
});
