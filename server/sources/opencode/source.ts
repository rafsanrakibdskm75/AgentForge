// OpenCode agent source (AgentSource 'opencode', see sources/source.ts): watches the sessions each
// OpenCode account wrote in its SQLite database (opencode.db under the data dir) and feeds the Office.
//
// Presence: a session is OPEN while its `time_updated` is within PRESENCE_MS and `time_archived` is
// unset. The schema exposes no running/in-progress flag; recency of `time_updated` is the only live
// signal. A session missing from the listing for longer than CLOSE_AFTER_MISSING_MS is closed; an
// archived session leaves immediately. Subagents are sessions with `parent_id`; they enter as subs of
// the parent main session of the same account while working and are completed when they go quiet (or
// disappear).
//
// Status: `time_updated` within WORKING_MS (or a fresh user message) means 'working', otherwise 'idle'.
// Boot is short and synchronous, with endBoot in a `finally`.
import { statSync, watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Activity, AgentStats, AgentStatus, SourceInfo, TaskItem } from '../../../shared/types';
import { describeTool, maskSecrets, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { detectOpencodeAccounts } from './accounts';
import {
  listSessions,
  readSessionMessages,
  readSessionParts,
  readSessionTodos,
  type OpencodeMessage,
  type OpencodeSession,
  type OpencodeToolPart,
} from './files';
import { createOpencodeTerminalParser, materializeTranscript } from './terminal';

/** A session updated within this window counts as an open session (and not archived). */
export const PRESENCE_MS = 10 * 60_000;
/** Time a session must be missing from the listing before it is treated as closed. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** `time_updated` within this window (or a fresh user message) means 'working'. */
const WORKING_MS = 90_000;
const MAIN_ROLE = tr('Agente principal (OpenCode)');
const SUB_ROLE = tr('Subagente (OpenCode)');

/** OpenCode tool names -> the describeTool case with the same meaning (shared/activity.ts). */
const TOOL_ALIASES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  todoread: 'TaskList',
  task: 'Task',
  question: 'AskUserQuestion',
};

export interface OpenCodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** OpenCode data dirs read by this process (one per account). */
  dirs: string[];
  /** Dir where transcripts are materialized (also the cwd fallback). */
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Disables fs.watch (tests). */
  watch?: boolean;
}

interface OpenCodeAccount {
  id: string;
  /** Data dir read by this process. */
  dir: string;
  /** Data dir for display (on Docker, the host's one). */
  configDir: string;
  error?: string;
}

interface SessionTracker {
  key: string;
  acc: OpenCodeAccount;
  sessionId: string;
  kind: 'main' | 'sub';
  session?: OpencodeSession;
  /** Message ids already folded into the tracker. */
  seenMsg: Set<string>;
  /** Message ids already turned into office activities. */
  emittedMsg: Set<string>;
  /** Tool part ids already folded into the tracker. */
  seenPart: Set<string>;
  /** Tool part ids already turned into office activities. */
  emittedPart: Set<string>;
  /** Messages/parts as of the last read (refreshed when time_updated changes). */
  messages: OpencodeMessage[];
  parts: OpencodeToolPart[];
  /** time_updated at the last message/part read (-1 = never). */
  lastSyncAt: number;
  /** Newest user message timestamp seen (forces 'working' while newer than the last decision). */
  freshUserAt?: number;
  /** Key of the parent main session, for subagents. */
  parentKey?: string;
  inOffice: boolean;
  status: AgentStatus;
  /** When the status was decided (message timestamp or time_updated): older information never overrides it. */
  statusAt: number;
  missingSince?: number;
  title?: string;
  firstAt?: number;
  lastAt?: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  subagents: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// ---------------------------------------------------------------------------
// Archived sessions.
//
// files.ts does not expose `time_archived`, so the flag is read here, straight from the database
// (guarded node:sqlite import, read-only, `session` rows only — the same privacy boundary as
// files.ts: no auth/credential/config files are ever opened).
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

let sqliteCtor: DatabaseSyncCtor | null | undefined;
function databaseSync(): DatabaseSyncCtor | null {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: unknown };
    sqliteCtor = typeof mod.DatabaseSync === 'function' ? (mod.DatabaseSync as DatabaseSyncCtor) : null;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

/**
 * Ids of the sessions with `time_archived` set (archived = finished). Empty when sqlite is
 * unavailable, the table/column is missing, or the database cannot be read (then nothing is
 * filtered this cycle).
 */
function readArchivedIds(home: string): Set<string> {
  const out = new Set<string>();
  const ctor = databaseSync();
  if (!ctor) return out;
  let dbPath: string;
  try {
    dbPath = join(home, 'opencode.db');
    if (!statSync(dbPath).isFile()) return out;
  } catch {
    return out;
  }
  let db: SqliteDb | undefined;
  try {
    db = new ctor(dbPath, { readOnly: true });
    const cols = new Set<string>();
    for (const row of db.prepare('PRAGMA table_info(session)').all()) {
      if (typeof row.name === 'string') cols.add(row.name);
    }
    if (!cols.has('id') || !cols.has('time_archived')) return out;
    for (const row of db.prepare('SELECT id FROM session WHERE time_archived IS NOT NULL').all()) {
      if (typeof row.id === 'string' && row.id) out.add(row.id);
    }
  } catch {
    // unreadable right now (locked, mid-write...): filter nothing this cycle
  } finally {
    try {
      db?.close();
    } catch {
      // already closed or broken
    }
  }
  return out;
}

export class OpenCodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private accs: OpenCodeAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private sessions = new Map<string, SessionTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly useWatch: boolean;
  private stopped = false;

