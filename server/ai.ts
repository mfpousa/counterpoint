// OpenAI-compatible chat primitives for the local LLM.
//
// Talks to ANY local runtime exposing /chat/completions (LM Studio, Ollama,
// llama.cpp, vLLM, ...). These are the low-level building blocks; the actual
// editorial logic (clickbait triage + deep analysis) lives in analysis.ts.
// Everything degrades gracefully: a failed/malformed response yields an empty
// result so callers keep their priors.

import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config";

// --- Global model-request gate -------------------------------------------------
// config.ai.maxConcurrency model instances sit behind config.ai.baseUrl, so that
// many requests can stream AT ONCE. This gate bounds TOTAL in-flight model requests
// to that number and lets INTERACTIVE work — a user waiting on a response: search/ask,
// briefing, reader rewrite, and the cold-start first paint — jump AHEAD of BACKGROUND
// work (the bulk backfill drain: prescreen + deep analysis + embedding, plus story
// synthesis and reactive augmentation). It RESERVES config.ai.reserveInteractive slots
// that ONLY interactive work may use, so background can never occupy every instance and
// queue the reader behind the backlog. NOTE: the reserve only helps if the bulk work is
// actually tagged background — see runBackfillBatch / getStories / augmentReactively, which
// wrap themselves in withModelPriority("background"). Priority rides on AsyncLocalStorage so
// callers just wrap a scope with withModelPriority(); every request reads the ambient value.

type ModelPriority = "interactive" | "background";
const priorityStore = new AsyncLocalStorage<ModelPriority>();

/** Run `fn` — and EVERY model request it issues — at the given priority. */
export function withModelPriority<T>(priority: ModelPriority, fn: () => Promise<T>): Promise<T> {
  return priorityStore.run(priority, fn);
}
function currentModelPriority(): ModelPriority {
  // Default to interactive: user-facing calls (search/ask, briefing, reader, and the
  // cold-start fetch + first-chunk triage) are foreground. The bulk backfill drain, story
  // synthesis and augmentation explicitly mark themselves "background" so they yield to users.
  return priorityStore.getStore() ?? "interactive";
}

let activeTotal = 0;
let activeBackground = 0;
const slotWaiters: { priority: ModelPriority; wake: () => void }[] = [];

function maxBackgroundSlots(): number {
  return Math.max(0, config.ai.maxConcurrency - config.ai.reserveInteractive);
}
function canStartSlot(priority: ModelPriority): boolean {
  if (activeTotal >= config.ai.maxConcurrency) return false;
  if (priority === "background" && activeBackground >= maxBackgroundSlots()) return false;
  return true;
}
function takeSlot(priority: ModelPriority): void {
  activeTotal += 1;
  if (priority === "background") activeBackground += 1;
}
function pumpSlots(): void {
  // Wake INTERACTIVE waiters before BACKGROUND ones, each only if a slot is free for it.
  for (;;) {
    let i = slotWaiters.findIndex((w) => w.priority === "interactive" && canStartSlot("interactive"));
    if (i < 0) i = slotWaiters.findIndex((w) => w.priority === "background" && canStartSlot("background"));
    if (i < 0) break;
    const [w] = slotWaiters.splice(i, 1);
    takeSlot(w.priority);
    w.wake();
  }
}
function acquireModelSlot(priority: ModelPriority): Promise<void> {
  if (canStartSlot(priority)) {
    takeSlot(priority);
    return Promise.resolve();
  }
  return new Promise<void>((wake) => slotWaiters.push({ priority, wake }));
}
function releaseModelSlot(priority: ModelPriority): void {
  activeTotal -= 1;
  if (priority === "background") activeBackground -= 1;
  pumpSlots();
}

