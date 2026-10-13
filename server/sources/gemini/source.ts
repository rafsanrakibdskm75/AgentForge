// Gemini CLI agent source (AgentSource 'gemini', see sources/source.ts): watches the open sessions
// each Gemini account wrote under its home (tmp/<projectHash>/chats/session-*.json) and feeds the Office.
//
// Presence: a session is OPEN while its file was modified within PRESENCE_MS. There is no lock file or
// explicit in-progress flag in Gemini CLI's format; recency of the file mtime (and of `lastUpdated`) is
// the only live signal. A session missing from the listing for longer than CLOSE_AFTER_MISSING_MS is closed.
// Subagents are sessions of kind 'subagent'; their parent is the main session (same account) that has a
// toolCall with `agentId` pointing at the subagent's sessionId. They enter as subs of that parent while they
// work and are completed when they go quiet (or disappear).
//
// Status: `lastUpdated` within WORKING_MS (or a fresh user message) means 'working', otherwise 'idle'.
// Boot is short and synchronous (whole files are small JSON), with endBoot in a `finally`.
import { watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import type { Activity, ActivityKind, AgentStats, AgentStatus, SourceInfo } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import type { TerminalParser } from '../terminal';
import { detectGeminiAccounts } from './accounts';
import {
  chatDirs,
  listSessionFiles,
  projectPathOf,
  readSessionFile,
  toMs,
  type GeminiMessage,
  type GeminiSession,
  type GeminiToolCall,
  type SessionFileRef,
} from './files';
import { createGeminiTerminalParser } from './terminal';

/** A session file modified within this window counts as an open session. */
export const PRESENCE_MS = 10 * 60_000;
/** Time a session must be missing from the listing before it is treated as closed. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** `lastUpdated` within this window (or a fresh user message) means 'working'. */
const WORKING_MS = 90_000;
const MAIN_ROLE = tr('Agente principal (Gemini)');
const SUB_ROLE = tr('Subagente (Gemini)');

export interface GeminiSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Gemini homes read by this process (one per account). */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Disables fs.watch (tests). */
  watch?: boolean;
}

interface GeminiAccount {
  id: string;
  /** Home read by this process. */
  dir: string;
  /** Home for display (on Docker, the host's one). */
  configDir: string;
  error?: string;
}

interface SessionTracker {
  key: string;
  acc: GeminiAccount;
  sessionId: string;
  kind: 'main' | 'sub';
  ref: SessionFileRef;
  session?: GeminiSession;
  /** Message ids already read from the file. */
  seenMsg: Set<string>;
  /** Message ids already turned into office activities. */
  emittedMsg: Set<string>;
  /** Tool call ids already turned into office activities. */
  seenTool: Set<string>;
  /** mtime of the file at the last successful read. */
  lastReadMtime: number;
  /** Newest user message timestamp seen (forces 'working' while newer than the last decision). */
  freshUserAt?: number;
  /** Key of the parent main session, for subagents. */
  parentKey?: string;
  inOffice: boolean;
  status: AgentStatus;
  /** When the status was decided (message timestamp or lastUpdated): older information never overrides it. */
  statusAt: number;
  missingSince?: number;
  title?: string;
  model?: string;
  firstAt?: number;
  lastAt?: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  subagents: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function short(s: string, n = 46): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Visible text of a message (joined content parts). */
function messageText(m: GeminiMessage): string {
  const parts = Array.isArray(m.content) ? m.content : [];
  return parts.map((p) => str(p.text)).filter(Boolean).join(' ') as string;
}

/** Visible text of a thought (string or {text}). */
function thoughtText(th: unknown): string {
  if (typeof th === 'string') return th;
  const t = rec(th);
  return str(t?.text) ?? '';
}

/** A short human argument for a tool call: command, path, query... */
function argShort(args: unknown): string {
  if (typeof args === 'string') return short(args, 40);
  const r = rec(args);
  if (!r) return '';
  for (const k of ['command', 'cmd', 'path', 'file', 'file_path', 'filePath', 'query', 'url', 'pattern', 'prompt', 'description']) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return short(v.trim(), 40);
  }
  return '';
}

/** Tool name -> activity kind/icon, mirroring the shared conventions. */
function toolKindIcon(name: string): { kind: ActivityKind; icon: string } {
  const n = name.toLowerCase();
  if (/read/.test(n)) return { kind: 'read', icon: '📖' };
  if (/edit|write/.test(n)) return { kind: 'edit', icon: '✏️' };
  if (/shell|bash|exec|run/.test(n)) return { kind: 'run', icon: '⌨️' };
  if (/grep|glob|search/.test(n)) return { kind: 'search', icon: '🔍' };
  if (/webfetch|websearch/.test(n)) return { kind: 'web', icon: '🌐' };
  if (/todo/.test(n)) return { kind: 'write', icon: '📝' };
  return { kind: 'run', icon: '🔧' };
}

