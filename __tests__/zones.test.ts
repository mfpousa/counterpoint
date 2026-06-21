import { detectZones, scoreZones } from "../src/lib/zones";
import type { Zone } from "../src/types";

const ZS: Zone[] = [
  { id: "ukraine", label: "Ukraine", aliases: ["ukraine", "kyiv", "zelensky"], sources: [] },
  { id: "russia", label: "Russia", aliases: ["russia", "moscow", "kremlin", "putin"], sources: [] },
  { id: "china", label: "China", aliases: ["china", "beijing", "hong kong", "taiwan"], sources: [] },
];

describe("detectZones", () => {
  it("identifies both sides of a conflict headline", () => {
    const ids = detectZones("Kremlin rejects Kyiv ceasefire as Russia masses troops near Ukraine", ZS);
    expect(ids).toEqual(expect.arrayContaining(["russia", "ukraine"]));
    // Russia has more alias hits here (kremlin + russia) so it ranks first.
    expect(ids[0]).toBe("russia");
  });

  it("matches whole words only for single-token aliases", () => {
    // "porcelain" contains "china" as a substring but must NOT trigger the zone.
    expect(detectZones("A porcelain vase sold at auction", ZS)).toEqual([]);
    expect(detectZones("China unveils new trade policy", ZS)).toEqual(["china"]);
  });

  it("matches multi-word aliases as substrings", () => {
    expect(detectZones("Protests continue in Hong Kong", ZS)).toEqual(["china"]);
  });

  it("honors a higher minHits threshold", () => {
    const text = "Ukraine update"; // only one ukraine alias
    expect(detectZones(text, ZS, 1)).toEqual(["ukraine"]);
    expect(detectZones(text, ZS, 2)).toEqual([]);
  });

  it("scoreZones returns distinct-alias counts, strongest first", () => {
    const scores = scoreZones("Putin and the Kremlin respond from Moscow", ZS);
    expect(scores[0]).toEqual({ id: "russia", hits: 3 });
  });
});
