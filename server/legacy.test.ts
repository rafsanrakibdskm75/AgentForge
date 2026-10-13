import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeStateMigration, legacyEnvVars, legacyEnvWarning, migrateLegacyStateDir } from './legacy';
import { tempDir } from './test/fixtures';

describe('legacy name variables', () => {
  it('lists only the CODETOWN_*, with the new name, in order', () => {
    expect(legacyEnvVars(['PATH', 'CODETOWN_PORT', 'AGENTFORGE_BIND', 'CODETOWN_BIND'])).toEqual([
      { from: 'CODETOWN_BIND', to: 'AGENTFORGE_BIND' },
      { from: 'CODETOWN_PORT', to: 'AGENTFORGE_PORT' },
    ]);
  });

  it('also catches HABBLAUD_*', () => {
    expect(legacyEnvVars(['HABBLAUD_PORT', 'PATH'])).toEqual([{ from: 'HABBLAUD_PORT', to: 'AGENTFORGE_PORT' }]);
  });

  it('warns only when there is one', () => {
    expect(legacyEnvWarning(['PATH', 'AGENTFORGE_PORT'])).toBeUndefined();
    expect(legacyEnvWarning(['CODETOWN_PORT'], 'no .env')).toBe(
      'old-name variable ignored no .env: CODETOWN_PORT → AGENTFORGE_PORT. Rename to re-enable.',
    );
  });
});

describe('migrateLegacyStateDir', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  const write = (rel: string, text: string) => {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), text);
  };
  const read = (rel: string) => readFileSync(join(home, rel), 'utf8');

  beforeEach(() => {
    tmp = tempDir('agentforge-legacy-');
    home = tmp.dir;
  });
  afterEach(() => tmp.cleanup());

  it('without the old folder, does nothing', () => {
    expect(migrateLegacyStateDir(home)).toEqual({ moved: [] });
    expect(existsSync(join(home, '.agentforge'))).toBe(false);
  });

  it('without the new folder, renames the old one entirely', () => {
    write('.codetown/names.json', '{"a":"Marina"}');
    write('.codetown/usage/.claude.json', '{}');
    const r = migrateLegacyStateDir(home);
    expect(r).toEqual({ moved: ['.'], from: 'codetown' });
    expect(read('.agentforge/names.json')).toBe('{"a":"Marina"}');
    expect(existsSync(join(home, '.agentforge/usage/.claude.json'))).toBe(true);
    expect(existsSync(join(home, '.codetown'))).toBe(false);
    expect(describeStateMigration(r)).toBe('~/.codetown (old name) is now ~/.agentforge.');
  });

  it('migrates ~/.habblaud too (0.10.0)', () => {
    write('.habblaud/names.json', '{"b":"Rafa"}');
    const r = migrateLegacyStateDir(home);
    expect(r).toEqual({ moved: ['.'], from: 'habblaud' });
    expect(read('.agentforge/names.json')).toBe('{"b":"Rafa"}');
    expect(existsSync(join(home, '.habblaud'))).toBe(false);
    expect(describeStateMigration(r)).toBe('~/.habblaud (old name) is now ~/.agentforge.');
  });

  it('with the new folder already created, moves what is missing and, for files on both sides, keeps the most recent', () => {
    const at = (rel: string, minutes: number) => {
      const t = new Date(2026, 9, 8, 18, minutes);
      utimesSync(join(home, rel), t, t);
    };
    write('.codetown/names.json', 'antigo');
    write('.codetown/usage/.claude.json', 'antigo');
    write('.codetown/usage/.claude-conta2.json', 'antigo, mas mais recente');
    write('.agentforge/usage/.claude.json', 'novo');
    write('.agentforge/usage/.claude-conta2.json', 'novo, mas parado');
    at('.codetown/usage/.claude.json', 10);
    at('.agentforge/usage/.claude.json', 20);
    at('.codetown/usage/.claude-conta2.json', 30);
    at('.agentforge/usage/.claude-conta2.json', 20);
    const r = migrateLegacyStateDir(home);
    expect(r.moved.sort()).toEqual(['names.json', 'usage/.claude-conta2.json']);
    expect(read('.agentforge/names.json')).toBe('antigo');
    expect(read('.agentforge/usage/.claude.json')).toBe('novo');
    expect(read('.agentforge/usage/.claude-conta2.json')).toBe('antigo, mas mais recente');
    // O que perdeu para um arquivo mais novo fica na pasta antiga, que então não some.
    expect(read('.codetown/usage/.claude.json')).toBe('antigo');
    expect(describeStateMigration(r)).toContain('names.json, usage/.claude-conta2.json');
  });

  it('old folder with nothing missing: disappears', () => {
    mkdirSync(join(home, '.codetown'));
    mkdirSync(join(home, '.agentforge'));
    expect(migrateLegacyStateDir(home)).toEqual({ moved: [], from: 'codetown' });
    expect(existsSync(join(home, '.codetown'))).toBe(false);
  });

  it("doesn't throw: returns the error (e.g.: ~/.agentforge is a file)", () => {
    write('.codetown/names.json', '{}');
    write('.agentforge', 'arquivo');
    const r = migrateLegacyStateDir(home);
    expect(r).toEqual({ moved: [], error: `${join(home, '.agentforge')} exists and isn't a folder`, from: 'codetown' });
    expect(existsSync(join(home, '.codetown/names.json'))).toBe(true);
    expect(describeStateMigration(r)).toMatch(/^couldn't move ~\/\.codetown to ~\/\.agentforge/);
  });
});
