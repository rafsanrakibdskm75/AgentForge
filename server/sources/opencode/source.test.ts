// Integration of the OpenCode source: a temporary OpenCode data dir (synthetic SQLite database),
// the AccountsService and the Office. The accounts and terminal modules are built in parallel, so the
// test stubs their exact contracts with vi.mock; source.ts keeps the real imports.
import { DatabaseSync, describeSqlite } from './sqlite-test';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import type { TerminalParser } from '../terminal';
import { OpenCodeSource } from './source';

vi.mock('./accounts', () => ({
  discoverOpencodeDirs: () => [] as string[],
  detectOpencodeAccounts: (dirs: string[]) =>
    dirs.map((dir: string) => ({ id: '.opencode', configDir: dir, short: 'O', name: 'OpenCode O', color: '#4aa8e8' })),
}));

vi.mock('./terminal', () => ({
  materializeTranscript: (_home: string, _dataDir: string, sessionId: string) => `/tmp/oc-transcripts/${sessionId}.txt`,
  createOpencodeTerminalParser: (): TerminalParser => ({ push: () => [] }),
}));

setQuiet(true);

const SID = 'ses_main_001';
const SUB = 'ses_child_002';
const ORPHAN = 'ses_orphan_003';
const KEY = `.opencode:${SID}`;
const SUB_KEY = `.opencode:${SUB}`;
const ORPHAN_KEY = `.opencode:${ORPHAN}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

interface OcHome {
  dir: string;
  db: string;
}

function ocHome(): OcHome {
  const tmp = tempDir('agentforge-opencode-');
  cleanups.push(tmp.cleanup);
  const db = join(tmp.dir, 'opencode.db');
  const sqlite = new DatabaseSync(db);
  try {
    sqlite.exec(`
      CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
        cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER,
        time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE todo(session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER);
    `);
  } finally {
    sqlite.close();
  }
  return { dir: tmp.dir, db };
}

function withDb(home: OcHome, fn: (db: DatabaseSync) => void): void {
  const sqlite = new DatabaseSync(home.db);
  try {
    fn(sqlite);
  } finally {
    sqlite.close();
  }
}

function insertSession(
  home: OcHome,
  s: {
    id: string;
    parentId?: string;
    directory?: string;
    title?: string;
    cost?: number;
    tokensIn?: number;
    tokensOut?: number;
    createdAt: number;
    updatedAt: number;
    archivedAt?: number;
  },
): void {
  withDb(home, (db) => {
    db.prepare(
      `INSERT INTO session (id, parent_id, directory, title, cost, tokens_input, tokens_output,
         time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.id,
      s.parentId ?? null,
      s.directory ?? null,
      s.title ?? null,
      s.cost ?? null,
      s.tokensIn ?? null,
      s.tokensOut ?? null,
      s.createdAt,
      s.updatedAt,
      s.archivedAt ?? null,
    );
  });
}

function touchSession(home: OcHome, id: string, updatedAt: number): void {
  withDb(home, (db) => {
    db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(updatedAt, id);
  });
}

function archiveSession(home: OcHome, id: string, archivedAt: number): void {
  withDb(home, (db) => {
    db.prepare('UPDATE session SET time_archived = ? WHERE id = ?').run(archivedAt, id);
  });
}

function deleteSession(home: OcHome, id: string): void {
  withDb(home, (db) => {
    db.prepare('DELETE FROM session WHERE id = ?').run(id);
  });
}

function insertMessage(home: OcHome, id: string, sessionId: string, role: 'user' | 'assistant', time: number, text: string): void {
  withDb(home, (db) => {
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
      id,
      sessionId,
      time,
      JSON.stringify({ role }),
    );
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
      `p-${id}`,
      id,
      sessionId,
      time,
      JSON.stringify({ type: 'text', text }),
    );
  });
}

function insertTool(
  home: OcHome,
  id: string,
  messageId: string,
  sessionId: string,
  time: number,
  tool: string,
  input: unknown,
  status: string,
  output?: string,
): void {
  withDb(home, (db) => {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
      id,
      messageId,
      sessionId,
      time,
      JSON.stringify({ type: 'tool', tool, state: { status, input, output } }),
    );
  });
}

function insertTodo(home: OcHome, sessionId: string, content: string, status: string, position: number): void {
  withDb(home, (db) => {
    db.prepare('INSERT INTO todo (session_id, content, status, position) VALUES (?, ?, ?, ?)').run(sessionId, content, status, position);
  });
}

