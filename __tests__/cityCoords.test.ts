import { lookupCity, cityCount, normalizePlace } from "../src/lib/cityCoords";

// Allow a degree or so of slack — the gazetteer stores rounded coords and a city's point is
// approximate anyway. These cities are large + stable in the GeoNames cities15000 dump.
const near = (got: number, want: number, tol = 1) => Math.abs(got - want) <= tol;

describe("cityCoords gazetteer (bundled GeoNames cities15000)", () => {
  it("loaded a substantial set of cities", () => {
    expect(cityCount()).toBeGreaterThan(20000);
  });

  it("normalizes names: diacritics, case, punctuation", () => {
    expect(normalizePlace("  São Paulo! ")).toBe("sao paulo");
    expect(normalizePlace("The Hague")).toBe("the hague");
  });

  it("geocodes well-known cities by name", () => {
    const tokyo = lookupCity("Tokyo", "jp");
    expect(tokyo).not.toBeNull();
    expect(near(tokyo!.lat, 35.69) && near(tokyo!.lon, 139.69)).toBe(true);

    const geneva = lookupCity("Geneva", "ch");
    expect(geneva).not.toBeNull();
    expect(near(geneva!.lat, 46.2) && near(geneva!.lon, 6.14)).toBe(true);
  });

  it("prefers the host country, else the most populous match", () => {
    // Bare "Geneva" → the Swiss one (far more populous than Geneva, Illinois).
    const geneva = lookupCity("Geneva");
    expect(geneva).not.toBeNull();
    expect(near(geneva!.lat, 46.2, 1.5)).toBe(true);
    // Scoped to the US → Geneva, Illinois (~41.9, -88.3), a different point.
    const us = lookupCity("Geneva", "us");
    expect(us).not.toBeNull();
    expect(us!.lat).toBeGreaterThan(38);
    expect(us!.lon).toBeLessThan(-80);
  });

  it("returns null for an unknown place", () => {
    expect(lookupCity("Zzqwx Nowhereville")).toBeNull();
  });
});
