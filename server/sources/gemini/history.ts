// Gemini CLI terminal history (the 'gemini' HistoryProvider, see sources/source.ts): the recent
// conversations of each Gemini account (open or finished), listed from the session files in
// tmp/<projectHash>/chats/ modified in the last 7 days. Each file is read whole (they are small);
// the project comes from projects.json (falling back to the session's own directories[0]) and the
// title from the first user message. Subagents stay out, like Claude Code's subagents. Results are
// cached while the file's mtime and size do not change.
import { realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { maskSecrets, truncate } from '../../../shared/activity';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { chatDirs, listSessionFiles, projectPathOf, readSessionFile, type GeminiMessage, type GeminiSession } from './files';
import { createGeminiTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

const READ_CONCURRENCY = 8;
const TITLE_MAX = 80;
/** A Gemini session id is a UUID (also the session file's name). */
const SESSION_ID = /^[0-9a-f-]{36}$/i;

export interface GeminiHistoryAccount {
  id: string;
  /** Gemini home read by this process (the mounted one, in Docker). */
  dir: string;
}

export interface GeminiHistoryOptions {
  accounts: () => readonly GeminiHistoryAccount[];
  /** Main agent of the session, if it is still open in the office. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

interface Candidate {
  account: string;
  dir: string;
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export class GeminiHistory implements HistoryProvider {
  readonly provider = 'gemini' as const;
  /** Sessions by path, valid while mtime and size are the same. */
  private cache = new Map<string, { mtimeMs: number; size: number; session?: GeminiSession }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: GeminiHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  /** Recent sessions of all accounts, most recent activity first. */
  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) {
      for (const f of listSessionFiles(acc.dir)) {
        if (now - f.mtimeMs > this.maxAgeMs) continue;
        all.push({ account: acc.id, dir: acc.dir, sessionId: f.sessionId, path: f.path, mtimeMs: f.mtimeMs, size: f.size });
      }
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const sessions = await mapLimit(picked, READ_CONCURRENCY, (c) => this.sessionOf(c));
    // Forget files that left the window (the cache does not grow unbounded).
    const keep = new Set(picked.map((c) => c.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);

    const out: RecentSession[] = [];
    picked.forEach((c, i) => {
      const s = sessions[i];
      // Subagents are not your conversations.
      if (!s || s.kind === 'subagent') return;
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      const project = projectPathOf(c.dir, s.projectHash) ?? s.directories[0];
      const r: RecentSession = {
        account: c.account,
        provider: 'gemini',
        sessionId: c.sessionId,
        projectDir: encodeCwd(project ?? s.projectHash),
        firstAt: s.startTime,
        lastAt: s.lastUpdated,
        size: c.size,
        open: !!agentId,
      };
      if (project) r.project = project;
      const title = titleOf(s);
      if (title) r.title = title;
      if (agentId) r.agentId = agentId;
      out.push(r);
    });
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * Session file `sessionId` of the account, validated: the account must be one of the known ones, the id
   * must be UUID-shaped, and the file (links resolved) must stay inside the account's home. Newest wins.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID.test(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };
    let root: string;
    try {
      root = realpathSync(acc.dir);
    } catch {
      return { status: 404, error: tr('sessão não encontrada') };
    }
    const id = sessionId.toLowerCase();
    let best: { path: string; mtimeMs: number } | undefined;
    for (const chats of chatDirs(acc.dir)) {
      for (const ext of ['json', 'jsonl']) {
        const p = join(chats, `session-${id}.${ext}`);
        try {
          const real = realpathSync(p);
          // A link inside the account home pointing outside does not count.
          if (!real.startsWith(root + sep)) continue;
          const st = statSync(real);
          if (!st.isFile()) continue;
          if (!best || st.mtimeMs > best.mtimeMs) best = { path: real, mtimeMs: st.mtimeMs };
        } catch {
          // vanished between listing and reading
        }
      }
    }
    if (best) return { path: best.path, createParser: createGeminiTerminalParser };
    return { status: 404, error: tr('sessão não encontrada') };
  }

  private async sessionOf(c: Candidate): Promise<GeminiSession | undefined> {
    const hit = this.cache.get(c.path);
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.session;
    let session: GeminiSession | undefined;
    try {
      session = readSessionFile(c.path);
    } catch (err) {
      log.warnOnce(`gemini-history:${errMsg(err)}`, tr('Histórico do Gemini: sessão ilegível ({0}).', [errMsg(err)]));
      session = undefined;
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, session });
    return session;
  }
}

/** Text of a message's text parts, joined. */
function messageText(m: GeminiMessage): string {
  const parts: string[] = [];
  for (const raw of m.content ?? []) {
    const t = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

/** No generated title in the file: the first user message (masked, truncated). */
function titleOf(s: GeminiSession): string | undefined {
  for (const m of s.messages) {
    if (m.type !== 'user') continue;
    const text = messageText(m);
    if (text) return truncate(maskSecrets(text), TITLE_MAX);
  }
  return undefined;
}

/** Async map() with at most `limit` tasks at once (keeps the order). */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