/** Acquire a model-request slot at the AMBIENT priority, run `fn`, then release. */
export async function withModelSlot<T>(fn: () => Promise<T>): Promise<T> {
  const priority = currentModelPriority();
  await acquireModelSlot(priority);
  try {
    return await fn();
  } finally {
    releaseModelSlot(priority);
  }
}

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
  // Salvage a TRUNCATED array (e.g. the model hit max_tokens mid-object): close
  // the array after the last COMPLETE object so we keep the items that did land
  // instead of dropping the whole batch.
  if (start !== -1) {
    const lastObj = body.lastIndexOf("}");
    if (lastObj > start) {
      try {
        return JSON.parse(body.slice(start, lastObj + 1) + "]");
      } catch {
        /* fall through */
      }
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

/** A JSON-schema name + schema object for constrained (structured) decoding. */
export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
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
export async function chatRaw(
  system: string,
  payload: unknown,
  opts: {
    maxTokens?: number;
    schema?: JsonSchema;
    /** Called with each chunk of visible answer text as it streams. */
    onDelta?: (delta: string) => void;
    /** Called with each chunk of REASONING text (models that expose a separate
     *  reasoning channel emit this BEFORE any answer content). */
    onReasoning?: (delta: string) => void;
  } = {},
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  };
  arm();

  // Hoisted so a mid-stream error can still return whatever already streamed —
  // discarding it would fail a rewrite the user already watched being written.
  let content = "";
  let raw = ""; // full decoded body, for the non-streaming fallback

  // Hold one model-instance slot for the WHOLE streamed round-trip; interactive
  // work jumps ahead of background drains (see the request gate above). Released
  // in the finally below so the slot frees the instant this request ends.
  const priority = currentModelPriority();
  await acquireModelSlot(priority);
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
        // Bound the reply so a non-stopping model can't blow past the context
        // window (which stalls/crashes the GPU). Sized by the caller per batch.
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        // Constrained decoding: force the model to emit JSON matching the schema
        // and STOP when it's complete. This is what makes a local model that
        // otherwise rambles past valid JSON produce parseable, bounded output.
        ...(opts.schema && config.ai.structuredOutput
          ? {
              response_format: {
                type: "json_schema",
                json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema },
              },
            }
          : {}),
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

    const drainLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          choices?: {
            delta?: { content?: string; reasoning_content?: string; reasoning?: string };
          }[];
        };
        const delta = json.choices?.[0]?.delta;
        if (typeof delta?.content === "string") {
          content += delta.content;
          opts.onDelta?.(delta.content);
        }
        // Reasoning channel (DeepSeek-style `reasoning_content`, or `reasoning`)
        // — emitted before any answer content; surfaced as a "thinking" signal.
        const reason = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reason === "string" && reason) opts.onReasoning?.(reason);
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
    // Salvage whatever streamed before the error rather than failing outright —
    // a truncated rewrite is far better than wiping text the user watched appear.
    if (!content && raw) {
      const obj = extractJsonObject(raw) as
        | { choices?: { message?: { content?: string } }[] }
        | null;
      content = obj?.choices?.[0]?.message?.content ?? "";
    }
    console.warn(
      `[ai] request error: ${why}${content ? ` — returning ${content.length} partial char(s)` : ""}`,
    );
    return content;
  } finally {
    if (timer) clearTimeout(timer);
    releaseModelSlot(priority);
  }
}

/**
 * One chat round-trip expecting a JSON array reply. Returns the parsed array
 * (also unwraps a { "items": [...] } envelope), or [] on any error/timeout.
 */
export async function chatJsonArray(
  system: string,
  payload: unknown,
  opts: { maxTokens?: number; schema?: JsonSchema } = {},
): Promise<unknown[]> {
  const parsed = extractJson(await chatRaw(system, payload, opts));
  if (Array.isArray(parsed)) return parsed;
  const items = (parsed as Record<string, unknown>)?.["items"];
  return Array.isArray(items) ? items : [];
}

/** One chat round-trip expecting a JSON object reply. Returns it, or null. */
export async function chatJsonObject(
  system: string,
  payload: unknown,
  opts: { maxTokens?: number; schema?: JsonSchema } = {},
): Promise<Record<string, unknown> | null> {
  return extractJsonObject(await chatRaw(system, payload, opts));
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
