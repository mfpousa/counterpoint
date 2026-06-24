import { countryLabel } from "../src/lib/countries";

describe("countryLabel (discovered placeSources registry)", () => {
  it("maps a catalogued ISO-2 code to its country name", () => {
    expect(countryLabel("ua")).toMatch(/ukrain/i);
    expect(countryLabel("RU")).toMatch(/russ/i); // case-insensitive
  });

  it("falls back to the upper-cased code for an uncatalogued code", () => {
    expect(countryLabel("zz")).toBe("ZZ");
  });

  it("returns International for absent / global tokens", () => {
    expect(countryLabel(undefined)).toBe("International");
    expect(countryLabel(null)).toBe("International");
    expect(countryLabel("")).toBe("International");
    expect(countryLabel("international")).toBe("International");
  });
});
