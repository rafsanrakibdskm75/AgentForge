// Low-level, read-only access to an OpenCode data directory (default: ~/.local/share/opencode).
//
// Layout (established from the real OpenCode storage code and several probed databases;
// the schema is internal to OpenCode and drifts between releases, so every expected
// table/column is checked with PRAGMA table_info before use):
//   opencode.db        SQLite in WAL mode (opencode.db-wal/-shm companions exist while it runs)
//     session(id, project_id, parent_id, slug, directory, title, version, agent, model, cost,
//             tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
//             tokens_cache_write, summary_*, revert, permission, share_url,
//             time_created, time_updated, time_compacting, time_archived)
//     message(id, session_id, time_created, time_updated, data)   -- data is JSON:
//            {role, agent, mode, modelID, providerID, path.{cwd,root}, cost, finish,
//             time.{created,completed}, tokens.{input,output,reasoning,total,cache.{read,write}},
//             tools.{<tool>:bool}, summary.diffs, error.{name,data.message}}
//     part(id, message_id, session_id, time_created, time_updated, data)  -- data is JSON:
//            {type:"text", text, time?} | {type:"reasoning", text, time}
//          | {type:"tool", tool, callID, state:{status, input, output|error, time, title}}
//          | {type:"step-start"|"step-finish"|"patch"|"file", ...}
//     todo(session_id, content, status, priority, position, ...)  -- status:
//            pending|in_progress|completed (older rows may use other values)
//   storage/           unstructured JSON area; the old per-session JSON layout is gone, so it is
//                      only used for directory detection and never read for transcripts.
//
// Live signal: the schema exposes NO running/in-progress flag, so `running` on OpencodeSession
// is never populated here; presence must be inferred from the recency of `updatedAt`.
//
// PRIVACY: this module never opens auth.json (provider credentials in the data dir), the
// `credential` table, or any config file holding tokens/keys. Only
// session/message/part/todo rows are read.
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface OpencodeTokens {
  input?: number;
  output?: number;
  /** Cache tokens: tokens_cache_read + tokens_cache_write when both columns exist. */
  cache?: number;
}

export interface OpencodeSession {
  id: string;
  projectId?: string;
  /** Session working directory (the `directory` column). */
  directory?: string;
  title?: string;
  /** Set for forked/child sessions (`parent_id`). */
  parentId?: string;
  /** Epoch ms (`time_created`). */
  createdAt: number;
  /** Epoch ms (`time_updated`). */
  updatedAt: number;
  tokens?: OpencodeTokens;
  cost?: number;
  /**
   * Never populated: the OpenCode schema exposes no running/in-progress flag.
   * Infer presence from the recency of `updatedAt` instead.
   */
  running?: boolean;
}

export interface OpencodeMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  /** Concatenation of the message's text parts, in part order. */
  text: string;
  /** Epoch ms. */
  time: number;
}

export interface OpencodeToolPart {
  id: string;
  sessionId: string;
  messageId?: string;
  tool: string;
  /** The typed argument object (state.input). */
  input?: unknown;
  /** state.output; for failed calls, state.error when there is no output. */
  output?: string;
  /** e.g. "completed", "error", "pending", "running". */
  status?: string;
  /** Epoch ms. */
  time: number;
}

export interface OpencodeTodo {
  content: string;
  status: string;
  priority?: string;
}

// ---------------------------------------------------------------------------
// Small value helpers (never throw on unexpected shapes).
// ---------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Cap runaway tool outputs so one row cannot blow the server's memory. */
function clipText(s: string, max = 262_144): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---------------------------------------------------------------------------
// Guarded node:sqlite access.
//
// `node:sqlite` (DatabaseSync) is stable on Node 22.13+/24, but the package declares
// engines >=22.12, so the import is lazy and guarded: when it is unavailable every
// public function below degrades to []/false instead of crashing the server.
// ---------------------------------------------------------------------------

interface SqliteRow {
  [k: string]: unknown;
}
interface SqliteStatement {
  all(...params: unknown[]): SqliteRow[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDb;

let cachedCtor: DatabaseSyncCtor | null | undefined;
function databaseSync(): DatabaseSyncCtor | null {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: unknown };
    cachedCtor = typeof mod.DatabaseSync === 'function' ? (mod.DatabaseSync as DatabaseSyncCtor) : null;
  } catch {
    cachedCtor = null;
  }
  return cachedCtor;
}

/** Absolute path of opencode.db inside the home, or undefined when it is not a file. */
function dbPathOf(home: string): string | undefined {
  const p = join(home, 'opencode.db');
  try {
    if (statSync(p).isFile()) return p;
  } catch {
    // missing or unreadable
  }
  return undefined;
}

