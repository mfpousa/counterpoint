// Diagnostic: try each political source through the same CORS proxy chain the
// web app uses and report which succeed. Run with: node scripts/diag-feeds.mjs
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

const PROXIES = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

async function fetchXml(url, timeoutMs = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: c.signal });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const xml = await res.text();
    return xml.trim() ? { ok: true, len: xml.length } : { ok: false, why: "empty" };
  } catch (e) {
    return { ok: false, why: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

for (const [side, id, url] of SOURCES) {
  let result = "FAIL";
  for (let i = 0; i < PROXIES.length; i++) {
    const r = await fetchXml(PROXIES[i](url));
    if (r.ok) { result = `ok via proxy#${i} (${r.len}b)`; break; }
    result = `p${i}:${r.why}`;
  }
  console.log(`${side} ${id.padEnd(22)} ${result}`);
}
