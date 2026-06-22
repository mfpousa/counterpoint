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
import { fetchBriefing, fetchRankedFeed, fetchStatus, gradeSummary, streamBriefing } from "../lib/api";
import { placeWorldId } from "../data/worlds";
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
  loadStoryViews,
  loadSummaries,
  resetProgressOnly,
  savePreferences,
  saveProgress,
  saveStoryViews,
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
  Story,
  StoryView,
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
  /** Live token stream of the briefing while it's being written (empty otherwise). */
  briefingStream: string;
  /** Live backend analysis progress (null until first poll). */
  status: AnalysisStatus | null;
  /** Graded recall summaries (newest first), persisted locally. */
  summaries: StoredSummary[];
  /** Per-story "last viewed" snapshots, for new-coverage detection (local). */
  storyViews: Record<string, StoryView>;
  /** The active TOPICAL world id (for the world switcher UI). */
  worldId: string;
  /** The EFFECTIVE pool id the feed/stories are served from: the topical world,
   *  or the regional pool (`place-<cc>`) when scope is "regional" + a place is set. */
  feedWorldId: string;
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
  /** Record that the reader just viewed a story (snapshots its current state so
   *  later coverage can be flagged as "new"). Persisted locally. */
  markStorySeen: (story: Story) => Promise<void>;
  /** Switch the active world (persists, clears the current pool, re-fetches). */
  setWorld: (worldId: string) => Promise<void>;
  resetToday: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

/**
 * The EFFECTIVE pool id for the current prefs. Regional mode switches the dataset
 * to the country's local-only pool (`place-<cc>`); otherwise the topical world.
 * Regional needs a country to be meaningful — without one it falls back to the
 * topical world (the UI gates the toggle on a set place).
 */
