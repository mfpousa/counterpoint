import {
  WORLDS,
  DEFAULT_WORLD_ID,
  worldById,
  worldSources,
  isWorldId,
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
});
