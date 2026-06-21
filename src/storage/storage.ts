// Local persistence (AsyncStorage). No backend in v1.

import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  DailyProgress,
  LeanHistoryPoint,
  Preferences,
  StoredSummary,
  StoryView,
  Topic,
} from "../types";
import { DEFAULT_WORLD_ID } from "../data/worlds";

const KEYS = {
  prefs: "cp:prefs:v1",
  progress: "cp:progress:v1",
  history: "cp:leanHistory:v1",
  summaries: "cp:summaries:v1",
  storyViews: "cp:storyViews:v1",
} as const;

/** Cap on remembered story views (newest by seenAt kept). Bounds local storage. */
const MAX_STORY_VIEWS = 400;

/** Cap on stored recall summaries (newest kept). Bounds local storage. */
const MAX_SUMMARIES = 500;

const ALL_TOPICS: Topic[] = [
  "world",
  "politics",
  "economics",
  "science",
  "technology",
  "history",
  "culture",
];

export const DEFAULT_PREFERENCES: Preferences = {
  dailyQuotaMin: 120,
  enabledTopics: ALL_TOPICS,
  includeKinds: ["video", "podcast", "news"],
  interestPrompt: "",
  driftThreshold: 0.25,
  onboarded: false,
  worldId: DEFAULT_WORLD_ID,
  language: "en",
};

/** Local YYYY-MM-DD for "today". */
export function todayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function emptyProgress(date = todayKey()): DailyProgress {
  return {
    date,
    consumedMin: 0,
    completedItemIds: [],
    leanWeightSum: 0,
    leanMinutesSum: 0,
    leftMinutesSum: 0,
    rightMinutesSum: 0,
  };
}

export async function loadPreferences(): Promise<Preferences> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.prefs);
    if (!raw) return DEFAULT_PREFERENCES;
    return { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export async function savePreferences(prefs: Preferences): Promise<void> {
  await AsyncStorage.setItem(KEYS.prefs, JSON.stringify(prefs));
}

/**
 * Load today's progress. If the stored record is from a previous day, archive it
 * into the lean-history window and start a fresh record (daily rollover).
 */
export async function loadProgress(now = new Date()): Promise<DailyProgress> {
  const today = todayKey(now);
  try {
    const raw = await AsyncStorage.getItem(KEYS.progress);
    if (!raw) return emptyProgress(today);
    // Merge over defaults so records saved before new fields existed still load.
    const stored = { ...emptyProgress(today), ...(JSON.parse(raw) as DailyProgress) };
    if (stored.date === today) return stored;
    // Rollover: archive yesterday into history, reset.
    await appendHistory({
      date: stored.date,
      leanWeightSum: stored.leanWeightSum,
      leanMinutesSum: stored.leanMinutesSum,
      leftMinutesSum: stored.leftMinutesSum,
      rightMinutesSum: stored.rightMinutesSum,
    });
    const fresh = emptyProgress(today);
    await saveProgress(fresh);
    return fresh;
  } catch {
    return emptyProgress(today);
  }
}

export async function saveProgress(progress: DailyProgress): Promise<void> {
  await AsyncStorage.setItem(KEYS.progress, JSON.stringify(progress));
}

const HISTORY_WINDOW_DAYS = 30;

export async function loadHistory(): Promise<LeanHistoryPoint[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.history);
    if (!raw) return [];
    return JSON.parse(raw) as LeanHistoryPoint[];
  } catch {
    return [];
  }
}

export async function appendHistory(point: LeanHistoryPoint): Promise<void> {
  const hist = await loadHistory();
  const filtered = hist.filter((h) => h.date !== point.date);
  filtered.push(point);
  filtered.sort((a, b) => (a.date < b.date ? -1 : 1));
  const trimmed = filtered.slice(-HISTORY_WINDOW_DAYS);
  await AsyncStorage.setItem(KEYS.history, JSON.stringify(trimmed));
}

/** Combine today's live progress with the trailing archived window. */
export function trailingWindow(
  history: LeanHistoryPoint[],
  today: DailyProgress,
): LeanHistoryPoint[] {
  const withoutToday = history.filter((h) => h.date !== today.date);
  return [
    ...withoutToday,
    {
      date: today.date,
      leanWeightSum: today.leanWeightSum,
      leanMinutesSum: today.leanMinutesSum,
      leftMinutesSum: today.leftMinutesSum,
      rightMinutesSum: today.rightMinutesSum,
    },
  ];
}

/** Load all graded recall summaries (newest first). */
export async function loadSummaries(): Promise<StoredSummary[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.summaries);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredSummary[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Upsert a graded summary (keyed by item id) and persist. Returns the new list
 * (newest first) so callers can update state without a re-read.
 */
export async function upsertSummary(
  existing: StoredSummary[],
  summary: StoredSummary,
): Promise<StoredSummary[]> {
  const without = existing.filter((s) => s.id !== summary.id);
  const next = [summary, ...without]
    .sort((a, b) => b.gradedAt - a.gradedAt)
    .slice(0, MAX_SUMMARIES);
  await AsyncStorage.setItem(KEYS.summaries, JSON.stringify(next));
  return next;
}

/** Load the reader's per-story "last viewed" snapshots (keyed by story id). */
export async function loadStoryViews(): Promise<Record<string, StoryView>> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.storyViews);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoryView>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist story views, capping to the most recently seen MAX_STORY_VIEWS so the
 * record can't grow without bound. Returns the (possibly trimmed) map actually
 * written so callers can keep state in sync.
 */
export async function saveStoryViews(
  views: Record<string, StoryView>,
): Promise<Record<string, StoryView>> {
  const entries = Object.entries(views);
  const trimmed =
    entries.length <= MAX_STORY_VIEWS
      ? views
      : Object.fromEntries(
          entries.sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, MAX_STORY_VIEWS),
        );
  await AsyncStorage.setItem(KEYS.storyViews, JSON.stringify(trimmed));
  return trimmed;
}

export async function resetAll(): Promise<void> {
  await AsyncStorage.multiRemove([
    KEYS.prefs,
    KEYS.progress,
    KEYS.history,
    KEYS.summaries,
    KEYS.storyViews,
  ]);
}

export async function resetProgressOnly(): Promise<void> {
  await AsyncStorage.removeItem(KEYS.progress);
}
