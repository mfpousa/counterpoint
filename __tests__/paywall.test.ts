import { isKnownPaywall } from "../server/rewrite";

describe("isKnownPaywall", () => {
  it("matches known paywall hosts (with and without www)", () => {
    expect(isKnownPaywall("https://www.nytimes.com/2026/01/01/world/x.html")).toBe(true);
    expect(isKnownPaywall("https://nytimes.com/x")).toBe(true);
    expect(isKnownPaywall("https://www.wsj.com/articles/y")).toBe(true);
    expect(isKnownPaywall("https://www.ft.com/content/z")).toBe(true);
  });

  it("matches subdomains of a paywall host", () => {
    expect(isKnownPaywall("https://cooking.nytimes.com/recipes/1")).toBe(true);
  });

  it("does NOT match free / unrelated hosts", () => {
    expect(isKnownPaywall("https://www.bbc.com/news/1")).toBe(false);
    expect(isKnownPaywall("https://apnews.com/article/2")).toBe(false);
    // A host that merely ends with a paywall brand name but is a different domain.
    expect(isKnownPaywall("https://notnytimes.com/x")).toBe(false);
  });

  it("returns false on malformed URLs", () => {
    expect(isKnownPaywall("not a url")).toBe(false);
    expect(isKnownPaywall("")).toBe(false);
  });
});
