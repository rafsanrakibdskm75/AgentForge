// Antigravity accounts: folder detection (isAntigravityHome / discoverAntigravityDirs), short/color
// assignment and host overrides from AGENTFORGE_ACCOUNTS. All fixtures live in os.tmpdir(): never
// real user files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import { tempDir } from '../../test/fixtures';
import { detectAntigravityAccounts, discoverAntigravityDirs, isAntigravityHome } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir('agentforge-antigravity-acc-');
  cleanups.push(tmp.cleanup);
  /** Antigravity home named `name` (under .Gemini/), with the given markers. */
  const antigravity = (name: string, markers: Array<'db' | 'projects'> = ['db']) => {
    const dir = join(tmp.dir, '.muse', name);
    mkdirSync(dir, { recursive: true });
    if (markers.includes('db')) writeFileSync(join(dir, 'conversation_summaries.db'), '');
    if (markers.includes('projects')) mkdirSync(join(dir, 'projects'), { recursive: true });
    return dir;
  };
  return { dir: tmp.dir, antigravity };
}

describe('isAntigravityHome', () => {
  it('conversation_summaries.db counts; empty dirs do not', () => {
    const h = home();
    expect(isAntigravityHome(h.antigravity('antigravity'))).toBe(true);
    const empty = join(h.dir, '.muse', 'empty');
    mkdirSync(empty, { recursive: true });
    expect(isAntigravityHome(empty)).toBe(false);
    // Missing dir: false, not a throw.
    expect(isAntigravityHome(join(h.dir, '.muse', 'nope'))).toBe(false);
  });

  it('a Claude home (projects/ subdir) is never an Antigravity home, even with the db present', () => {
    const h = home();
    expect(isAntigravityHome(h.antigravity('antigravity', ['db', 'projects']))).toBe(false);
  });
});

describe('discoverAntigravityDirs', () => {
  it('AGENTFORGE_ANTIGRAVITY_DIRS overrides: ~ expands, nonexistent filtered, layout check skipped', () => {
    const h = home();
    const main = h.antigravity('antigravity');
    const plain = join(h.dir, 'plain-dir');
    mkdirSync(plain, { recursive: true });
    expect(discoverAntigravityDirs({ AGENTFORGE_ANTIGRAVITY_DIRS: `~/.muse/antigravity, ${plain}, /nao/existe` }, h.dir)).toEqual([
      main,
      plain,
    ]);
  });

  it('discovers the known candidates plus any other antigravity* folder under ~/.muse', () => {
    const h = home();
    const main = h.antigravity('antigravity');
    const cli = h.antigravity('antigravity-cli');
    const custom = h.antigravity('antigravity-backup');
    // A lookalike without the catalog db is ignored.
    h.antigravity('antigravity-empty', []);
    expect(discoverAntigravityDirs({}, h.dir)).toEqual([main, cli, custom]);
  });

  it('nothing discovered -> []', () => {
    const h = home();
    expect(discoverAntigravityDirs({}, h.dir)).toEqual([]);
  });
});

describe('detectAntigravityAccounts', () => {
  it('one dir -> short A, name "Antigravity", first palette color', () => {
    const h = home();
    const main = h.antigravity('antigravity');
    const accs = detectAntigravityAccounts([main], { home: h.dir, env: {} });
    expect(accs.map((a) => [a.id, a.provider, a.short, a.name, a.configDir])).toEqual([
      ['antigravity', 'antigravity', 'A', 'Antigravity', main],
    ]);
    expect(accs[0].color).toBe(ACCOUNT_COLORS[0]);
  });

  it('two dirs -> suffix letter for the second, distinct colors, "Antigravity X" names', () => {
    const h = home();
    const main = h.antigravity('antigravity');
    const work = h.antigravity('antigravity-work');
    const accs = detectAntigravityAccounts([main, work], { home: h.dir, env: {} });
    expect(accs.map((a) => [a.id, a.provider, a.short, a.name, a.configDir])).toEqual([
      ['antigravity', 'antigravity', 'A', 'Antigravity A', main],
      ['antigravity-work', 'antigravity', 'W', 'Antigravity W', work],
    ]);
    expect(accs.map((a) => a.color)).toEqual([ACCOUNT_COLORS[0], ACCOUNT_COLORS[1]]);
    // Taken shorts/colors are skipped.
    const accs2 = detectAntigravityAccounts([main], { home: h.dir, env: {}, taken: { shorts: ['A'], colors: [ACCOUNT_COLORS[0]] } });
    expect(accs2[0].short).toBe('G');
    expect(accs2[0].color).toBe(ACCOUNT_COLORS[1]);
  });

  it('AGENTFORGE_ACCOUNTS overrides rename and recolor', () => {
    const h = home();
    const main = h.antigravity('antigravity');
    const env = {
      AGENTFORGE_ACCOUNTS: JSON.stringify([
        { provider: 'antigravity', configDir: main, id: 'ag-main', name: 'Meu AG', short: 'MG', color: '#123456' },
      ]),
    };
    const accs = detectAntigravityAccounts([main], { home: h.dir, env });
    expect(accs.map((a) => [a.id, a.short, a.name, a.color, a.configDir])).toEqual([
      ['ag-main', 'MG', 'Meu AG', '#123456', main],
    ]);
  });
});
