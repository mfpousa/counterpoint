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
import { fetchBriefing, fetchRankedFeed } from "../lib/api";
import { buildFeed } from "../lib/buildFeed";
import { applyCompletion } from "../lib/lean";
import {
  DEFAULT_PREFERENCES,
  emptyProgress,
  loadHistory,
  loadPreferences,
  loadProgress,
  resetProgressOnly,
  savePreferences,
  saveProgress,
  trailingWindow,
} from "../storage/storage";
import type {
  Briefing,
  DailyProgress,
  FeedItem,
  LeanHistoryPoint,
  Preferences,
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
  updatePrefs: (patch: Partial<Preferences>) => Promise<void>;
  completeItem: (item: FeedItem) => Promise<void>;
  refreshFeed: (opts?: { force?: boolean }) => Promise<void>;
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

  // Initial load of persisted state.
  useEffect(() => {
    (async () => {
      const [p, pr, h] = await Promise.all([loadPreferences(), loadProgress(), loadHistory()]);
      setPrefs(p);
      setProgress(pr);
      setHistory(h);
      setReady(true);
    })();
  }, []);

  // Always read the latest steering interest without re-creating refreshFeed.
  const interestRef = useRef(prefs.interestPrompt);
  interestRef.current = prefs.interestPrompt;

  // Best-effort, non-blocking. The pool is already fresh after a feed load, so
  // we never force here (avoids a second rebuild). Steered by the same interest.
  const loadBriefing = useCallback(async () => {
    setLoadingBriefing(true);
    try {
      setBriefing(await fetchBriefing({ interest: interestRef.current }));
    } finally {
      setLoadingBriefing(false);
    }
  }, []);

  const refreshFeed = useCallback(async (opts: { force?: boolean } = {}) => {
    setLoadingFeed(true);
    setFeedError(null);
    try {
      // The backend fetches every feed server-side and uses the local LLM to
      // categorize, score, and diversify (steered by the interest) before we
      // ever see it.
      const items = await fetchRankedFeed({
        force: opts.force,
        interest: interestRef.current,
      });
      if (items.length === 0) {
        setFeedError(
          "The backend returned no items. Make sure the server is running (npm run server) " +
            "and your local model is loaded.",
        );
      }
      setPool(items);
      void loadBriefing();
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : "Failed to load the feed.");
    } finally {
      setLoadingFeed(false);
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
    updatePrefs,
    completeItem,
    refreshFeed,
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
