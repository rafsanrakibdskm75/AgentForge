// Antigravity terminal history (the 'antigravity' HistoryProvider, see sources/source.ts): the recent
// conversations of each Antigravity account (open or finished), listed from the conversation catalog in
// the account's home and updated in the last 7 days. Catalog level only: the per-message transcript is a
// protobuf blob, out of scope for now, so resolve() writes a small placeholder file explaining that
// instead of a transcript. Child conversations (parentId set) stay out of the recent list.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider, RecentSession } from '../../../shared/types';
import { truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { createTerminalParser } from '../terminal';
import { encodeCwd } from '../watcher';
import { listConversations, type AntigravityConversation } from './files';

const TITLE_MAX = 80;
/** Catalog ids are opaque strings; anything path-like is rejected (aligned with files.ts validConversationId). */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/;
/** 'antigravity' is not in shared/types.ts Provider yet (the coordinator adds it); the local cast keeps this file compiling until then. */
const PROVIDER: Provider = 'antigravity';

export interface AntigravityHistoryAccount {
  id: string;
  /** Antigravity home read by this process (the mounted one, in Docker). */
  dir: string;
}

export interface AntigravityHistoryOptions {
  accounts: () => readonly AntigravityHistoryAccount[];
  /** Main agent of the conversation, if it is still open in the office. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  /** Where catalog placeholders are written (<dataDir>/antigravity-catalog/). */
  dataDir: string;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

export class AntigravityHistory implements HistoryProvider {
  readonly provider = PROVIDER;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: AntigravityHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  /** Recent conversations of all accounts, most recent activity first. */
  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const out: RecentSession[] = [];
    for (const acc of this.opts.accounts()) {
      for (const c of listConversations(acc.dir)) {
        if (now - c.updatedAt > this.maxAgeMs) continue;
        // Child conversations are not your conversations.
        if (c.parentId) continue;
        const agentId = this.opts.openAgentOf(acc.id, c.id);
        const r: RecentSession = {
          account: acc.id,
          provider: PROVIDER,
          sessionId: c.id,
          projectDir: encodeCwd(c.workspace ?? c.id),
          firstAt: c.createdAt > 0 ? c.createdAt : undefined,
          lastAt: c.updatedAt,
          // Catalog level: there are no transcript bytes.
          size: 0,
          open: !!agentId,
        };
        if (c.workspace) r.project = c.workspace;
        const title = c.title?.trim();
        if (title) r.title = truncate(title, TITLE_MAX);
        if (agentId) r.agentId = agentId;
        out.push(r);
      }
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.limit);
  }

  /**
   * Conversation `sessionId` of the account, validated: the account must be one of the known ones, the
   * id must be an opaque catalog id (nothing path-like), and the conversation must exist in the
   * account's catalog. There is no transcript to hand out at catalog level (protobuf, out of scope),
   * so a placeholder file is written explaining that. Never throws: 400 = invalid id, 404 = unknown
   * account or conversation.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!CONVERSATION_ID.test(sessionId)) return { status: 400, error: tr('id de conversa inválido') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };
    const conversation = listConversations(acc.dir).find((c) => c.id === sessionId);
    if (!conversation) return { status: 404, error: tr('conversa não encontrada') };
    return { path: writePlaceholder(this.opts.dataDir, conversation), createParser: createTerminalParser };
  }
}

/**
 * The placeholder handed out instead of a transcript: the catalog facts plus one honest line saying the
 * full transcript is not available at catalog level.
 */
function writePlaceholder(dataDir: string, c: AntigravityConversation): string {
  const dir = join(dataDir, 'antigravity-catalog');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${c.id}.txt`);
  const lines = [
    c.title?.trim() || tr('Conversa'),
    `${tr('ID')}: ${c.id}`,
    ...(c.workspace ? [`${tr('Espaço de trabalho')}: ${c.workspace}`] : []),
    `${tr('Criada em')}: ${new Date(c.createdAt).toISOString()}`,
    `${tr('Atualizada em')}: ${new Date(c.updatedAt).toISOString()}`,
    '',
    tr(
      'A transcrição completa desta conversa não está disponível: o Antigravity grava as mensagens em protobuf e esta integração lê só o catálogo.',
    ),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
