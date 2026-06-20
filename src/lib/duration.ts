// Estimate how many minutes an item takes to consume.

import type { Kind } from "../types";

const WORDS_PER_MINUTE = 200;

/** Parse an iTunes / media duration string into seconds. Accepts HH:MM:SS, MM:SS, or raw seconds. */
export function parseDurationToSeconds(raw?: string | number | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw > 0 ? raw : null;
  const s = raw.trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n > 0 ? n : null;
  }
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return seconds > 0 ? seconds : null;
}

/** Rough read time from a body of text. */
export function readMinutesFromText(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/**
 * Estimate consume-minutes for an item.
 * - video/podcast: prefer an explicit duration; otherwise fall back by kind.
 * - news: estimate from summary word count (or a default).
 */
export function estimateMinutes(opts: {
  kind: Kind;
  durationRaw?: string | number | null;
  summary?: string;
}): number {
  const explicit = parseDurationToSeconds(opts.durationRaw);
  if (explicit) return Math.max(1, Math.round(explicit / 60));

  if (opts.kind === "news") {
    const text = opts.summary ?? "";
    if (text.trim().length > 0) return readMinutesFromText(text);
    return 4; // default article read time
  }
  // Sensible fallbacks when feeds omit durations.
  return opts.kind === "podcast" ? 35 : 12;
}
