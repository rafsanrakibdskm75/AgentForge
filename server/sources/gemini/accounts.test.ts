// Gemini CLI accounts: folder detection (isGeminiHome / discoverGeminiDirs), short/color assignment
// and host overrides from AGENTFORGE_ACCOUNTS. All fixtures live in os.tmpdir(): never real user files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import { tempDir } from '../../test/fixtures';
import { detectGeminiAccounts, discoverGeminiDirs, isGeminiHome } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  /** Gemini folder named `name`, with the given markers. */
  const gemini = (name: string, markers: Array<'chats' | 'projects-json' | 'projects' | 'oauth'> = ['chats']) => {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    if (markers.includes('chats')) mkdirSync(join(dir, 'tmp', 'abc123', 'chats'), { recursive: true });
    if (markers.includes('projects-json')) writeFileSync(join(dir, 'projects.json'), JSON.stringify({ abc123: '/proj/a' }));
    if (markers.includes('projects')) mkdirSync(join(dir, 'projects'), { recursive: true });
    // Present but must never be opened: prove it by making it a directory (reading it would throw EISDIR).
    if (markers.includes('oauth')) mkdirSync(join(dir, 'oauth_creds.json'), { recursive: true });
    return dir;
  };
  return { dir: tmp.dir, gemini };
}

describe('contas do Gemini', () => {
  it('isGeminiHome: chats/ or projects.json count; projects/ (Claude) and empty dirs do not', () => {
    const h = home();
    expect(isGeminiHome(h.gemini('with-chats'))).toBe(true);
    expect(isGeminiHome(h.gemini('projects-only', ['projects-json']))).toBe(true);
    mkdirSync(join(h.dir, 'empty'), { recursive: true });
    expect(isGeminiHome(join(h.dir, 'empty'))).toBe(false);
    // A Claude home (projects/ subdir) is never a Gemini home, even with Gemini markers.
    expect(isGeminiHome(h.gemini('claude', ['chats', 'projects']))).toBe(false);
    // oauth_creds.json exists but isGeminiHome only checks existence: no throw, still a Gemini home.
    expect(() => isGeminiHome(h.gemini('with-creds', ['chats', 'oauth']))).not.toThrow();
    expect(isGeminiHome(h.gemini('with-creds', ['chats', 'oauth']))).toBe(true);
    // Missing dir: false, not a throw.
    expect(isGeminiHome(join(h.dir, 'nope'))).toBe(false);
  });

  it('discoverGeminiDirs: AGENTFORGE_GEMINI_DIRS overrides; default and .gemini* variants otherwise', () => {
    const h = home();
    const main = h.gemini('.gemini');
    const alpha = h.gemini('.gemini-alpha');
    const work = h.gemini('.gemini-work');
    h.gemini('.gemini-empty', []);
    mkdirSync(join(h.dir, '.claude', 'projects'), { recursive: true });
    // Default first, then alphabetical.
    expect(discoverGeminiDirs({}, h.dir)).toEqual([main, alpha, work]);
    // Explicit list wins: ~ expands, nonexistent filtered, no isGeminiHome required.
    const plain = join(h.dir, 'plain-dir');
    mkdirSync(plain);
    expect(discoverGeminiDirs({ AGENTFORGE_GEMINI_DIRS: `~/.gemini-empty, ${work}, ${plain}, /nao/existe` }, h.dir)).toEqual([
      join(h.dir, '.gemini-empty'),
      work,
      plain,
    ]);
    // GEMINI_HOME changes the default folder.
    expect(discoverGeminiDirs({ GEMINI_HOME: work }, h.dir)).toEqual([work, main, alpha]);
  });

  it('detectGeminiAccounts: two dirs -> derived shorts, distinct colors, taken shorts/colors respected', () => {
    const h = home();
    const main = h.gemini('.gemini');
    const work = h.gemini('.gemini-work');
    const accs = detectGeminiAccounts([main, work], { home: h.dir, env: {} });
    expect(accs.map((a) => [a.id, a.provider, a.short, a.name, a.configDir])).toEqual([
      ['.gemini', 'gemini', 'G', 'Gemini G', main],
      ['.gemini-work', 'gemini', 'W', 'Gemini W', work],
    ]);
    expect(accs.map((a) => a.color)).toEqual([ACCOUNT_COLORS[0], ACCOUNT_COLORS[1]]);
    // Taken shorts/colors are skipped: 'G' and 'W' taken -> 'H' and 'J'.
    const taken = detectGeminiAccounts([main, work], {
      home: h.dir,
      env: {},
      taken: { shorts: ['G', 'W'], colors: [ACCOUNT_COLORS[0]] },
    });
    expect(taken.map((a) => a.short)).toEqual(['H', 'J']);
    expect(taken.map((a) => a.color)).toEqual([ACCOUNT_COLORS[1], ACCOUNT_COLORS[2]]);
    // One account: plain "Gemini".
    expect(detectGeminiAccounts([main], { home: h.dir, env: {} })[0]).toMatchObject({ short: 'G', name: 'Gemini' });
  });

  it('Docker: host overrides (provider gemini) set id/name/short/color matched by mounted dir', () => {
    const h = home();
    const mounted = h.gemini('.gemini');
    const work = h.gemini('.gemini-work');
    const env = {
      AGENTFORGE_ACCOUNTS: JSON.stringify([
        { id: '.codex', provider: 'codex', configDir: '/Users/fulano/.codex', mountDir: '/codex/.codex', short: 'CX' },
        {
          id: 'work',
          provider: 'gemini',
          configDir: '/Users/fulano/.gemini-work',
          mountDir: work,
          short: 'GW',
          name: 'Work Gemini',
          color: '#123456',
        },
      ]),
    };
    const accs = detectGeminiAccounts([mounted, work], { home: '/nao/existe', env });
    // The codex override is ignored by the gemini source.
    expect(accs[0]).toMatchObject({ id: '.gemini', provider: 'gemini', short: 'G', name: 'Gemini G', configDir: mounted });
    expect(accs[1]).toEqual({ id: 'work', provider: 'gemini', configDir: '/Users/fulano/.gemini-work', short: 'GW', name: 'Work Gemini', color: '#123456' });
  });
});