/**
 * Open the database read-only, run `fn`, always close. Returns undefined when the
 * sqlite builtin is unavailable, the database is missing, or any step fails.
 * A read-only open works while OpenCode holds the database in WAL mode; when the
 * -wal/-shm companions are absent it simply reads the main file.
 */
function withDb<T>(home: string, fn: (db: SqliteDb) => T): T | undefined {
  const ctor = databaseSync();
  if (!ctor) return undefined;
  const path = dbPathOf(home);
  if (!path) return undefined;
  let db: SqliteDb | undefined;
  try {
    db = new ctor(path, { readOnly: true });
    return fn(db);
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed or broken
    }
  }
}

/** Column names actually present on a table (empty when the table does not exist). */
function presentColumns(db: SqliteDb, table: string): Set<string> {
  const cols = new Set<string>();
  try {
    // `table` is always one of our own constants, never user input.
    for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
      const name = str(row.name);
      if (name) cols.add(name);
    }
  } catch {
    // unreadable schema
  }
  return cols;
}

/** Conservative session-id check: real ids look like `ses_<base62>`; reject anything odd. */
function validSessionId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/.test(id);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 1000;
const MAX_MESSAGES = 5000;
const MAX_PARTS = 20000;
const MAX_TODOS = 1000;

/**
 * Default OpenCode data directory: $XDG_DATA_HOME/opencode, else ~/.local/share/opencode.
 * (OpenCode resolves this via xdg-basedir; recent builds also honor OPENCODE_DATA_DIR,
 * which callers may pass through env explicitly.)
 */
export function defaultOpencodeDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === 'string' && xdg.trim() !== '') return join(xdg, 'opencode');
  return join(home, '.local', 'share', 'opencode');
}

/** True when the path looks like an OpenCode data dir: opencode.db is a file, or storage/ exists. */
export function looksLikeOpencodeDir(home: string): boolean {
  if (dbPathOf(home) !== undefined) return true;
  try {
    return statSync(join(home, 'storage')).isDirectory();
  } catch {
    return false;
  }
}

const SESSION_WANTED = [
  'id',
  'project_id',
  'parent_id',
  'directory',
  'title',
  'cost',
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
  'time_created',
  'time_updated',
] as const;

