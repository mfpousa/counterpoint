// Reactive INTERNATIONAL source registry, grouped by geographic / affiliation
// ZONE. These feeds are deliberately NOT part of any world's default source set:
// fetching "the whole world" on every build is infeasible. Instead the server
// loads a zone's sources ON DEMAND when a live story is detected to involve that
// zone (its `aliases` show up in the coverage) — see server/feedService.ts
// (augmentWithZones) and src/lib/zones.ts (detectZones).
//
// The point is comparative framing: once a story about, say, the Russia–Ukraine
// war is live, we pull Russian AND Ukrainian outlets and surface how each side
// reports it. Sides themselves are NOT pre-set — the model labels them per story
// from the zones actually present.
//
// All feeds are free, keyless RSS/Atom, English editions (so no translation
// dependency for v1). `lean` is null: a foreign outlet's domestic left/right axis
// doesn't map onto the US-centric scale, and we don't want them skewing the
// left/right balance — their relevant axis here is GEOGRAPHIC. `leanRationale`
// instead records the outlet's affiliation (state-aligned vs independent), which
// the UI already surfaces. URLs are approximate and editable; a dead feed simply
// yields nothing (fetching is best-effort).

import type { Source, Zone } from "../types";

/** Helper: a zoned international news source with an affiliation note. */
function intl(
  id: string,
  title: string,
  url: string,
  zone: string,
  affiliation: string,
  confidence = 0.6,
): Source {
  return {
    id,
    title,
    url,
    kind: "news",
    topic: "world",
    lean: null,
    confidence,
    leanRationale: affiliation,
    zone,
  };
}