/** PT-BR label for a tool call, in the style of the other sources. */
function describeGeminiTool(name: string, args: unknown): { kind: ActivityKind; icon: string; text: string; detail?: string } {
  const { kind, icon } = toolKindIcon(name);
  const arg = argShort(args);
  const file = (() => {
    const r = rec(args);
    const p = r ? str(r['path']) ?? str(r['file']) ?? str(r['file_path']) ?? str(r['filePath']) : undefined;
    return p ? basename(p) : undefined;
  })();
  let text: string;
  if (kind === 'read') text = file ? tr('Lendo {0}', [file]) : tr('Lendo arquivo');
  else if (kind === 'edit') text = file ? tr('Editando {0}', [file]) : tr('Editando arquivo');
  else if (kind === 'search') text = arg ? tr('Procurando {0}', [arg]) : tr('Procurando');
  else if (kind === 'web') text = arg ? tr('Na web: {0}', [arg]) : tr('Pesquisando na web');
  else if (/todo/.test(name.toLowerCase())) text = tr('Atualizando tarefas');
  else if (kind === 'run' && arg) text = arg;
  else text = arg ? `${name}: ${arg}` : name;
  const raw = rec(args);
  const detail = raw ? short(JSON.stringify(raw), 300) : undefined;
  return { kind, icon, text: short(text), ...(detail ? { detail } : {}) };
}

export class GeminiSource implements AgentSource {
  readonly provider = 'gemini' as const;
  private accs: GeminiAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private sessions = new Map<string, SessionTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private readonly homeDir: string;
  private readonly now: () => number;
  private readonly useWatch: boolean;
  private stopped = false;

