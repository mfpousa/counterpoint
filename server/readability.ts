// Fetch an article's HTML server-side (no CORS) and reduce it to readable plain
// text. Deliberately dependency-free: a pragmatic "reader mode" extractor that
// strips boilerplate (scripts/styles/nav/header/footer/asides), prefers the
// <article>/<main> region, and returns clean paragraphs for the LLM to rewrite.

import { config } from "./config";

/** A browser-ish UA — many publishers 403 obvious bots/empty UAs. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Full set of headers a real Chrome sends for a top-level navigation. Many
 * publishers 403 requests that have a UA but lack the rest (no Accept-Language,
 * no Sec-Fetch-* / Sec-CH-UA hints), since that signature screams "script". This
 * makes the DIRECT fetch succeed for soft-paywall pages whose full text is in the
 * served HTML — avoiding the now-captcha-gated public proxies entirely.
 */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Sec-CH-UA": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"macOS"',
};

/** Phrases that mark a bot-challenge / captcha / interstitial rather than article
 *  text (Cloudflare, PerimeterX, generic captchas). If we see these we treat the
 *  fetch as a failure so the next fallback tier runs. */
const CHALLENGE_MARKERS = [
  "just a moment",
  "attention required! | cloudflare",
  "cf-browser-verification",
  "cf-challenge",
  "/cdn-cgi/challenge-platform",
  "g-recaptcha",
  "h-captcha",
  "px-captcha",
  "enable javascript and cookies to continue",
  "verifying you are human",
  "request unsuccessful. incapsula",
];

function looksLikeChallenge(html: string): boolean {
  // Only inspect the head: real challenge pages are tiny and put the marker up
  // top, while a genuine article that merely mentions "captcha" won't match the
  // specific platform strings above.
  const head = html.slice(0, 4000).toLowerCase();
  return CHALLENGE_MARKERS.some((m) => head.includes(m));
}

export interface ExtractedArticle {
  /** <title>/<h1>/og:title if found. */
  title: string;
  /** Cleaned body text (paragraph breaks preserved as \n\n). */
  text: string;
}

interface FetchOpts {
  timeoutMs?: number;
  /** Extra/override request headers (e.g. proxy Authorization). */
  headers?: Record<string, string>;
  /** Send a plausible same-origin Referer (helps sites that gate cold hits). */
  referer?: boolean;
}

