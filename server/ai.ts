// OpenAI-compatible chat primitives for the local LLM.
//
// Talks to ANY local runtime exposing /chat/completions (LM Studio, Ollama,
// llama.cpp, vLLM, ...). These are the low-level building blocks; the actual
// editorial logic (clickbait triage + deep analysis) lives in analysis.ts.
// Everything degrades gracefully: a failed/malformed response yields an empty
// result so callers keep their priors.

import { config } from "./config";

/** Pull the first JSON array/object out of a model response (handles ``` fences). */
export function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : content).trim();
  // Prefer an array; fall back to an object wrapper like { "items": [...] }.
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Pull the first JSON object out of a model response (handles ``` fences). */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : content).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(body.slice(start, end + 1));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Clamp a model-provided number into [lo,hi], falling back when unparseable. */
export function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * One chat round-trip. Returns the raw assistant message ("" on error/timeout).
 *
 * We STREAM the completion and use an INACTIVITY timeout (config.ai.timeoutMs):
 * the timer resets on every received chunk, so a model that is actively
 * generating — even a long reply or a slow local GPU — is never aborted
 * mid-prompt. We only give up if the endpoint goes silent for the whole window
 * (which also covers a stuck connection or very slow prompt ingestion before
 * the first token). Falls back to non-streaming parsing if the server ignores
 * `stream: true`.
 */
export async function chatRaw(system: string, payload: unknown): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  };
  arm();

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
        temperature: 0,
        stream: true,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: typeof payload === "string" ? payload : JSON.stringify(payload),
          },
        ],
      }),
    });
    if (!res.ok || !res.body) {
      console.warn(`[ai] request failed: HTTP ${res.status}`);
      return "";
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ""; // unparsed SSE text (may hold a partial line)
    let raw = ""; // full decoded body, for the non-streaming fallback
    let content = "";

    const drainLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string") content += delta;
      } catch {
        /* keepalive / partial frame — ignore */
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // tokens flowing — reset the inactivity timer
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        drainLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer) drainLine(buffer); // flush any trailing frame without a newline

    // Fallback: server ignored `stream: true` and returned one JSON object.
    if (!content && raw) {
      const obj = extractJsonObject(raw) as
        | { choices?: { message?: { content?: string } }[] }
        | null;
      content = obj?.choices?.[0]?.message?.content ?? "";
    }

    return content;
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "idle timeout" : String(e);
    console.warn(`[ai] request error: ${why}`);
    return "";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One chat round-trip expecting a JSON array reply. Returns the parsed array
 * (also unwraps a { "items": [...] } envelope), or [] on any error/timeout.
 */
export async function chatJsonArray(system: string, payload: unknown): Promise<unknown[]> {
  const parsed = extractJson(await chatRaw(system, payload));
  if (Array.isArray(parsed)) return parsed;
  const items = (parsed as Record<string, unknown>)?.["items"];
  return Array.isArray(items) ? items : [];
}

/** One chat round-trip expecting a JSON object reply. Returns it, or null. */
export async function chatJsonObject(
  system: string,
  payload: unknown,
): Promise<Record<string, unknown> | null> {
  return extractJsonObject(await chatRaw(system, payload));
}

/** Run async tasks with a bounded number in flight (order-preserving results). */
export async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** True if the configured AI endpoint answers a models list (used by /health). */
export async function aiReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${config.ai.baseUrl}/models`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.ai.apiKey}` },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
