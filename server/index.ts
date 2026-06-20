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
import { clearCaches, getBriefing, getFeed, getStatus } from "./feedService";
import { gradeSummary } from "./grade";
import { runStartupHealthcheck } from "./healthcheck";
import { generateKnowledgeInsight, type KnowledgeCandidate } from "./knowledge";
import { rewriteArticle } from "./rewrite";
import { getStored } from "./store";
import type { KnowledgeProfile } from "../src/types";

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

app.get("/api/status", (_req, res) => {
  res.json(getStatus());
});

app.get("/api/feed", async (req, res) => {
  try {
    const feed = await getFeed(false, readInterest(req.query.interest));
    res.json(feed);
  } catch (e) {
    console.error("[api] /api/feed failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "feed build failed" });
  }
});

app.get("/api/briefing", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const briefing = await getBriefing(force, readInterest(req.query.interest));
    res.json({ briefing });
  } catch (e) {
    console.error("[api] /api/briefing failed:", e);
    res.status(500).json({ briefing: null, error: e instanceof Error ? e.message : "failed" });
  }
});

app.get("/api/rewrite", async (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({ error: "missing item id" });
    return;
  }
  const stored = getStored(id);
  if (!stored) {
    res.status(404).json({ error: "item not found (it may have aged out of the feed)" });
    return;
  }
  try {
    const article = await rewriteArticle(stored);
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
  const stored = getStored(id);
  if (!stored) {
    res.status(404).json({ error: "item not found (it may have aged out of the feed)" });
    return;
  }
  try {
    const grade = await gradeSummary(stored, summary);
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
    clearCaches();
    const feed = await getFeed(true, readInterest(req.body?.interest));
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
