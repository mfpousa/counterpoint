// Counterpoint backend entrypoint.
//
// Exposes a tiny JSON API the Expo app consumes:
//   GET  /api/health   liveness + whether the local LLM is reachable
//   GET  /api/feed     the AI-ranked, diversified feed (TTL-cached)
//   POST /api/refresh  force a full rebuild (clears caches)
//
// Run: npm run server  (tsx watch)  |  npm run server:start

import cors from "cors";
import express from "express";
import { aiReachable } from "./ai";
import { config } from "./config";
import { clearCaches, getFeed } from "./feedService";

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

app.get("/api/feed", async (_req, res) => {
  try {
    const feed = await getFeed();
    res.json(feed);
  } catch (e) {
    console.error("[api] /api/feed failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "feed build failed" });
  }
});

app.post("/api/refresh", async (_req, res) => {
  try {
    clearCaches();
    const feed = await getFeed(true);
    res.json(feed);
  } catch (e) {
    console.error("[api] /api/refresh failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "refresh failed" });
  }
});

app.listen(config.server.port, () => {
  console.log(`[server] Counterpoint API on http://localhost:${config.server.port}`);
  console.log(`[server] AI endpoint: ${config.ai.baseUrl} (model: ${config.ai.model})`);
  // Warm the cache so the first client request is fast. Failures are non-fatal.
  getFeed().catch((e) => console.warn("[server] initial warm-up failed:", e));
});
