// Counterpoint backend entrypoint.
//
// Exposes a tiny JSON API the Expo app consumes:
//   GET  /api/health   liveness + whether the local LLM is reachable
//   GET  /api/feed?interest=...   the AI-ranked, diversified feed (TTL-cached per interest)
//   POST /api/refresh {interest}   force a full rebuild (clears caches)
//
// Run: npm run server  (tsx watch)  |  npm run server:start

import cors from "cors";
import express from "express";
import { aiReachable } from "./ai";
import { config } from "./config";
import {
  clearCaches,
  getBriefing,
  getBriefingStream,
  getFeed,
  getRelated,
  getStatus,
  getStories,
  getStory,
} from "./feedService";
import { gradeSummary } from "./grade";
import { readLang } from "./lang";
import { runStartupHealthcheck } from "./healthcheck";
import { generateKnowledgeInsight, type KnowledgeCandidate } from "./knowledge";
import { rewriteArticle, rewriteArticleStream } from "./rewrite";
import { getStoredAnyWorld } from "./store";
import { DEFAULT_WORLD_ID, WORLDS, isPlaceWorldId, isWorldId } from "../src/data/worlds";
import type { KnowledgeProfile, Place } from "../src/types";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", async (_req, res) => {
  const ai = await aiReachable();
  res.json({
    ok: true,
    ai: { reachable: ai, baseUrl: config.ai.baseUrl, model: config.ai.model },
    time: Date.now(),
  });
});

/** Pull the steering interest from a query param or JSON body (string, capped). */
function readInterest(raw: unknown): string {
  if (typeof raw !== "string") return config.feed.interest;
  return raw.slice(0, config.feed.maxInterestLen);
}

/**
 * Resolve a pool id from a query param / body. Accepts a topical world id OR a
 * synthetic REGIONAL pool id (`place-<cc>`, the International↔Regional switch),
 * defaulting to the front page.
 */
function readWorld(raw: unknown): string {
  return typeof raw === "string" && (isWorldId(raw) || isPlaceWorldId(raw)) ? raw : DEFAULT_WORLD_ID;
}

/**
 * Parse a `place` lens from a request: a JSON string (GET query param) OR an
 * object (POST body). Returns null for absent/malformed input or a missing
 * country. Fields are length-capped so a hostile client can't bloat the cache key.
 */
function readPlace(raw: unknown): Place | null {
  let p: Partial<Place> | null = null;
  if (typeof raw === "string" && raw) {
    try {
      p = JSON.parse(raw) as Partial<Place>;
    } catch {
      p = null;
    }
  } else if (raw && typeof raw === "object") {
    p = raw as Partial<Place>;
  }
  if (!p || typeof p.country !== "string" || !p.country) return null;
  return {
    country: p.country.toLowerCase().slice(0, 2),
    region: typeof p.region === "string" && p.region ? p.region.slice(0, 64) : undefined,
    locality: typeof p.locality === "string" && p.locality ? p.locality.slice(0, 80) : undefined,
  };
}

/** The catalogue of worlds (metadata only) the client renders in its switcher. */
app.get("/api/worlds", (_req, res) => {
  res.json({
    worlds: WORLDS.map((w) => ({
      id: w.id,
      title: w.title,
      description: w.description,
      icon: w.icon,
      sources: w.sources.length,
    })),
  });
});

app.get("/api/status", (req, res) => {
  res.json(getStatus(readWorld(req.query.world)));
});

app.get("/api/feed", async (req, res) => {
  try {
    const feed = await getFeed(
      readWorld(req.query.world),
      false,
      readInterest(req.query.interest),
      readPlace(req.query.place),
    );
    res.json(feed);
  } catch (e) {
    console.error("[api] /api/feed failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "feed build failed" });
  }
});

app.get("/api/briefing", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const briefing = await getBriefing(
      readWorld(req.query.world),
      force,
      readInterest(req.query.interest),
      readLang(req.query.lang),
    );
    res.json({ briefing });
  } catch (e) {
    console.error("[api] /api/briefing failed:", e);
    res.status(500).json({ briefing: null, error: e instanceof Error ? e.message : "failed" });
  }
});

// Streaming briefing (SSE): forwards the model's tokens as it writes the digest,
// then a `done` event with the parsed Briefing (or null). Events: delta, done, error.
app.get("/api/briefing/stream", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const briefing = await getBriefingStream(
      readWorld(req.query.world),
      readInterest(req.query.interest),
      readLang(req.query.lang),
      (delta) => send("delta", delta),
    );
    send("done", briefing);
  } catch (e) {
    console.error("[api] /api/briefing/stream failed:", e);
    send("error", e instanceof Error ? e.message : "briefing failed");
  } finally {
    if (!closed) res.end();
  }
});

app.get("/api/stories", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const { stories, busyWith } = await getStories(
      readWorld(req.query.world),
      force,
      readLang(req.query.lang),
    );
    res.json({ stories, busyWith });
  } catch (e) {
    console.error("[api] /api/stories failed:", e);
    res.status(500).json({ stories: [], error: e instanceof Error ? e.message : "failed" });
  }
});