/** Every session, newest first. [] when the directory/database/tables are missing or unreadable. */
export function listSessions(home: string): OpencodeSession[] {
  const sessions = withDb(home, (db) => {
    const cols = presentColumns(db, 'session');
    if (!cols.has('id')) return [];
    const sel = SESSION_WANTED.filter((c) => cols.has(c));
    const order = cols.has('time_updated') ? 'time_updated DESC, rowid DESC' : 'rowid DESC';
    const rows = db.prepare(`SELECT ${sel.join(', ')} FROM session ORDER BY ${order} LIMIT ?`).all(MAX_SESSIONS);
    const out: OpencodeSession[] = [];
    for (const row of rows) {
      const id = str(row.id);
      if (!id) continue;
      const input = num(row.tokens_input);
      const output = num(row.tokens_output);
      const cacheRead = num(row.tokens_cache_read);
      const cacheWrite = num(row.tokens_cache_write);
      const cache = cacheRead !== undefined || cacheWrite !== undefined ? (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined;
      const tokens: OpencodeTokens | undefined =
        input !== undefined || output !== undefined || cache !== undefined ? { input, output, cache } : undefined;
      const cost = num(row.cost);
      const s: OpencodeSession = {
        id,
        projectId: str(row.project_id),
        directory: str(row.directory),
        title: str(row.title),
        parentId: str(row.parent_id),
        createdAt: num(row.time_created) ?? 0,
        updatedAt: num(row.time_updated) ?? 0,
      };
      if (tokens) s.tokens = tokens;
      if (cost !== undefined) s.cost = cost;
      out.push(s);
    }
    return out;
  });
  return sessions ?? [];
}

const MESSAGE_WANTED = ['id', 'session_id', 'time_created', 'data'] as const;

/** Messages of one session, chronological. The text comes from the message's text parts. */
export function readSessionMessages(home: string, sessionId: string): OpencodeMessage[] {
  if (!validSessionId(sessionId)) return [];
  const messages = withDb(home, (db) => {
    const msgCols = presentColumns(db, 'message');
    if (!msgCols.has('id') || !msgCols.has('session_id') || !msgCols.has('data')) return [];
    const sel = MESSAGE_WANTED.filter((c) => msgCols.has(c));
    const order = msgCols.has('time_created') ? 'time_created ASC, rowid ASC' : 'rowid ASC';
    const rows = db
      .prepare(`SELECT ${sel.join(', ')} FROM message WHERE session_id = ? ORDER BY ${order} LIMIT ?`)
      .all(sessionId, MAX_MESSAGES);
    // Group text-part bodies by their message so each message gets its full text.
    const texts = new Map<string, string[]>();
    const partCols = presentColumns(db, 'part');
    if (partCols.has('message_id') && partCols.has('data')) {
      const partOrder = partCols.has('time_created') ? 'time_created ASC, rowid ASC' : 'rowid ASC';
      for (const prow of db
        .prepare(`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY ${partOrder} LIMIT ?`)
        .all(sessionId, MAX_PARTS)) {
        const mid = str(prow.message_id);
        if (!mid) continue;
        const data = typeof prow.data === 'string' ? parseJson(prow.data) : obj(prow.data);
        if (data?.type !== 'text') continue;
        const text = str(data.text);
        if (text === undefined) continue;
        const list = texts.get(mid);
        if (list) list.push(text);
        else texts.set(mid, [text]);
      }
    }
    const out: OpencodeMessage[] = [];
    for (const row of rows) {
      const id = str(row.id);
      if (!id) continue;
      const data = typeof row.data === 'string' ? parseJson(row.data) : obj(row.data);
      const role = data ? str(data.role) : undefined;
      if (role !== 'user' && role !== 'assistant') continue;
      const body = texts.get(id);
      const dataTime = data ? obj(data.time) : undefined;
      out.push({
        id,
        sessionId,
        role,
        text: body ? clipText(body.join('\n')) : '',
        time: num(row.time_created) ?? num(dataTime?.created) ?? 0,
      });
    }
    return out;
  });
  return messages ?? [];
}

const PART_WANTED = ['id', 'message_id', 'session_id', 'time_created', 'data'] as const;

/** Tool parts (tool calls) of one session, in execution order. */
export function readSessionParts(home: string, sessionId: string): OpencodeToolPart[] {
  if (!validSessionId(sessionId)) return [];
  const parts = withDb(home, (db) => {
    const cols = presentColumns(db, 'part');
    if (!cols.has('id') || !cols.has('session_id') || !cols.has('data')) return [];
    const sel = PART_WANTED.filter((c) => cols.has(c));
    const order = cols.has('time_created') ? 'time_created ASC, rowid ASC' : 'rowid ASC';
    const rows = db
      .prepare(`SELECT ${sel.join(', ')} FROM part WHERE session_id = ? ORDER BY ${order} LIMIT ?`)
      .all(sessionId, MAX_PARTS);
    const out: OpencodeToolPart[] = [];
    for (const row of rows) {
      const id = str(row.id);
      if (!id) continue;
      const data = typeof row.data === 'string' ? parseJson(row.data) : obj(row.data);
      if (!data || data.type !== 'tool') continue;
      const tool = str(data.tool);
      if (!tool) continue;
      const state = obj(data.state);
      const status = state ? str(state.status) : undefined;
      const output = state ? str(state.output) : undefined;
      const error = state ? str(state.error) : undefined;
      const stateTime = state ? obj(state.time) : undefined;
      const part: OpencodeToolPart = {
        id,
        sessionId,
        messageId: str(row.message_id),
        tool,
        time: num(row.time_created) ?? num(stateTime?.start) ?? 0,
      };
      if (state && 'input' in state) part.input = state.input;
      // A failed call often carries the message in state.error instead of state.output.
      const shown = output ?? (status === 'error' ? error : undefined);
      if (shown !== undefined) part.output = clipText(shown);
      if (status !== undefined) part.status = status;
      out.push(part);
    }
    return out;
  });
  return parts ?? [];
}

const TODO_WANTED = ['session_id', 'content', 'status', 'priority', 'position'] as const;

/** Todos of one session, in list order. */
export function readSessionTodos(home: string, sessionId: string): OpencodeTodo[] {
  if (!validSessionId(sessionId)) return [];
  const todos = withDb(home, (db) => {
    const cols = presentColumns(db, 'todo');
    if (!cols.has('session_id') || !cols.has('content') || !cols.has('status')) return [];
    const sel = TODO_WANTED.filter((c) => cols.has(c));
    const order = cols.has('position') ? 'position ASC, rowid ASC' : 'rowid ASC';
    const rows = db
      .prepare(`SELECT ${sel.join(', ')} FROM todo WHERE session_id = ? ORDER BY ${order} LIMIT ?`)
      .all(sessionId, MAX_TODOS);
    const out: OpencodeTodo[] = [];
    for (const row of rows) {
      const content = str(row.content);
      const status = str(row.status);
      if (content === undefined || status === undefined) continue;
      const todo: OpencodeTodo = { content, status };
      const priority = str(row.priority);
      if (priority !== undefined) todo.priority = priority;
      out.push(todo);
    }
    return out;
  });
  return todos ?? [];
}
