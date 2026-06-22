import { getCoverage } from "../server/feedService";

describe("getCoverage (drill-down navigation)", () => {
  it("returns the world root with its continents as children by default", () => {
    const v = getCoverage();
    expect(v.node.nodeId).toBe("world");
    expect(v.node.poolId).toBe("geo-world");
    expect(v.path.map((n) => n.nodeId)).toEqual(["world"]);
    const childIds = v.children.map((n) => n.nodeId);
    expect(childIds).toContain("eu");
    expect(childIds).toContain("am");
  });

  it("builds the breadcrumb and children for a deep node", () => {
    const v = getCoverage("es-galicia");
    expect(v.path.map((n) => n.nodeId)).toEqual(["world", "eu", "es", "es-galicia"]);
    expect(v.children.map((n) => n.nodeId)).toEqual(["es-galicia-pontevedra"]);
    // Every node carries a pool id and a coverage state.
    expect(v.node.poolId).toBe("geo-es-galicia");
    expect(["ready", "none", "unknown"]).toContain(v.node.state);
  });

  it("marks seeded nodes ready and unseeded continents unknown", () => {
    expect(getCoverage("es").node.state).toBe("ready");
    expect(getCoverage("as").node.state).toBe("unknown"); // Asia intentionally unseeded
  });

  it("flags leaves as having no children", () => {
    const vigo = getCoverage("es-galicia-pontevedra-vigo");
    expect(vigo.node.hasChildren).toBe(false);
    expect(vigo.children).toEqual([]);
  });

  it("falls back to the world root for unknown ids", () => {
    expect(getCoverage("not-a-node").node.nodeId).toBe("world");
  });
});
