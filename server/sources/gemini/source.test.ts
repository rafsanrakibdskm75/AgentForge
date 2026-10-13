// Integration of the Gemini source: a temporary GEMINI home (synthetic session files), the
// AccountsService and the Office. The accounts and terminal modules are built in parallel, so the
// test stubs their exact contracts with vi.mock; source.ts keeps the real imports.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import type { TerminalParser } from '../terminal';
import { GeminiSource } from './source';

vi.mock('./accounts', () => ({
  discoverGeminiDirs: () => [] as string[],
  detectGeminiAccounts: (dirs: string[]) =>
    dirs.map((dir: string) => ({ id: '.gemini', configDir: dir, short: 'G', name: 'Gemini G', color: '#f08a3c' })),
}));

vi.mock('./terminal', () => ({
  createGeminiTerminalParser: (): TerminalParser => ({ push: () => [] }),
}));

setQuiet(true);

const SID = '11111111-2222-3333-4444-555555555555';
const SUB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KEY = `.gemini:${SID}`;
const SUB_KEY = `.gemini:${SUB}`;
const HASH = 'abc123hash';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

interface GemHome {
  dir: string;
  chats: string;
  cleanup: () => void;
}

function gemHome(): GemHome {
  const dir = join(tmpdir(), `agentforge-gemini-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const chats = join(dir, 'tmp', HASH, 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ [HASH]: '/projetos/api' }));
  return { dir, chats, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSession(home: GemHome, sessionId: string, rec: Record<string, unknown>, mtime: number): string {
  const path = join(home.chats, `session-${sessionId}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      sessionId,
      projectHash: HASH,
      startTime: mtime - 60_000,
      lastUpdated: mtime,
      kind: 'main',
      directories: [],
      messages: [],
      ...rec,
    }),
  );
  const s = mtime / 1000;
  utimesSync(path, s, s);
  return path;
}

