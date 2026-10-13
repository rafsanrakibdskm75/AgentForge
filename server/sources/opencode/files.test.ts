// Fixture-based tests for the OpenCode read layer. Every test builds a real SQLite
// database with the OpenCode-like schema (sessions, messages, parts, todos) inside a
// temporary directory, so no real OpenCode install is needed.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultOpencodeDataDir,
  listSessions,
  looksLikeOpencodeDir,
  readSessionMessages,
  readSessionParts,
  readSessionTodos,
} from './files';

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

const T0 = 1_760_000_000_000; // fixed clock so ordering is deterministic

const SCHEMA = `
CREATE TABLE session(
  id TEXT PRIMARY KEY,
  project_id TEXT,
  parent_id TEXT,
  slug TEXT,
  directory TEXT,
  title TEXT,
  version TEXT,
  agent TEXT,
  model TEXT,
  cost REAL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  time_created INTEGER,
  time_updated INTEGER,
  time_compacting INTEGER,
  time_archived INTEGER
);
CREATE TABLE message(
  id TEXT PRIMARY KEY,
  session_id TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  data TEXT
);
CREATE TABLE part(
  id TEXT PRIMARY KEY,
  message_id TEXT,
  session_id TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  data TEXT
);
CREATE TABLE todo(
  session_id TEXT,
  content TEXT,
  status TEXT,
  priority TEXT,
  position INTEGER,
  PRIMARY KEY (session_id, position)
);
`;

const SES_MAIN_OLD = 'ses_mainold123';
const SES_MAIN_NEW = 'ses_mainnew456';
const SES_CHILD = 'ses_child789';

interface FixtureHome {
  dir: string;
  db: string;
}

/** Builds a data dir with a WAL-mode opencode.db holding the fixture rows; writer stays open. */
function fixtureHome(): FixtureHome & { close: () => void } {
  const dir = tempDir('agentforge-opencode');
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO session(id, project_id, parent_id, directory, title, cost, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(SES_MAIN_OLD, 'proj-1', null, '/repo/old', 'Old session', 0.12, 1000, 500, 200, 300, 100, T0 - 2000, T0 - 2000);
  db.prepare(
    `INSERT INTO session(id, project_id, parent_id, directory, title, cost, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(SES_MAIN_NEW, 'proj-2', null, '/repo/new', 'New session', 1.5, 8000, 4000, 900, 1200, 600, T0 - 1000, T0 - 100);
  db.prepare(
    `INSERT INTO session(id, project_id, parent_id, directory, title, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(SES_CHILD, 'proj-2', SES_MAIN_NEW, '/repo/new', 'Forked work', T0 - 500, T0 - 50);
  // User message + assistant message on the new session.
  db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    'msg_u1',
    SES_MAIN_NEW,
    T0 - 900,
    JSON.stringify({ role: 'user', time: { created: T0 - 900 } }),
  );
  db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    'msg_a1',
    SES_MAIN_NEW,
    T0 - 800,
    JSON.stringify({ role: 'assistant', modelID: 'm1', providerID: 'p1', time: { created: T0 - 800 } }),
  );
  // A system-ish message that must be skipped.
  db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    'msg_x1',
    SES_MAIN_NEW,
    T0 - 850,
    JSON.stringify({ role: 'summary', time: { created: T0 - 850 } }),
  );
  // Text parts for both messages.
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_t1',
    'msg_u1',
    SES_MAIN_NEW,
    T0 - 900,
    JSON.stringify({ type: 'text', text: 'Add retries to the uploader' }),
  );
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_t2',
    'msg_a1',
    SES_MAIN_NEW,
    T0 - 800,
    JSON.stringify({ type: 'text', text: 'On it.' }),
  );
  // A successful tool call.
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_tool1',
    'msg_a1',
    SES_MAIN_NEW,
    T0 - 700,
    JSON.stringify({
      type: 'tool',
      tool: 'read',
      callID: 'call_1',
      state: {
        status: 'completed',
        input: { filePath: '/repo/new/src/app.ts' },
        output: 'const x = 1;',
        time: { start: T0 - 700, end: T0 - 690 },
      },
    }),
  );
  // A failed tool call (message carried in state.error, no output).
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_tool2',
    'msg_a1',
    SES_MAIN_NEW,
    T0 - 600,
    JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: 'call_2',
      state: {
        status: 'error',
        input: { command: 'make deploy' },
        error: 'make: *** No rule to make target',
        time: { start: T0 - 600, end: T0 - 590 },
      },
    }),
  );
  // A step-finish marker: not a tool call, must be excluded from parts.
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_step1',
    'msg_a1',
    SES_MAIN_NEW,
    T0 - 595,
    JSON.stringify({ type: 'step-finish', reason: 'stop' }),
  );
  // Todos for the new session (inserted out of position order on purpose).
  db.prepare(`INSERT INTO todo(session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)`).run(
    SES_MAIN_NEW,
    'Write tests',
    'in_progress',
    'high',
    1,
  );
  db.prepare(`INSERT INTO todo(session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)`).run(
    SES_MAIN_NEW,
    'Sketch plan',
    'completed',
    'medium',
    0,
  );
  db.prepare(`INSERT INTO todo(session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)`).run(
    SES_MAIN_NEW,
    'Ship it',
    'pending',
    null,
    2,
  );
  return { dir, db: dbPath, close: () => db.close() };
}

