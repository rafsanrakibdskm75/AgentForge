// Client entry point: first the active language's dictionary (only it ships to the browser), then the app
// (client/src/app.ts), because several modules call tr() while loading. If the dictionary fails to load,
// the UI stays in English.
import { getLocale, registerDictionary, type Locale } from '../../shared/i18n';

const LOADERS: Partial<Record<Locale, () => Promise<Readonly<Record<string, string>>>>> = {
  en: () => import('../../shared/locales/en').then((m) => m.EN),
  bn: () => import('../../shared/locales/bn').then((m) => m.BN),
};

const locale = getLocale();
const load = LOADERS[locale];
const dictionary = load ? load().then((d) => registerDictionary(locale, d)).catch(() => undefined) : Promise.resolve();
void dictionary.then(() => import('./app')).then((app) => app.start());
