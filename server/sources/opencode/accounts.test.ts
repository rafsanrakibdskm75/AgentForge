// OpenCode accounts: folder detection (isOpencodeHome / discoverOpencodeDirs), short/color assignment
// and host overrides from AGENTFORGE_ACCOUNTS. All fixtures live in os.tmpdir(): never real user files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import { tempDir } from '../../test/fixtures';
import { detectOpencodeAccounts, discoverOpencodeDirs, isOpencodeHome } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir('agentforge-opencode-acc-');
  cleanups.push(tmp.cleanup);
  /** OpenCode data folder named `name`, with the given markers. */
  const opencode = (name: string, markers: Array<'db' | 'storage' | 'projects'> = ['db']) => {
    const dir = join(tmp.dir, name);
    mkdirSync(dir, { recursive: true });
    if (markers.includes('db')) writeFileSync(join(dir, 'opencode.db'), '');
    if (markers.includes('storage')) mkdirSync(join(dir, 'storage'), { recursive: true });
    if (markers.includes('projects')) mkdirSync(join(dir, 'projects'), { recursive: true });
    return dir;
  };
  return { dir: tmp.dir, opencode };
}

describe('contas do OpenCode', () => {
  it('isOpencodeHome: opencode.db or storage/ count; projects/ (Claude) and empty dirs do not', () => {
    const h = home();
    expect(isOpencodeHome(h.opencode('with-db'))).toBe(true);
    expect(isOpencodeHome(h.opencode('with-storage', ['storage']))).toBe(true);
    mkdirSync(join(h.dir, 'empty'), { recursive: true });
    expect(isOpencodeHome(join(h.dir, 'empty'))).toBe(false);
    // A Claude home (projects/ subdir) is never an OpenCode home, even with OpenCode markers.
    expect(isOpencodeHome(h.opencode('claude', ['db', 'projects']))).toBe(false);
    // Missing dir: false, not a throw.
    expect(isOpencodeHome(join(h.dir, 'nope'))).toBe(false);
  });

  it('discoverOpencodeDirs: AGENTFORGE_OPENCODE_DIRS overrides; OPENCODE_DATA_DIR or the default otherwise', () => {
    const h = home();
    const main = h.opencode('opencode');
    const work = h.opencode('opencode-work');
    const plain = join(h.dir, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    // Explicit list wins: ~ expands, nonexistent filtered, no isOpencodeHome required.
    expect(
      discoverOpencodeDirs({ AGENTFORGE_OPENCODE_DIRS: `~/opencode, ${work}, ${plain}, /nao/existe` }, h.dir),
    ).toEqual([main, work, plain]);
    // OPENCODE_DATA_DIR changes the data folder (kept when it looks like an OpenCode home).
    expect(discoverOpencodeDirs({ OPENCODE_DATA_DIR: work }, h.dir)).toEqual([work]);
    // OPENCODE_DATA_DIR to a non-OpenCode dir: nothing.
    expect(discoverOpencodeDirs({ OPENCODE_DATA_DIR: plain }, h.dir)).toEqual([]);
    // Default: $HOME/.local/share/opencode.
    const def = join(h.dir, '.local', 'share', 'opencode');
    mkdirSync(def, { recursive: true });
    writeFileSync(join(def, 'opencode.db'), '');
    expect(discoverOpencodeDirs({}, h.dir)).toEqual([def]);
    // XDG_DATA_HOME moves the default.
    const xdg = join(h.dir, 'xdg', 'opencode');
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(xdg, 'opencode.db'), '');
    expect(discoverOpencodeDirs({ XDG_DATA_HOME: join(h.dir, 'xdg') }, h.dir)).toEqual([xdg]);
  });

  it('detectOpencodeAccounts: two dirs -> derived shorts, distinct colors, taken shorts/colors respected', () => {
    const h = home();
    const main = h.opencode('opencode');
    const work = h.opencode('opencode-work');
    const accs = detectOpencodeAccounts([main, work], { home: h.dir, env: {} });
    expect(accs.map((a) => [a.id, a.provider, a.short, a.name, a.configDir])).toEqual([
      ['opencode', 'opencode', 'O', 'OpenCode O', main],
      ['opencode-work', 'opencode', 'W', 'OpenCode W', work],
    ]);
    expect(accs.map((a) => a.color)).toEqual([ACCOUNT_COLORS[0], ACCOUNT_COLORS[1]]);
    // Taken shorts/colors are skipped: 'O' and 'W' taken -> 'C' and 'D'.
    const taken = detectOpencodeAccounts([main, work], {
      home: h.dir,
      env: {},
      taken: { shorts: ['O', 'W'], colors: [ACCOUNT_COLORS[0]] },
    });
    expect(taken.map((a) => a.short)).toEqual(['C', 'D']);
    expect(taken.map((a) => a.color)).toEqual([ACCOUNT_COLORS[1], ACCOUNT_COLORS[2]]);
    // One account: plain "OpenCode".
    expect(detectOpencodeAccounts([main], { home: h.dir, env: {} })[0]).toMatchObject({ short: 'O', name: 'OpenCode' });
  });

  it('Docker: host overrides (provider opencode) set id/name/short/color matched by mounted dir', () => {
    const h = home();
    const mounted = h.opencode('opencode');
    const work = h.opencode('opencode-work');
    const env = {
      AGENTFORGE_ACCOUNTS: JSON.stringify([
        { id: '.gemini', provider: 'gemini', configDir: '/Users/fulano/.muse', mountDir: '/gemini/.muse', short: 'G' },
        {
          id: 'work',
          provider: 'opencode',
          configDir: '/Users/fulano/.local/share/opencode-work',
          mountDir: work,
          short: 'OW',
          name: 'Work OpenCode',
          color: '#123456',
        },
      ]),
    };
    const accs = detectOpencodeAccounts([mounted, work], { home: '/nao/existe', env });
    // The gemini override is ignored by the opencode source.
    expect(accs[0]).toMatchObject({ id: 'opencode', provider: 'opencode', short: 'O', name: 'OpenCode O', configDir: mounted });
    expect(accs[1]).toEqual({
      id: 'work',
      provider: 'opencode',
      configDir: '/Users/fulano/.local/share/opencode-work',
      short: 'OW',
      name: 'Work OpenCode',
      color: '#123456',
    });
  });
});
