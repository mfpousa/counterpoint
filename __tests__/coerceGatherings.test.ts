import { coerceGatherings } from "../server/synthesize";

describe("coerceGatherings (co-located multi-party events)", () => {
  it("keeps a valid multi-party gathering, lowercasing codes and parsing coords", () => {
    expect(
      coerceGatherings([
        { kind: "summit", place: "Geneva", iso2: "CH", parties: ["US", "ru"], coords: "46.20,6.14" },
      ]),
    ).toEqual([
      { kind: "summit", place: "Geneva", iso2: "ch", parties: ["us", "ru"], lat: 46.2, lon: 6.14 },
    ]);
  });

  it("requires AT LEAST TWO distinct parties (it must be MULTI-party)", () => {
    expect(
      coerceGatherings([{ kind: "talks", place: "Doha", iso2: "qa", parties: ["us"], coords: "" }]),
    ).toEqual([]);
    // Duplicates collapse, so two copies of one country is still single-party → dropped.
    expect(
      coerceGatherings([
        { kind: "talks", place: "Doha", iso2: "qa", parties: ["us", "US"], coords: "" },
      ]),
    ).toEqual([]);
  });

  it("drops rows without a place or a valid host ISO-2", () => {
    expect(
      coerceGatherings([{ kind: "summit", place: "", iso2: "ch", parties: ["us", "ru"], coords: "" }]),
    ).toEqual([]);
    expect(
      coerceGatherings([
        { kind: "summit", place: "Nowhere", iso2: "xyz", parties: ["us", "ru"], coords: "" },
      ]),
    ).toEqual([]);
  });

  it("coerces an unknown/missing kind to 'other' rather than dropping the gathering", () => {
    expect(
      coerceGatherings([
        { kind: "shindig", place: "Davos", iso2: "ch", parties: ["us", "cn"], coords: "" },
      ]),
    ).toEqual([{ kind: "other", place: "Davos", iso2: "ch", parties: ["us", "cn"] }]);
  });

  it("omits coordinates when they are absent, malformed, out of range, or null-island", () => {
    const base = { kind: "forum", place: "New York", iso2: "us", parties: ["us", "cn"] };
    for (const coords of ["", "not coords", "200,9", "0,0"]) {
      expect(coerceGatherings([{ ...base, coords }])).toEqual([base]);
    }
  });

  it("de-dupes by place and caps the count", () => {
    const out = coerceGatherings([
      { kind: "summit", place: "Geneva", iso2: "ch", parties: ["us", "ru"], coords: "" },
      { kind: "talks", place: "geneva", iso2: "ch", parties: ["us", "ru"], coords: "" },
    ]);
    expect(out).toHaveLength(1);
  });
});
