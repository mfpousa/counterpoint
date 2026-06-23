import {
  buildCountryShapes,
  buildLandGeometry,
  computeCentroids,
  continentSlug,
  iso2Of,
  type GeoJson,
} from "../src/lib/geoShapes";
import { latLonToVec3, lengthOf } from "../src/lib/globeLayout";

// A 10°×10° square near (lon 0, lat 0) plus a two-square MultiPolygon country.
const FIXTURE: GeoJson = {
  features: [
    {
      properties: { ISO_A2: "ZZ", ISO_A2_EH: "ZZ", CONTINENT: "North America", NAME: "Squareland" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      },
    },
    {
      properties: { ISO_A2: "-99", ISO_A2_EH: "Qory", CONTINENT: "Europe", NAME: "Multi" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [20, 20],
              [25, 20],
              [25, 25],
              [20, 20],
            ],
          ],
          [
            [
              [30, 30],
              [35, 30],
              [35, 35],
              [30, 30],
            ],
          ],
        ],
      },
    },
  ],
};

describe("geoShapes (GeoJSON → sphere geometry)", () => {
  it("continentSlug normalizes names", () => {
    expect(continentSlug("North America")).toBe("north-america");
    expect(continentSlug("Europe")).toBe("europe");
  });

  it("iso2Of prefers a valid 2-letter code and lowercases", () => {
    expect(iso2Of({ ISO_A2_EH: "FR", ISO_A2: "FR" })).toBe("fr");
    // ISO_A2 invalid ("-99"), ISO_A2_EH not 2 alpha → null
    expect(iso2Of({ ISO_A2: "-99", ISO_A2_EH: "Qory" })).toBeNull();
    expect(iso2Of({ ISO_A2: "-99", ISO_A2_EH: "ES" })).toBe("es");
  });

  it("buildLandGeometry returns a non-indexed sphere-projected triangle soup", () => {
    const { positions, normals } = buildLandGeometry(FIXTURE, 1);
    expect(positions.length % 9).toBe(0); // whole triangles (3 verts × 3 floats)
    expect(positions.length).toBeGreaterThan(0);
    // Non-indexed: one normal per position vertex.
    expect(normals.length).toBe(positions.length);
    // Every vertex sits on the unit sphere, and its normal is the matching outward dir.
    for (let i = 0; i < positions.length; i += 3) {
      const len = lengthOf({ x: positions[i], y: positions[i + 1], z: positions[i + 2] });
      expect(len).toBeCloseTo(1, 6);
      expect(lengthOf({ x: normals[i], y: normals[i + 1], z: normals[i + 2] })).toBeCloseTo(1, 6);
      // normal == normalized position (radius 1 here, so they match directly)
      expect(normals[i]).toBeCloseTo(positions[i], 6);
      expect(normals[i + 1]).toBeCloseTo(positions[i + 1], 6);
      expect(normals[i + 2]).toBeCloseTo(positions[i + 2], 6);
    }
  });
  it("buildCountryShapes returns one interactive shape per feature", () => {
    const shapes = buildCountryShapes(FIXTURE, 1);
    expect(shapes).toHaveLength(2);
    const zz = shapes.find((s) => s.iso2 === "zz")!;
    expect(zz).toBeTruthy();
    expect(zz.continent).toBe("north-america");
    expect(zz.positions.length % 9).toBe(0); // whole triangles
    expect(zz.normals.length).toBe(zz.positions.length); // one normal per vertex
    // Second feature's codes are invalid (-99 / "Qory") → iso2 null, continent europe.
    const eu = shapes.find((s) => s.continent === "europe")!;
    expect(eu.iso2).toBeNull();
  });

  it("radius scales the projected vertices", () => {
    const { positions } = buildLandGeometry(FIXTURE, 2);
    const len = lengthOf({ x: positions[0], y: positions[1], z: positions[2] });
    expect(len).toBeCloseTo(2, 6);
  });

  it("computeCentroids anchors countries and continents", () => {
    const { byIso2, byContinent } = computeCentroids(FIXTURE);
    expect(byIso2.has("zz")).toBe(true);
    const got = byIso2.get("zz")!;
    // It's a unit direction in the +x/+y/+z octant (lon/lat 0..10), landing loosely
    // near the square's centre (~5°,5°). Averaging vertices is an approximate
    // centroid — good enough to anchor a pin, not an exact spherical centroid.
    expect(lengthOf(got)).toBeCloseTo(1, 6);
    expect(got.x).toBeGreaterThan(0);
    expect(got.y).toBeGreaterThan(0);
    expect(got.z).toBeLessThan(0); // longitude is negated, so east (+lon) maps to -z
    const want = latLonToVec3(5, 5);
    expect(got.x).toBeCloseTo(want.x, 1);
    expect(got.y).toBeCloseTo(want.y, 1);
    expect(got.z).toBeCloseTo(want.z, 1);
    expect(byContinent.has("north-america")).toBe(true);
    expect(byContinent.has("europe")).toBe(true);
    // Continent centroid is a unit direction.
    expect(lengthOf(byContinent.get("europe")!)).toBeCloseTo(1, 6);
  });
});