describe('defaultOpencodeDataDir', () => {
  it('uses XDG_DATA_HOME when set', () => {
    expect(defaultOpencodeDataDir({ XDG_DATA_HOME: '/xdg/data' }, '/home/u')).toBe(join('/xdg/data', 'opencode'));
  });

  it('falls back to ~/.local/share/opencode when XDG is missing or blank', () => {
    expect(defaultOpencodeDataDir({}, '/home/u')).toBe(join('/home/u', '.local', 'share', 'opencode'));
    expect(defaultOpencodeDataDir({ XDG_DATA_HOME: '   ' }, '/home/u')).toBe(
      join('/home/u', '.local', 'share', 'opencode'),
    );
  });
});

describe('looksLikeOpencodeDir', () => {
  it('true when opencode.db exists', () => {
    const fx = fixtureHome();
    try {
      expect(looksLikeOpencodeDir(fx.dir)).toBe(true);
    } finally {
      fx.close();
    }
  });

  it('true when only a storage/ directory exists', () => {
    const dir = tempDir('agentforge-opencode-empty');
    mkdirSync(join(dir, 'storage'), { recursive: true });
    expect(looksLikeOpencodeDir(dir)).toBe(true);
  });

  it('false for an empty or missing directory', () => {
    const dir = tempDir('agentforge-opencode-empty2');
    expect(looksLikeOpencodeDir(dir)).toBe(false);
    expect(looksLikeOpencodeDir(join(dir, 'nope'))).toBe(false);
  });
});

describe('listSessions', () => {
  it('returns sessions newest first with tokens and cost mapped', () => {
    const fx = fixtureHome();
    try {
      const sessions = listSessions(fx.dir);
      expect(sessions.map((s) => s.id)).toEqual([SES_CHILD, SES_MAIN_NEW, SES_MAIN_OLD]);
      const newest = sessions[1];
      expect(newest.directory).toBe('/repo/new');
      expect(newest.title).toBe('New session');
      expect(newest.projectId).toBe('proj-2');
      expect(newest.cost).toBe(1.5);
      expect(newest.tokens).toEqual({ input: 8000, output: 4000, cache: 1800 });
      expect(newest.createdAt).toBe(T0 - 1000);
      expect(newest.updatedAt).toBe(T0 - 100);
    } finally {
      fx.close();
    }
  });

  it('exposes parentId for child sessions', () => {
    const fx = fixtureHome();
    try {
      const child = listSessions(fx.dir).find((s) => s.id === SES_CHILD)!;
      expect(child.parentId).toBe(SES_MAIN_NEW);
      expect(child.tokens).toBeUndefined();
    } finally {
      fx.close();
    }
  });

  it('reads while the writer connection is still open (WAL mode)', () => {
    const fx = fixtureHome();
    try {
      expect(listSessions(fx.dir)).toHaveLength(3);
    } finally {
      fx.close();
    }
  });

  it('returns [] for a missing directory, a corrupt database, or missing tables', () => {
    expect(listSessions(join(tmpdir(), 'agentforge-opencode-missing-dir'))).toEqual([]);

    const corrupt = tempDir('agentforge-opencode-corrupt');
    writeFileSync(join(corrupt, 'opencode.db'), 'this is not a database');
    expect(listSessions(corrupt)).toEqual([]);

    const noTables = tempDir('agentforge-opencode-notables');
    const db = new DatabaseSync(join(noTables, 'opencode.db'));
    db.exec('CREATE TABLE other(x TEXT);');
    db.close();
    expect(listSessions(noTables)).toEqual([]);
  });
});