export const ZONES: Zone[] = [
  {
    id: "ukraine",
    label: "Ukraine",
    aliases: ["ukraine", "ukrainian", "kyiv", "kiev", "zelensky", "zelenskyy", "donbas", "kharkiv", "mariupol", "crimea"],
    sources: [
      intl("ua-kyiv-independent", "The Kyiv Independent", "https://kyivindependent.com/feed/", "ukraine", "Ukraine: independent English-language outlet."),
      intl("ua-ukrinform", "Ukrinform", "https://www.ukrinform.net/rss", "ukraine", "Ukraine: state news agency (English)."),
      intl("ua-pravda", "Ukrainska Pravda", "https://www.pravda.com.ua/eng/rss/", "ukraine", "Ukraine: independent daily (English)."),
    ],
  },
  {
    id: "russia",
    label: "Russia",
    aliases: ["russia", "russian", "moscow", "kremlin", "putin", "lavrov", "donbas", "crimea"],
    sources: [
      intl("ru-tass", "TASS", "https://tass.com/rss/v2.xml", "russia", "Russia: state news agency."),
      intl("ru-moscow-times", "The Moscow Times", "https://www.themoscowtimes.com/rss/news", "russia", "Russia: independent, now exiled (English)."),
    ],
  },
  {
    id: "china",
    label: "China",
    aliases: ["china", "chinese", "beijing", "xi jinping", "taiwan", "taipei", "hong kong", "ccp", "pla"],
    sources: [
      intl("cn-globaltimes", "Global Times", "https://www.globaltimes.cn/rss/outbrain.xml", "china", "China: state-affiliated tabloid."),
      intl("cn-scmp", "South China Morning Post", "https://www.scmp.com/rss/91/feed", "china", "Hong Kong: independent, China-focused."),
      intl("cn-xinhua", "Xinhua", "http://www.xinhuanet.com/english/rss/worldrss.xml", "china", "China: official state news agency."),
    ],
  },
  {
    id: "israel",
    label: "Israel",
    aliases: ["israel", "israeli", "jerusalem", "tel aviv", "netanyahu", "idf", "gaza", "west bank", "hamas", "hezbollah"],
    sources: [
      intl("il-times-of-israel", "The Times of Israel", "https://www.timesofisrael.com/feed/", "israel", "Israel: independent English-language daily."),
      intl("il-jpost", "The Jerusalem Post", "https://www.jpost.com/rss/rssfeedsfrontpage.aspx", "israel", "Israel: centre-right English daily."),
      intl("il-haaretz", "Haaretz", "https://www.haaretz.com/srv/htz---all-news", "israel", "Israel: liberal daily (English)."),
    ],
  },
  {
    id: "palestine",
    label: "Palestine & Arab world",
    aliases: ["palestine", "palestinian", "gaza", "west bank", "ramallah", "hamas", "fatah", "arab", "egypt", "jordan", "lebanon"],
    sources: [
      intl("ps-middle-east-eye", "Middle East Eye", "https://www.middleeasteye.net/rss", "palestine", "London-based, Middle East focus."),
      intl("ps-wafa", "WAFA", "https://english.wafa.ps/Rss.aspx", "palestine", "Palestine: official news agency (English)."),
      intl("ps-middle-east-monitor", "Middle East Monitor", "https://www.middleeastmonitor.com/feed/", "palestine", "London-based, pro-Palestinian commentary."),
    ],
  },
  {
    id: "iran",
    label: "Iran",
    aliases: ["iran", "iranian", "tehran", "khamenei", "irgc", "persian gulf", "ayatollah"],
    sources: [
      intl("ir-tehran-times", "Tehran Times", "https://www.tehrantimes.com/rss", "iran", "Iran: state-aligned English daily."),
      intl("ir-presstv", "Press TV", "https://www.presstv.ir/rss.xml", "iran", "Iran: state broadcaster (English)."),
    ],
  },
  {
    id: "india",
    label: "India",
    aliases: ["india", "indian", "new delhi", "delhi", "modi", "kashmir", "hindu", "bjp"],
    sources: [
      intl("in-the-hindu", "The Hindu", "https://www.thehindu.com/news/national/feeder/default.rss", "india", "India: centre-left national daily."),
      intl("in-toi", "The Times of India", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "india", "India: largest English daily."),
      intl("in-ndtv", "NDTV", "https://feeds.feedburner.com/ndtvnews-top-stories", "india", "India: national broadcaster."),
    ],
  },
  {
    id: "pakistan",
    label: "Pakistan",
    aliases: ["pakistan", "pakistani", "islamabad", "karachi", "kashmir", "imran khan"],
    sources: [
      intl("pk-dawn", "Dawn", "https://www.dawn.com/feeds/home", "pakistan", "Pakistan: leading English daily."),
      intl("pk-tribune", "The Express Tribune", "https://tribune.com.pk/feed/home", "pakistan", "Pakistan: English daily."),
    ],
  },
  {
    id: "turkey",
    label: "Türkiye",
    aliases: ["turkey", "türkiye", "turkish", "ankara", "istanbul", "erdogan", "erdoğan"],
    sources: [
      intl("tr-daily-sabah", "Daily Sabah", "https://www.dailysabah.com/rssFeed/home", "turkey", "Türkiye: pro-government English daily."),
      intl("tr-hurriyet", "Hürriyet Daily News", "https://www.hurriyetdailynews.com/rss", "turkey", "Türkiye: mainstream English daily."),
    ],
  },
  {
    id: "latam",
    label: "Latin America",
    aliases: ["latin america", "brazil", "brazilian", "argentina", "venezuela", "mexico", "colombia", "chile", "bolsonaro", "lula", "maduro"],
    sources: [
      intl("latam-mercopress", "MercoPress", "https://en.mercopress.com/rss/", "latam", "South Atlantic news agency (English)."),
      intl("latam-buenosaires-herald", "Buenos Aires Herald", "https://buenosairesherald.com/feed", "latam", "Argentina: English-language outlet."),
    ],
  },
  {
    id: "africa",
    label: "Africa",
    aliases: ["africa", "african", "nigeria", "ethiopia", "kenya", "sudan", "south africa", "sahel", "congo"],
    sources: [
      intl("af-allafrica", "AllAfrica", "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf", "africa", "Pan-African news aggregator."),
      intl("af-news24", "News24", "https://feeds.capi24.com/v1/Search/articles/news24/TopStories/rss", "africa", "South Africa: major news site."),
    ],
  },
  {
    id: "japan",
    label: "Japan",
    aliases: ["japan", "japanese", "tokyo", "kishida", "okinawa"],
    sources: [
      intl("jp-japan-times", "The Japan Times", "https://www.japantimes.co.jp/feed/", "japan", "Japan: independent English daily."),
      intl("jp-nhk", "NHK World", "https://www3.nhk.or.jp/nhkworld/en/news/rss/all.xml", "japan", "Japan: public broadcaster (English)."),
    ],
  },
  {
    id: "korea",
    label: "Korea",
    aliases: ["korea", "korean", "seoul", "pyongyang", "north korea", "south korea", "kim jong un", "dprk"],
    sources: [
      intl("kr-korea-herald", "The Korea Herald", "http://www.koreaherald.com/rss/020000000000.xml", "korea", "South Korea: English daily."),
      intl("kr-yonhap", "Yonhap", "https://en.yna.co.kr/RSS/news.xml", "korea", "South Korea: national news agency (English)."),
    ],
  },
];

/** Map of zone id -> Zone, for quick lookup. */
export const ZONES_BY_ID: Record<string, Zone> = Object.fromEntries(
  ZONES.map((z) => [z.id, z]),
);

/** Display label for a zone id (falls back to the id itself). */
export function zoneLabel(id: string | undefined | null): string {
  if (!id || id === "international") return "International";
  return ZONES_BY_ID[id]?.label ?? id;
}
