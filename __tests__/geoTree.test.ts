import { resolve } from "node:path";
import {
  _clearGeoTreeCache,
  _setPlaceSourcesDir,
  childrenOf,
  coverageStateOf,
  geoLabel,
  geoNode,
  pathOf,
  sourcesForGeoNode,
} from "../server/geoTree";

// The tree is built ENTIRELY from generated placeSources — no hardcoded places.
// The fixture mirrors a real generation: an index.json (es → Europe) plus an
// es.json whose outlets are region-tagged (ES-GA Galicia, ES-MD Madrid).
const FIXTURE = resolve(__dirname, "fixtures", "placeSources");

describe("geoTree (data-driven from discovered placeSources)", () => {
  beforeAll(() => _setPlaceSourcesDir(FIXTURE));
  afterAll(() => _clearGeoTreeCache());

  it("builds world → continent → country → region from generated data", () => {
    expect(childrenOf("world").map((n) => n.id)).toEqual(["europe"]);
    expect(childrenOf("europe").map((n) => n.id)).toEqual(["es"]);
    expect(childrenOf("es").map((n) => n.id).sort()).toEqual(["es-ga", "es-md"]);
    expect(geoNode("europe")?.level).toBe("continent");
    expect(geoNode("es")?.level).toBe("country");
    expect(geoNode("es-ga")?.level).toBe("region");
    expect(geoLabel("es")).toBe("Spain");
    expect(geoLabel("es-ga")).toBe("Galicia");
    expect(geoNode("es-ga")?.regionCode).toBe("ES-GA");
  });

  it("resolves the root→region path inclusive and ordered", () => {
    expect(pathOf("es-ga").map((n) => n.id)).toEqual(["world", "europe", "es", "es-ga"]);
    expect(pathOf("nope")).toEqual([]);
  });

  it("serves region-FILTERED outlets (region discovery)", () => {
    // Country node = every outlet; region node = only that region's outlets.
    expect(sourcesForGeoNode("es").length).toBe(4);
    expect(sourcesForGeoNode("es-ga").map((s) => s.id).sort()).toEqual(["es-faro", "es-lavoz"]);
    expect(sourcesForGeoNode("es-md").map((s) => s.id)).toEqual(["es-elpais"]);
    // World/continent serve nothing directly (drill in).
    expect(sourcesForGeoNode("world")).toEqual([]);
    expect(sourcesForGeoNode("europe")).toEqual([]);
  });

  it("colors coverage from discovered outlets", () => {
    expect(coverageStateOf("es")).toBe("ready");
    expect(coverageStateOf("es-ga")).toBe("ready");
    expect(coverageStateOf("europe")).toBe("unknown"); // drill in for coverage
    expect(coverageStateOf("world")).toBe("unknown");
    expect(coverageStateOf("nope")).toBe("unknown");
  });
});