  constructor(private readonly opts: OpenCodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.useWatch = opts.watch ?? true;
    this.dataDir = opts.dataDir;
    const env = opts.env ?? process.env;
    const existing = opts.accounts.entries();
    this.detected = detectOpencodeAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: existing.map((e) => e.detected.short), colors: existing.map((e) => e.detected.color) },
    });
    this.register();
  }

  /** Registers (again) the accounts with the AccountsService, always in the same order: ids never change. */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'opencode',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    const prev = new Map(this.accs.map((a) => [a.dir, a]));
    this.accs = entries.map((e) => {
      const old = prev.get(e.dir);
      if (old) {
        old.id = e.id;
        old.configDir = e.detected.configDir;
        return old;
      }
      return { id: e.id, dir: e.dir, configDir: e.detected.configDir };
    });
  }

  /** OpenCode accounts (final ids, from the AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  /** Rebuilds the open sessions without notifications. Synchronous and short. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.sessions.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'opencode', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.sessions.get(agentId);
    if (!t?.inOffice) return undefined;
    return materializeTranscript(t.acc.dir, this.dataDir, t.sessionId);
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.sessions.has(agentId) ? createOpencodeTerminalParser() : undefined;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`opencode-poll:${errMsg(err)}`, tr('OpenCode: falha no ciclo de leitura: {0}', [errMsg(err)]));
    }
  }

  private schedule(): void {
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  poll(boot = false): void {
    const now = (this.lastPollAt = this.now());
    const seen = new Set<string>();
    for (const acc of this.accs) {
      let sessions: OpencodeSession[];
      try {
        sessions = listSessions(acc.dir);
      } catch (err) {
        acc.error = errMsg(err);
        continue;
      }
      delete acc.error;
      // Archived sessions never enter; a tracked one that got archived leaves right away.
      const archived = readArchivedIds(acc.dir);
      for (const s of sessions) {
        if (!archived.has(s.id)) continue;
        const key = `${acc.id}:${s.id}`;
        const t = this.sessions.get(key);
        if (t) {
          this.leave(t);
          this.sessions.delete(key);
        }
      }
      const live = sessions.filter((s) => !archived.has(s.id));
      const children = new Map<string, number>();
      for (const s of live) if (s.parentId) children.set(s.parentId, (children.get(s.parentId) ?? 0) + 1);
      for (const s of live) {
        const key = `${acc.id}:${s.id}`;
        seen.add(key);
        let t = this.sessions.get(key);
        if (!t) {
          t = this.newTracker(acc, s.id);
          this.sessions.set(key, t);
        }
        try {
          this.syncSession(t, s, now, boot, children.get(s.id) ?? 0);
        } catch (err) {
          log.warnOnce(`opencode-session:${key}:${errMsg(err)}`, tr('OpenCode: sessão {0}: {1}', [key, errMsg(err)]));
        }
      }
      this.watchDataDir(acc);
    }
    for (const [key, t] of [...this.sessions]) {
      if (seen.has(key)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.leave(t);
      this.sessions.delete(key);
    }
    // Subagents whose parent entered this cycle: now the fallback to a main session may settle.
    for (const t of this.sessions.values()) {
      if (t.kind === 'sub' && !t.inOffice && seen.has(t.key)) {
        this.reconcile(t, now, boot, true);
      }
    }
  }

  private newTracker(acc: OpenCodeAccount, sessionId: string): SessionTracker {
    return {
      key: `${acc.id}:${sessionId}`,
      acc,
      sessionId,
      kind: 'main',
      seenMsg: new Set(),
      emittedMsg: new Set(),
      seenPart: new Set(),
      emittedPart: new Set(),
      messages: [],
      parts: [],
      lastSyncAt: -1,
      inOffice: false,
      status: 'idle',
      statusAt: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      subagents: 0,
    };
  }

  /** One cycle of a listed session: reads what is new, decides status and reconciles office presence. */
  private syncSession(t: SessionTracker, s: OpencodeSession, now: number, boot: boolean, childCount: number): void {
    delete t.missingSince;
    t.session = s;
    t.kind = s.parentId ? 'sub' : 'main';
    t.subagents = childCount;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // left the office (grace period ended)
    if (s.updatedAt !== t.lastSyncAt) {
      t.lastSyncAt = s.updatedAt;
      this.accumulate(t, s, now);
    }
    this.decideStatus(t, now);
    this.reconcile(t, now, boot);
    if (t.inOffice) {
      this.applySummary(t);
      if (t.kind === 'main') this.opts.office.fillWorkingActivity(t.key);
    }
  }

  /** Folds newly read rows into the tracker: title, stats and status edges. */
  private accumulate(t: SessionTracker, s: OpencodeSession, now: number): void {
    const tok = s.tokens;
    if (tok?.input !== undefined) t.tokensIn = Math.max(t.tokensIn, tok.input);
    if (tok?.output !== undefined) t.tokensOut = Math.max(t.tokensOut, tok.output);
    if (s.cost !== undefined) t.costUSD = Math.max(t.costUSD ?? 0, s.cost);
    if (!t.title && str(s.title)) t.title = truncate(s.title!, 80);
    t.messages = readSessionMessages(t.acc.dir, t.sessionId);
    t.parts = readSessionParts(t.acc.dir, t.sessionId);
    let freshUserAt = 0;
    for (const m of t.messages) {
      if (t.seenMsg.has(m.id)) continue;
      t.seenMsg.add(m.id);
      const at = m.time || now;
      if (at > (t.lastAt ?? 0)) t.lastAt = at;
      if (t.firstAt === undefined || at < t.firstAt) t.firstAt = at;
      if (m.role === 'user') {
        if (!t.title && m.text.trim()) t.title = truncate(m.text, 80);
        if (at > freshUserAt) freshUserAt = at;
      }
    }
    t.freshUserAt = freshUserAt;
    for (const p of t.parts) {
      if (t.seenPart.has(p.id)) continue;
      t.seenPart.add(p.id);
      t.toolCalls++;
    }
  }

  /** Status from the newest information: a fresh user message or a recent time_updated means 'working'. */
  private decideStatus(t: SessionTracker, now: number): void {
    const s = t.session;
    if (!s) return;
    const fresh = (t.freshUserAt ?? 0) > t.statusAt;
    const recent = now - s.updatedAt <= WORKING_MS;
    const status: AgentStatus = fresh || recent ? 'working' : 'idle';
    const at = Math.max(s.updatedAt, t.freshUserAt ?? 0);
    this.decide(t, status, at, true);
  }

  /**
   * Changes the status on an edge (new information): older information than the last decision never wins.
   * `live` = applies to the office now (the initial load only stores; the status enters with the agent).
   */
  private decide(t: SessionTracker, status: AgentStatus, at: number, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    if (t.status === status) return;
    t.status = status;
    if (live) this.statusToOffice(t);
  }

  /** Brings the tracker status to the office (a quiet subagent is completed; a busy one comes back). */
  private statusToOffice(t: SessionTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (this.officeKind(t) !== 'sub') {
      office.setStatus(t.key, t.status);
      return;
    }
    if (t.status === 'idle') {
      office.completeSub(t.key);
      return;
    }
    if (office.isSubDone(t.key)) office.reactivateSub(t.key);
    else office.setStatus(t.key, t.status);
  }

  /** Should the session be in the office now? Enters, leaves or changes room accordingly. */
  private reconcile(t: SessionTracker, now: number, boot: boolean, settle = false): void {
    // The parent may have entered this same cycle (sessions are read newest-first, not hierarchy-first).
    if (t.kind === 'sub') t.parentKey = this.findParent(t);
    const want = this.wanted(t, now, settle);
    if (!want) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (t.inOffice && t.kind === 'sub' && t.parentKey && this.officeKind(t) === 'main') {
      // A spawner showed up late: re-enter as a subagent of the parent.
      this.opts.office.closeMain(t.key);
      t.inOffice = false;
    }
    if (!t.inOffice) this.enter(t, now);
    if (t.inOffice) this.emitPending(t, boot);
  }

  /**
   * `settle` = every candidate parent had its chance this cycle: a subagent still without a parent falls
   * back to a main session instead of waiting (and disappearing) forever.
   */
  private wanted(t: SessionTracker, now: number, settle: boolean): boolean {
    const s = t.session;
    if (!s) return false;
    if (now - s.updatedAt > PRESENCE_MS) return false;
    if (t.kind === 'sub') {
      if (t.parentKey) {
        const office = this.opts.office;
        const parentGone = !office.has(t.parentKey) || office.isSubDone(t.parentKey) || office.get(t.parentKey)?.status === 'offline';
        if (!parentGone) {
          // A subagent only shows up while working; once quiet, it has delivered.
          if (!t.inOffice && t.status !== 'working') return false;
          return true;
        }
        // Parent gone: falls through and shows as a main session instead of disappearing.
      } else {
        return settle;
      }
    }
    return true;
  }

  /** The kind under which the tracker currently sits in the office (a sub may sit as a main fallback). */
  private officeKind(t: SessionTracker): 'main' | 'sub' | undefined {
    const k = this.opts.office.get(t.key)?.kind;
    return k === 'sub' ? 'sub' : k === 'main' ? 'main' : undefined;
  }

  /** Parent of a subagent: a tracked session of the same account with the matching session id, in the office. */
  private findParent(t: SessionTracker): string | undefined {
    const parentId = t.session?.parentId;
    if (!parentId) return undefined;
    const office = this.opts.office;
    for (const u of this.sessions.values()) {
      if (u === t || u.acc !== t.acc || u.sessionId !== parentId) continue;
      if (office.has(u.key)) return u.key;
    }
    return undefined;
  }

  private enter(t: SessionTracker, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.addMain({
        id: t.key,
        provider: 'opencode',
        account: t.acc.id,
        sessionId: t.sessionId,
        cwd: this.cwdOf(t),
        role: MAIN_ROLE,
        startedAt: t.session && t.session.createdAt > 0 ? t.session.createdAt : now,
        status: t.status,
      });
      t.inOffice = office.has(t.key);
      if (t.inOffice) office.setStatus(t.key, t.status);
    } else if (t.parentKey) {
      const added = office.addSub({
        id: t.key,
        parentId: t.parentKey,
        sessionId: t.sessionId,
        role: SUB_ROLE,
        title: t.title,
        background: false,
        startedAt: t.session && t.session.createdAt > 0 ? t.session.createdAt : now,
      });
      t.inOffice = added;
      if (added && t.status === 'working') office.setStatus(t.key, 'working');
    } else {
      // Subagent whose spawner was not seen: shows as a main session instead of disappearing.
      office.addMain({
        id: t.key,
        provider: 'opencode',
        account: t.acc.id,
        sessionId: t.sessionId,
        cwd: this.cwdOf(t),
        role: SUB_ROLE,
        startedAt: t.session && t.session.createdAt > 0 ? t.session.createdAt : now,
        status: t.status,
      });
      t.inOffice = office.has(t.key);
    }
  }

  /** Leaves the office: a main session closes; a subagent delivers (if it had not already). */
  private leave(t: SessionTracker): void {
    if (!t.inOffice) return;
    if (this.officeKind(t) === 'sub') this.opts.office.completeSub(t.key);
    else this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }

  /** Working directory of the session: the session's own directory, else the data dir. */
  private cwdOf(t: SessionTracker): string {
    const d = str(t.session?.directory);
    return d ?? join(this.dataDir);
  }

  /** Turns read-but-not-yet-shown messages and tool parts into office activities. */
  private emitPending(t: SessionTracker, boot: boolean): void {
    const feed = !boot;
    for (const m of t.messages) {
      if (!t.seenMsg.has(m.id) || t.emittedMsg.has(m.id)) continue;
      t.emittedMsg.add(m.id);
      const at = m.time || this.now();
      if (m.role === 'user') {
        this.activity(
          t,
          { id: `${t.key}#m${m.id}`, at, kind: 'prompt', icon: '💬', text: maskSecrets(truncate(m.text, 46)) || tr('Nova instrução') },
          feed,
        );
      } else if (m.role === 'assistant' && m.text.trim()) {
        this.activity(t, { id: `${t.key}#m${m.id}`, at, kind: 'respond', icon: '✏️', text: maskSecrets(truncate(m.text, 46)) }, feed);
      }
    }
    for (const p of t.parts) {
      if (!t.seenPart.has(p.id) || t.emittedPart.has(p.id)) continue;
      t.emittedPart.add(p.id);
      this.emitTool(t, p, p.time || this.now(), feed);
    }
  }

  private emitTool(t: SessionTracker, p: OpencodeToolPart, at: number, feed: boolean): void {
    const name = p.tool || 'tool';
    const input = rec(p.input) ?? {};
    // The shared tool descriptions already mask and truncate; unknown tools fall back to 'Usando {name}'.
    const desc = describeTool(TOOL_ALIASES[name.toLowerCase()] ?? name, input);
    const activity: Activity = {
      id: `${t.key}#p${p.id}`,
      at,
      kind: desc.kind,
      icon: desc.icon,
      text: desc.text,
      tool: name,
    };
    if (desc.detail) activity.detail = desc.detail;
    if (desc.questions) activity.questions = desc.questions;
    const status = (p.status ?? '').toLowerCase();
    if (status === 'error' || /fail|error|denied|cancel/.test(status)) activity.error = true;
    this.activity(t, activity, feed);
  }

  private activity(t: SessionTracker, activity: Activity, feed: boolean): void {
    if (!t.inOffice) return;
    this.opts.office.addActivity(t.key, activity, true, { feed });
  }

  private applySummary(t: SessionTracker): void {
    if (!t.inOffice) return;
    const tasks: TaskItem[] = readSessionTodos(t.acc.dir, t.sessionId).map((td, i) => ({
      id: `${t.key}#todo${i}`,
      title: truncate(td.content, 80),
      status: td.status === 'completed' ? 'completed' : td.status === 'in_progress' ? 'in_progress' : 'pending',
    }));
    const stats: AgentStats = {
      toolCalls: t.toolCalls,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      subagents: t.subagents,
    };
    if (t.costUSD !== undefined) stats.costUSD = t.costUSD;
    const summary: TranscriptSummary = { tasks, stats };
    if (t.title) summary.title = t.title;
    if (t.firstAt !== undefined) summary.firstAt = t.firstAt;
    if (t.lastAt !== undefined) summary.lastAt = t.lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  // ---------------------------------------------------------------- fs.watch (accelerator)

  private watchDataDir(acc: OpenCodeAccount): void {
    if (!this.useWatch || this.dirWatchers.has(acc.dir)) return;
    try {
      const w = watch(acc.dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(acc.dir);
      });
      this.dirWatchers.set(acc.dir, w);
    } catch {
      // unsupported: polling covers it
    }
  }
}
