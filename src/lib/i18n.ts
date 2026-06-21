// Lightweight i18n: a flat key -> string dictionary per language and a
// `translate` helper with {param} interpolation. English is the source-of-truth
// fallback for any missing key. The `useT()` hook (which needs app state) lives
// in the store so this module stays pure (no React/JSX) and server-safe.

import type { Lang } from "../types";

export const LANGUAGES: { code: Lang; label: string; endonym: string }[] = [
  { code: "en", label: "English", endonym: "English" },
  { code: "es", label: "Spanish", endonym: "Español" },
];

/** Human-readable language name for prompts/UI (e.g. "Spanish"). */
export function languageName(lang: Lang): string {
  return LANGUAGES.find((l) => l.code === lang)?.label ?? "English";
}

type Dict = Record<string, string>;

const en: Dict = {
  // common
  "common.retry": "Retry",
  "common.openOriginal": "Open original",
  // tabs
  "tabs.today": "Today",
  "tabs.balance": "Balance",
  "tabs.learn": "Learn",
  "tabs.settings": "Settings",
  // feed
  "feed.title": "Today",
  "feed.searchPlaceholder": "Search your feed — e.g. AI and scientific progress",
  "feed.refresh": "Refresh",
  "feed.summary": "{count} picks across {topics} topics, balanced for you",
  "feed.summaryOne": "{count} pick across {topics} topics, balanced for you",
  "feed.caughtUp": "You're all caught up — revisit anything you've read below",
  "feed.all": "All",
  "feed.developing": "Developing",
  "feed.curating": "Curating your balanced feed…",
  "feed.busy":
    "“{world}” is still refreshing. Only one world refreshes at a time — this one will update once it’s free.",
  "feed.empty.quotaTitle": "You've hit today's quota.",
  "feed.empty.noItemsTitle": "No items to show.",
  "feed.empty.quotaSub": "Come back tomorrow, or raise your quota in Settings.",
  "feed.empty.noItemsSub": "Pull down to refresh, or steer your feed in Settings.",
  // briefing
  "briefing.title": "Briefing",
  "briefing.unavailable": "Briefing unavailable right now.",
  "briefing.headed": "Where it’s headed: ",
  // story card
  "story.developing": "Developing",
  "story.synthesis": "Synthesis",
  "story.outlets": "{count} outlets",
  "story.outletsOne": "{count} outlet",
  "story.events": "{count} events",
  "story.differences": "{count} differences",
  "story.differencesOne": "{count} difference",
  "story.limited": "limited",
  // reader
  "reader.thinking": "Thinking…",
  "reader.reading": "Reading the article…",
  // settings
  "settings.title": "Settings",
  "settings.dailyQuota": "Daily quota",
  "settings.topics": "Topics",
  "settings.contentTypes": "Content types",
  "settings.kind.video": "Videos",
  "settings.kind.podcast": "Podcasts",
  "settings.kind.news": "News",
  "settings.drift": "Drift sensitivity",
  "settings.driftSub": "How far from 50/50 before we warn you and counter-weight the feed.",
  "settings.strict": "Strict",
  "settings.balanced": "Balanced",
  "settings.relaxed": "Relaxed",
  "settings.steer": "Steer your feed",
  "settings.steerSub":
    "Tell the AI what you care about. It scores every story against this and surfaces the matches first — low-signal filler (accidents, crime-blotter, gossip) is always pushed down. Leave blank to rank on general importance.",
  "settings.steerPlaceholder": "e.g. AI and AI-related scientific progress",
  "settings.saveUpdate": "Save & update feed",
  "settings.saved": "Saved",
  "settings.clear": "Clear",
  "settings.howBuilt": "How your feed is built",
  "settings.howBuiltSub":
    "A local AI model reads each story — and YouTube transcripts — to tag its topic, perspective, and relevance, then ranks for balance and variety. It runs on your own machine; nothing is uploaded. The model has its own biases, so treat its tags as a second opinion, not ground truth.",
  "settings.language": "Language",
  "settings.languageSub":
    "Show the app — and AI summaries — in this language, even when the source article is written in another.",
  "settings.data": "Data",
  "settings.refreshNow": "Refresh feed now",
  "settings.resetToday": "Reset today's progress",
  "settings.rerunOnboarding": "Re-run onboarding",
  "settings.eraseAll": "Erase all local data",
  "settings.footnote": "Counterpoint v0.1 — your feed, your balance, your device.",
};

