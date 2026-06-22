import {
  _clearRegistryCache,
  coverageStateOf,
  registryForNode,
  sourcesForNode,
} from "../server/sourceRegistry";

describe("source registry", () => {
  beforeEach(() => _clearRegistryCache());

  it("reads seeded registries as ready with sources", () => {
    const es = registryForNode("es");
    expect(es.state).toBe("ready");
    expect(es.sources.length).toBeGreaterThan(0);
    expect(sourcesForNode("es-galicia-pontevedra-vigo").length).toBeGreaterThan(0);
  });

  it("covers the full Spain vertical slice", () => {
    for (const id of [
      "world",
      "eu",
      "es",
      "es-galicia",
      "es-galicia-pontevedra",
      "es-galicia-pontevedra-vigo",
    ]) {
      expect(coverageStateOf(id)).toBe("ready");
    }
  });

  it("reports unknown for nodes without a registry file", () => {
    expect(coverageStateOf("as")).toBe("unknown"); // Asia intentionally unseeded
    expect(coverageStateOf("oc")).toBe("unknown");
    expect(sourcesForNode("as")).toEqual([]);
  });

  it("reports unknown for ids outside the tree", () => {
    expect(coverageStateOf("not-a-node")).toBe("unknown");
    expect(registryForNode("").state).toBe("unknown");
    expect(registryForNode(null).sources).toEqual([]);
  });

  it("each source carries a usable url + id", () => {
    for (const s of sourcesForNode("world")) {
      expect(typeof s.id).toBe("string");
      expect(s.url.startsWith("http")).toBe(true);
    }
  });
});
