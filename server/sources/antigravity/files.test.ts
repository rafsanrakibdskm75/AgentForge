// Antigravity catalog reader (listConversations): fixture-based tests against temp SQLite
// databases built with node:sqlite. All fixtures live in os.tmpdir(): never real user files.
// The schema is UNVERIFIED (see files.ts), so the tests also pin the graceful-degradation paths:
// unknown tables/columns -> [] without throwing, row caps, timestamp normalization.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { defaultAntigravityDirs, isAntigravityHome, listConversations, looksLikeAntigravityDir, toEpochMs } from './files';

const SQLITE_OK = (() => {
  try {
    const req = createRequire(import.meta.url);
    return typeof (req('node:sqlite') as { DatabaseSync?: unknown }).DatabaseSync === 'function';
  } catch {
    return false;
  }
})();

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/** Antigravity home fixture named `name`, with conversation_summaries.db built by `build`. */
function antigravityHome(name: string, build?: (db: SqliteLike) => void): string {
  const tmp = tempDir('agentforge-antigravity-files-');
  cleanups.push(tmp.cleanup);
  const dir = join(tmp.dir, '.muse', name);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'conversation_summaries.db');
  writeFileSync(dbPath, '');
  if (build && SQLITE_OK) {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (p: string) => SqliteLike };
    const db = new DatabaseSync(dbPath);
    try {
      build(db);
    } finally {
      db.close();
    }
  }
  return dir;
}

interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): void };
  close(): void;
}

