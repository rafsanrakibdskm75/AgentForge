import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, intlLocale, normalizeLocale, serverLocale, setLocale, tr } from './i18n';
import { BN } from './locales/bn';
import { EN } from './locales/en';

const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);

describe('i18n', () => {
  afterEach(() => setLocale('en'));

  it('tests run in English, whatever the machine language', () => {
    expect(getLocale()).toBe('en');
  });

  it('recognizes browser and system language formats', () => {
    expect(normalizeLocale('bn')).toBe('bn');
    expect(normalizeLocale('bn-BD')).toBe('bn');
    expect(normalizeLocale('bn_BD.UTF-8')).toBe('bn');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('en_US.UTF-8')).toBe('en');
    expect(normalizeLocale('pt-BR')).toBeUndefined();
    expect(normalizeLocale('es')).toBeUndefined();
    expect(normalizeLocale('fr')).toBeUndefined();
    expect(normalizeLocale('de-DE')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });

  it('in English translates and fills the gaps', () => {
    expect(tr('Lendo {0}', ['app.ts'])).toBe('Reading app.ts');
    expect(tr('Texto que ninguém traduziu')).toBe('Texto que ninguém traduziu');
  });

  it('in Bangla translates, fills the gaps and uses the Bangla date format', () => {
    setLocale('bn');
    const out = tr('Lendo {0}', ['app.ts']);
    expect(out).toContain('app.ts');
    expect(out).not.toBe('Lendo {0}');
    expect(out).not.toContain('{0}');
    expect(tr('Texto que ninguém traduziu')).toBe('Texto que ninguém traduziu');
    expect(intlLocale()).toBe('bn-BD');
  });

  it('gaps without arguments stay as they are (named ones are filled by the caller)', () => {
    expect(tr('Ganhei de {a} a {b}! 🏆')).toBe('I won {a} to {b}! 🏆');
    expect(tr('{0} e {1}', ['um'])).toBe('um and {1}');
  });

  it('server: AGENTFORGE_LANG wins for any language; from the system, only Bangla counts', () => {
    expect(serverLocale({ AGENTFORGE_LANG: 'en' }, 'pt-BR')).toBe('en');
    expect(serverLocale({ AGENTFORGE_LANG: 'bn', LANG: 'en_US.UTF-8' })).toBe('bn');
    // Machine with LANG in English and container without LANG (Intl en-US): the office stays in English.
    expect(serverLocale({ LANG: 'en_US.UTF-8' }, 'en-US')).toBe('en');
    expect(serverLocale({}, 'en-US')).toBe('en');
    expect(serverLocale({ LANG: 'bn_BD.UTF-8' })).toBe('bn');
    expect(serverLocale({ LC_ALL: 'bn_BD.UTF-8', LANG: 'en_US.UTF-8' })).toBe('bn');
    expect(serverLocale({}, 'bn-BD')).toBe('bn');
  });

  it('English uses the US date format', () => {
    setLocale('en');
    expect(intlLocale()).toBe('en-US');
  });

  it('no translation is empty nor loses or invents gaps', () => {
    for (const [lang, dict] of Object.entries({ en: EN, bn: BN })) {
      for (const [pt, t] of Object.entries(dict)) {
        expect(t.trim(), `${lang}: ${pt}`).not.toBe('');
        const original = placeholders(pt);
        for (const p of placeholders(t)) expect(original.has(p), `${lang}: ${pt} -> ${t}`).toBe(true);
        for (const p of original) expect(placeholders(t).has(p), `${lang}: ${pt} -> ${t}`).toBe(true);
      }
    }
  });
});
