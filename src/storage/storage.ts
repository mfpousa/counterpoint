// Local persistence (AsyncStorage). No backend in v1.

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DailyProgress, LeanHistoryPoint, Preferences, Topic } from "../types";

const KEYS = {
  prefs: "cp:prefs:v1",
  progress: "cp:progress:v1",
  history: "cp:leanHistory:v1",
} as const;

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
  llmTaggingEnabled: false,
  driftThreshold: 0.25,
  onboarded: false,
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

export async function resetAll(): Promise<void> {
  await AsyncStorage.multiRemove([KEYS.prefs, KEYS.progress, KEYS.history]);
}

export async function resetProgressOnly(): Promise<void> {
  await AsyncStorage.removeItem(KEYS.progress);
}
