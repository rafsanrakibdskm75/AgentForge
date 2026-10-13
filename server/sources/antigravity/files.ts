// Low-level, read-only access to Google Antigravity's conversation catalog (CATALOG level only).
//
// Layout (from research; THE SCHEMA IS NOT VERIFIED and drifts between Antigravity releases, so
// every table and column is discovered with PRAGMA before use — nothing is assumed):
//   ~/.muse/antigravity(-ide|-cli)?/conversation_summaries.db   SQLite catalog of conversations.
// Expected (not verified) columns on the summary table: a conversation/session id, a title, the
// workspace or project path, a status, a parent id for hierarchy, created/updated timestamps.
// The full session payloads are protobuf blobs; legacy `.pb` files may be encrypted. They are
// NEVER read or decoded here (nor are transcript rows, even if a table carrying them existed).
//
// Live signal: the catalog exposes NO running/in-progress flag, so `running` on
// AntigravityConversation is never populated here; presence must be inferred from the recency of
// `updatedAt`.
//
// PRIVACY: this module never opens oauth_creds.json, google_accounts.json, mcp-oauth-tokens.json,
// or any other credential/token/config file (only existence checks, inside looksLikeAntigravityDir).
// Only conversation_summaries.db is read.
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface AntigravityConversation {
  id: string;
  title?: string;
  /** Project/workspace path when the catalog records one. */
  workspace?: string;
  /** e.g. "active", "archived" — free-form, taken as-is from the catalog. */
  status?: string;
  /** Set for forked/child conversations (`parent_id`). */
  parentId?: string;
  /** Epoch ms (normalized: the catalog may store seconds or ISO strings). */
  createdAt: number;
  /** Epoch ms (normalized). */
  updatedAt: number;
  /**
   * Never populated: the catalog exposes no running/in-progress flag. Infer presence from the
   * recency of `updatedAt` instead.
   */
  running?: boolean;
}

// ---------------------------------------------------------------------------
// Small value helpers (never throw on unexpected shapes).
// ---------------------------------------------------------------------------

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Normalize a timestamp cell to epoch ms. Accepts epoch ms, epoch seconds, and ISO-8601 strings
 * (the catalog format is unverified, so all three are tried). Anything else becomes 0.
 */
export function toEpochMs(v: unknown): number {
  const n = num(v);
  if (n !== undefined) {
    if (n >= 1e12) return Math.floor(n); // epoch ms
    if (n >= 1e9) return Math.floor(n * 1000); // epoch seconds
    return 0;
  }
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------
// Guarded node:sqlite access.
//
// `node:sqlite` (DatabaseSync) is stable on Node 22.13+/24, but the import is lazy and guarded:
// when it is unavailable every public function below degrades to []/false instead of crashing
// the server.
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

/** Absolute path of conversation_summaries.db inside the home, or undefined when it is not a file. */
function dbPathOf(home: string): string | undefined {
  const p = join(home, 'conversation_summaries.db');
  try {
    if (statSync(p).isFile()) return p;
  } catch {
    // missing or unreadable
  }
  return undefined;
}

/**
 * Open the database read-only, run `fn`, always close. Returns undefined when the sqlite builtin
 * is unavailable, the database is missing, or any step fails. A read-only open works while
 * Antigravity holds the database in WAL mode; when the -wal/-shm companions are absent it simply
 * reads the main file.
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

/** Names of every table in the database (empty when the schema is unreadable). */
function tableNames(db: SqliteDb): string[] {
  const out: string[] = [];
  try {
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      const name = str(row.name);
      if (name) out.push(name);
    }
  } catch {
    // unreadable schema
  }
  return out;
}

/** Column names actually present on a table (empty when the table does not exist). */
function presentColumns(db: SqliteDb, table: string): Set<string> {
  const cols = new Set<string>();
  try {
    // `table` is always one of our own constants or a name read from sqlite_master, never user input.
    for (const row of db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all()) {
      const name = str(row.name);
      if (name) cols.add(name);
    }
  } catch {
    // unreadable schema
  }
  return cols;
}

/** Quote an identifier read from sqlite_master (defensive: strip quotes first). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '')}"`;
}

/** Conservative id check: reject anything that is not a plain token-like id. */
function validConversationId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/.test(id);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

const MAX_CONVERSATIONS = 1000;

/**
 * The three ~/.muse/antigravity* homes Google Antigravity is known to use (the three candidates
 * from research: ~/.muse/antigravity, ~/.muse/antigravity-ide, ~/.muse/antigravity-cli). Returns
 * only the candidates that exist as directories (any deeper layout check is the caller's job).
 */
export function defaultAntigravityDirs(home: string): string[] {
  const out: string[] = [];
  for (const name of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const p = join(home, '.muse', name);
    try {
      if (statSync(p).isDirectory()) out.push(p);
    } catch {
      // candidate absent
    }
  }
  return out;
}

/** True when the path looks like an Antigravity home: conversation_summaries.db is a file. */
export function looksLikeAntigravityDir(dir: string): boolean {
  return dbPathOf(dir) !== undefined;
}

