// Fixture-based tests for the OpenCode history provider: listing (age window, no child
// sessions, newest first), titles, open sessions, and the safe resolve() paths.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeHistory } from './history';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const T0 = 1_760_000_000_000; // fixed "now"
const DAY = 24 * 3600_000;
const SES_NEW1 = 'ses_new1aaa';
const SES_NEW2 = 'ses_new2bbb';
const SES_CHILD = 'ses_childccc';
const SES_OLD = 'ses_oldddd';
const SES_ACC2 = 'ses_acc2eee';

const SCHEMA = `
CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
  time_created INTEGER, time_updated INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
`;

function addSession(db: DatabaseSync, id: string, o: { directory?: string; title?: string | null; parentId?: string; created: number; updated: number }) {
  db.prepare(
    `INSERT INTO session(id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'proj', o.parentId ?? null, o.directory ?? null, o.title ?? null, o.created, o.updated);
}

function addUserMessage(db: DatabaseSync, sessionId: string, msgId: string, text: string, time: number) {
  db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    msgId, sessionId, time, JSON.stringify({ role: 'user' }),
  );
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    `${msgId}-p`, msgId, sessionId, time, JSON.stringify({ type: 'text', text }),
  );
}

interface Homes {
  acc1: string;
  acc2: string;
}

function fixtureHomes(): Homes {
  const acc1 = tempDir('agentforge-opencode-hist-a1');
  const acc2 = tempDir('agentforge-opencode-hist-a2');
  const db1 = new DatabaseSync(join(acc1, 'opencode.db'));
  db1.exec(SCHEMA);
  addSession(db1, SES_NEW1, { directory: '/repo/a', title: 'New one', created: T0 - 200, updated: T0 - 100 });
  addSession(db1, SES_NEW2, { directory: '/repo/b', created: T0 - 300, updated: T0 - 50 });
  addSession(db1, SES_CHILD, { directory: '/repo/a', title: 'Forked', parentId: SES_NEW1, created: T0 - 20, updated: T0 - 10 });
  addSession(db1, SES_OLD, { directory: '/repo/old', title: 'Old', created: T0 - 11 * DAY, updated: T0 - 10 * DAY });
  addUserMessage(db1, SES_NEW2, 'm1', 'Fix the bug', T0 - 300);
  db1.close();
  const db2 = new DatabaseSync(join(acc2, 'opencode.db'));
  db2.exec(SCHEMA);
  addSession(db2, SES_ACC2, { directory: '/repo/c', title: 'Acc2 session', created: T0 - 160, updated: T0 - 80 });
  db2.close();
  return { acc1, acc2 };
}

function historyOf(homes: Homes, dataDir: string) {
  return new OpenCodeHistory({
    accounts: () => [
      { id: 'acc1', dir: homes.acc1 },
      { id: 'acc2', dir: homes.acc2 },
    ],
    openAgentOf: (acc, sid) => (sid === SES_NEW1 ? 'agent-1' : undefined),
    dataDir,
    now: () => T0,
  });
}

describe('OpenCodeHistory.list', () => {
  it('lists recent sessions newest-first, without children or stale ones', async () => {
    const homes = fixtureHomes();
    const list = await historyOf(homes, tempDir('agentforge-opencode-hist-data')).list();
    expect(list.map((s) => s.sessionId)).toEqual([SES_NEW2, SES_ACC2, SES_NEW1]);
    expect(list.every((s) => s.provider === 'opencode')).toBe(true);
    expect(list.every((s) => s.size === 0)).toBe(true);
  });

  it('maps project fields and titles, and marks open sessions', async () => {
    const homes = fixtureHomes();
    const list = await historyOf(homes, tempDir('agentforge-opencode-hist-data')).list();
    const byId = new Map(list.map((s) => [s.sessionId, s]));
    const titled = byId.get(SES_NEW1)!;
    expect(titled.project).toBe('/repo/a');
    expect(titled.projectDir).toBe('-repo-a');
    expect(titled.title).toBe('New one');
    expect(titled.open).toBe(true);
    expect(titled.agentId).toBe('agent-1');
    expect(titled.firstAt).toBe(T0 - 200);
    expect(titled.lastAt).toBe(T0 - 100);
    // No title on the row: the first user message becomes the title.
    expect(byId.get(SES_NEW2)!.title).toBe('Fix the bug');
    expect(byId.get(SES_ACC2)!.open).toBe(false);
  });

  it('honors a custom age window', async () => {
    const homes = fixtureHomes();
    const h = new OpenCodeHistory({
      accounts: () => [{ id: 'acc1', dir: homes.acc1 }],
      openAgentOf: () => undefined,
      dataDir: tempDir('agentforge-opencode-hist-data'),
      now: () => T0,
      maxAgeMs: 11 * DAY,
    });
    const ids = (await h.list()).map((s) => s.sessionId);
    expect(ids).toContain(SES_OLD);
  });
});

describe('OpenCodeHistory.resolve', () => {
  it('400 on a bad session id', () => {
    const homes = fixtureHomes();
    const h = historyOf(homes, tempDir('agentforge-opencode-hist-data'));
    expect(h.resolve('acc1', '../x')).toEqual({ status: 400, error: 'invalid session id' });
    expect(h.resolve('acc1', 'nope')).toEqual({ status: 400, error: 'invalid session id' });
  });

  it('404 on an unknown account', () => {
    const homes = fixtureHomes();
    const h = historyOf(homes, tempDir('agentforge-opencode-hist-data'));
    expect(h.resolve('nope', SES_NEW1)).toEqual({ status: 404, error: 'unknown account' });
  });

  it('404 on an unknown session', () => {
    const homes = fixtureHomes();
    const h = historyOf(homes, tempDir('agentforge-opencode-hist-data'));
    expect(h.resolve('acc1', 'ses_missing99')).toEqual({ status: 404, error: 'session not found' });
  });

  it('resolves a session to its materialized transcript, parseable by the bundled parser', () => {
    const homes = fixtureHomes();
    const h = historyOf(homes, tempDir('agentforge-opencode-hist-data'));
    const r = h.resolve('acc1', SES_NEW2);
    expect('path' in r && r.path.endsWith(`opencode-transcripts/${SES_NEW2}.txt`)).toBe(true);
    if (!('path' in r)) return;
    const parser = r.createParser();
    const entries = readFileSync(r.path, 'utf8')
      .split('\n')
      .flatMap((line: string) => parser.push(line));
    const user = entries.find((e) => e.kind === 'user');
    expect(user).toMatchObject({ kind: 'user', text: 'Fix the bug' });
  });

  it('hasAccount only for known accounts', () => {
    const homes = fixtureHomes();
    const h = historyOf(homes, tempDir('agentforge-opencode-hist-data'));
    expect(h.hasAccount('acc2')).toBe(true);
    expect(h.hasAccount('nope')).toBe(false);
  });
});
