import { resolve } from "node:path";
import { getCoverage } from "../server/feedService";
import { _clearGeoTreeCache, _setPlaceSourcesDir } from "../server/geoTree";

// Coverage is served from the data-driven geoTree; point it at the fixture so the
// drill-down is deterministic (es → Europe, region-tagged Galicia/Madrid outlets).
const FIXTURE = resolve(__dirname, "fixtures", "placeSources");

describe("getCoverage (drill-down navigation)", () => {
  beforeAll(() => _setPlaceSourcesDir(FIXTURE));
  afterAll(() => _clearGeoTreeCache());

  it("returns the world root with its continents as children by default", () => {
    const v = getCoverage();
    expect(v.node.nodeId).toBe("world");
    expect(v.node.poolId).toBe("geo-world");
    expect(v.path.map((n) => n.nodeId)).toEqual(["world"]);
    expect(v.children.map((n) => n.nodeId)).toEqual(["europe"]);
  });

  it("builds the breadcrumb and children for a country", () => {
    const v = getCoverage("es");
    expect(v.path.map((n) => n.nodeId)).toEqual(["world", "europe", "es"]);
    expect(v.children.map((n) => n.nodeId).sort()).toEqual(["es-ga", "es-md"]);
    expect(v.node.poolId).toBe("geo-es");
    expect(v.node.state).toBe("ready");
  });

  it("derives coverage from discovered placeSources + region tags", () => {
    // Spain is covered; its region nodes come from the outlets' ISO 3166-2 tags.
    expect(getCoverage("es").node.state).toBe("ready");
    expect(getCoverage("es-ga").node.state).toBe("ready"); // region discovery
    // Continents are browsed into (no direct outlets).
    expect(getCoverage("europe").node.state).toBe("unknown");
  });

  it("flags region leaves as having no children", () => {
    const ga = getCoverage("es-ga");
    expect(ga.node.hasChildren).toBe(false);
    expect(ga.children).toEqual([]);
  });

  it("falls back to the world root for unknown ids", () => {
    expect(getCoverage("not-a-node").node.nodeId).toBe("world");
  });
});