function effectiveWorldId(p: Preferences): string {
  return p.scope === "regional" && p.place?.country ? placeWorldId(p.place.country) : p.worldId;
}

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
  const [briefingStream, setBriefingStream] = useState("");
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [summaries, setSummaries] = useState<StoredSummary[]>([]);
  const [storyViews, setStoryViews] = useState<Record<string, StoryView>>({});
  const [busyWorld, setBusyWorld] = useState<string | null>(null);

  // Initial load of persisted state.
  useEffect(() => {
    (async () => {
      const [p, pr, h, sm, sv] = await Promise.all([
        loadPreferences(),
        loadProgress(),
        loadHistory(),
        loadSummaries(),
        loadStoryViews(),
      ]);
      setPrefs(p);
      setProgress(pr);
      setHistory(h);
      setSummaries(sm);
      setStoryViews(sv);
      setReady(true);
    })();
  }, []);

  // Always read the latest steering interest + active world without re-creating
  // the fetch callbacks.
  const interestRef = useRef(prefs.interestPrompt);
  interestRef.current = prefs.interestPrompt;
  // The EFFECTIVE pool id (regional pool when in regional mode), used for ALL
  // backend calls so the feed/stories/briefing/status target the right dataset.
  const worldRef = useRef(effectiveWorldId(prefs));
  worldRef.current = effectiveWorldId(prefs);
  const langRef = useRef(prefs.language);
  langRef.current = prefs.language;
  const placeRef = useRef(prefs.place ?? null);
  placeRef.current = prefs.place ?? null;

  // Best-effort, non-blocking. The pool is already fresh after a feed load, so
  // we never force here (avoids a second rebuild). Streams tokens so the card
  // shows the AI writing live (falls back to a single fetch where SSE is absent).
  const briefingHandleRef = useRef<{ cancel: () => void } | null>(null);
  // Per world+language+interest cache so switching languages shows the already
  // written briefing INSTANTLY (no wipe to skeleton) while we refresh in the bg.
  const briefingByKeyRef = useRef<Map<string, Briefing | null>>(new Map());
  const loadBriefing = useCallback(async () => {
    briefingHandleRef.current?.cancel();
    const key = `${worldRef.current}:${langRef.current}:${interestRef.current}`;
    const hadCache = briefingByKeyRef.current.has(key);
    if (hadCache) {
      // Show the cached briefing immediately; keep it on screen while we refresh.
      setBriefing(briefingByKeyRef.current.get(key) ?? null);
      setBriefingStream("");
      setLoadingBriefing(false);
    } else {
      setBriefing(null);
      setBriefingStream("");
      setLoadingBriefing(true);
    }
    const finish = (b: Briefing | null) => {
      setBriefing(b);
      setBriefingStream("");
      setLoadingBriefing(false);
      briefingByKeyRef.current.set(key, b);
    };
    const fallback = () => {
      fetchBriefing({
        interest: interestRef.current,
        world: worldRef.current,
        lang: langRef.current,
      })
        .then(finish)
        .catch(() => finish(null));
    };
    const handle = streamBriefing({
      interest: interestRef.current,
      world: worldRef.current,
      lang: langRef.current,
      // Only show the live token stream when we have nothing cached to display.
      onDelta: (d) => {
        if (!hadCache) setBriefingStream((p) => p + d);
      },
      onDone: finish,
      onError: fallback,
    });
    briefingHandleRef.current = handle;
    if (!handle) fallback(); // SSE unsupported in this runtime
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
        place: placeRef.current,
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

  // Re-fetch when the EFFECTIVE pool changes (skip the first run): a topical-world
  // switch, an International↔Regional flip, or a regional place change all swap the
  // dataset, so clear the pool first for an immediate, unambiguous switch.
  const lastEffWorld = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !prefs.onboarded) return;
    const eff = effectiveWorldId(prefs);
    if (lastEffWorld.current === null) {
      lastEffWorld.current = eff;
      return;
    }
    if (lastEffWorld.current !== eff) {
      lastEffWorld.current = eff;
      setPool([]);
      setBriefing(null);
      setBusyWorld(null);
      void refreshFeed();
    }
  }, [ready, prefs.onboarded, prefs.worldId, prefs.scope, prefs.place, refreshFeed]);

  // In INTERNATIONAL mode the place lens only affects the geographic BOOST (same
  // pool), so a place change just re-ranks — refetch WITHOUT clearing. Regional
  // place changes are handled by the effective-pool effect above.
  const lastPlaceIntl = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !prefs.onboarded) return;
    const key =
      prefs.scope === "regional"
        ? ""
        : prefs.place?.country
          ? `${prefs.place.country}/${prefs.place.region ?? ""}/${prefs.place.locality ?? ""}`
          : "";
    if (lastPlaceIntl.current === null) {
      lastPlaceIntl.current = key;
      return;
    }
    if (lastPlaceIntl.current !== key) {
      lastPlaceIntl.current = key;
      void refreshFeed();
    }
  }, [ready, prefs.onboarded, prefs.scope, prefs.place, refreshFeed]);

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
      const res = await fetchRankedFeed({
        interest: interestRef.current,
        world: worldRef.current,
        place: placeRef.current,
      });
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

  // Keep a ref of story views so markStorySeen stays stable (no re-creation on
  // every view change) while always reading the latest map.
  const storyViewsRef = useRef(storyViews);
  storyViewsRef.current = storyViews;

  const markStorySeen = useCallback(async (story: Story) => {
    const snapshot: StoryView = {
      seenAt: Date.now(),
      updatedAt: story.updatedAt,
      sourceCount: story.sources.length,
    };
    const next = { ...storyViewsRef.current, [story.id]: snapshot };
    setStoryViews(next);
    // saveStoryViews may trim to the cap; mirror what was actually written.
    const written = await saveStoryViews(next);
    if (Object.keys(written).length !== Object.keys(next).length) setStoryViews(written);
  }, []);

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
    briefingStream,
    status,
    summaries,
    storyViews,
    worldId: prefs.worldId,
    feedWorldId: effectiveWorldId(prefs),
    busyWorld,
    updatePrefs,
    completeItem,
    gradeAndRecord,
    refreshFeed,
    markStorySeen,
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
