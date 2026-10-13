// All dictionaries at once: the server, the scripts and the tests use this module. In the browser,
// vite.config.ts swaps it for locales/none.ts, and the client loads only the active language's dictionary
// (client/src/main.ts).
import type { Locale } from '../i18n';
import { BN } from './bn';
import { EN } from './en';

export const DICTIONARIES: Partial<Record<Locale, Readonly<Record<string, string>>>> = { en: EN, bn: BN };