describe('readSessionMessages', () => {
  it('returns user and assistant messages in chronological order with text from text parts', () => {
    const fx = fixtureHome();
    try {
      const msgs = readSessionMessages(fx.dir, SES_MAIN_NEW);
      expect(msgs.map((m) => m.id)).toEqual(['msg_u1', 'msg_a1']);
      expect(msgs[0]).toMatchObject({
        sessionId: SES_MAIN_NEW,
        role: 'user',
        text: 'Add retries to the uploader',
        time: T0 - 900,
      });
      expect(msgs[1]).toMatchObject({ role: 'assistant', text: 'On it.' });
    } finally {
      fx.close();
    }
  });

  it('returns [] for an unknown session, an invalid id, or a broken database', () => {
    const fx = fixtureHome();
    try {
      expect(readSessionMessages(fx.dir, 'ses_doesnotexist')).toEqual([]);
      expect(readSessionMessages(fx.dir, '../../etc/passwd')).toEqual([]);
      expect(readSessionMessages(fx.dir, '')).toEqual([]);
      const noTables = tempDir('agentforge-opencode-notables2');
      const db = new DatabaseSync(join(noTables, 'opencode.db'));
      db.exec('CREATE TABLE other(x TEXT);');
      db.close();
      expect(readSessionMessages(noTables, SES_MAIN_NEW)).toEqual([]);
    } finally {
      fx.close();
    }
  });
});

describe('readSessionParts', () => {
  it('maps tool calls in order, with input/output/status; failed calls use state.error', () => {
    const fx = fixtureHome();
    try {
      const parts = readSessionParts(fx.dir, SES_MAIN_NEW);
      expect(parts.map((p) => p.id)).toEqual(['prt_tool1', 'prt_tool2']);
      expect(parts[0]).toMatchObject({
        sessionId: SES_MAIN_NEW,
        messageId: 'msg_a1',
        tool: 'read',
        input: { filePath: '/repo/new/src/app.ts' },
        output: 'const x = 1;',
        status: 'completed',
        time: T0 - 700,
      });
      expect(parts[1]).toMatchObject({
        tool: 'bash',
        output: 'make: *** No rule to make target',
        status: 'error',
      });
    } finally {
      fx.close();
    }
  });

  it('returns [] for unknown or invalid session ids', () => {
    const fx = fixtureHome();
    try {
      expect(readSessionParts(fx.dir, 'ses_nope')).toEqual([]);
      expect(readSessionParts(fx.dir, 'not a valid id!')).toEqual([]);
    } finally {
      fx.close();
    }
  });
});

describe('readSessionTodos', () => {
  it('returns todos ordered by position with status and priority', () => {
    const fx = fixtureHome();
    try {
      const todos = readSessionTodos(fx.dir, SES_MAIN_NEW);
      expect(todos).toEqual([
        { content: 'Sketch plan', status: 'completed', priority: 'medium' },
        { content: 'Write tests', status: 'in_progress', priority: 'high' },
        { content: 'Ship it', status: 'pending' },
      ]);
    } finally {
      fx.close();
    }
  });

  it('returns [] for sessions without todos or invalid ids', () => {
    const fx = fixtureHome();
    try {
      expect(readSessionTodos(fx.dir, SES_MAIN_OLD)).toEqual([]);
      expect(readSessionTodos(fx.dir, '../x')).toEqual([]);
    } finally {
      fx.close();
    }
  });
});
