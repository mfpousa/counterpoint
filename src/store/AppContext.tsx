// App-wide state: preferences, daily progress, the built feed, and actions.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchBriefing, fetchRankedFeed, fetchStatus, gradeSummary } from "../lib/api";
import { buildFeed } from "../lib/buildFeed";
import { translate } from "../lib/i18n";
import { PASS_SCORE } from "../lib/knowledge";
import { applyCompletion } from "../lib/lean";
import {
  DEFAULT_PREFERENCES,
  emptyProgress,
  loadHistory,
  loadPreferences,
  loadProgress,
  loadSummaries,
  resetProgressOnly,
  savePreferences,
  saveProgress,
  trailingWindow,
  upsertSummary,
} from "../storage/storage";
import type {
  AnalysisStatus,
  Briefing,
  DailyProgress,
  FeedItem,
  LeanHistoryPoint,
  Preferences,
  StoredSummary,
  SummaryGrade,
} from "../types";

interface AppState {
  ready: boolean;
  prefs: Preferences;
  progress: DailyProgress;
  history: LeanHistoryPoint[];
  /** All fetched items (raw pool, lean possibly refined). */
  pool: FeedItem[];
  /** Today's built, balanced feed (excludes already-completed). */
  feed: FeedItem[];
  loadingFeed: boolean;
  feedError: string | null;
  /** AI digest of what's happening / where it's headed (null if unavailable). */
  briefing: Briefing | null;
  loadingBriefing: boolean;
  /** Live backend analysis progress (null until first poll). */
  status: AnalysisStatus | null;
  /** Graded recall summaries (newest first), persisted locally. */
  summaries: StoredSummary[];
  /** The active world id (set of sources). */
  worldId: string;
  /** If a DIFFERENT world is currently refreshing (only one at a time), its id. */
  busyWorld: string | null;
  updatePrefs: (patch: Partial<Preferences>) => Promise<void>;
  completeItem: (item: FeedItem) => Promise<void>;
  /**
   * Grade the reader's recall summary of an item. Persists it and, when it
   * passes the threshold, marks the item seen. Returns the grade so the UI can
   * show the score + feedback. Throws on grading failure (model offline, etc.).
   */
  gradeAndRecord: (item: FeedItem, summaryText: string) => Promise<SummaryGrade>;
  refreshFeed: (opts?: { force?: boolean }) => Promise<void>;
  /** Switch the active world (persists, clears the current pool, re-fetches). */
  setWorld: (worldId: string) => Promise<void>;
  resetToday: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [progress, setProgress] = useState<DailyProgress>(emptyProgress());
  const [history, setHistory] = useState<LeanHistoryPoint[]>([]);
  const [pool, setPool] = useState<FeedItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loadingBriefing, setLoadingBriefing] = useState(false);
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [summaries, setSummaries] = useState<StoredSummary[]>([]);
  const [busyWorld, setBusyWorld] = useState<string | null>(null);

  // Initial load of persisted state.
  useEffect(() => {
    (async () => {
      const [p, pr, h, sm] = await Promise.all([
        loadPreferences(),
        loadProgress(),
        loadHistory(),
        loadSummaries(),
      ]);
      setPrefs(p);
      setProgress(pr);
      setHistory(h);
      setSummaries(sm);
      setReady(true);
    })();
  }, []);

  // Always read the latest steering interest + active world without re-creating
  // the fetch callbacks.
  const interestRef = useRef(prefs.interestPrompt);
  interestRef.current = prefs.interestPrompt;
  const worldRef = useRef(prefs.worldId);
  worldRef.current = prefs.worldId;
  const langRef = useRef(prefs.language);
  langRef.current = prefs.language;

  // Best-effort, non-blocking. The pool is already fresh after a feed load, so
  // we never force here (avoids a second rebuild). Steered by the same interest.
  const loadBriefing = useCallback(async () => {
    setLoadingBriefing(true);
    try {
      setBriefing(
        await fetchBriefing({
          interest: interestRef.current,
          world: worldRef.current,
          lang: langRef.current,
        }),
      );
    } finally {
      setLoadingBriefing(false);
    }
  }, []);

  // Coalesce overlapping non-forced refreshes (e.g. the world-change effect and
  // the pool-empty effect both firing on a switch) into a single fetch.
  const fetchingRef = useRef(false);
  const refreshFeed = useCallback(async (opts: { force?: boolean } = {}) => {
    if (fetchingRef.current && !opts.force) return;
    fetchingRef.current = true;
    setLoadingFeed(true);
    setFeedError(null);
    try {
      // The backend fetches every feed server-side and uses the local LLM to
      // categorize, score, and diversify (steered by the interest) before we
      // ever see it.
      const res = await fetchRankedFeed({
        force: opts.force,
        interest: interestRef.current,
        world: worldRef.current,
      });
      setBusyWorld(res.busyWith ?? null);
      if (res.items.length === 0 && !res.busyWith) {
        setFeedError(
          "The backend returned no items. Make sure the server is running (npm run server) " +
            "and your local model is loaded.",
        );
      }
      setPool(res.items);
      void loadBriefing();
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : "Failed to load the feed.");
    } finally {
      setLoadingFeed(false);
      fetchingRef.current = false;
    }
  }, [loadBriefing]);

  // Fetch once we're ready & onboarded.
  useEffect(() => {
    if (ready && prefs.onboarded && pool.length === 0) {
      void refreshFeed();
    }
  }, [ready, prefs.onboarded, pool.length, refreshFeed]);

  // Re-fetch when the committed steering interest changes (skip the first run).
  const lastInterest = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !prefs.onboarded) return;
    if (lastInterest.current === null) {
      lastInterest.current = prefs.interestPrompt;
      return;
    }
    if (lastInterest.current !== prefs.interestPrompt) {
      lastInterest.current = prefs.interestPrompt;
      void refreshFeed();
    }
  }, [ready, prefs.onboarded, prefs.interestPrompt, refreshFeed]);

  // Re-fetch when the active WORLD changes (skip the first run). The pool was
  // already cleared by setWorld, so this assembles the newly-selected world.
  const lastWorld = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !prefs.onboarded) return;
    if (lastWorld.current === null) {
      lastWorld.current = prefs.worldId;
      return;
    }
    if (lastWorld.current !== prefs.worldId) {
      lastWorld.current = prefs.worldId;
      void refreshFeed();
    }
  }, [ready, prefs.onboarded, prefs.worldId, refreshFeed]);

  // Re-synthesize the briefing in the new language when it changes (skip first
  // run). The feed/stories re-fetch in their own language-aware effects.
  const lastLang = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !prefs.onboarded) return;
    if (lastLang.current === null) {
      lastLang.current = prefs.language;
      return;
    }
    if (lastLang.current !== prefs.language) {
      lastLang.current = prefs.language;
      void loadBriefing();
    }
  }, [ready, prefs.onboarded, prefs.language, loadBriefing]);

  // Keep a ref of loadingFeed so the status poller can avoid overlapping loads.
  const loadingFeedRef = useRef(loadingFeed);
  loadingFeedRef.current = loadingFeed;

  // Silently pull newly-analyzed items into the pool (no loading banner), used
  // when the backend finishes an analysis chunk in the background.
  const reloadPool = useCallback(async () => {
    try {
      const res = await fetchRankedFeed({ interest: interestRef.current, world: worldRef.current });
      setBusyWorld(res.busyWith ?? null);
      if (res.items.length > 0) setPool(res.items);
    } catch {
      /* best-effort live refresh; ignore */
    }
  }, []);

  // Poll backend analysis progress. While the build advances, surface it via
  // `status`; when the analyzed count grows (a chunk finished), refresh the feed
  // so new items appear live without a manual reload.
  const prevAnalyzed = useRef(0);
  useEffect(() => {
    if (!ready || !prefs.onboarded) return;
    let cancelled = false;
    const tick = async () => {
      const s = await fetchStatus(worldRef.current);
      if (cancelled || !s) return;
      setStatus(s);
      setBusyWorld(s.busyWith ?? null);
      if (prevAnalyzed.current === 0) {
        prevAnalyzed.current = s.analyzed;
      } else if (s.analyzed > prevAnalyzed.current) {
        prevAnalyzed.current = s.analyzed;
        if (!loadingFeedRef.current) void reloadPool();
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ready, prefs.onboarded, reloadPool]);

  const feed = useMemo(
    () => buildFeed({ items: pool, prefs, progress }),
    [pool, prefs, progress],
  );

  const updatePrefs = useCallback(
    async (patch: Partial<Preferences>) => {
      const next = { ...prefs, ...patch };
      setPrefs(next);
      await savePreferences(next);
    },
    [prefs],
  );

  const completeItem = useCallback(
    async (item: FeedItem) => {
      const next = applyCompletion(progress, item);
      setProgress(next);
      await saveProgress(next);
    },
    [progress],
  );

  // Keep a ref of summaries so grading can upsert without re-creating the cb.
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;

  const gradeAndRecord = useCallback(
    async (item: FeedItem, summaryText: string): Promise<SummaryGrade> => {
      const grade = await gradeSummary(item.id, summaryText, worldRef.current, langRef.current);
      const passed = grade.score >= PASS_SCORE;
      const record: StoredSummary = {
        id: item.id,
        title: item.title,
        sourceTitle: item.sourceTitle,
        topic: item.topic,
        url: item.url,
        summary: summaryText.trim(),
        grade,
        passed,
        gradedAt: Date.now(),
      };
      const next = await upsertSummary(summariesRef.current, record);
      setSummaries(next);
      // An item is "seen" only once the reader proves recall.
      if (passed) await completeItem(item);
      return grade;
    },
    [completeItem],
  );

  const setWorld = useCallback(
    async (worldId: string) => {
      if (worldId === worldRef.current) return;
      // Clear the current world's view immediately; the worldId-change effect
      // (and the pool-empty effect) will assemble the newly-selected world.
      setPool([]);
      setBriefing(null);
      setFeedError(null);
      setBusyWorld(null);
      const next = { ...prefs, worldId };
      setPrefs(next);
      await savePreferences(next);
    },
    [prefs],
  );

  const resetToday = useCallback(async () => {
    await resetProgressOnly();
    const fresh = emptyProgress();
    setProgress(fresh);
    await saveProgress(fresh);
  }, []);

  const value: AppState = {
    ready,
    prefs,
    progress,
    history,
    pool,
    feed,
    loadingFeed,
    feedError,
    briefing,
    loadingBriefing,
    status,
    summaries,
    worldId: prefs.worldId,
    busyWorld,
    updatePrefs,
    completeItem,
    gradeAndRecord,
    refreshFeed,
    setWorld,
    resetToday,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

/** The trailing-window lean history including today's live progress. */
export function useTrailingWindow(): LeanHistoryPoint[] {
  const { history, progress } = useApp();
  return useMemo(() => trailingWindow(history, progress), [history, progress]);
}

/** Hook returning a `t(key, params)` bound to the reader's current language. */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const { prefs } = useApp();
  const lang = prefs.language;
  return useCallback(
    (key: string, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );
}
