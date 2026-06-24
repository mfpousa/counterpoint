import { parseAsk, pickIds } from "../server/ask";
import {
  buildAskNameIndex,
  resolveAskPlace,
  scanCountries,
  type AskNameIndex,
} from "../src/lib/askLocate";
import type { GeoCentroids } from "../src/lib/geoShapes";
import type { Vec3 } from "../src/lib/globeLayout";

describe("parseAsk", () => {
  it("parses a NUMBERED list of places (the common model style)", () => {
    const raw = [
      "Three major conflicts dominate the news right now.",
      "",
      "1. Ukraine (UA): Russia's full-scale invasion grinds on.",
      "2. Gaza (PS): Fighting and a fragile truce dominate coverage.",
      "3. Sudan (SD): The army–RSF war drives mass displacement.",
    ].join("\n");
    const { synopsis, places } = parseAsk(raw);
    expect(synopsis).toBe("Three major conflicts dominate the news right now.");
    expect(places.map((p) => [p.label, p.iso2])).toEqual([
      ["Ukraine", "ua"],
      ["Gaza", "ps"],
      ["Sudan", "sd"],
    ]);
    expect(places[0].blurb).toContain("invasion");
  });

  it("parses bulleted lines with markdown bold and bracketed codes", () => {
    const raw = "Summary.\n\n- **Ukraine [UA]**: heavy fighting\n* Israel (IL): strikes continue";
    const { places } = parseAsk(raw);
    expect(places).toEqual([
      { label: "Ukraine", iso2: "ua", blurb: "heavy fighting" },
      { label: "Israel", iso2: "il", blurb: "strikes continue" },
    ]);
  });

  it("keeps the place even when the ISO code is missing (name-resolved later)", () => {
    const { places } = parseAsk("- Ukraine: Russia's invasion continues.");
    expect(places).toEqual([
      { label: "Ukraine", iso2: "", blurb: "Russia's invasion continues." },
    ]);
  });

  it("handles a spaced-dash separator without splitting hyphenated names", () => {
    const { places } = parseAsk("- Guinea-Bissau (GW) — a contested election");
    expect(places).toEqual([
      { label: "Guinea-Bissau", iso2: "gw", blurb: "a contested election" },
    ]);
  });

  it("returns no places for a pure-prose answer", () => {
    const raw = "Inflation is cooling across advanced economies, though unevenly.";
    const { synopsis, places } = parseAsk(raw);
    expect(places).toHaveLength(0);
    expect(synopsis).toBe(raw);
  });

  it("extracts INLINE 'Place (ISO2):' mentions from prose (no bullets/newlines)", () => {
    // The model ignored the line format and inlined the mentions in one paragraph —
    // but still tagged the (language-neutral) ISO codes, so we can still locate them.
    const raw =
      "Los artículos no mencionan ningún país nuevo en la OTAN; se centran en una cumbre. " +
      "Alemania (DE): Las tropas neerlandesas realizan ejercicios militares. " +
      "Turquía (TR): Arrestos masivos en Ankara antes de la cumbre de la OTAN.";
    const { synopsis, places } = parseAsk(raw);
    expect(places.map((p) => [p.label, p.iso2])).toEqual([
      ["Alemania", "de"],
      ["Turquía", "tr"],
    ]);
    expect(places[0].blurb).toContain("tropas neerlandesas");
    expect(places[1].blurb).toContain("Ankara");
    expect(synopsis).toContain("OTAN");
    expect(synopsis).not.toContain("(DE)");
  });
});

describe("pickIds (planner selection validation)", () => {
  it("keeps in-range, unique, ordered numbers and drops the rest", () => {
    // coerces "3", drops 0/-1 (out of range), 99 (out of range), the duplicate 2.
    expect(pickIds([1, 2, 2, 99, "3", 0, -1], 10, 40)).toEqual([1, 2, 3]);
  });

  it("caps at max, preserving the planner's order", () => {
    expect(pickIds([5, 4, 3, 2, 1], 10, 3)).toEqual([5, 4, 3]);
  });

  it("returns [] for a non-array / garbage payload", () => {
    expect(pickIds(undefined, 10, 40)).toEqual([]);
    expect(pickIds("nope", 10, 40)).toEqual([]);
    expect(pickIds([1.5, "x", null], 10, 40)).toEqual([]);
  });
});

// --- locator -----------------------------------------------------------------

const dir = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function fixtureCentroids(): GeoCentroids {
  const countries = [
    { iso2: "ua", name: "Ukraine", continent: "europe", dir: dir(1, 0, 0) },
    { iso2: "sd", name: "Sudan", continent: "africa", dir: dir(0, 1, 0) },
    { iso2: "il", name: "Israel", continent: "asia", dir: dir(0, 0, 1) },
    { iso2: "ru", name: "Russia", continent: "europe", dir: dir(-1, 0, 0) },
    { iso2: "ps", name: "Palestine", continent: "asia", dir: dir(0, -1, 0) },
  ];
  const byIso2 = new Map(countries.map((c) => [c.iso2, c.dir]));
  return {
    byIso2,
    byContinent: new Map(),
    countries,
    continents: [],
  };
}

describe("askLocate", () => {
  let idx: AskNameIndex;
  beforeAll(() => {
    idx = buildAskNameIndex(fixtureCentroids());
  });

  it("resolves by the model's ISO2 first", () => {
    expect(resolveAskPlace("Anything", "ua", idx)).toEqual(dir(1, 0, 0));
  });

  it("resolves by country name when ISO2 is missing", () => {
    expect(resolveAskPlace("Sudan", "", idx)).toEqual(dir(0, 1, 0));
  });

  it("resolves common aliases (Gaza -> Palestine, Russia)", () => {
    expect(resolveAskPlace("Gaza", "", idx)).toEqual(dir(0, -1, 0));
    expect(resolveAskPlace("russia", "", idx)).toEqual(dir(-1, 0, 0));
  });

  it("returns null for an unlocatable label", () => {
    expect(resolveAskPlace("Atlantis", "", idx)).toBeNull();
  });

  it("scans free prose for distinct countries (the marker fallback)", () => {
    const found = scanCountries(
      "The major conflicts are in Ukraine, Sudan and Israel right now.",
      idx,
    );
    expect(found.map((f) => f.name).sort()).toEqual(["Israel", "Sudan", "Ukraine"]);
  });
});
