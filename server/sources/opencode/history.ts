// OpenCode terminal history (the 'opencode' HistoryProvider, see sources/source.ts): the recent
// conversations of each OpenCode account (open or finished), listed from the SQLite sessions in the
// account's data dir modified in the last 7 days. A session's conversation is a materialized snapshot
// (server/sources/opencode/terminal.ts), written on resolve(). Child (forked) sessions stay out.
import type { RecentSession } from '../../../shared/types';
import { maskSecrets, truncate } from '../../../shared/activity';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { listSessions, readSessionMessages } from './files';
import { createOpencodeTerminalParser, materializeTranscript } from './terminal';
import { tr } from '../../../shared/i18n';

const TITLE_MAX = 80;
/** An OpenCode session id looks like `ses_…` (the session id is also the transcript file name). */
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/i;

export interface OpenCodeHistoryAccount {
  id: string;
  /** OpenCode data dir read by this process (the mounted one, in Docker). */
  dir: string;
}

export interface OpenCodeHistoryOptions {
  accounts: () => readonly OpenCodeHistoryAccount[];
  /** Main agent of the session, if it is still open in the office. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  /** Where materialized transcripts are written (<dataDir>/opencode-transcripts/). */
  dataDir: string;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

export class OpenCodeHistory implements HistoryProvider {
  readonly provider = 'opencode' as const;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: OpenCodeHistoryOptions) {
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
    const out: RecentSession[] = [];
    for (const acc of this.opts.accounts()) {
      for (const s of listSessions(acc.dir)) {
        if (now - s.updatedAt > this.maxAgeMs) continue;
        // Child (forked) sessions are not your conversations.
        if (s.parentId) continue;
        const agentId = this.opts.openAgentOf(acc.id, s.id);
        const r: RecentSession = {
          account: acc.id,
          provider: 'opencode',
          sessionId: s.id,
          projectDir: encodeCwd(s.directory ?? s.id),
          firstAt: s.createdAt,
          lastAt: s.updatedAt,
          // OpenCode has no transcript byte size; the transcript is a snapshot written on demand.
          size: 0,
          open: !!agentId,
        };
        if (s.directory) r.project = s.directory;
        const title = s.title?.trim() ? s.title : firstUserMessage(acc.dir, s.id);
        if (title) r.title = title;
        if (agentId) r.agentId = agentId;
        out.push(r);
      }
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.limit);
  }

  /**
   * Session `sessionId` of the account, validated: the account must be one of the known ones, the id
   * must be `ses_…`-shaped, and the session must exist in the account's database. The conversation
   * comes from the materialized transcript snapshot.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID.test(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };
    const session = listSessions(acc.dir).find((s) => s.id === sessionId);
    const path = session ? materializeTranscript(acc.dir, this.opts.dataDir, sessionId) : undefined;
    if (!path) return { status: 404, error: tr('sessão não encontrada') };
    return { path, createParser: createOpencodeTerminalParser };
  }
}

/** No generated title on the session row: the first user message (masked, truncated). */
function firstUserMessage(home: string, sessionId: string): string | undefined {
  for (const m of readSessionMessages(home, sessionId)) {
    if (m.role !== 'user' || !m.text.trim()) continue;
    return truncate(maskSecrets(m.text), TITLE_MAX);
  }
  return undefined;
}
