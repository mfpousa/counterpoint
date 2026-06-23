import { buildAlerts, locateStory, type AlertPlaceIndex } from "../src/lib/geoAlerts";
import { latLonToVec3 } from "../src/lib/globeLayout";
import type { Story } from "../src/types";

const uaDir = latLonToVec3(50, 30);
const sdDir = latLonToVec3(15, 30);

const IDX: AlertPlaceIndex = {
  centroidByIso2: new Map([
    ["ua", uaDir],
    ["sd", sdDir],
  ]),
  centroidByName: new Map([
    ["ukraine", uaDir],
    ["sudan", sdDir],
  ]),
  zoneToIso2: { ukraine: "ua", russia: "ru" },
};

// Minimal Story factory (only the fields geoAlerts reads matter here).
const story = (over: Partial<Story>): Story =>
  ({
    id: "s",
    title: "",
    summary: "",
    synthesis: [],
    topic: "world",
    lean: 0,
    severity: 0.8,
    sources: [],
    angles: [],
    contradictions: [],
    relatedIds: [],
    updatedAt: 0,
    generatedAt: 0,
    ...over,
  }) as unknown as Story;

describe("geoAlerts (locate ongoing stories on the globe)", () => {
  it("locates a story by its affiliation zone", () => {
    const s = story({ developing: true, sources: [{ zone: "ukraine" } as never] });
    expect(locateStory(s, IDX)).toBe(uaDir);
  });

  it("falls back to a country name in the headline/dek", () => {
    const s = story({ developing: true, title: "Crisis in Sudan deepens" });
    expect(locateStory(s, IDX)).toBe(sdDir);
  });

  it("returns null when no location can be inferred", () => {
    expect(locateStory(story({ developing: true, title: "Markets wobble" }), IDX)).toBeNull();
  });

  it("buildAlerts keeps only locatable DEVELOPING stories", () => {
    const alerts = buildAlerts(
      [
        story({ id: "a", developing: true, severity: 0.6, sources: [{ zone: "ukraine" } as never] }),
        story({ id: "b", developing: false, severity: 0.9, sources: [{ zone: "ukraine" } as never] }), // not developing
        story({ id: "c", developing: true, severity: 0.7, title: "Nothing here" }), // unlocatable
      ],
      IDX,
    );
    expect(alerts.map((a) => a.id)).toEqual(["a"]);
    expect(alerts[0].dir).toBe(uaDir);
  });

  it("sorts by severity and honours minSeverity + max", () => {
    const stories = [
      story({ id: "low", developing: true, severity: 0.3, title: "Sudan" }),
      story({ id: "hi", developing: true, severity: 0.9, title: "Ukraine" }),
    ];
    expect(buildAlerts(stories, IDX, { minSeverity: 0.5 }).map((a) => a.id)).toEqual(["hi"]);
    expect(buildAlerts(stories, IDX, { max: 1 }).map((a) => a.id)).toEqual(["hi"]);
  });
});