function setup() {
  const home = gemHome();
  cleanups.push(home.cleanup);
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
  const source = new GeminiSource({ accounts, office, dirs: [home.dir], home: home.dir, now, watch: false });
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

describe('fonte do Gemini: presença pelo mtime', () => {
  it('boot com uma sessão nova: principal na sala do projects.json, status working', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = writeSession(
      ctx.home,
      SID,
      {
        messages: [{ id: 'm1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'Explique o módulo de pagamentos' }] }],
      },
      t0 - 1_000,
    );
    ctx.source.boot();
    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'gemini',
      account: '.gemini',
      sessionId: SID,
      roomId: '/projetos/api',
      role: 'Main agent (Gemini)',
      status: 'working',
      title: 'Explique o módulo de pagamentos',
    });
    expect(ctx.source.sources()).toEqual([{ label: '.gemini', provider: 'gemini', path: ctx.home.dir, sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(KEY)).toBe(path);
    expect(ctx.source.terminalParser(KEY)).toBeDefined();
    expect(ctx.source.terminalParser('.gemini:desconhecido')).toBeUndefined();
  });

  it('sessão velha (mtime de 1 h atrás) não entra', () => {
    const ctx = setup();
    const old = Date.now() - 3_600_000;
    writeSession(
      ctx.home,
      SID,
      { messages: [{ id: 'm1', timestamp: old, type: 'user', content: [{ text: 'oi' }] }], lastUpdated: old, startTime: old },
      old,
    );
    ctx.source.boot();
    expect(ctx.agents()).toEqual([]);
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
  });

  it('mensagem nova (arquivo reescrito, mtime maior) vira atividade de prompt/resposta', () => {
    const ctx = setup();
    const t0 = ctx.now();
    writeSession(
      ctx.home,
      SID,
      { messages: [{ id: 'm1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'Liste os arquivos' }] }] },
      t0 - 1_000,
    );
    ctx.source.boot();
    expect(ctx.history().map((a) => a.kind)).toEqual(['prompt']);
    ctx.advance(5_000);
    const m2at = ctx.now();
    writeSession(
      ctx.home,
      SID,
      {
        messages: [
          { id: 'm1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'Liste os arquivos' }] },
          { id: 'm2', timestamp: m2at, type: 'gemini', content: [{ text: 'Aqui estão os arquivos do projeto.' }] },
        ],
      },
      m2at,
    );
    ctx.poll();
    const kinds = ctx.history().map((a) => a.kind);
    expect(kinds).toEqual(['prompt', 'respond']);
    expect(ctx.history()[1]).toMatchObject({ id: `${KEY}#mm2`, icon: '✍️' });
    // Tool call vira atividade de ferramenta.
    ctx.advance(5_000);
    const m3at = ctx.now();
    writeSession(
      ctx.home,
      SID,
      {
        messages: [
          { id: 'm1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'Liste os arquivos' }] },
          { id: 'm2', timestamp: m2at, type: 'gemini', content: [{ text: 'Aqui estão os arquivos do projeto.' }] },
          {
            id: 'm3',
            timestamp: m3at,
            type: 'gemini',
            content: [],
            toolCalls: [{ id: 'tc1', name: 'read_file', args: { path: '/projetos/api/src/app.ts' }, status: 'success' }],
          },
        ],
      },
      m3at,
    );
    ctx.poll();
    const tool = ctx.history().find((a) => a.id === `${KEY}#ttc1`);
    expect(tool).toMatchObject({ kind: 'read', icon: '📖', tool: 'read_file' });
    expect(tool?.text).toContain('app.ts');
  });

  it('segundo poll com o mtime inalterado não duplica atividades', () => {
    const ctx = setup();
    const t0 = ctx.now();
    writeSession(
      ctx.home,
      SID,
      {
        messages: [
          { id: 'm1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'oi' }] },
          { id: 'm2', timestamp: t0 - 500, type: 'gemini', content: [{ text: 'olá!' }] },
        ],
      },
      t0 - 500,
    );
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
    const path = writeSession(ctx.home, SID, { messages: [{ id: 'm1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'oi' }] }] }, t0 - 1_000);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    rmSync(path);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    // A leave notice went out (the text itself is translated; the agent id is not).
    expect(ctx.notices.some((n) => n.agentId === KEY)).toBe(true);
  });
});

describe('fonte do Gemini: subagentes', () => {
  it('subagente cujo sessionId bate com o agentId de um toolCall do pai entra como sub dele', () => {
    const ctx = setup();
    const t0 = ctx.now();
    writeSession(
      ctx.home,
      SID,
      {
        messages: [
          { id: 'm1', timestamp: t0 - 2_000, type: 'user', content: [{ text: 'Pesquise o login' }] },
          {
            id: 'm2',
            timestamp: t0 - 1_500,
            type: 'gemini',
            content: [],
            toolCalls: [{ id: 'tc1', name: 'task', args: { description: 'pesquisa' }, status: 'running', agentId: SUB }],
          },
        ],
      },
      t0 - 1_500,
    );
    writeSession(
      ctx.home,
      SUB,
      {
        kind: 'subagent',
        messages: [{ id: 's1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'Procure onde o login é validado' }] }],
      },
      t0 - 1_000,
    );
    ctx.source.boot();
    expect(ctx.agent(SUB_KEY)).toMatchObject({
      kind: 'sub',
      provider: 'gemini',
      parentId: KEY,
      sessionId: SUB,
      role: 'Subagent (Gemini)',
      title: 'Procure onde o login é validado',
      status: 'working',
      roomId: '/projetos/api',
    });
    // O subagente some da listagem: entrega.
    rmSync(join(ctx.home.chats, `session-${SUB}.json`));
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
    writeSession(
      ctx.home,
      SUB,
      {
        kind: 'subagent',
        messages: [{ id: 's1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'tarefa órfã' }] }],
      },
      t0 - 1_000,
    );
    ctx.source.boot();
    expect(ctx.agent(SUB_KEY)).toMatchObject({ kind: 'main', provider: 'gemini', role: 'Subagent (Gemini)' });
  });
});

describe('fonte do Gemini: transcriptPathOf', () => {
  it('devolve o caminho do arquivo; id desconhecido devolve undefined', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = writeSession(ctx.home, SID, { messages: [{ id: 'm1', timestamp: t0 - 1_000, type: 'user', content: [{ text: 'oi' }] }] }, t0 - 1_000);
    ctx.source.boot();
    expect(ctx.source.transcriptPathOf(KEY)).toBe(path);
    expect(ctx.source.transcriptPathOf('.gemini:nao-existe')).toBeUndefined();
  });
});
