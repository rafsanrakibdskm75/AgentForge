// Antigravity agent source (AgentSource 'antigravity', see sources/source.ts): watches the conversation
// catalog of each Antigravity account (the sibling's files.ts contract) and feeds the Office.
//
// Catalog level only: per-message transcripts are protobuf blobs, out of scope for now, so no message
// is ever read and no transcript is ever materialized. What the office shows per conversation is its
// title (or a generic conversation activity) — never invented messages.
//
// Presence: a conversation is OPEN while its `updatedAt` is within PRESENCE_MS. A conversation missing
// from the listing for longer than CLOSE_AFTER_MISSING_MS is closed; an archived one leaves right away.
// Subagents are conversations with `parentId`; they enter as subs of the parent main conversation of the
// same account while working and are completed when they go quiet (or disappear). A subagent whose
// parent was never seen shows as a main session instead of disappearing.
//
// Status: `updatedAt` within WORKING_MS means 'working', otherwise 'idle'.
// Boot is short and synchronous, with endBoot in a `finally`.
import { watch, type FSWatcher } from 'node:fs';
import type { Activity, AgentStatus, Provider, SourceInfo } from '../../../shared/types';
import { truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { detectAntigravityAccounts } from './accounts';
import { listConversations, type AntigravityConversation } from './files';

/** A conversation updated within this window counts as an open conversation. */
export const PRESENCE_MS = 10 * 60_000;
/** Time a conversation must be missing from the listing before it is treated as closed. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** `updatedAt` within this window means 'working'. */
const WORKING_MS = 90_000;
/** 'antigravity' is not in shared/types.ts Provider yet (the coordinator adds it); the local cast keeps this file compiling until then. */
const PROVIDER: Exclude<Provider, 'claude'> = 'antigravity';
const MAIN_ROLE = tr('Agente principal (Antigravity)');
const SUB_ROLE = tr('Subagente (Antigravity)');
const GENERIC_ACTIVITY = tr('Conversa');

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Antigravity homes read by this process (one per account). */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Disables fs.watch (tests). */
  watch?: boolean;
}

interface AntigravityAccount {
  id: string;
  /** Home read by this process. */
  dir: string;
  /** Home for display (on Docker, the host's one). */
  configDir: string;
  error?: string;
}

