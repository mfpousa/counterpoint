import {
  buildAlerts,
  classifyEvent,
  eventVisual,
  locatePlace,
  locateStory,
  recencyOf,
  withinWindow,
  type AlertPlaceIndex,
} from "../src/lib/geoAlerts";
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
  iso2ByName: new Map([
    ["ukraine", "ua"],
    ["sudan", "sd"],
  ]),
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

  it("locatePlace also yields the subject nation's ISO2 (zone + name paths)", () => {
    expect(locatePlace(story({ sources: [{ zone: "ukraine" } as never] }), IDX)).toEqual({
      dir: uaDir,
      iso2: "ua",
    });
    expect(locatePlace(story({ title: "Crisis in Sudan deepens" }), IDX)).toEqual({
      dir: sdDir,
      iso2: "sd",
    });
  });

  it("buildAlerts does NOT flag a story located only by name (no national protagonist)", () => {
    const [alert] = buildAlerts([story({ title: "War in Ukraine grinds on", severity: 0.9 })], IDX);
    expect(alert.dir).toBe(uaDir); // still pinned where it's happening
    expect(alert.iso2).toBeUndefined(); // …but no flag without a national protagonist
  });

  it("buildAlerts anchors on the analyzed PROTAGONIST nation over geolocation", () => {
    // Story is located in Ukraine (zone) but its protagonist is Sudan → pin + flag = Sudan.
    const [alert] = buildAlerts(
      [
        story({
          severity: 0.9,
          sources: [{ zone: "ukraine" } as never],
          protagonist: { name: "Sudan", iso2: "sd" },
        }),
      ],
      IDX,
    );
    expect(alert.iso2).toBe("sd");
    expect(alert.dir).toBe(sdDir);
  });

  it("buildAlerts keeps locatable MAJOR events (developing or not), strongest first", () => {
    const alerts = buildAlerts(
      [
        story({ id: "a", developing: true, severity: 0.6, sources: [{ zone: "ukraine" } as never] }),
        story({ id: "b", developing: false, severity: 0.9, sources: [{ zone: "ukraine" } as never] }),
        story({ id: "c", developing: true, severity: 0.7, title: "Nothing here" }), // unlocatable
      ],
      IDX,
    );
    // b (0.9) outranks a (0.6); the single event b is included now, not just developing ones.
    expect(alerts.map((a) => a.id)).toEqual(["b", "a"]);
    expect(alerts[0].dir).toBe(uaDir);
    expect(alerts.find((x) => x.id === "b")?.developing).toBe(false);
  });

  it("sorts by severity and honours minSeverity + max", () => {
    const stories = [
      story({ id: "low", developing: true, severity: 0.3, title: "Sudan" }),
      story({ id: "hi", developing: true, severity: 0.9, title: "Ukraine" }),
    ];
    expect(buildAlerts(stories, IDX, { minSeverity: 0.5 }).map((a) => a.id)).toEqual(["hi"]);
    expect(buildAlerts(stories, IDX, { max: 1 }).map((a) => a.id)).toEqual(["hi"]);
  });

  it("carries the story's time fields onto the alert (for the recency treatment)", () => {
    const [alert] = buildAlerts(
      [story({ title: "Ukraine", severity: 0.9, updatedAt: 1700, startedAt: 900 })],
      IDX,
    );
    expect(alert.updatedAt).toBe(1700);
    expect(alert.startedAt).toBe(900);
  });

  it("PREFERS the model's category over keywords and resolves a custom one's visual", () => {
    // Text screams conflict, but the model labelled it diplomacy — trust the model.
    const [known] = buildAlerts([story({ title: "War in Ukraine", category: "diplomacy" })], IDX);
    expect(known.category).toBe("diplomacy");
    expect(known.color).toBe(eventVisual("diplomacy").color); // curated registry colour

    // A model-INVENTED category keeps its slug + carries a resolved icon/colour/label.
    const [custom] = buildAlerts(
      [story({ title: "Ukraine", category: "cyber", categoryIcon: "bug" })],
      IDX,
    );
    expect(custom.category).toBe("cyber");
    expect(custom.icon).toBe("bug");
    expect(custom.label).toBe("Cyber");
    expect(custom.color).toMatch(/^#[0-9a-f]{6}$/i);

    // No model category → fall back to the keyword classifier (here: conflict).
    const [fallback] = buildAlerts([story({ title: "Missile strike on Ukraine kills troops" })], IDX);
    expect(fallback.category).toBe("conflict");
  });
});

describe("time dimension (recency band + window scrubber)", () => {
  const NOW = 1_000_000_000_000;
  const H = 60 * 60 * 1000;
  const D = 24 * H;

  describe("recencyOf", () => {
    it("is fresh within 6h, recent within 24h, week within 7d, then stale", () => {
      expect(recencyOf(NOW - 1 * H, false, NOW)).toBe("fresh");
      expect(recencyOf(NOW - 6 * H, false, NOW)).toBe("fresh"); // boundary inclusive
      expect(recencyOf(NOW - 12 * H, false, NOW)).toBe("recent");
      expect(recencyOf(NOW - 3 * D, false, NOW)).toBe("week");
      expect(recencyOf(NOW - 30 * D, false, NOW)).toBe("stale");
    });

    it("never lets an ONGOING issue fade to stale (it stays at least 'week')", () => {
      expect(recencyOf(NOW - 30 * D, true, NOW)).toBe("week");
    });
  });

  describe("withinWindow", () => {
    it("'all' admits everything", () => {
      expect(withinWindow(NOW - 365 * D, "all", NOW)).toBe(true);
    });
    it("narrows to now (6h) / day (24h) / week (7d)", () => {
      expect(withinWindow(NOW - 3 * H, "now", NOW)).toBe(true);
      expect(withinWindow(NOW - 9 * H, "now", NOW)).toBe(false);
      expect(withinWindow(NOW - 12 * H, "day", NOW)).toBe(true);
      expect(withinWindow(NOW - 2 * D, "day", NOW)).toBe(false);
      expect(withinWindow(NOW - 5 * D, "week", NOW)).toBe(true);
      expect(withinWindow(NOW - 10 * D, "week", NOW)).toBe(false);
    });
  });
});

describe("classifyEvent (news → world-event category)", () => {
  const ev = (title: string, topic = "world") => classifyEvent({ title, summary: "", topic });
  it("detects conflict", () => expect(ev("Russia launches missile attack on troops")).toBe("conflict"));
  it("detects diplomacy", () => expect(ev("Leaders hold peace talks at summit")).toBe("diplomacy"));
  it("detects unrest", () => expect(ev("Mass protests and riots erupt after election")).toBe("unrest"));
  it("detects health", () => expect(ev("New virus outbreak spreads, vaccine sought")).toBe("health"));
  it("detects disaster", () => expect(ev("Major earthquake and tsunami hit the coast")).toBe("disaster"));
  it("detects tech", () => expect(ev("Semiconductor breakthrough in quantum computing")).toBe("tech"));
  it("detects economy", () => expect(ev("Inflation spikes as the stock market tumbles")).toBe("economy"));
  it("conflict outranks unrest on a tie via priority", () =>
    expect(ev("Air strike amid protest")).toBe("conflict"));
  it("falls back to topic when no keyword matches", () => {
    expect(ev("A calm day", "technology")).toBe("tech");
    expect(ev("A calm day", "health")).toBe("health");
    expect(ev("A calm day", "culture")).toBe("other");
  });
});
