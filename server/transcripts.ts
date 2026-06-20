// YouTube caption fetching, so the AI understands a video's actual CONTENT
// instead of just its marketing description.
//
// YouTube gates the caption download behind a PoToken now, so a plain HTTP
// scrape returns empty bodies. We delegate to **yt-dlp**, which implements the
// token logic, requesting (auto-)subtitles only (no media download) into a temp
// dir, then flatten the resulting VTT to plain text. Everything is best-effort:
// missing binary / no captions / errors -> null, and the caller falls back to
// the feed description. Transcripts are cached by video id (they don't change).

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FeedItem } from "../src/types";
import { config } from "./config";

const execFileAsync = promisify(execFile);

// videoId -> transcript text ("" = checked, none available).
const cache = new Map<string, string>();

// Becomes false after the first ENOENT so we stop trying (and warn once).
let ytDlpAvailable = true;

/** Extract a YouTube video id from a watch / youtu.be / embed URL. */
export function youTubeVideoId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/\/embed\/([\w-]{11})/) ||
    url.match(/\/shorts\/([\w-]{11})/);
  return m ? m[1] : null;
}

export function isYouTube(item: FeedItem): boolean {
  return item.kind === "video" && /youtu\.?be/.test(item.url) && !!youTubeVideoId(item.url);
}

/** Return the installed yt-dlp version string, or null if the binary is missing. */
export async function ytDlpVersion(): Promise<string | null> {
  try {
    // Standalone yt-dlp binaries self-unpack on first run, which can take a
    // while on a cold/loaded machine — give it room before declaring it missing.
    const { stdout } = await execFileAsync(config.transcripts.ytDlpPath, ["--version"], {
      timeout: 25_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Flatten a WebVTT subtitle file into clean, de-duplicated plain text. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  let last = "";
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("WEBVTT")) continue;
    if (line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (line.includes("-->")) continue; // cue timing
    if (/^\d+$/.test(line)) continue; // cue index
    // Strip inline timing/karaoke tags (<00:00:00.000>, <c>...</c>) + entities.
    const clean = line
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    if (!clean || clean === last) continue; // drop rolling-window repeats
    out.push(clean);
    last = clean;
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** Read whichever .vtt yt-dlp wrote into `dir` (prefers a larger/English one). */
async function readBestVtt(dir: string): Promise<string | null> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".vtt"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  // Prefer an English track; otherwise just take the first.
  files.sort((a, b) => Number(/\.en\b/.test(b)) - Number(/\.en\b/.test(a)));
  try {
    return await readFile(join(dir, files[0]), "utf8");
  } catch {
    return null;
  }
}

/** Fetch + clean a single video's transcript via yt-dlp, or null if none. */
export async function fetchYouTubeTranscript(videoId: string): Promise<string | null> {
  const cached = cache.get(videoId);
  if (cached !== undefined) return cached || null;
  if (!ytDlpAvailable) return null;

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "cp-yt-"));
    const args = [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      // Keep langs narrow: manual + original-language auto track only. Wildcards
      // pull dozens of machine-translated tracks and trip YouTube's 429 limit.
      "--sub-langs",
      "en,en-orig,en-US,en-GB",
      "--sub-format",
      "vtt",
      "--no-playlist",
      "--no-warnings",
      "-o",
      join(dir, "%(id)s.%(ext)s"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    if (config.transcripts.insecureTls) args.unshift("--no-check-certificates");
    // yt-dlp's bundled Python reads SSL_CERT_FILE for a custom CA bundle.
    const env = config.transcripts.caFile
      ? { ...process.env, SSL_CERT_FILE: config.transcripts.caFile }
      : process.env;
    await execFileAsync(config.transcripts.ytDlpPath, args, {
      timeout: config.transcripts.timeoutMs,
      maxBuffer: 1024 * 1024 * 16,
      env,
    });
    const vtt = await readBestVtt(dir);
    const text = vtt ? vttToText(vtt) : "";
    cache.set(videoId, text);
    return text || null;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      ytDlpAvailable = false;
      console.warn(
        `[transcripts] '${config.transcripts.ytDlpPath}' not found — skipping transcripts. ` +
          "Install yt-dlp or set TRANSCRIPTS_OFF=1.",
      );
      return null; // don't cache: a later install should take effect
    }
    // Non-fatal (no captions, geo-block, timeout): cache the miss.
    cache.set(videoId, "");
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Build a map of item id -> transcript excerpt for the YouTube items in the
 * list, fetched with bounded concurrency and truncated to the configured
 * character budget. Items without captions are simply omitted.
 */
export async function fetchTranscripts(items: FeedItem[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!config.transcripts.enabled) return out;

  const targets = items.filter(isYouTube);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(config.transcripts.concurrency, targets.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= targets.length) return;
        const item = targets[i];
        const id = youTubeVideoId(item.url);
        if (!id) continue;
        const t = await fetchYouTubeTranscript(id);
        if (t) out.set(item.id, t.slice(0, config.transcripts.maxChars));
      }
    },
  );
  await Promise.all(workers);
  return out;
}
