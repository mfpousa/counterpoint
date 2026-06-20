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
import { clearCaches, getFeed } from "./feedService";
import { runStartupHealthcheck } from "./healthcheck";

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

app.get("/api/feed", async (req, res) => {
  try {
    const feed = await getFeed(false, readInterest(req.query.interest));
    res.json(feed);
  } catch (e) {
    console.error("[api] /api/feed failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "feed build failed" });
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

app.listen(config.server.port, async () => {
  console.log(`[server] Counterpoint API on http://localhost:${config.server.port}`);
  console.log(`[server] AI endpoint: ${config.ai.baseUrl} (model: ${config.ai.model})`);
  // Verify every dependency up front so problems are obvious, not silent.
  await runStartupHealthcheck();
  // Warm the cache so the first client request is fast. Failures are non-fatal.
  getFeed().catch((e) => console.warn("[server] initial warm-up failed:", e));
});