interface ConversationTracker {
  key: string;
  acc: AntigravityAccount;
  conversationId: string;
  kind: 'main' | 'sub';
  conversation?: AntigravityConversation;
  /** Key of the parent main conversation, for subagents. */
  parentKey?: string;
  inOffice: boolean;
  status: AgentStatus;
  /** When the status was decided (a poll timestamp): a decision made with an older clock never overrides it. */
  statusAt: number;
  missingSince?: number;
  title?: string;
  /** The catalog activity (title) was already added to the office. */
  announced: boolean;
  subagents: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export class AntigravitySource implements AgentSource {
  readonly provider = PROVIDER;
  private accs: AntigravityAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private trackers = new Map<string, ConversationTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private readonly now: () => number;
  private readonly useWatch: boolean;
  private stopped = false;

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.now = opts.now ?? Date.now;
    this.useWatch = opts.watch ?? true;
    const env = opts.env ?? process.env;
    const existing = opts.accounts.entries();
    this.detected = detectAntigravityAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: existing.map((e) => e.detected.short), colors: existing.map((e) => e.detected.color) },
    });
    this.register();
  }

  /** Registers (again) the accounts with the AccountsService, always in the same order: ids never change. */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      PROVIDER,
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

  /** Antigravity accounts (final ids, from the AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  /** Rebuilds the open conversations without notifications. Synchronous and short. */
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
      for (const t of this.trackers.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: PROVIDER, path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(_agentId: string): string | undefined {
    // Catalog level: no transcripts are ever read or materialized.
    return undefined;
  }

  // --------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`antigravity-poll:${errMsg(err)}`, tr('Antigravity: falha no ciclo de leitura: {0}', [errMsg(err)]));
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
      let conversations: AntigravityConversation[];
      try {
        conversations = listConversations(acc.dir);
      } catch (err) {
        acc.error = errMsg(err);
        continue;
      }
      delete acc.error;
      const children = new Map<string, number>();
      for (const c of conversations) if (c.parentId) children.set(c.parentId, (children.get(c.parentId) ?? 0) + 1);
      for (const c of conversations) {
        const key = `${acc.id}:${c.id}`;
        if (c.status === 'archived') {
          // Archived = finished: a tracked one leaves right away, a new one never enters.
          const t = this.trackers.get(key);
          if (t) {
            this.leave(t);
            this.trackers.delete(key);
          }
          continue;
        }
        seen.add(key);
        let t = this.trackers.get(key);
        if (!t) {
          t = this.newTracker(acc, c.id);
          this.trackers.set(key, t);
        }
        try {
          this.syncConversation(t, c, now, boot, children.get(c.id) ?? 0);
        } catch (err) {
          log.warnOnce(`antigravity-conversation:${key}:${errMsg(err)}`, tr('Antigravity: conversa {0}: {1}', [key, errMsg(err)]));
        }
      }
      this.watchDir(acc);
    }
    for (const [key, t] of [...this.trackers]) {
      if (seen.has(key)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.leave(t);
      this.trackers.delete(key);
    }
    // Subagents whose parent entered this cycle: now the fallback to a main session may settle.
    for (const t of this.trackers.values()) {
      if (t.kind === 'sub' && !t.inOffice && seen.has(t.key)) {
        this.reconcile(t, now, boot, true);
      }
    }
  }

  private newTracker(acc: AntigravityAccount, conversationId: string): ConversationTracker {
    return {
      key: `${acc.id}:${conversationId}`,
      acc,
      conversationId,
      kind: 'main',
      inOffice: false,
      status: 'idle',
      statusAt: 0,
      announced: false,
      subagents: 0,
    };
  }

  /** One cycle of a listed conversation: folds what is new, decides status and reconciles office presence. */
  private syncConversation(t: ConversationTracker, c: AntigravityConversation, now: number, boot: boolean, childCount: number): void {
    delete t.missingSince;
    t.conversation = c;
    t.kind = c.parentId ? 'sub' : 'main';
    t.subagents = childCount;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // left the office (grace period ended)
    const title = str(c.title);
    if (title) t.title = truncate(title, 80);
    this.decideStatus(t, now);
    this.reconcile(t, now, boot);
    if (t.inOffice) {
      this.applySummary(t);
      if (t.kind === 'main') this.opts.office.fillWorkingActivity(t.key);
    }
  }

  /** Status from the newest information: a recent updatedAt means 'working'. The decision is timestamped with `now`: idleness is a judgment made now, not an event at updatedAt (a quiet conversation's updatedAt may never move again, which must still flip working -> idle). */
  private decideStatus(t: ConversationTracker, now: number): void {
    const c = t.conversation;
    if (!c) return;
    const status: AgentStatus = now - c.updatedAt <= WORKING_MS ? 'working' : 'idle';
    this.decide(t, status, now, true);
  }

  /**
   * Changes the status on an edge (new information): older information than the last decision never wins.
   * `live` = applies to the office now (the initial load only stores; the status enters with the agent).
   */
  private decide(t: ConversationTracker, status: AgentStatus, at: number, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    if (t.status === status) return;
    t.status = status;
    if (live) this.statusToOffice(t);
  }

  /** Brings the tracker status to the office (a quiet subagent is completed; a busy one comes back). */
  private statusToOffice(t: ConversationTracker): void {
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

  /** Should the conversation be in the office now? Enters, leaves or changes room accordingly. */
  private reconcile(t: ConversationTracker, now: number, boot: boolean, settle = false): void {
    // The parent may have entered this same cycle (conversations are read newest-first, not hierarchy-first).
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
    if (!t.inOffice) this.enter(t, now, boot);
    // No per-message activities at catalog level; the title activity is added once, on enter.
  }

  /**
   * `settle` = every candidate parent had its chance this cycle: a subagent still without a parent falls
   * back to a main session instead of waiting (and disappearing) forever.
   */
  private wanted(t: ConversationTracker, now: number, settle: boolean): boolean {
    const c = t.conversation;
    if (!c) return false;
    if (now - c.updatedAt > PRESENCE_MS) return false;
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
  private officeKind(t: ConversationTracker): 'main' | 'sub' | undefined {
    const k = this.opts.office.get(t.key)?.kind;
    return k === 'sub' ? 'sub' : k === 'main' ? 'main' : undefined;
  }

  /** Parent of a subagent: a tracked conversation of the same account with the matching id, in the office. */
  private findParent(t: ConversationTracker): string | undefined {
    const parentId = t.conversation?.parentId;
    if (!parentId) return undefined;
    const office = this.opts.office;
    for (const u of this.trackers.values()) {
      if (u === t || u.acc !== t.acc || u.conversationId !== parentId) continue;
      if (office.has(u.key)) return u.key;
    }
    return undefined;
  }

  private enter(t: ConversationTracker, now: number, boot: boolean): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.addMain({
        id: t.key,
        provider: PROVIDER,
        account: t.acc.id,
        sessionId: t.conversationId,
        cwd: this.cwdOf(t),
        role: MAIN_ROLE,
        startedAt: t.conversation && t.conversation.createdAt > 0 ? t.conversation.createdAt : now,
        status: t.status,
      });
      t.inOffice = office.has(t.key);
      if (t.inOffice) office.setStatus(t.key, t.status);
    } else if (t.parentKey) {
      const added = office.addSub({
        id: t.key,
        parentId: t.parentKey,
        sessionId: t.conversationId,
        role: SUB_ROLE,
        title: t.title,
        background: false,
        startedAt: t.conversation && t.conversation.createdAt > 0 ? t.conversation.createdAt : now,
      });
      t.inOffice = added;
      if (added && t.status === 'working') office.setStatus(t.key, 'working');
    } else {
      // Subagent whose spawner was not seen: shows as a main session instead of disappearing.
      office.addMain({
        id: t.key,
        provider: PROVIDER,
        account: t.acc.id,
        sessionId: t.conversationId,
        cwd: this.cwdOf(t),
        role: SUB_ROLE,
        startedAt: t.conversation && t.conversation.createdAt > 0 ? t.conversation.createdAt : now,
        status: t.status,
      });
      t.inOffice = office.has(t.key);
    }
    if (t.inOffice) this.announce(t, now, boot);
  }

  /**
   * The single honest activity of a catalog-level conversation: its title (or a generic conversation
   * activity when the catalog has none). Added once, on enter — never invented messages.
   */
  private announce(t: ConversationTracker, now: number, boot: boolean): void {
    if (t.announced) return;
    t.announced = true;
    const activity: Activity = {
      id: `${t.key}#catalog`,
      at: t.conversation && t.conversation.createdAt > 0 ? t.conversation.createdAt : now,
      kind: 'other',
      icon: '💬',
      text: truncate(t.title || GENERIC_ACTIVITY, 46),
    };
    this.opts.office.addActivity(t.key, activity, true, { feed: !boot });
  }

  /** Leaves the office: a main session closes; a subagent delivers (if it had not already). */
  private leave(t: ConversationTracker): void {
    if (!t.inOffice) return;
    if (this.officeKind(t) === 'sub') this.opts.office.completeSub(t.key);
    else this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }

  /** Working directory of the conversation: its workspace, else the account home. */
  private cwdOf(t: ConversationTracker): string {
    return str(t.conversation?.workspace) ?? t.acc.dir;
  }

  /** The catalog facts the office can show: the title (no tasks, no token stats at catalog level). */
  private applySummary(t: ConversationTracker): void {
    if (!t.inOffice || !t.title) return;
    const summary: TranscriptSummary = {
      title: t.title,
      tasks: [],
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: t.subagents },
    };
    this.opts.office.applyTranscript(t.key, summary);
  }

  // --------------------------------------------------------------- fs.watch (accelerator)

  private watchDir(acc: AntigravityAccount): void {
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