/** Plausible catalog schema (one of several layouts the reader must accept). */
function plausibleSchema(db: SqliteLike): void {
  db.exec(`CREATE TABLE conversation_summaries (
    id TEXT PRIMARY KEY, title TEXT, workspace TEXT, status TEXT,
    parent_id TEXT, created_at INTEGER, updated_at INTEGER
  )`);
  const ins = db.prepare(
    'INSERT INTO conversation_summaries (id, title, workspace, status, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  ins.run('conv-1', 'Refactor auth', '/home/u/proj-a', 'active', null, 1_700_000_000, 1_700_000_100);
  ins.run('conv-2', 'Fix login bug', '/home/u/proj-b', 'archived', 'conv-1', 1_700_000_050, 1_700_000_200);
  ins.run('conv-3', null, null, null, null, null, null);
}

describe('listConversations', () => {
  it.runIf(SQLITE_OK)('reads a plausible catalog schema, newest first, normalized to epoch ms', () => {
    const dir = antigravityHome('antigravity', plausibleSchema);
    expect(listConversations(dir)).toEqual([
      { id: 'conv-2', title: 'Fix login bug', workspace: '/home/u/proj-b', status: 'archived', parentId: 'conv-1', createdAt: 1_700_000_050_000, updatedAt: 1_700_000_200_000 },
      { id: 'conv-1', title: 'Refactor auth', workspace: '/home/u/proj-a', status: 'active', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 },
      { id: 'conv-3', createdAt: 0, updatedAt: 0 },
    ]);
  });

  it.runIf(SQLITE_OK)('accepts an alternative naming (camelCase columns, conversations table)', () => {
    const dir = antigravityHome('antigravity', (db) => {
      db.exec('CREATE TABLE conversations (sessionId TEXT, title TEXT, projectPath TEXT, updatedAt INTEGER)');
      db.prepare('INSERT INTO conversations (sessionId, title, projectPath, updatedAt) VALUES (?, ?, ?, ?)').run(
        'sess_abc',
        'Hello',
        '/tmp/x',
        1_700_000_000_000,
      );
    });
    expect(listConversations(dir)).toEqual([
      { id: 'sess_abc', title: 'Hello', workspace: '/tmp/x', createdAt: 0, updatedAt: 1_700_000_000_000 },
    ]);
  });

  it.runIf(SQLITE_OK)('unknown schema degrades to [] without throwing (no id column / unrelated tables)', () => {
    const noId = antigravityHome('antigravity', (db) => {
      db.exec('CREATE TABLE conversation_summaries (title TEXT, note TEXT)');
      db.prepare('INSERT INTO conversation_summaries (title, note) VALUES (?, ?)').run('x', 'y');
    });
    expect(listConversations(noId)).toEqual([]);
    const unrelated = antigravityHome('antigravity-ide', (db) => {
      db.exec('CREATE TABLE telemetry (id TEXT, payload TEXT)');
    });
    expect(listConversations(unrelated)).toEqual([]);
  });

  it.runIf(SQLITE_OK)('caps rows at 1000', () => {
    const dir = antigravityHome('antigravity', (db) => {
      db.exec('CREATE TABLE conversation_summaries (id TEXT, updated_at INTEGER)');
      const ins = db.prepare('INSERT INTO conversation_summaries (id, updated_at) VALUES (?, ?)');
      for (let i = 0; i < 1500; i++) ins.run(`conv-${i}`, 1_700_000_000 + i);
    });
    const rows = listConversations(dir);
    expect(rows.length).toBe(1000);
    // Newest first: the last inserted row (highest updated_at) comes first.
    expect(rows[0].id).toBe('conv-1499');
  });

  it.runIf(SQLITE_OK)('drops rows with unusable ids instead of failing', () => {
    const dir = antigravityHome('antigravity', (db) => {
      db.exec('CREATE TABLE conversation_summaries (id TEXT, updated_at INTEGER)');
      const ins = db.prepare('INSERT INTO conversation_summaries (id, updated_at) VALUES (?, ?)');
      ins.run('ok-1', 2);
      ins.run('../../etc/passwd', 3);
      ins.run('ok-2', 1);
    });
    expect(listConversations(dir).map((c) => c.id)).toEqual(['ok-1', 'ok-2']);
  });

  it('missing db or dir -> [] without throwing', () => {
    const tmp = tempDir('agentforge-antigravity-files-');
    cleanups.push(tmp.cleanup);
    const empty = join(tmp.dir, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(listConversations(empty)).toEqual([]);
    expect(listConversations(join(tmp.dir, 'nope'))).toEqual([]);
  });

  it.runIf(!SQLITE_OK)('without node:sqlite -> [] (graceful degradation)', () => {
    const tmp = tempDir('agentforge-antigravity-files-');
    cleanups.push(tmp.cleanup);
    expect(listConversations(tmp.dir)).toEqual([]);
  });
});

describe('toEpochMs', () => {
  it('accepts epoch ms, epoch seconds and ISO strings', () => {
    expect(toEpochMs(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs('2023-11-14T22:13:20.000Z')).toBe(Date.parse('2023-11-14T22:13:20.000Z'));
  });

  it('garbage becomes 0', () => {
    expect(toEpochMs(undefined)).toBe(0);
    expect(toEpochMs(null)).toBe(0);
    expect(toEpochMs('not-a-date')).toBe(0);
    expect(toEpochMs(42)).toBe(0);
  });
});

describe('home helpers', () => {
  it('looksLikeAntigravityDir / isAntigravityHome: db file counts, empty dirs do not', () => {
    const withDb = antigravityHome('antigravity');
    expect(looksLikeAntigravityDir(withDb)).toBe(true);
    expect(isAntigravityHome(withDb)).toBe(true);
    const tmp = tempDir('agentforge-antigravity-files-');
    cleanups.push(tmp.cleanup);
    const empty = join(tmp.dir, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(looksLikeAntigravityDir(empty)).toBe(false);
    expect(isAntigravityHome(empty)).toBe(false);
    expect(looksLikeAntigravityDir(join(tmp.dir, 'nope'))).toBe(false);
  });

  it('defaultAntigravityDirs: the three known candidates that exist', () => {
    const tmp = tempDir('agentforge-antigravity-home-');
    cleanups.push(tmp.cleanup);
    const dotGemini = join(tmp.dir, '.muse');
    mkdirSync(join(dotGemini, 'antigravity'), { recursive: true });
    mkdirSync(join(dotGemini, 'antigravity-cli'), { recursive: true });
    expect(defaultAntigravityDirs(tmp.dir)).toEqual([
      join(dotGemini, 'antigravity'),
      join(dotGemini, 'antigravity-cli'),
    ]);
    expect(defaultAntigravityDirs(join(tmp.dir, 'nope'))).toEqual([]);
  });
});