/** Download the raw HTML for a URL, or "" on any failure/timeout/challenge. */
async function fetchHtml(url: string, opts: FetchOpts = {}): Promise<string> {
  const { timeoutMs = 15000, headers = {}, referer = false } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reqHeaders: Record<string, string> = { ...BROWSER_HEADERS, ...headers };
    // A same-origin referer makes the hit look like an in-site click, not a
    // cold, script-driven request.
    if (referer) {
      try {
        reqHeaders.Referer = new URL(url).origin + "/";
      } catch {
        /* malformed URL — skip the referer */
      }
    }
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: reqHeaders,
    });
    if (!res.ok) {
      console.warn(`[reader] fetch ${url} -> HTTP ${res.status}`);
      return "";
    }
    const ct = res.headers.get("content-type") ?? "";
    // Accept HTML/XML and plain text/markdown (reader proxies return the latter);
    // reject binaries (PDF, images, …) we can't turn into article text.
    if (ct && !ct.includes("html") && !ct.includes("xml") && !ct.includes("text")) {
      console.warn(`[reader] ${url} is not text (${ct})`);
      return "";
    }
    const body = await res.text();
    if (looksLikeChallenge(body)) {
      console.warn(`[reader] ${url} returned a bot-challenge/captcha page — skipping`);
      return "";
    }
    return body;
  } catch (e) {
    console.warn(`[reader] fetch error for ${url}: ${e instanceof Error ? e.message : e}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

export function pickTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(og[1]).trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return decodeEntities(h1[1].replace(/<[^>]*>/g, "")).trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t?.[1]) return decodeEntities(t[1]).trim();
  return "";
}

/** Remove elements whose content is never article body. */
function stripBoilerplate(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<figure[\s\S]*?<\/figure>/gi, " ");
}

/** Narrow to the most article-like region, else fall back to <body>. */
function mainRegion(html: string): string {
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (article?.[1] && article[1].length > 400) return article[1];
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (main?.[1] && main[1].length > 400) return main[1];
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] ?? html;
}

/**
 * Convert an HTML fragment to paragraph text. We split on block-level closers so
 * paragraph structure survives, then strip remaining tags and tidy whitespace.
 */
export function htmlToText(fragment: string): string {
  const withBreaks = fragment
    .replace(/<\/(p|div|section|li|h[1-6]|br|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const stripped = decodeEntities(withBreaks.replace(/<[^>]*>/g, " "));
  return stripped
    .split(/\n{2,}/)
    .map((para) => para.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    // Drop tiny fragments (menu labels, share buttons, "Advertisement", etc.).
    .filter((para) => para.length >= 40)
    .join("\n\n")
    .trim();
}

/**
 * Fetch and extract an article into a title + clean body text, truncated to the
 * model's character budget. Returns null if the page can't be fetched or yields
 * too little usable text (paywall, JS-only page, etc.).
 */
export async function extractArticle(url: string): Promise<ExtractedArticle | null> {
  // Send a same-origin referer + full browser headers so soft-paywall pages
  // (whose complete text is in the served HTML) return it to us directly.
  const html = await fetchHtml(url, { referer: true });
  if (!html) return null;

  const title = pickTitle(html);
  const text = htmlToText(mainRegion(stripBoilerplate(html)));
  if (text.length < config.reader.minChars) {
    console.warn(`[reader] extracted only ${text.length} chars from ${url} (below min)`);
    return null;
  }
  return { title, text: text.slice(0, config.reader.maxChars) };
}

/** Reduce r.jina.ai markdown output to plain paragraphs. Drops its header block
 *  ("Title:/URL Source:/Markdown Content:") and light markdown syntax. */
export function jinaMarkdownToText(md: string): string {
  const body = md.replace(/^[\s\S]*?Markdown Content:\s*/i, "");
  const cleaned = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/[*_`>]/g, "") // emphasis/quote markers
    .replace(/^[ \t]*[-+][ \t]+/gm, ""); // list bullets (don't consume newlines)
  return cleaned
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length >= 40)
    .join("\n\n")
    .trim();
}

interface ProxyCandidate {
  kind: "markdown" | "html";
  proxied: string;
  /** Extra request headers (e.g. r.jina.ai Authorization). */
  headers?: Record<string, string>;
}

/** Build the proxy URLs to try, in order. r.jina.ai renders JS and returns
 *  clean markdown; the CORS proxies just re-fetch the raw HTML from a different
 *  egress (helps simple bot-walls). When a Jina API key is configured we send it
 *  (the anonymous tier now 403s/captchas), and jina goes first. */
function proxyCandidates(url: string): ProxyCandidate[] {
  const jinaHeaders = config.reader.jinaApiKey
    ? { Authorization: `Bearer ${config.reader.jinaApiKey}` }
    : undefined;
  return [
    { kind: "markdown", proxied: `https://r.jina.ai/${url}`, headers: jinaHeaders },
    { kind: "html", proxied: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
    { kind: "html", proxied: `https://corsproxy.io/?url=${encodeURIComponent(url)}` },
  ];
}

/**
 * Resilient extraction: try the publisher directly, then (if enabled) reader
 * proxies. Catches JS-only pages and some soft paywalls; does NOT defeat hard
 * paywalls. Returns null only when no path yields enough usable text.
 */
export async function extractReadable(url: string): Promise<ExtractedArticle | null> {
  const direct = await extractArticle(url);
  if (direct) return direct;
  if (!config.reader.proxyEnabled) return null;

  for (const { kind, proxied, headers } of proxyCandidates(url)) {
    const raw = await fetchHtml(proxied, { timeoutMs: 20000, headers });
    if (!raw) continue;
    const text =
      kind === "markdown" ? jinaMarkdownToText(raw) : htmlToText(mainRegion(stripBoilerplate(raw)));
    if (text.length >= config.reader.minChars) {
      console.log(`[reader] recovered ${text.length} chars via proxy for ${url}`);
      const title = kind === "html" ? pickTitle(raw) : "";
      return { title, text: text.slice(0, config.reader.maxChars) };
    }
  }
  return null;
}