function setup() {
  const home = ocHome();
  let clock = Date.now();
  const now = () => clock;
  const accounts = new AccountsService({ dirs: [], home: home.dir, env: {}, now, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  const dataDir = join(home.dir, 'data');
  const source = new OpenCodeSource({ accounts, office, dirs: [home.dir], dataDir, home: home.dir, now, watch: false });
  // Stops before the folders are deleted (no scheduled cycle runs after).
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  return {
    home,
    accounts,
    office,
    source,
    notices,
    now,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id = KEY): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    history(id = KEY) {
      return office.detail(id)?.history ?? [];
    },
  };
}

describeSqlite('fonte do OpenCode: presença pelo time_updated', () => {
  it('boot com uma sessão nova: principal entra working, com título, stats e transcript', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, {
      id: SID,
      directory: '/projetos/api',
      title: 'Fix login',
      cost: 0.02,
      tokensIn: 1200,
      tokensOut: 300,
      createdAt: t0 - 60_000,
      updatedAt: t0 - 1_000,
    });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'Explique o módulo de pagamentos');
    ctx.source.boot();
    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'opencode',
      account: '.opencode',
      sessionId: SID,
      roomId: '/projetos/api',
      role: 'Main agent (OpenCode)',
      status: 'working',
      title: 'Fix login',
    });
    expect(a.stats).toMatchObject({ toolCalls: 0, tokensIn: 1200, tokensOut: 300, subagents: 0, costUSD: 0.02 });
    expect(ctx.source.sources()).toEqual([{ label: '.opencode', provider: 'opencode', path: ctx.home.dir, sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(KEY)).toBe(`/tmp/oc-transcripts/${SID}.txt`);
    expect(ctx.source.terminalParser(KEY)).toBeDefined();
    expect(ctx.source.terminalParser('.opencode:desconhecido')).toBeUndefined();
    expect(ctx.source.transcriptPathOf('.opencode:desconhecido')).toBeUndefined();
  });

  it('título cai para a primeira mensagem do usuário quando a sessão não tem título', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'Explique o módulo de pagamentos');
    ctx.source.boot();
    expect(ctx.agent()?.title).toBe('Explique o módulo de pagamentos');
  });

  it('sessão velha (time_updated de 1 h atrás) não entra', () => {
    const ctx = setup();
    const old = Date.now() - 3_600_000;
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: old, updatedAt: old });
    insertMessage(ctx.home, 'm1', SID, 'user', old, 'oi');
    ctx.source.boot();
    expect(ctx.agents()).toEqual([]);
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
  });

  it('sessão arquivada (time_archived) não entra, mesmo com time_updated recente', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, {
      id: SID,
      directory: '/projetos/api',
      createdAt: t0 - 60_000,
      updatedAt: t0 - 1_000,
      archivedAt: t0 - 500,
    });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'oi');
    ctx.source.boot();
    expect(ctx.agents()).toEqual([]);
  });

  it('sessão arquivada enquanto presente sai na hora', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'oi');
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    archiveSession(ctx.home, SID, ctx.now());
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.notices.some((n) => n.agentId === KEY)).toBe(true);
  });

  it('sem time_updated recente o status cai para idle (mas a sessão continua presente)', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'oi');
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(100_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.source.transcriptPathOf(KEY)).toBeDefined();
  });

  it('mensagem e tool part novos viram atividades; erro na ferramenta marca error', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'Liste os arquivos');
    ctx.source.boot();
    expect(ctx.history().map((a) => a.kind)).toEqual(['prompt']);
    expect(ctx.history()[0]).toMatchObject({ id: `${KEY}#mm1`, icon: '💬' });

    ctx.advance(5_000);
    const m2at = ctx.now();
    insertMessage(ctx.home, 'm2', SID, 'assistant', m2at, 'Aqui estão os arquivos do projeto.');
    touchSession(ctx.home, SID, m2at);
    ctx.poll();
    expect(ctx.history().map((a) => a.kind)).toEqual(['prompt', 'respond']);
    expect(ctx.history()[1]).toMatchObject({ id: `${KEY}#mm2`, icon: '✏️' });

    // Tool call vira atividade de ferramenta (mensagem do assistente sem texto não vira 'respond').
    ctx.advance(5_000);
    const m3at = ctx.now();
    insertMessage(ctx.home, 'm3', SID, 'assistant', m3at, '');
    insertTool(ctx.home, 'part1', 'm3', SID, m3at, 'read', { path: '/projetos/api/src/app.ts' }, 'completed', 'conteúdo');
    touchSession(ctx.home, SID, m3at);
    ctx.poll();
    const kinds = ctx.history().map((a) => a.kind);
    expect(kinds).toEqual(['prompt', 'respond', 'read']);
    const tool = ctx.history().find((a) => a.id === `${KEY}#ppart1`);
    expect(tool).toMatchObject({ kind: 'read', icon: '📖', tool: 'read' });
    expect(tool?.text).toContain('app.ts');
    expect(tool?.error).not.toBe(true);

    // Tool com erro: error: true.
    ctx.advance(5_000);
    const m4at = ctx.now();
    insertMessage(ctx.home, 'm4', SID, 'assistant', m4at, '');
    insertTool(ctx.home, 'part2', 'm4', SID, m4at, 'bash', { command: 'rm -rf /' }, 'error');
    touchSession(ctx.home, SID, m4at);
    ctx.poll();
    const failed = ctx.history().find((a) => a.id === `${KEY}#ppart2`);
    expect(failed).toMatchObject({ tool: 'bash', error: true });
    expect(ctx.agent()?.stats.toolCalls).toBe(2);
  });

  it('segundo poll sem mudanças não duplica atividades', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 500 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'oi');
    insertMessage(ctx.home, 'm2', SID, 'assistant', t0 - 500, 'olá!');
    ctx.source.boot();
    const before = ctx.history().length;
    expect(before).toBe(2);
    ctx.advance(1_000);
    ctx.poll();
    ctx.poll();
    expect(ctx.history().length).toBe(before);
  });

  it('sessão que some da listagem fecha depois da folga', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'oi');
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    deleteSession(ctx.home, SID);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    // A leave notice went out (the text itself is translated; the agent id is not).
    expect(ctx.notices.some((n) => n.agentId === KEY)).toBe(true);
  });

  it('todos da sessão viram tarefas no resumo', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 1_000, 'oi');
    insertTodo(ctx.home, SID, 'Escrever testes', 'completed', 0);
    insertTodo(ctx.home, SID, 'Rodar o build', 'in_progress', 1);
    insertTodo(ctx.home, SID, 'Revisar o diff', 'pending', 2);
    ctx.source.boot();
    expect(ctx.agent()?.tasks).toEqual([
      { id: `${KEY}#todo0`, title: 'Escrever testes', status: 'completed' },
      { id: `${KEY}#todo1`, title: 'Rodar o build', status: 'in_progress' },
      { id: `${KEY}#todo2`, title: 'Revisar o diff', status: 'pending' },
    ]);
  });
});