const es: Dict = {
  // common
  "common.retry": "Reintentar",
  "common.openOriginal": "Abrir original",
  // tabs
  "tabs.today": "Hoy",
  "tabs.balance": "Equilibrio",
  "tabs.learn": "Aprender",
  "tabs.settings": "Ajustes",
  // feed
  "feed.title": "Hoy",
  "feed.searchPlaceholder": "Busca en tu feed — p. ej. IA y avances científicos",
  "feed.refresh": "Actualizar",
  "feed.summary": "{count} selecciones en {topics} temas, equilibrado para ti",
  "feed.summaryOne": "{count} selección en {topics} temas, equilibrado para ti",
  "feed.caughtUp": "Estás al día — vuelve a leer lo que quieras más abajo",
  "feed.all": "Todo",
  "feed.developing": "En curso",
  "feed.curating": "Preparando tu feed equilibrado…",
  "feed.busy":
    "“{world}” todavía se está actualizando. Solo se actualiza un mundo a la vez — este se actualizará cuando quede libre.",
  "feed.empty.quotaTitle": "Has alcanzado tu cuota de hoy.",
  "feed.empty.noItemsTitle": "No hay elementos para mostrar.",
  "feed.empty.quotaSub": "Vuelve mañana o aumenta tu cuota en Ajustes.",
  "feed.empty.noItemsSub": "Desliza para actualizar u orienta tu feed en Ajustes.",
  // briefing
  "briefing.title": "Informe",
  "briefing.unavailable": "Informe no disponible ahora mismo.",
  "briefing.headed": "Hacia dónde va: ",
  // story card
  "story.developing": "En curso",
  "story.synthesis": "Síntesis",
  "story.outlets": "{count} medios",
  "story.outletsOne": "{count} medio",
  "story.events": "{count} eventos",
  "story.differences": "{count} diferencias",
  "story.differencesOne": "{count} diferencia",
  "story.limited": "limitado",
  // reader
  "reader.thinking": "Pensando…",
  "reader.reading": "Leyendo el artículo…",
  // settings
  "settings.title": "Ajustes",
  "settings.dailyQuota": "Cuota diaria",
  "settings.topics": "Temas",
  "settings.contentTypes": "Tipos de contenido",
  "settings.kind.video": "Vídeos",
  "settings.kind.podcast": "Podcasts",
  "settings.kind.news": "Noticias",
  "settings.drift": "Sensibilidad de sesgo",
  "settings.driftSub":
    "Cuánto puedes alejarte del 50/50 antes de que te avisemos y reequilibremos el feed.",
  "settings.strict": "Estricto",
  "settings.balanced": "Equilibrado",
  "settings.relaxed": "Relajado",
  "settings.steer": "Orienta tu feed",
  "settings.steerSub":
    "Dile a la IA lo que te importa. Puntúa cada noticia según esto y muestra primero las coincidencias — el relleno de bajo interés (sucesos, crónica negra, cotilleos) siempre baja. Déjalo en blanco para ordenar por importancia general.",
  "settings.steerPlaceholder": "p. ej. IA y avances científicos relacionados con la IA",
  "settings.saveUpdate": "Guardar y actualizar feed",
  "settings.saved": "Guardado",
  "settings.clear": "Borrar",
  "settings.howBuilt": "Cómo se crea tu feed",
  "settings.howBuiltSub":
    "Un modelo de IA local lee cada noticia — y las transcripciones de YouTube — para etiquetar su tema, perspectiva y relevancia, y luego ordena por equilibrio y variedad. Se ejecuta en tu propia máquina; no se sube nada. El modelo tiene sus propios sesgos, así que trata sus etiquetas como una segunda opinión, no como una verdad absoluta.",
  "settings.language": "Idioma",
  "settings.languageSub":
    "Muestra la app — y los resúmenes de IA — en este idioma, aunque el artículo original esté escrito en otro.",
  "settings.data": "Datos",
  "settings.refreshNow": "Actualizar feed ahora",
  "settings.resetToday": "Restablecer el progreso de hoy",
  "settings.rerunOnboarding": "Repetir la introducción",
  "settings.eraseAll": "Borrar todos los datos locales",
  "settings.footnote": "Counterpoint v0.1 — tu feed, tu equilibrio, tu dispositivo.",
};

const DICTS: Record<Lang, Dict> = { en, es };

/** Translate `key` into `lang`, interpolating `{param}` placeholders. Falls back
 *  to English, then to the raw key, so a missing translation never crashes. */
export function translate(
  lang: Lang,
  key: string,
  params?: Record<string, string | number>,
): string {
  let s = DICTS[lang]?.[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}