  constructor(private readonly opts: GeminiSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.useWatch = opts.watch ?? true;
    const env = opts.env ?? process.env;
    this.homeDir = opts.home ?? env.HOME ?? env.USERPROFILE ?? '';
    const claude = opts.accounts.entries();
    this.detected = detectGeminiAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: claude.map((e) => e.detected.short), colors: claude.map((e) => e.detected.color) },
    });
    this.register();
  }

  /** Registers (again) the accounts with the AccountsService, always in the same order: ids never change. */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'gemini',
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

  /** Gemini accounts (final ids, from the AccountsService). */
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
      const info: SourceInfo = { label: acc.id, provider: 'gemini', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.sessions.get(agentId);
    return t?.inOffice ? t.ref.path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.sessions.has(agentId) ? createGeminiTerminalParser() : undefined;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`gemini-poll:${errMsg(err)}`, tr('Gemini: falha no ciclo de leitura: {0}', [errMsg(err)]));
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
      let refs: SessionFileRef[];
      try {
        refs = listSessionFiles(acc.dir);
      } catch (err) {
        acc.error = errMsg(err);
        continue;
      }
      delete acc.error;
      for (const ref of refs) {
        const key = `${acc.id}:${ref.sessionId}`;
        seen.add(key);
        let t = this.sessions.get(key);
        if (!t) {
          t = this.newTracker(acc, ref);
          this.sessions.set(key, t);
        }
        try {
          this.syncSession(t, ref, now, boot);
        } catch (err) {
          log.warnOnce(`gemini-session:${key}:${errMsg(err)}`, tr('Gemini: sessão {0}: {1}', [key, errMsg(err)]));
        }
      }
      this.watchChats(acc);
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

  private newTracker(acc: GeminiAccount, ref: SessionFileRef): SessionTracker {
    return {
      key: `${acc.id}:${ref.sessionId}`,
      acc,
      sessionId: ref.sessionId,
      kind: 'main',
      ref,
      seenMsg: new Set(),
      emittedMsg: new Set(),
      seenTool: new Set(),
      lastReadMtime: 0,
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
  private syncSession(t: SessionTracker, ref: SessionFileRef, now: number, boot: boolean): void {
    delete t.missingSince;
    t.ref = ref;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // left the office (grace period ended)
    if (ref.mtimeMs !== t.lastReadMtime) {
      const session = readSessionFile(ref.path);
      if (session) {
        t.session = session;
        t.lastReadMtime = ref.mtimeMs;
        t.kind = session.kind === 'subagent' ? 'sub' : 'main';
        this.accumulate(t, session, now);
      } else {
        // Unreadable right now (mid-write?): keep the old mtime and try again next cycle.
        log.warnOnce(`gemini-read:${t.key}`, tr('Gemini: sessão {0} ilegível.', [t.key]));
      }
    }
    this.decideStatus(t, now);
    this.reconcile(t, now, boot);
    if (t.inOffice) {
      this.applySummary(t);
      if (t.kind === 'main') this.opts.office.fillWorkingActivity(t.key);
    }
  }

  /** Folds newly read messages into the tracker: title, model, stats and status edges. */
  private accumulate(t: SessionTracker, session: GeminiSession, now: number): void {
    if (!t.title) {
      const firstUser = session.messages.find((m) => m.type === 'user');
      const text = firstUser ? messageText(firstUser) : '';
      if (text) t.title = short(text, 80);
    }
    t.model = session.model ?? t.model;
    let freshUserAt = 0;
    session.messages.forEach((m, i) => {
      const mid = msgId(m, i);
      if (t.seenMsg.has(mid)) return;
      t.seenMsg.add(mid);
      const at = msgAt(m, now);
      if (at > (t.lastAt ?? 0)) t.lastAt = at;
      if (t.firstAt === undefined || at < t.firstAt) t.firstAt = at;
      if (m.type === 'user' && at > freshUserAt) freshUserAt = at;
      t.model ??= str(m.model);
      const tokens = rec(m.tokens);
      if (tokens) {
        const input = num(tokens.input);
        if (input !== undefined && input > t.tokensIn) t.tokensIn = input; // peak context, not cumulative
        const output = num(tokens.output);
        if (output !== undefined) t.tokensOut += output;
      }
      for (const tc of m.toolCalls ?? []) {
        const tid = toolId(tc);
        if (t.seenTool.has(tid)) continue;
        t.seenTool.add(tid);
        t.toolCalls++;
        if (str(tc.agentId)) t.subagents++;
      }
    });
    t.freshUserAt = freshUserAt;
  }

  /** Status from the newest information: a fresh user message or a recent lastUpdated means 'working'. */
  private decideStatus(t: SessionTracker, now: number): void {
    const s = t.session;
    if (!s) return;
    const fresh = (t.freshUserAt ?? 0) > t.statusAt;
    const recent = now - s.lastUpdated <= WORKING_MS;
    const status: AgentStatus = fresh || recent ? 'working' : 'idle';
    const at = Math.max(s.lastUpdated, t.freshUserAt ?? 0);
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
    // The parent may have entered this same cycle (files are read in mtime order, not hierarchy order).
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
    if (!t.session) return false;
    if (now - t.ref.mtimeMs > PRESENCE_MS) return false;
    if (t.kind === 'sub' && t.parentKey) {
      const office = this.opts.office;
      const parentGone = !office.has(t.parentKey) || office.isSubDone(t.parentKey) || office.get(t.parentKey)?.status === 'offline';
      if (!parentGone) {
        // A subagent only shows up while working; once quiet, it has delivered.
        if (!t.inOffice && t.status !== 'working') return false;
        return true;
      }
      // Parent gone: falls through and shows as a main session instead of disappearing.
    } else if (t.kind === 'sub') {
      return settle;
    }
    return true;
  }

  /** The kind under which the tracker currently sits in the office (a sub may sit as a main fallback). */
  private officeKind(t: SessionTracker): 'main' | 'sub' | undefined {
    const k = this.opts.office.get(t.key)?.kind;
    return k === 'sub' ? 'sub' : k === 'main' ? 'main' : undefined;
  }

  /** Parent of a subagent: a tracked main session of the same account with a toolCall spawning it. */
  private findParent(t: SessionTracker): string | undefined {
    const office = this.opts.office;
    for (const u of this.sessions.values()) {
      if (u === t || u.acc !== t.acc || u.kind !== 'main' || !u.session) continue;
      const spawns = u.session.messages.some((m) => (m.toolCalls ?? []).some((tc) => str(tc.agentId) === t.sessionId));
      if (spawns && office.has(u.key)) return u.key;
    }
    return undefined;
  }

  private enter(t: SessionTracker, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.addMain({
        id: t.key,
        provider: 'gemini',
        account: t.acc.id,
        sessionId: t.sessionId,
        cwd: this.cwdOf(t),
        role: MAIN_ROLE,
        startedAt: t.session?.startTime ?? now,
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
        startedAt: t.session?.startTime ?? now,
      });
      t.inOffice = added;
      if (added && t.status === 'working') office.setStatus(t.key, 'working');
    } else {
      // Subagent whose spawner was not seen: shows as a main session instead of disappearing.
      office.addMain({
        id: t.key,
        provider: 'gemini',
        account: t.acc.id,
        sessionId: t.sessionId,
        cwd: this.cwdOf(t),
        role: SUB_ROLE,
        startedAt: t.session?.startTime ?? now,
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

  /** Project of the session: projects.json, else the session's own directories, else a tmp fallback. */
  private cwdOf(t: SessionTracker): string {
    const s = t.session;
    const hash = s?.projectHash ?? '';
    return projectPathOf(this.homeDir, hash) ?? s?.directories[0] ?? join(this.homeDir, 'tmp', hash);
  }

  /** Turns read-but-not-yet-shown messages and tool calls into office activities. */
  private emitPending(t: SessionTracker, boot: boolean): void {
    const s = t.session;
    if (!s) return;
    const now = this.now();
    const feed = !boot;
    s.messages.forEach((m, i) => {
      const mid = msgId(m, i);
      if (!t.seenMsg.has(mid) || t.emittedMsg.has(mid)) return;
      t.emittedMsg.add(mid);
      const at = msgAt(m, now);
      const type = str(m.type);
      const text = messageText(m);
      if (type === 'user') {
        this.activity(t, { id: `${t.key}#m${mid}`, at, kind: 'prompt', icon: '💬', text: short(maskSecrets(text)) || tr('Nova instrução') }, feed);
      } else if (type === 'gemini') {
        const hasTools = (m.toolCalls ?? []).length > 0;
        if (text && !hasTools) {
          this.activity(t, { id: `${t.key}#m${mid}`, at, kind: 'respond', icon: '✍️', text: short(maskSecrets(text)) }, feed);
        }
      }
      const thoughts = Array.isArray(m.thoughts) ? m.thoughts : [];
      thoughts.forEach((th, j) => {
        const tt = thoughtText(th);
        if (!tt) return;
        this.activity(t, { id: `${t.key}#m${mid}th${j}`, at, kind: 'think', icon: '🧠', text: short(maskSecrets(tt)) }, feed);
      });
      (m.toolCalls ?? []).forEach((tc) => {
        const tid = toolId(tc);
        if (!t.seenTool.has(tid)) return; // counted in accumulate(); a call seen twice is emitted once
        this.emitTool(t, tc, tid, at, feed);
      });
    });
  }

  private emitTool(t: SessionTracker, tc: GeminiToolCall, tid: string, at: number, feed: boolean): void {
    const name = str(tc.name) ?? 'tool';
    const desc = describeGeminiTool(name, tc.args);
    const status = str(tc.status) ?? '';
    const activity: Activity = {
      id: `${t.key}#t${tid}`,
      at,
      kind: desc.kind,
      icon: desc.icon,
      text: maskSecrets(desc.text),
      tool: name,
    };
    if (desc.detail) activity.detail = maskSecrets(desc.detail);
    if (/fail|error|denied|cancel/i.test(status)) activity.error = true;
    this.activity(t, activity, feed);
  }

  private activity(t: SessionTracker, activity: Activity, feed: boolean): void {
    if (!t.inOffice) return;
    this.opts.office.addActivity(t.key, activity, true, { feed });
  }

  private applySummary(t: SessionTracker): void {
    if (!t.inOffice) return;
    const summary: TranscriptSummary = {
      tasks: [],
      stats: { toolCalls: t.toolCalls, tokensIn: t.tokensIn, tokensOut: t.tokensOut, subagents: t.subagents } as AgentStats,
    };
    if (t.title) summary.title = t.title;
    if (t.model) summary.model = t.model;
    if (t.firstAt !== undefined) summary.firstAt = t.firstAt;
    if (t.lastAt !== undefined) summary.lastAt = t.lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  // ---------------------------------------------------------------- fs.watch (accelerator)

  private watchChats(acc: GeminiAccount): void {
    if (!this.useWatch) return;
    for (const dir of chatDirs(acc.dir)) this.watchDir(dir);
  }

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // unsupported: polling covers it
    }
  }
}

function msgId(m: GeminiMessage, index: number): string {
  return str(m.id) ?? `n${index}`;
}

function msgAt(m: GeminiMessage, now: number): number {
  return toMs(m.timestamp) ?? now;
}

function toolId(tc: GeminiToolCall): string {
  return str(tc.id) ?? `${str(tc.name) ?? 'tool'}:${short(JSON.stringify(tc.args ?? ''), 24)}`;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
