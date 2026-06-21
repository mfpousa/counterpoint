import { translate, languageName, LANGUAGES, untranslatedKeys } from "../src/lib/i18n";

describe("i18n translate", () => {
  it("returns the Spanish string for a known key", () => {
    expect(translate("es", "tabs.today")).toBe("Hoy");
    expect(translate("en", "tabs.today")).toBe("Today");
  });

  it("interpolates {params}", () => {
    expect(translate("en", "feed.summaryOne", { count: 1, topics: 3 })).toBe(
      "1 pick across 3 topics, balanced for you",
    );
    expect(translate("es", "story.outlets", { count: 4 })).toBe("4 medios");
  });

  it("falls back to English, then to the raw key, for missing entries", () => {
    // A key only ever defined in English still resolves under es.
    expect(translate("es", "settings.kind.news")).toBe("Noticias");
    // A totally unknown key returns itself (never throws / blanks).
    expect(translate("es", "does.not.exist")).toBe("does.not.exist");
  });

  it("languageName maps codes to readable names", () => {
    expect(languageName("es")).toBe("Spanish");
    expect(languageName("en")).toBe("English");
  });

  it("exposes both supported languages", () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(["en", "es"]);
  });

  it("has a Spanish translation for every English key (no UI left untranslated)", () => {
    expect(untranslatedKeys("es")).toEqual([]);
  });
});
