// Keyless YouTube SEARCH via yt-dlp's `ytsearch`. Powers story-driven discovery:
// given a headline the outlets are covering, find a relevant longer-form news /
// podcast video and surface it as a tagged "article" (see feedService's
// augmentWithYouTube). yt-dlp implements YouTube's token logic, so no API key is
// needed — and we already depend on it for transcripts.
//
// `--flat-playlist --dump-json` returns one JSON object per result WITHOUT
// extracting each video page, so a search is a single fast process. Everything is
// best-effort: missing binary / network / rate-limit -> empty list, and the
// caller simply adds no videos. Results are cached per query (server-side, shared
// across all users) so we never re-run the same search within its TTL.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config";

const execFileAsync = promisify(execFile);

export interface YouTubeHit {
  /** 11-char YouTube video id. */
  videoId: string;
  title: string;
  /** Channel/uploader name — used in place of the outlet name. */
  channel: string;
  /** Canonical watch URL. */
  url: string;
  /** Length in seconds, or null when yt-dlp didn't report it (flat mode). */
  durationSec: number | null;
  thumbnail?: string;
  /** Upload time (epoch ms) when known. */
  uploadedAt?: number;
}

// Becomes false after the first ENOENT so we stop trying (and warn once).
let ytDlpAvailable = true;

// query -> { at, hits }. Server-side cache shared across every user/request.
const cache = new Map<string, { at: number; hits: YouTubeHit[] }>();

/** True when yt-dlp has been found to be missing (search permanently degraded). */
export function youTubeSearchDisabled(): boolean {
  return !ytDlpAvailable;
}

/**
 * Turn a news headline into a clean YouTube search query: strip surrounding
 * quotes and a trailing outlet/site suffix (" - The New York Times", " | Reuters",
 * " — Vox"), then cap the length. Pure (no I/O) so it's unit-testable.
 */
export function cleanHeadlineQuery(title: string): string {
  let q = (title || "").trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "").trim();
  // Drop a short trailing " - Outlet" / " | Outlet" / " — Outlet" attribution.
  q = q.replace(/\s+[\-\u2013\u2014|]\s+[^\-\u2013\u2014|]{1,40}$/u, "").trim();
  if (q.length > 120) q = q.slice(0, 120).trim();
  return q;
}

function pickThumbnail(o: Record<string, unknown>, videoId: string): string | undefined {
  const thumbs = o["thumbnails"];
  if (Array.isArray(thumbs) && thumbs.length > 0) {
    const last = thumbs[thumbs.length - 1] as { url?: unknown };
    if (last && typeof last.url === "string") return last.url;
  }
  if (typeof o["thumbnail"] === "string") return o["thumbnail"] as string;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function parseUploadDate(o: Record<string, unknown>): number | undefined {
  const ud = o["upload_date"];
  if (typeof ud === "string" && /^\d{8}$/.test(ud)) {
    const t = Date.UTC(+ud.slice(0, 4), +ud.slice(4, 6) - 1, +ud.slice(6, 8));
    if (!Number.isNaN(t)) return t;
  }
  const ts = o["timestamp"];
  if (typeof ts === "number" && ts > 0) return Math.round(ts * 1000);
  return undefined;
}

/**
 * Parse yt-dlp `--dump-json --flat-playlist` JSONL into hits. Pure (no I/O) so it
 * can be unit-tested against captured yt-dlp output. Skips malformed lines and
 * anything without a valid video id + title.
 */
export function parseSearchOutput(stdout: string): YouTubeHit[] {
  const hits: YouTubeHit[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    const videoId = typeof o["id"] === "string" ? (o["id"] as string) : "";
    if (!/^[\w-]{11}$/.test(videoId)) continue;
    const title = typeof o["title"] === "string" ? (o["title"] as string).trim() : "";
    if (!title || title === "[Private video]" || title === "[Deleted video]") continue;
    const channel =
      (typeof o["channel"] === "string" && (o["channel"] as string).trim()) ||
      (typeof o["uploader"] === "string" && (o["uploader"] as string).trim()) ||
      "YouTube";
    const rawDur = o["duration"];
    const durationSec =
      typeof rawDur === "number" && rawDur > 0 ? Math.round(rawDur) : null;
    hits.push({
      videoId,
      title,
      channel,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      durationSec,
      thumbnail: pickThumbnail(o, videoId),
      uploadedAt: parseUploadDate(o),
    });
  }
  return hits;
}

/**
 * Duration gate + de-duplication. Pure (no I/O). Drops shorts/clips and
 * multi-hour livestreams when the duration is known; entries with an unknown
 * duration are kept (relevance filtering downstream still applies).
 */
export function filterHits(hits: YouTubeHit[]): YouTubeHit[] {
  const seen = new Set<string>();
  const out: YouTubeHit[] = [];
  for (const h of hits) {
    if (seen.has(h.videoId)) continue;
    if (h.durationSec !== null) {
      if (h.durationSec < config.youtube.minDurationSec) continue;
      if (h.durationSec > config.youtube.maxDurationSec) continue;
    }
    seen.add(h.videoId);
    out.push(h);
  }
  return out;
}

/**
 * Search YouTube for `query` and return duration-filtered, de-duplicated hits.
 * Cached per query (TTL config.youtube.queryTtlMs). Returns [] on any failure.
 */
export async function searchYouTube(
  query: string,
  limit = config.youtube.resultsPerQuery,
): Promise<YouTubeHit[]> {
  const q = query.trim();
  if (!q || !ytDlpAvailable) return [];

  const cached = cache.get(q);
  if (cached && Date.now() - cached.at < config.youtube.queryTtlMs) return cached.hits;

  const args = [
    `ytsearch${Math.max(1, limit)}:${q}`,
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--ignore-errors",
  ];
  if (config.transcripts.insecureTls) args.unshift("--no-check-certificates");
  const env = config.transcripts.caFile
    ? { ...process.env, SSL_CERT_FILE: config.transcripts.caFile }
    : process.env;

  try {
    const { stdout } = await execFileAsync(config.transcripts.ytDlpPath, args, {
      timeout: config.youtube.searchTimeoutMs,
      maxBuffer: 1024 * 1024 * 32,
      env,
    });
    const hits = filterHits(parseSearchOutput(stdout));
    cache.set(q, { at: Date.now(), hits });
    return hits;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string };
    if (err.code === "ENOENT") {
      ytDlpAvailable = false;
      console.warn(
        `[youtube] '${config.transcripts.ytDlpPath}' not found — YouTube search disabled. ` +
          "Install yt-dlp or set YT_SEARCH_OFF=1.",
      );
      return []; // don't cache: a later install should take effect
    }
    // yt-dlp exits non-zero when SOME results error, but still prints the good
    // ones to stdout — salvage those before giving up.
    if (err.stdout) {
      const hits = filterHits(parseSearchOutput(err.stdout));
      if (hits.length > 0) {
        cache.set(q, { at: Date.now(), hits });
        return hits;
      }
    }
    // Timeout / network / rate-limit: cache a brief empty miss so we don't hammer.
    cache.set(q, { at: Date.now(), hits: [] });
    console.warn(`[youtube] search failed for "${q}": ${err.message ?? e}`);
    return [];
  }
}