/**
 * True when the dir looks like an Antigravity home (the conversation catalog exists). This is the
 * pure layout check; the accounts layer additionally excludes Claude homes (see
 * server/sources/antigravity/accounts.ts).
 */
export function isAntigravityHome(dir: string): boolean {
  return looksLikeAntigravityDir(dir);
}

// The schema is unverified, so the catalog table and its columns are matched against several
// candidate names before any query is built. All matching is case-insensitive.

const TABLE_HINT = /(conversation|summary|session)s?/i;

const ID_CANDIDATES = ['id', 'conversation_id', 'session_id', 'conversationid', 'sessionid', 'conversationId', 'sessionId'] as const;
const TITLE_CANDIDATES = ['title', 'name', 'subject'] as const;
const WORKSPACE_CANDIDATES = [
  'workspace',
  'project_path',
  'projectpath',
  'project',
  'working_directory',
  'workingdirectory',
  'cwd',
  'directory',
  'dir',
] as const;
const STATUS_CANDIDATES = ['status', 'state', 'phase'] as const;
const PARENT_CANDIDATES = ['parent_id', 'parentid', 'parentId', 'parent'] as const;
const CREATED_CANDIDATES = ['created_at', 'createdat', 'createdAt', 'time_created', 'created', 'created_on'] as const;
const UPDATED_CANDIDATES = [
  'updated_at',
  'updatedat',
  'updatedAt',
  'time_updated',
  'updated',
  'updated_on',
  'last_modified',
] as const;

/** First candidate present in `cols` (case-insensitive), or undefined. */
function pickColumn(cols: Set<string>, candidates: readonly string[]): string | undefined {
  const lower = new Map<string, string>();
  for (const c of cols) lower.set(c.toLowerCase(), c);
  for (const cand of candidates) {
    const hit = lower.get(cand.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** Resolved column mapping for one catalog table. */
interface ColumnMap {
  table: string;
  id: string;
  title?: string;
  workspace?: string;
  status?: string;
  parentId?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Find the conversation-catalog table and map its columns. Returns undefined when no plausible
 * table (name hint) or no id-like column exists — callers degrade to [].
 */
function resolveCatalog(db: SqliteDb): ColumnMap | undefined {
  const tables = tableNames(db).filter((t) => TABLE_HINT.test(t));
  for (const table of tables) {
    const cols = presentColumns(db, table);
    const id = pickColumn(cols, ID_CANDIDATES);
    if (!id) continue; // a catalog without a usable id column is not queryable
    return {
      table,
      id,
      title: pickColumn(cols, TITLE_CANDIDATES),
      workspace: pickColumn(cols, WORKSPACE_CANDIDATES),
      status: pickColumn(cols, STATUS_CANDIDATES),
      parentId: pickColumn(cols, PARENT_CANDIDATES),
      createdAt: pickColumn(cols, CREATED_CANDIDATES),
      updatedAt: pickColumn(cols, UPDATED_CANDIDATES),
    };
  }
  return undefined;
}

/**
 * Every conversation in the catalog, newest first. [] when node:sqlite is unavailable, the
 * database is missing/unreadable, or the schema does not match anything expected. Never throws.
 */
export function listConversations(home: string): AntigravityConversation[] {
  const convs = withDb(home, (db) => {
    const cat = resolveCatalog(db);
    if (!cat) return [];
    const sel = [quoteIdent(cat.id)];
    if (cat.title) sel.push(quoteIdent(cat.title));
    if (cat.workspace) sel.push(quoteIdent(cat.workspace));
    if (cat.status) sel.push(quoteIdent(cat.status));
    if (cat.parentId) sel.push(quoteIdent(cat.parentId));
    if (cat.createdAt) sel.push(quoteIdent(cat.createdAt));
    if (cat.updatedAt) sel.push(quoteIdent(cat.updatedAt));
    const order = cat.updatedAt ? `${quoteIdent(cat.updatedAt)} DESC, rowid DESC` : 'rowid DESC';
    const rows = db
      .prepare(`SELECT ${sel.join(', ')} FROM ${quoteIdent(cat.table)} ORDER BY ${order} LIMIT ?`)
      .all(MAX_CONVERSATIONS);
    const out: AntigravityConversation[] = [];
    for (const row of rows) {
      const id = str(row[cat.id]);
      if (!id || !validConversationId(id)) continue;
      const c: AntigravityConversation = {
        id,
        createdAt: cat.createdAt ? toEpochMs(row[cat.createdAt]) : 0,
        updatedAt: cat.updatedAt ? toEpochMs(row[cat.updatedAt]) : 0,
      };
      if (cat.title) {
        const title = str(row[cat.title]);
        if (title) c.title = title;
      }
      if (cat.workspace) {
        const ws = str(row[cat.workspace]);
        if (ws) c.workspace = ws;
      }
      if (cat.status) {
        const status = str(row[cat.status]);
        if (status) c.status = status;
      }
      if (cat.parentId) {
        const parent = str(row[cat.parentId]);
        if (parent) c.parentId = parent;
      }
      out.push(c);
    }
    return out;
  });
  return convs ?? [];
}
