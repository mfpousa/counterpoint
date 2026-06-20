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

/** Clamp a model-provided number into [lo,hi], falling back when unparseable. */
export function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * One chat round-trip expecting a JSON array reply. Returns the parsed array
 * (also unwraps a { "items": [...] } envelope), or [] on any error/timeout.
 */
export async function chatJsonArray(system: string, payload: unknown): Promise<unknown[]> {
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
        temperature: 0,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: typeof payload === "string" ? payload : JSON.stringify(payload),
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[ai] request failed: HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(content);
    if (Array.isArray(parsed)) return parsed;
    const items = (parsed as Record<string, unknown>)?.["items"];
    return Array.isArray(items) ? items : [];
  } catch (e) {
    const why = e instanceof Error && e.name === "AbortError" ? "timeout" : String(e);
    console.warn(`[ai] request error: ${why}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
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
