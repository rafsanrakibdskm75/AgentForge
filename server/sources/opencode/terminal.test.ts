// Fixture-based tests for the OpenCode transcript materializer and terminal parser.
// Every test builds a real SQLite database with the OpenCode-like schema in a temp dir.
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, describeSqlite } from './sqlite-test';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { createOpencodeTerminalParser, materializeTranscript } from './terminal';

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

const T0 = 1_760_000_000_000; // fixed clock so the transcript is deterministic
const iso = (t: number) => new Date(t).toISOString();
const SES = 'ses_demo01';

const SCHEMA = `
CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
  cost REAL, tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER, time_updated INTEGER);
CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER,
  PRIMARY KEY (session_id, position));
`;

interface Fixture {
  home: string;
  dataDir: string;
  db: DatabaseSync;
}

function fixture(): Fixture {
  const home = tempDir('agentforge-opencode-term-home');
  const dataDir = tempDir('agentforge-opencode-term-data');
  const db = new DatabaseSync(join(home, 'opencode.db'));
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO session(id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`).run(
    SES, '/repo/demo', 'Demo session', T0 - 2000, T0,
  );
  db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    'msg_u1', SES, T0 - 1000, JSON.stringify({ role: 'user' }),
  );
  db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    'msg_a1', SES, T0 - 800, JSON.stringify({ role: 'assistant' }),
  );
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_u1', 'msg_u1', SES, T0 - 1000, JSON.stringify({ type: 'text', text: 'Deploy the site\nwith care' }),
  );
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_a1', 'msg_a1', SES, T0 - 800, JSON.stringify({ type: 'text', text: 'Working on it' }),
  );
  // A tool call between the two messages: tests the chronological merge of parts and messages.
  db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
    'prt_tool1', 'msg_a1', SES, T0 - 900,
    JSON.stringify({
      type: 'tool', tool: 'Bash', callID: 'c1',
      state: { status: 'completed', input: { command: 'npm test' }, output: 'ok\npassed' },
    }),
  );
  db.prepare(`INSERT INTO todo(session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)`).run(
    SES, 'Write docs', 'pending', null, 1,
  );
  cleanups.push(() => db.close());
  return { home, dataDir, db };
}

/** Feed every line of the transcript through a fresh parser, in order. */
function parseAll(text: string): TerminalEntry[] {
  const parser = createOpencodeTerminalParser();
  return text.split('\n').flatMap((line) => parser.push(line));
}

describeSqlite('materializeTranscript', () => {
  it('writes the exact line format, records merged chronologically', () => {
    const { home, dataDir } = fixture();
    const path = materializeTranscript(home, dataDir, SES);
    expect(path).toBe(join(dataDir, 'opencode-transcripts', `${SES}.txt`));
    expect(readFileSync(path!, 'utf8')).toBe(
      [
        `[${iso(T0 - 1000)}] USER: Deploy the site\\nwith care`,
        `[${iso(T0 - 900)}] TOOL Bash (completed): {"command":"npm test"}`,
        `[${iso(T0 - 900)}] RESULT Bash: ok\\npassed`,
        `[${iso(T0 - 800)}] ASSISTANT: Working on it`,
        `[${iso(T0 - 800)}] TODO [pending] Write docs`,
        '',
      ].join('\n'),
    );
  });

  it('masks secrets in the transcript', () => {
    const { home, dataDir, db } = fixture();
    db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
      'msg_s1', SES, T0 - 500, JSON.stringify({ role: 'user' }),
    );
    db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
      'prt_s1', 'msg_s1', SES, T0 - 500,
      JSON.stringify({ type: 'text', text: 'export GITHUB_TOKEN=hunter2secret and done' }),
    );
    const path = materializeTranscript(home, dataDir, SES)!;
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('GITHUB_TOKEN=***');
    expect(text).not.toContain('hunter2secret');
  });

  it('does not rewrite when the session is unchanged', () => {
    const { home, dataDir } = fixture();
    const path = materializeTranscript(home, dataDir, SES)!;
    const m1 = statSync(path).mtimeMs;
    expect(materializeTranscript(home, dataDir, SES)).toBe(path);
    expect(statSync(path).mtimeMs).toBe(m1);
  });

  it('rewrites when the session got newer', () => {
    const { home, dataDir, db } = fixture();
    const path = materializeTranscript(home, dataDir, SES)!;
    const before = readFileSync(path, 'utf8');
    db.prepare(`INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
      'msg_u2', SES, T0 + 4000, JSON.stringify({ role: 'user' }),
    );
    db.prepare(`INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`).run(
      'prt_u2', 'msg_u2', SES, T0 + 4000, JSON.stringify({ type: 'text', text: 'Another one' }),
    );
    db.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(T0 + 5000, SES);
    expect(materializeTranscript(home, dataDir, SES)).toBe(path);
    const after = readFileSync(path, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain(`[${iso(T0 + 4000)}] USER: Another one`);
  });

  it('returns undefined for a bad session id (no path traversal)', () => {
    const { home, dataDir } = fixture();
    expect(materializeTranscript(home, dataDir, '../evil')).toBeUndefined();
    expect(materializeTranscript(home, dataDir, 'ses demo')).toBeUndefined();
    expect(materializeTranscript(home, dataDir, 'foo')).toBeUndefined();
    expect(materializeTranscript(home, dataDir, '')).toBeUndefined();
  });

  it('returns undefined for an unknown session', () => {
    const { home, dataDir } = fixture();
    expect(materializeTranscript(home, dataDir, 'ses_missing')).toBeUndefined();
  });
});

