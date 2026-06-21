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
// All feeds are free, keyless RSS/Atom. Each zone carries BOTH English-edition
// outlets AND ORIGINAL-LANGUAGE outlets (tagged with `lang`): the model reads the
// native text directly and summarizes in the reader's language, so we capture how
// a story is genuinely told inside a country — not just its export-facing English.
// `lean` is null: a foreign outlet's domestic left/right axis doesn't map onto the
// US-centric scale, and we don't want them skewing the left/right balance — their
// relevant axis here is GEOGRAPHIC. `leanRationale` records the outlet's
// affiliation (state-aligned vs independent). URLs are approximate and editable; a
// dead feed simply yields nothing (fetching is best-effort).

import type { Source, Zone } from "../types";

/** Helper: a zoned international news source (with language + affiliation note). */
function intl(
  id: string,
  title: string,
  url: string,
  zone: string,
  affiliation: string,
  lang = "en",
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
    lang,
    zone,
  };
}

export const ZONES: Zone[] = [
  {
    id: "ukraine",
    label: "Ukraine",
    aliases: ["ukraine", "ukrainian", "kyiv", "kiev", "zelensky", "zelenskyy", "donbas", "kharkiv", "mariupol", "crimea"],
    sources: [
      intl("ua-kyiv-independent", "The Kyiv Independent", "https://kyivindependent.com/feed/", "ukraine", "Ukraine: independent English-language outlet.", "en"),
      intl("ua-ukrinform", "Ukrinform", "https://www.ukrinform.net/rss", "ukraine", "Ukraine: state news agency (English).", "en"),
      // Original language (Ukrainian)
      intl("ua-pravda-uk", "Українська правда", "https://www.pravda.com.ua/rss/", "ukraine", "Ukraine: independent daily (Ukrainian).", "uk"),
      intl("ua-ukrinform-uk", "Укрінформ", "https://www.ukrinform.ua/rss", "ukraine", "Ukraine: state news agency (Ukrainian).", "uk"),
    ],
  },
  {
    id: "russia",
    label: "Russia",
    aliases: ["russia", "russian", "moscow", "kremlin", "putin", "lavrov", "donbas", "crimea"],
    sources: [
      intl("ru-tass", "TASS", "https://tass.com/rss/v2.xml", "russia", "Russia: state news agency (English).", "en"),
      intl("ru-moscow-times", "The Moscow Times", "https://www.themoscowtimes.com/rss/news", "russia", "Russia: independent, now exiled (English).", "en"),
      // Original language (Russian)
      intl("ru-ria", "РИА Новости", "https://ria.ru/export/rss2/archive/index.xml", "russia", "Russia: state news agency (Russian).", "ru"),
      intl("ru-lenta", "Lenta.ru", "https://lenta.ru/rss", "russia", "Russia: large pro-state portal (Russian).", "ru"),
      intl("ru-meduza", "Meduza", "https://meduza.io/rss/all", "russia", "Russia: independent, exiled (Russian).", "ru"),
    ],
  },
  {
    id: "china",
    label: "China",
    aliases: ["china", "chinese", "beijing", "xi jinping", "taiwan", "taipei", "hong kong", "ccp", "pla"],
    sources: [
      intl("cn-globaltimes", "Global Times", "https://www.globaltimes.cn/rss/outbrain.xml", "china", "China: state-affiliated tabloid (English).", "en"),
      intl("cn-scmp", "South China Morning Post", "https://www.scmp.com/rss/91/feed", "china", "Hong Kong: independent, China-focused (English).", "en"),
      // Original language (Chinese)
      intl("cn-xinhua-zh", "新华网", "http://www.xinhuanet.com/politics/news_politics.xml", "china", "China: official state news agency (Chinese).", "zh"),
      intl("cn-bbc-zhongwen", "BBC 中文", "https://www.bbc.com/zhongwen/simp/index.xml", "china", "Independent (Chinese).", "zh"),
    ],
  },
  {
    id: "israel",
    label: "Israel",
    aliases: ["israel", "israeli", "jerusalem", "tel aviv", "netanyahu", "idf", "gaza", "west bank", "hamas", "hezbollah"],
    sources: [
      intl("il-times-of-israel", "The Times of Israel", "https://www.timesofisrael.com/feed/", "israel", "Israel: independent daily (English).", "en"),
      intl("il-jpost", "The Jerusalem Post", "https://www.jpost.com/rss/rssfeedsfrontpage.aspx", "israel", "Israel: centre-right daily (English).", "en"),
      // Original language (Hebrew)
      intl("il-ynet", "Ynet", "https://www.ynet.co.il/Integration/StoryRss2.xml", "israel", "Israel: most-read outlet (Hebrew).", "he"),
      intl("il-haaretz-he", "הארץ", "https://www.haaretz.co.il/cmlink/1.1617539", "israel", "Israel: liberal daily (Hebrew).", "he"),
    ],
  },
  {
    id: "palestine",
    label: "Palestine & Arab world",
    aliases: ["palestine", "palestinian", "gaza", "west bank", "ramallah", "hamas", "fatah", "arab", "egypt", "jordan", "lebanon"],
    sources: [
      intl("ps-middle-east-eye", "Middle East Eye", "https://www.middleeasteye.net/rss", "palestine", "London-based, Middle East focus (English).", "en"),
      intl("ps-middle-east-monitor", "Middle East Monitor", "https://www.middleeastmonitor.com/feed/", "palestine", "London-based, pro-Palestinian (English).", "en"),
      // Original language (Arabic)
      intl("ps-aljazeera-ar", "الجزيرة", "https://www.aljazeera.net/xml/rss/all.xml", "palestine", "Qatar: pan-Arab broadcaster (Arabic).", "ar"),
      intl("ps-wafa-ar", "وفا", "https://www.wafa.ps/RssXml.aspx?lang=ar_AR", "palestine", "Palestine: official news agency (Arabic).", "ar"),
    ],
  },
  {
    id: "iran",
    label: "Iran",
    aliases: ["iran", "iranian", "tehran", "khamenei", "irgc", "persian gulf", "ayatollah"],
    sources: [
      intl("ir-tehran-times", "Tehran Times", "https://www.tehrantimes.com/rss", "iran", "Iran: state-aligned daily (English).", "en"),
      intl("ir-presstv", "Press TV", "https://www.presstv.ir/rss.xml", "iran", "Iran: state broadcaster (English).", "en"),
      // Original language (Persian)
      intl("ir-irna-fa", "ایرنا", "https://www.irna.ir/rss", "iran", "Iran: state news agency (Persian).", "fa"),
      intl("ir-isna-fa", "ایسنا", "https://www.isna.ir/rss", "iran", "Iran: semi-official student agency (Persian).", "fa"),
    ],
  },
  {
    id: "india",
    label: "India",
    aliases: ["india", "indian", "new delhi", "delhi", "modi", "kashmir", "hindu", "bjp"],
    sources: [
      intl("in-the-hindu", "The Hindu", "https://www.thehindu.com/news/national/feeder/default.rss", "india", "India: centre-left national daily (English).", "en"),
      intl("in-toi", "The Times of India", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "india", "India: largest English daily.", "en"),
      // Original language (Hindi)
      intl("in-bbc-hindi", "BBC हिंदी", "https://www.bbc.com/hindi/index.xml", "india", "Independent (Hindi).", "hi"),
      intl("in-ndtv-hindi", "NDTV India", "https://feeds.feedburner.com/ndtvkhabar-latest", "india", "India: national broadcaster (Hindi).", "hi"),
    ],
  },
  {
    id: "pakistan",
    label: "Pakistan",
    aliases: ["pakistan", "pakistani", "islamabad", "karachi", "kashmir", "imran khan"],
    sources: [
      intl("pk-dawn", "Dawn", "https://www.dawn.com/feeds/home", "pakistan", "Pakistan: leading English daily.", "en"),
      intl("pk-tribune", "The Express Tribune", "https://tribune.com.pk/feed/home", "pakistan", "Pakistan: English daily.", "en"),
      // Original language (Urdu)
      intl("pk-bbc-urdu", "BBC اردو", "https://www.bbc.com/urdu/index.xml", "pakistan", "Independent (Urdu).", "ur"),
      intl("pk-jang", "روزنامہ جنگ", "https://jang.com.pk/rss/1/latest-news", "pakistan", "Pakistan: largest Urdu daily.", "ur"),
    ],
  },
  {
    id: "turkey",
    label: "Türkiye",
    aliases: ["turkey", "türkiye", "turkish", "ankara", "istanbul", "erdogan", "erdoğan"],
    sources: [
      intl("tr-daily-sabah", "Daily Sabah", "https://www.dailysabah.com/rssFeed/home", "turkey", "Türkiye: pro-government daily (English).", "en"),
      intl("tr-hurriyet-en", "Hürriyet Daily News", "https://www.hurriyetdailynews.com/rss", "turkey", "Türkiye: mainstream daily (English).", "en"),
      // Original language (Turkish)
      intl("tr-hurriyet", "Hürriyet", "https://www.hurriyet.com.tr/rss/anasayfa", "turkey", "Türkiye: mainstream daily (Turkish).", "tr"),
      intl("tr-aa", "Anadolu Ajansı", "https://www.aa.com.tr/tr/rss/default?cat=guncel", "turkey", "Türkiye: state news agency (Turkish).", "tr"),
    ],
  },
  {
    id: "latam",
    label: "Latin America",
    aliases: ["latin america", "brazil", "brazilian", "argentina", "venezuela", "mexico", "colombia", "chile", "bolsonaro", "lula", "maduro"],
    sources: [
      intl("latam-mercopress", "MercoPress", "https://en.mercopress.com/rss/", "latam", "South Atlantic news agency (English).", "en"),
      // Original language (Spanish / Portuguese)
      intl("latam-clarin", "Clarín", "https://www.clarin.com/rss/lo-ultimo/", "latam", "Argentina: largest daily (Spanish).", "es"),
      intl("latam-g1", "G1 — Globo", "https://g1.globo.com/rss/g1/", "latam", "Brazil: largest news portal (Portuguese).", "pt"),
    ],
  },
  {
    id: "africa",
    label: "Africa",
    aliases: ["africa", "african", "nigeria", "ethiopia", "kenya", "sudan", "south africa", "sahel", "congo"],
    sources: [
      intl("af-allafrica", "AllAfrica", "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf", "africa", "Pan-African aggregator (English).", "en"),
      intl("af-news24", "News24", "https://feeds.capi24.com/v1/Search/articles/news24/TopStories/rss", "africa", "South Africa: major news site (English).", "en"),
      // Original language (French — Francophone Africa)
      intl("af-rfi", "RFI Afrique", "https://www.rfi.fr/fr/afrique/rss", "africa", "France/Francophone Africa: public broadcaster (French).", "fr"),
    ],
  },
  {
    id: "japan",
    label: "Japan",
    aliases: ["japan", "japanese", "tokyo", "kishida", "okinawa"],
    sources: [
      intl("jp-japan-times", "The Japan Times", "https://www.japantimes.co.jp/feed/", "japan", "Japan: independent daily (English).", "en"),
      intl("jp-nhk-world", "NHK World", "https://www3.nhk.or.jp/nhkworld/en/news/rss/all.xml", "japan", "Japan: public broadcaster (English).", "en"),
      // Original language (Japanese)
      intl("jp-nhk-ja", "NHK ニュース", "https://www.nhk.or.jp/rss/news/cat0.xml", "japan", "Japan: public broadcaster (Japanese).", "ja"),
      intl("jp-asahi", "朝日新聞", "https://www.asahi.com/rss/asahi/newsheadlines.rdf", "japan", "Japan: centre-left daily (Japanese).", "ja"),
    ],
  },
  {
    id: "korea",
    label: "Korea",
    aliases: ["korea", "korean", "seoul", "pyongyang", "north korea", "south korea", "kim jong un", "dprk"],
    sources: [
      intl("kr-korea-herald", "The Korea Herald", "http://www.koreaherald.com/rss/020000000000.xml", "korea", "South Korea: English daily.", "en"),
      intl("kr-yonhap-en", "Yonhap", "https://en.yna.co.kr/RSS/news.xml", "korea", "South Korea: national news agency (English).", "en"),
      // Original language (Korean)
      intl("kr-yonhap-ko", "연합뉴스", "https://www.yna.co.kr/rss/news.xml", "korea", "South Korea: national news agency (Korean).", "ko"),
      intl("kr-chosun", "조선일보", "https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml", "korea", "South Korea: conservative daily (Korean).", "ko"),
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