app.get("/api/story", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({ error: "missing story id" });
    return;
  }
  try {
    const story = await getStory(readWorld(req.query.world), id, readLang(req.query.lang));
    if (!story) {
      res.status(404).json({ error: "story not found (it may have aged out)" });
      return;
    }
    res.json({ story });
  } catch (e) {
    console.error("[api] /api/story failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "failed" });
  }
});

app.get("/api/related", (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({ error: "missing item id" });
    return;
  }
  const limit = Math.max(1, Math.min(12, Number(req.query.limit) || 6));
  try {
    const items = getRelated(readWorld(req.query.world), id, limit);
    res.json({ items });
  } catch (e) {
    console.error("[api] /api/related failed:", e);
    res.status(500).json({ items: [], error: e instanceof Error ? e.message : "failed" });
  }
});

// Streaming rewrite (SSE): forwards the model's tokens as they generate so the
// reader can show the AI writing live. Events: `delta` (string chunk), `done`
// (the final RewrittenArticle), `error` (message).
app.get("/api/rewrite/stream", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({ error: "missing item id" });
    return;
  }
  const stored = getStoredAnyWorld(id, readWorld(req.query.world));
  if (!stored) {
    res.status(404).json({ error: "item not found (it may have aged out of the feed)" });
    return;
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const article = await rewriteArticleStream(
      stored,
      (delta) => send("delta", delta),
      (reasoning) => send("reasoning", reasoning),
      readLang(req.query.lang),
    );
    if (!article) send("error", "The article couldn't be rewritten (paywall or model offline).");
    else send("done", article);
  } catch (e) {
    console.error("[api] /api/rewrite/stream failed:", e);
    send("error", e instanceof Error ? e.message : "rewrite failed");
  } finally {
    if (!closed) res.end();
  }
});

app.get("/api/rewrite", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({ error: "missing item id" });
    return;
  }
  const stored = getStoredAnyWorld(id, readWorld(req.query.world));
  if (!stored) {
    res.status(404).json({ error: "item not found (it may have aged out of the feed)" });
    return;
  }
  try {
    const article = await rewriteArticle(stored, readLang(req.query.lang));
    if (!article) {
      res.status(502).json({
        error:
          "Couldn't produce a readable version (the page may be paywalled or the model is offline).",
      });
      return;
    }
    res.json({ article });
  } catch (e) {
    console.error("[api] /api/rewrite failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "rewrite failed" });
  }
});

app.post("/api/grade", async (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  const summary = typeof req.body?.summary === "string" ? req.body.summary : "";
  if (!id || summary.trim().length < 10) {
    res.status(400).json({ error: "Provide an item id and a summary of at least 10 characters." });
    return;
  }
  const stored = getStoredAnyWorld(id, readWorld(req.body?.world));
  if (!stored) {
    res.status(404).json({ error: "item not found (it may have aged out of the feed)" });
    return;
  }
  try {
    const grade = await gradeSummary(stored, summary, readLang(req.body?.lang));
    if (!grade) {
      res.status(502).json({
        error: "Couldn't grade your summary (the model may be offline or the article unavailable).",
      });
      return;
    }
    res.json({ grade });
  } catch (e) {
    console.error("[api] /api/grade failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "grade failed" });
  }
});

app.post("/api/knowledge", async (req, res) => {
  const profile = req.body?.profile as KnowledgeProfile | undefined;
  const candidates = Array.isArray(req.body?.candidates)
    ? (req.body.candidates as KnowledgeCandidate[])
    : [];
  if (!profile || typeof profile.totalGraded !== "number") {
    res.status(400).json({ error: "missing knowledge profile" });
    return;
  }
  try {
    const insight = await generateKnowledgeInsight(profile, candidates);
    res.json({ insight });
  } catch (e) {
    console.error("[api] /api/knowledge failed:", e);
    res.status(500).json({ insight: null, error: e instanceof Error ? e.message : "failed" });
  }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const world = readWorld(req.body?.world);
    clearCaches(world);
    const feed = await getFeed(world, true, readInterest(req.body?.interest), readPlace(req.body?.place));
    res.json(feed);
  } catch (e) {
    console.error("[api] /api/refresh failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "refresh failed" });
  }
});

const server = app.listen(config.server.port, async () => {
  console.log(`[server] Counterpoint API on http://localhost:${config.server.port}`);
  console.log(`[server] AI endpoint: ${config.ai.baseUrl} (model: ${config.ai.model})`);
  // Verify every dependency up front so problems are obvious, not silent.
  await runStartupHealthcheck();
  // Warm the cache so the first client request is fast. Failures are non-fatal.
  getFeed().catch((e) => console.warn("[server] initial warm-up failed:", e));
});

// A cold, full-corpus analysis can take many minutes. Node's defaults would
// otherwise abort a long-running /api/feed build (requestTimeout) or a slow
// response, so disable those limits — this is a trusted local API.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