describeSqlite('createOpencodeTerminalParser', () => {
  it('round-trips a materialized transcript into entries, tool paired with its result', () => {
    const { home, dataDir } = fixture();
    const entries = parseAll(readFileSync(materializeTranscript(home, dataDir, SES)!, 'utf8'));
    expect(entries.map((e) => e.kind)).toEqual(['user', 'tool', 'result', 'assistant', 'system']);
    const [user, tool, result, assistant, system] = entries;
    expect(user).toMatchObject({ kind: 'user', text: 'Deploy the site\nwith care' });
    expect(tool).toMatchObject({ kind: 'tool', tool: 'Bash', title: 'Bash({"command":"npm test"})' });
    expect(result).toMatchObject({ kind: 'result', toolUseId: (tool as { id: string }).id, text: 'ok\npassed' });
    expect(assistant).toMatchObject({ kind: 'assistant', text: 'Working on it' });
    // TODO lines surface as system entries (no user/assistant/thinking/tool shape fits).
    expect(system).toMatchObject({ kind: 'system', level: 'info' });
    expect((system as { text: string }).text).toContain('Write docs');
  });

  it('parses THINKING lines and marks failed results', () => {
    const parser = createOpencodeTerminalParser();
    const thinking = parser.push(`[${iso(T0)}] THINKING: maybe a cache`);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ kind: 'thinking', text: 'maybe a cache' });
    const tool = parser.push(`[${iso(T0)}] TOOL Read (error): {"file":"x"}`);
    expect(tool[0]).toMatchObject({ kind: 'tool', tool: 'Read' });
    const result = parser.push(`[${iso(T0)}] RESULT Read: not found`);
    expect(result[0]).toMatchObject({ kind: 'result', error: true, text: 'not found' });
    expect((result[0] as { toolUseId: string }).toolUseId).toBe((tool[0] as { id: string }).id);
  });

  it('ignores invalid lines', () => {
    const parser = createOpencodeTerminalParser();
    expect(parser.push('')).toEqual([]);
    expect(parser.push('not a transcript line')).toEqual([]);
    expect(parser.push('[broken')).toEqual([]);
    expect(parser.push(`[${iso(T0)}] UNKNOWN: something`)).toEqual([]);
  });
});
