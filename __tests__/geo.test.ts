import {
  childrenOf,
  geoLabel,
  geoNode,
  geoNodeIdOf,
  GEO_ROOT_ID,
  isGeoNode,
  isGeoPoolId,
  pathOf,
  poolIdForNode,
} from "../src/data/geo";

describe("geo tree", () => {
  it("resolves nodes and labels", () => {
    expect(geoNode("es")?.label).toBe("Spain");
    expect(geoNode("es-galicia-pontevedra-vigo")?.level).toBe("locality");
    expect(geoLabel("es-galicia")).toBe("Galicia");
    expect(geoLabel("unknown")).toBe("unknown");
    expect(isGeoNode("es")).toBe(true);
    expect(isGeoNode("nope")).toBe(false);
  });

  it("walks children", () => {
    const continents = childrenOf(GEO_ROOT_ID).map((n) => n.id);
    expect(continents).toContain("eu");
    expect(childrenOf("es").map((n) => n.id)).toEqual(["es-galicia"]);
    expect(childrenOf("es-galicia-pontevedra-vigo")).toEqual([]); // leaf
  });

  it("populates Europe's countries from the dataset (not a hardcoded handful)", () => {
    const euCountries = childrenOf("eu");
    // A broad, data-driven set — well beyond the original Spain-only seed.
    expect(euCountries.length).toBeGreaterThan(30);
    expect(euCountries.every((n) => n.level === "country" && n.parent === "eu")).toBe(true);
    const ids = euCountries.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["es", "fr", "de", "it", "gb", "ua"]));
    expect(isGeoNode("fr")).toBe(true);
    expect(geoNode("de")?.label).toBe("Germany");
    expect(pathOf("fr").map((n) => n.id)).toEqual(["world", "eu", "fr"]);
  });

  it("builds the root→node path inclusive and ordered", () => {
    const path = pathOf("es-galicia-pontevedra-vigo").map((n) => n.id);
    expect(path).toEqual([
      "world",
      "eu",
      "es",
      "es-galicia",
      "es-galicia-pontevedra",
      "es-galicia-pontevedra-vigo",
    ]);
    expect(pathOf("unknown")).toEqual([]);
  });

  it("maps pool ids <-> node ids", () => {
    expect(poolIdForNode("es-galicia")).toBe("geo-es-galicia");
    expect(geoNodeIdOf("geo-es-galicia")).toBe("es-galicia");
    expect(isGeoPoolId("geo-es")).toBe(true);
    expect(isGeoPoolId("geo-nope")).toBe(false); // unknown node
    expect(isGeoPoolId("place-es")).toBe(false); // legacy regional id
    expect(isGeoPoolId("frontpage")).toBe(false);
    expect(geoNodeIdOf("place-es")).toBeNull();
  });
});
