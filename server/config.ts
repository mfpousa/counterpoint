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

function bool(name: string): boolean {
  const v = (process.env[name] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// Corporate TLS-interception (Zscaler/Netskope/etc.) presents a self-signed
// root CA that Node doesn't trust by default, causing SELF_SIGNED_CERT_IN_CHAIN
// on most HTTPS feed fetches. The SECURE fix is NODE_EXTRA_CA_CERTS=<root.pem>
// (read by Node at startup). As a local-dev convenience ONLY, ALLOW_INSECURE_TLS
// disables certificate verification process-wide. Never use it in production.
if (bool("ALLOW_INSECURE_TLS")) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn(
    "[config] ALLOW_INSECURE_TLS is set — TLS certificate verification is DISABLED. " +
      "Use NODE_EXTRA_CA_CERTS with your corporate root CA for a secure setup.",
  );
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
  transcripts: {
    // Fetch YouTube caption transcripts (via yt-dlp) so the model understands a
    // video's actual content, not just its description. On by default; degrades
    // gracefully if yt-dlp isn't installed. Disable with TRANSCRIPTS_OFF=1.
    enabled: !bool("TRANSCRIPTS_OFF"),
    // Path/command for the yt-dlp binary.
    ytDlpPath: str("YT_DLP_PATH", "yt-dlp"),
    // yt-dlp has its own bundled CA store (it won't see NODE_EXTRA_CA_CERTS),
    // so mirror our TLS strategy: pass --no-check-certificates when insecure,
    // or hand it the corporate CA via SSL_CERT_FILE when one is configured.
    insecureTls: bool("ALLOW_INSECURE_TLS"),
    caFile: str("NODE_EXTRA_CA_CERTS", ""),
    // Max transcript characters sent to the model (keeps prompts in budget).
    maxChars: num("TRANSCRIPT_MAX_CHARS", 6000),
    // Parallel yt-dlp processes (each spawns a child + network; keep low).
    concurrency: num("TRANSCRIPT_CONCURRENCY", 2),
    timeoutMs: num("TRANSCRIPT_TIMEOUT_MS", 30_000),
  },
} as const;

export type Config = typeof config;
