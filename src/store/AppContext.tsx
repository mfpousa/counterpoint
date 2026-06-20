// App-wide state: preferences, daily progress, the built feed, and actions.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fetchRankedFeed } from "../lib/api";
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
import type { DailyProgress, FeedItem, LeanHistoryPoint, Preferences } from "../types";

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
  updatePrefs: (patch: Partial<Preferences>) => Promise<void>;
  completeItem: (item: FeedItem) => Promise<void>;
  refreshFeed: () => Promise<void>;
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

  const refreshFeed = useCallback(async () => {
    setLoadingFeed(true);
    setFeedError(null);
    try {
      // The backend fetches every feed server-side and uses the local LLM to
      // categorize, score, and diversify before we ever see it.
      const items = await fetchRankedFeed();
      if (items.length === 0) {
        setFeedError(
          "The backend returned no items. Make sure the server is running (npm run server) " +
            "and your local model is loaded.",
        );
      }
      setPool(items);
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : "Failed to load the feed.");
    } finally {
      setLoadingFeed(false);
    }
  }, []);

  // Fetch once we're ready & onboarded.
  useEffect(() => {
    if (ready && prefs.onboarded && pool.length === 0) {
      void refreshFeed();
    }
  }, [ready, prefs.onboarded, pool.length, refreshFeed]);

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