describeSqlite('fonte do OpenCode: subagentes', () => {
  it('sessão com parent_id entra como sub do pai', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: SID, directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 2_000 });
    insertMessage(ctx.home, 'm1', SID, 'user', t0 - 2_000, 'Pesquise o login');
    // The child is newer than the parent: exercises the settle pass at the end of the poll.
    insertSession(ctx.home, { id: SUB, parentId: SID, directory: '/projetos/api', createdAt: t0 - 1_500, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 's1', SUB, 'user', t0 - 1_000, 'Procure onde o login é validado');
    ctx.source.boot();
    expect(ctx.agent(SUB_KEY)).toMatchObject({
      kind: 'sub',
      provider: 'opencode',
      parentId: KEY,
      sessionId: SUB,
      role: 'Subagent (OpenCode)',
      title: 'Procure onde o login é validado',
      status: 'working',
      roomId: '/projetos/api',
    });
    expect(ctx.agent()?.stats.subagents).toBe(1);
    // O subagente some da listagem: entrega.
    deleteSession(ctx.home, SUB);
    ctx.poll();
    expect(ctx.agent(SUB_KEY)?.status).toBe('working');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent(SUB_KEY)?.status).toBe('done');
    expect(ctx.notices.some((n) => n.agentId === SUB_KEY)).toBe(true);
    expect(ctx.agent()?.status).toBe('working');
  });

  it('subagente sem pai conhecido vira principal em vez de sumir', () => {
    const ctx = setup();
    const t0 = ctx.now();
    insertSession(ctx.home, { id: ORPHAN, parentId: 'ses_missing', directory: '/projetos/api', createdAt: t0 - 60_000, updatedAt: t0 - 1_000 });
    insertMessage(ctx.home, 's1', ORPHAN, 'user', t0 - 1_000, 'tarefa órfã');
    ctx.source.boot();
    expect(ctx.agent(ORPHAN_KEY)).toMatchObject({ kind: 'main', provider: 'opencode', role: 'Subagent (OpenCode)' });
  });
});
