// Interface languages: English and Bangla (বাংলা). Portuguese stays as the internal source language of the
// code: every string is written in PT and goes through tr(), which returns the translation for the active
// language or, if missing, the PT text itself. PT never appears in the UI because both dictionaries are
// complete — it only exists as the internal lookup key.
//
// Language choice (once, when this module loads):
// - browser: saved preference (Settings > Language), otherwise the browser's languages;
// - server: AGENTFORGE_LANG, otherwise the system language (LC_ALL / LC_MESSAGES / LANG / Intl) when it is
//   Bangla (see serverLocale).
// Activity texts are built by the server, so they follow the server language.
import { DICTIONARIES } from './locales/all';

export type Locale = 'en' | 'bn';

/** In selector order; each language's name is in its own language, for users who don't read the current one. */
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'bn', name: 'বাংলা' },
];

/** Key of the saved preference in the browser. */
export const LOCALE_STORAGE_KEY = 'agentforge:locale';

/** Available dictionaries. In the browser it starts empty: see registerDictionary. */
const DICTS: Partial<Record<Locale, Readonly<Record<string, string>>>> = { ...DICTIONARIES };

/** The browser loads only the active language's dictionary and registers it here before building the UI. */
export function registerDictionary(l: Locale, dict: Readonly<Record<string, string>>): void {
  DICTS[l] = dict;
}

/** "bn-BD", "bn_BD.UTF-8", "en-US", "en"... -> supported language; undefined for anything else. */
export function normalizeLocale(v: string | null | undefined): Locale | undefined {
  const s = (v ?? '').trim().toLowerCase().replace('_', '-');
  if (!s) return undefined;
  if (s === 'bn' || s.startsWith('bn-')) return 'bn';
  if (s === 'en' || s.startsWith('en-')) return 'en';
  return undefined;
}

/**
 * Server language (activities, notices, logs). AGENTFORGE_LANG wins for any language. From the system (LC_ALL,
 * LC_MESSAGES, LANG and, lastly, Intl) only Bangla counts: many machines and containers come in English by
 * default (en_US, or Node's en-US without LANG), even for users of another language, and the office would
 * switch language on its own. For the server in English: AGENTFORGE_LANG=en (or just leave it: en is default).
 */
export function serverLocale(env: Record<string, string | undefined>, intl?: string): Locale {
  const own = normalizeLocale(env.AGENTFORGE_LANG);
  if (own) return own;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG, intl]) {
    const n = normalizeLocale(v);
    if (n && n !== 'en') return n;
  }
  return 'en';
}

function detect(): Locale {
  const g = globalThis as {
    window?: unknown;
    localStorage?: { getItem(k: string): string | null };
    navigator?: { languages?: readonly string[]; language?: string };
    process?: { env?: Record<string, string | undefined> };
  };
  if (g.window !== undefined) {
    try {
      const saved = normalizeLocale(g.localStorage?.getItem(LOCALE_STORAGE_KEY));
      if (saved) return saved;
    } catch {
      // localStorage blocked (private mode, iframe): fall through to the browser's languages.
    }
    for (const l of g.navigator?.languages ?? [g.navigator?.language ?? '']) {
      const n = normalizeLocale(l);
      if (n) return n;
    }
    return 'en';
  }
  const env = g.process?.env ?? {};
  // Tests compare English texts: they stay in English whatever the machine's language.
  if (env.VITEST) return normalizeLocale(env.AGENTFORGE_LANG_TEST) ?? 'en';
  let intl: string | undefined;
  try {
    intl = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    intl = undefined;
  }
  return serverLocale(env, intl);
}

let current: Locale = detect();

export function getLocale(): Locale {
  return current;
}

/** Switches the active language (tests; in the browser, switching via the UI reloads the page). */
export function setLocale(l: Locale): void {
  current = l;
}

/**
 * Translates a string written in PT (the internal source language). Numbered gaps ({0}, {1}...) take `args`
 * in order; the translation may reorder them. Without a translation for the active language, returns the
 * original text.
 */
export function tr(src: string, args?: readonly unknown[]): string {
  const dict = DICTS[current];
  const s = (dict && dict[src]) || src;
  if (!args || args.length === 0) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Language in Intl format (dates, numbers). */
export function intlLocale(): string {
  return current === 'bn' ? 'bn-BD' : 'en-US';
}
