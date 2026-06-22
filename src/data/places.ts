// SHARED place gazetteer SEED + selectors. Single source of truth for both the
// server (relevance boost — see server/places.ts) and the client (Settings place
// picker), so the country/region ids they exchange always agree.
//
// This is a small hand-seeded fallback so the place lens works out of the box for
// the primary market (Spain). The GeoNames importer (scripts/buildGazetteer.ts)
// produces the full hierarchy and, when its src/data/gazetteer/<cc>.json is
// present, supersedes this seed (server-side). Country aliases are kept tight
// ("spain"/"españa") so the country node doesn't swallow every regional mention.

import type { PlaceNode } from "../types";

export const SEED_GAZETTEER: Record<string, PlaceNode[]> = {
  es: [
    { id: "es", level: "country", label: "Spain", country: "es", aliases: ["spain", "spanish", "españa", "espana"] },
    // Regions (Comunidades Autónomas) — a representative subset.
    { id: "es-madrid", parent: "es", level: "region", label: "Comunidad de Madrid", country: "es", aliases: ["comunidad de madrid", "madrileño", "madrilenos"] },
    { id: "es-cataluna", parent: "es", level: "region", label: "Cataluña", country: "es", aliases: ["cataluña", "catalunya", "cataluna", "catalan", "català"] },
    { id: "es-andalucia", parent: "es", level: "region", label: "Andalucía", country: "es", aliases: ["andalucía", "andalucia", "andaluz"] },
    { id: "es-pais-vasco", parent: "es", level: "region", label: "País Vasco", country: "es", aliases: ["país vasco", "pais vasco", "euskadi", "vasco"] },
    { id: "es-valencia", parent: "es", level: "region", label: "Comunidad Valenciana", country: "es", aliases: ["comunidad valenciana", "valenciana", "valencià"] },
    { id: "es-galicia", parent: "es", level: "region", label: "Galicia", country: "es", aliases: ["galicia", "gallego", "galego"] },
    // Major localities.
    { id: "es-madrid-madrid", parent: "es-madrid", level: "locality", label: "Madrid", country: "es", aliases: ["madrid"], population: 3223000 },
    { id: "es-cataluna-barcelona", parent: "es-cataluna", level: "locality", label: "Barcelona", country: "es", aliases: ["barcelona"], population: 1620000 },
    { id: "es-valencia-valencia", parent: "es-valencia", level: "locality", label: "Valencia", country: "es", aliases: ["valencia", "valència"], population: 800000 },
    { id: "es-andalucia-sevilla", parent: "es-andalucia", level: "locality", label: "Sevilla", country: "es", aliases: ["sevilla", "seville"], population: 688000 },
    { id: "es-pais-vasco-bilbao", parent: "es-pais-vasco", level: "locality", label: "Bilbao", country: "es", aliases: ["bilbao"], population: 346000 },
    { id: "es-andalucia-malaga", parent: "es-andalucia", level: "locality", label: "Málaga", country: "es", aliases: ["málaga", "malaga"], population: 578000 },
    { id: "es-madrid-mostoles", parent: "es-madrid", level: "locality", label: "Móstoles", country: "es", aliases: ["móstoles", "mostoles"], population: 207000 },
  ],
};

/** A country selectable in the place picker. */
export interface CountryOption {
  code: string;
  label: string;
}

/** Countries the SEED covers (those a picker can offer meaningful regions for). */
export function seededCountries(): CountryOption[] {
  return Object.keys(SEED_GAZETTEER).map((cc) => {
    const country = SEED_GAZETTEER[cc].find((n) => n.level === "country");
    return { code: cc, label: country?.label ?? cc.toUpperCase() };
  });
}

/** Region nodes for a country code (empty when unknown). */
export function regionsFor(country: string | undefined | null): PlaceNode[] {
  const cc = (country ?? "").toLowerCase();
  return (SEED_GAZETTEER[cc] ?? []).filter((n) => n.level === "region");
}
