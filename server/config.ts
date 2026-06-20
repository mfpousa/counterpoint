// Backend configuration, resolved once from the environment.
//
// All values have safe defaults so the server boots without a .env file.
// The AI target is a generic OpenAI-compatible endpoint (LM Studio, Ollama,
// llama.cpp, vLLM, ...) so nothing here is vendor-specific.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader (no dependency). Does not override real env vars. */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // No .env file — fall back to defaults / real env.
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const config = {
  ai: {
    baseUrl: str("AI_BASE_URL", "http://localhost:1234/v1"),
    model: str("AI_MODEL", "local-model"),
    apiKey: str("AI_API_KEY", "not-needed"),
    batchSize: num("AI_BATCH_SIZE", 8),
    concurrency: num("AI_CONCURRENCY", 2),
    maxItems: num("AI_MAX_ITEMS", 80),
    timeoutMs: num("AI_TIMEOUT_MS", 60_000),
  },
  server: {
    port: num("PORT", 8787),
    feedTtlMs: num("FEED_TTL_MS", 600_000),
  },
} as const;

export type Config = typeof config;
