// Diagnostic: DIRECT server-side fetch (no proxy) of each source, counting raw
// <item>/<entry> elements. Mirrors what the backend does. Run:
//   node scripts/diag-direct.mjs
const SOURCES = [
  ["L", "guardian-world", "https://www.theguardian.com/world/rss"],
  ["L", "vox", "https://www.vox.com/rss/index.xml"],
  ["L", "npr-news", "https://feeds.npr.org/1001/rss.xml"],
  ["L", "nyt-world", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"],
  ["L", "the-nation", "https://www.thenation.com/feed/?post_type=article"],
  ["C", "bbc-world", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["C", "csmonitor", "https://rss.csmonitor.com/feeds/all"],
  ["C", "the-hill", "https://thehill.com/news/feed/"],
  ["C", "aljazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["C", "marketwatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
  ["R", "foxnews", "https://moxie.foxnews.com/google-publisher/latest.xml"],
  ["R", "nypost", "https://nypost.com/feed/"],
  ["R", "national-review", "https://www.nationalreview.com/feed/"],
  ["R", "washington-examiner", "https://www.washingtonexaminer.com/tag/news.rss"],
  ["R", "reason", "https://reason.com/feed/"],
  ["R", "wsj-opinion", "https://feeds.a.dj.com/rss/RSSOpinion.xml"],
];

async function check(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: c.signal,
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "User-Agent":
          "Mozilla/5.0 (compatible; CounterpointReader/1.0; +https://github.com/counterpoint)",
      },
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const xml = await res.text();
    const items = (xml.match(/<item[ >]/g) || []).length;
    const entries = (xml.match(/<entry[ >]/g) || []).length;
    return `ok ${xml.length}b items=${items} entries=${entries}`;
  } catch (e) {
    const cause = e.cause ? ` cause=${e.cause.code || e.cause.message || e.cause}` : "";
    return e.name === "AbortError" ? "timeout" : `ERR ${e.message}${cause}`;
  } finally {
    clearTimeout(t);
  }
}

for (const [side, id, url] of SOURCES) {
  console.log(`${side} ${id.padEnd(22)} ${await check(url)}`);
}
