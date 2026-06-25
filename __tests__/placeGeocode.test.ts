import { geocodeGathering, type GeocodeContext } from "../src/lib/placeGeocode";
import { latLonToVec3, type Vec3 } from "../src/lib/globeLayout";
import type { BBox } from "../src/lib/geoShapes";

// Switzerland-ish bbox + a stand-in centroid.
const CH_BBOX: BBox = { minLon: 5.9, minLat: 45.8, maxLon: 10.5, maxLat: 47.8 };
const CH_CENTROID: Vec3 = latLonToVec3(46.8, 8.2);

function ctx(overrides: Partial<GeocodeContext> = {}): GeocodeContext {
  return {
    lookupCity: () => null,
    bboxes: new Map([["ch", CH_BBOX]]),
    byIso2: new Map([["ch", CH_CENTROID]]),
    ...overrides,
  };
}

describe("geocodeGathering (gazetteer → validated coords → centroid)", () => {
  it("1) prefers the GAZETTEER hit over model coords and the centroid", () => {
    const c = ctx({ lookupCity: () => ({ lat: 46.2, lon: 6.14 }) });
    expect(geocodeGathering({ place: "Geneva", iso2: "ch", lat: 1, lon: 1 }, c)).toEqual(
      latLonToVec3(46.2, 6.14),
    );
  });

  it("2) uses MODEL COORDS when no gazetteer hit and they're inside the country bbox", () => {
    expect(
      geocodeGathering({ place: "Some Resort", iso2: "ch", lat: 46.8, lon: 9.83 }, ctx()),
    ).toEqual(latLonToVec3(46.8, 9.83));
  });

  it("3) REJECTS model coords outside the country bbox and falls back to the centroid", () => {
    // Paris coords, but the host country is Switzerland → out of bbox → centroid.
    expect(
      geocodeGathering({ place: "Elsewhere", iso2: "ch", lat: 48.85, lon: 2.35 }, ctx()),
    ).toEqual(CH_CENTROID);
  });

  it("4) falls back to the centroid when there is no gazetteer hit and no coords", () => {
    expect(geocodeGathering({ place: "Unknown", iso2: "ch" }, ctx())).toEqual(CH_CENTROID);
  });

  it("5) trusts coords for a country we have NO bbox for (can't disprove)", () => {
    expect(
      geocodeGathering({ place: "Nowhere", iso2: "zz", lat: 10, lon: 10 }, ctx()),
    ).toEqual(latLonToVec3(10, 10));
  });

  it("6) returns null when nothing can locate it", () => {
    expect(geocodeGathering({ place: "Nowhere", iso2: "qq" }, ctx())).toBeNull();
  });
});
