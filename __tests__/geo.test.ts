import {
  GEO_ROOT_ID,
  geoNodeIdOf,
  isGeoPoolId,
  poolIdForNode,
} from "../src/data/geo";

// The shared geo module is now purely the type model + pool-id helpers. The TREE
// itself is data-driven and lives server-side (see __tests__/geoTree.test.ts), so
// these helpers are FORMAT-based (no membership against a hardcoded node list).
describe("geo pool ids", () => {
  it("exposes the world root", () => {
    expect(GEO_ROOT_ID).toBe("world");
  });

  it("maps node ids <-> pool ids round-trip", () => {
    expect(poolIdForNode("es")).toBe("geo-es");
    expect(poolIdForNode("es-ga")).toBe("geo-es-ga");
    expect(geoNodeIdOf("geo-es-ga")).toBe("es-ga");
    expect(geoNodeIdOf(poolIdForNode("europe"))).toBe("europe");
  });

  it("recognizes geo pool ids by SHAPE, not membership", () => {
    expect(isGeoPoolId("geo-es")).toBe(true);
    expect(isGeoPoolId("geo-anything")).toBe(true); // server validates existence
    expect(isGeoPoolId("geo-")).toBe(false); // empty node id
    expect(isGeoPoolId("place-es")).toBe(false); // legacy regional id
    expect(isGeoPoolId("frontpage")).toBe(false);
    expect(isGeoPoolId(null)).toBe(false);
    expect(isGeoPoolId(undefined)).toBe(false);
  });

  it("returns null for non-geo pool ids", () => {
    expect(geoNodeIdOf("place-es")).toBeNull();
    expect(geoNodeIdOf("frontpage")).toBeNull();
    expect(geoNodeIdOf("geo-")).toBeNull();
    expect(geoNodeIdOf(null)).toBeNull();
  });
});
