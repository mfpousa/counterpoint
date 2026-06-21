// Server-side language helper. The client sends a `lang` param; the model is
// then instructed to write its answer in that language regardless of the source
// article's language. English is the default and adds no instruction.

import type { Lang } from "../src/types";

const NAMES: Record<Lang, string> = { en: "English", es: "Spanish" };

/** Coerce an untrusted query/body value into a supported Lang (defaults en). */
export function readLang(raw: unknown): Lang {
  return raw === "es" ? "es" : "en";
}

/**
 * A system-prompt suffix telling the model to respond entirely in `lang`. Empty
 * for English. Appended to the existing rules so JSON-shape instructions still
 * apply — only the natural-language text is translated.
 */
export function langDirective(lang: Lang): string {
  if (lang === "en") return "";
  const name = NAMES[lang] ?? "English";
  return (
    `\nLANGUAGE: Write ALL natural-language text in your response in ${name}, ` +
    `regardless of the language of the source material (translate it faithfully). ` +
    `Keep proper nouns, names and JSON keys unchanged.`
  );
}
