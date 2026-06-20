// Startup healthcheck: verifies every external dependency the backend relies on
// and prints a clear pass/fail report so problems surface immediately rather
// than as silent empty feeds later. Checks:
//   1. The local LLM (OpenAI-compatible) — and asks it to greet us live.
//   2. yt-dlp presence (YouTube transcripts).
//   3. Feed connectivity (a sample source fetch — also exercises TLS).

import SOURCES from "../src/data/sources";
import { fetchSource } from "../src/lib/rss";
import { aiReachable } from "./ai";
import { config } from "./config";
import { ytDlpVersion } from "./transcripts";

const OK = "\u2713"; // ✓
const WARN = "\u26A0"; // ⚠
const FAIL = "\u2717"; // ✗

/** Ask the model for a one-line hello so we can see it actually responds. */
async function aiGreeting(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "You are the Counterpoint backend's local AI. Reply with ONE short, friendly " +
              "sentence confirming you are online and ready to curate the feed. No preamble.",
          },
          { role: "user", content: "Say hello so we know you're working." },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run all startup checks and log a report. Never throws. */
export async function runStartupHealthcheck(): Promise<void> {
  console.log("\n[health] Running startup checks…");

  // 1. Local LLM.
  if (!(await aiReachable())) {
    console.warn(
      `[health] ${FAIL} AI endpoint unreachable at ${config.ai.baseUrl} ` +
        `(model: ${config.ai.model}). Start your local model server (LM Studio / Ollama / …).`,
    );
  } else {
    const greeting = await aiGreeting();
    if (greeting) {
      console.log(`[health] ${OK} AI online (${config.ai.model})`);
      console.log(`[health]   AI says: "${greeting}"`);
    } else {
      console.warn(
        `[health] ${WARN} AI endpoint reachable but the chat completion failed — ` +
          `is a model actually loaded at ${config.ai.baseUrl}?`,
      );
    }
  }

  // 2. yt-dlp (YouTube transcripts).
  if (!config.transcripts.enabled) {
    console.log(`[health] • Transcripts disabled (TRANSCRIPTS_OFF).`);
  } else {
    const version = await ytDlpVersion();
    if (version) {
      console.log(`[health] ${OK} yt-dlp present (v${version})`);
    } else {
      console.warn(
        `[health] ${FAIL} yt-dlp not found ('${config.transcripts.ytDlpPath}'). ` +
          `YouTube transcripts will be skipped — install yt-dlp or set TRANSCRIPTS_OFF=1.`,
      );
    }
  }

  // 3. Feed connectivity (sample fetch — also exercises TLS).
  try {
    const sample = SOURCES[0];
    const items = await fetchSource(sample);
    if (items.length > 0) {
      console.log(`[health] ${OK} Feed fetch OK (${sample.title}: ${items.length} items)`);
    } else {
      console.warn(
        `[health] ${WARN} Feed fetch returned 0 items (${sample.title}). ` +
          `Check connectivity/TLS (NODE_EXTRA_CA_CERTS or ALLOW_INSECURE_TLS).`,
      );
    }
  } catch (e) {
    console.warn(`[health] ${FAIL} Feed fetch failed: ${e instanceof Error ? e.message : e}`);
  }

  console.log("[health] Startup checks complete.\n");
}
