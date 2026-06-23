import { searchPlaces, type PlaceHit } from "../src/lib/placeSearch";
import { latLonToVec3 } from "../src/lib/globeLayout";

const PLACES: PlaceHit[] = [
  { nodeId: "europe", label: "Europe", level: "continent", dir: latLonToVec3(50, 15) },
  { nodeId: "es", label: "Spain", level: "country", dir: latLonToVec3(40, -3) },
  { nodeId: "kr", label: "South Korea", level: "country", dir: latLonToVec3(37, 127) },
  { nodeId: "us", label: "United States", level: "country", dir: latLonToVec3(39, -98) },
];

describe("placeSearch (unified place finder)", () => {
  it("returns nothing for an empty query", () => {
    expect(searchPlaces(PLACES, "")).toEqual([]);
    expect(searchPlaces(PLACES, "   ")).toEqual([]);
  });

  it("prefix-matches a country", () => {
    expect(searchPlaces(PLACES, "spa")[0].nodeId).toBe("es");
  });

  it("prefix-matches a continent", () => {
    expect(searchPlaces(PLACES, "eur")[0].nodeId).toBe("europe");
  });

  it("matches an interior word ('korea' / 'south')", () => {
    expect(searchPlaces(PLACES, "korea")[0].nodeId).toBe("kr");
    expect(searchPlaces(PLACES, "south")[0].nodeId).toBe("kr");
  });

  it("honours the result limit", () => {
    expect(searchPlaces(PLACES, "a", 2).length).toBeLessThanOrEqual(2);
  });
});
