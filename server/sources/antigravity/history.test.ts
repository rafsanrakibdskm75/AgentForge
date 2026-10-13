// Fixture-based tests for the Antigravity history provider: listing (age window, no child
// conversations, newest first) and the safe resolve() paths. The catalog (files.ts) is built by a
// sibling worker; the test stubs its contract with vi.mock.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { AntigravityHistory } from './history';

interface FakeConversation {
  id: string;
  title?: string;
  workspace?: string;
  status?: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
}

const store = vi.hoisted(() => ({
  conversations: new Map<string, FakeConversation[]>(),
}));

vi.mock('./files', () => ({
  listConversations: (dir: string): FakeConversation[] => store.conversations.get(dir)?.map((c) => ({ ...c })) ?? [],
  isAntigravityHome: () => true,
}));

let cleanups: Array<() => void> = [];
afterEach(() => {
  store.conversations.clear();
  for (const c of cleanups) c();
  cleanups = [];
});

const T0 = 1_760_000_000_000; // fixed "now"
const DAY = 24 * 3600_000;
const NEW1 = 'conv-new1aaa';
const NEW2 = 'conv-new2bbb';
const CHILD = 'conv-childccc';
const OLD = 'conv-oldddd';
const ACC2 = 'conv-acc2eee';

function conv(id: string, o: { title?: string; workspace?: string; parentId?: string; updated: number }): FakeConversation {
  return { id, title: o.title, workspace: o.workspace, parentId: o.parentId, createdAt: o.updated - 60_000, updatedAt: o.updated };
}

function setup(o: { limit?: number; openAgentOf?: (account: string, sessionId: string) => string | undefined } = {}) {
  const a1 = tempDir('agentforge-antigravity-hist-a1');
  const a2 = tempDir('agentforge-antigravity-hist-a2');
  const data = tempDir('agentforge-antigravity-hist-data');
  cleanups.push(a1.cleanup, a2.cleanup, data.cleanup);
  const history = new AntigravityHistory({
    accounts: () => [
      { id: 'acc1', dir: a1.dir },
      { id: 'acc2', dir: a2.dir },
    ],
    openAgentOf: o.openAgentOf ?? (() => undefined),
    dataDir: data.dir,
    now: () => T0,
    limit: o.limit,
  });
  return { a1: a1.dir, a2: a2.dir, dataDir: data.dir, history };
}

function seed(a1: string, a2: string) {
  store.conversations.set(a1, [
    conv(NEW1, { title: 'Refatorar o login', workspace: '/projetos/api', updated: T0 - 3_600_000 }),
    conv(NEW2, { title: 'Revisar o diff', workspace: '/projetos/web', updated: T0 - 7_200_000 }),
    conv(CHILD, { title: 'Filha', parentId: NEW1, updated: T0 - 1_800_000 }),
    conv(OLD, { title: 'Velha', updated: T0 - 8 * DAY }),
  ]);
  store.conversations.set(a2, [conv(ACC2, { title: 'Outra conta', workspace: '/projetos/outro', updated: T0 - 5_400_000 })]);
}

describe('histórico do Antigravity', () => {
  it('lista só conversas recentes, sem filhas, da mais nova para a mais antiga', async () => {
    const ctx = setup();
    seed(ctx.a1, ctx.a2);
    const list = await ctx.history.list();
    expect(list.map((r) => r.sessionId)).toEqual([NEW1, ACC2, NEW2]);
    expect(list[0]).toMatchObject({
      account: 'acc1',
      provider: 'antigravity',
      sessionId: NEW1,
      title: 'Refatorar o login',
      project: '/projetos/api',
      size: 0,
      open: false,
    });
    expect(list[0].projectDir).toBeTruthy();
    expect(list[0].firstAt).toBeLessThan(list[0].lastAt);
  });

  it('respeita o limite', async () => {
    const ctx = setup({ limit: 2 });
    seed(ctx.a1, ctx.a2);
    expect((await ctx.history.list()).map((r) => r.sessionId)).toEqual([NEW1, ACC2]);
  });

  it('marca a conversa aberta com o agente', async () => {
    const ctx = setup({ openAgentOf: (account, sessionId) => (account === 'acc1' && sessionId === NEW1 ? 'agent-1' : undefined) });
    seed(ctx.a1, ctx.a2);
    const list = await ctx.history.list();
    expect(list[0]).toMatchObject({ open: true, agentId: 'agent-1' });
    expect(list[1].open).toBe(false);
  });

  it('hasAccount conhece só as contas registradas', () => {
    const ctx = setup();
    expect(ctx.history.hasAccount('acc1')).toBe(true);
    expect(ctx.history.hasAccount('nope')).toBe(false);
  });
});

describe('histórico do Antigravity: resolve()', () => {
  it('devolve um placeholder honesto em vez da transcrição', () => {
    const ctx = setup();
    seed(ctx.a1, ctx.a2);
    const res = ctx.history.resolve('acc1', NEW1);
    expect(res).not.toHaveProperty('status');
    const { path, createParser } = res as { path: string; createParser: () => unknown };
    expect(existsSync(path)).toBe(true);
    expect(typeof createParser).toBe('function');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('Refatorar o login');
    expect(content).toContain('/projetos/api');
    expect(content).toContain(NEW1);
    // The honest line: full transcripts are protobuf, out of scope at catalog level.
    expect(content).toContain('protobuf');
  });

  it('id inválido dá 400', () => {
    const ctx = setup();
    seed(ctx.a1, ctx.a2);
    for (const bad of ['', '../x', 'a/b', 'conv com espaço']) {
      expect(ctx.history.resolve('acc1', bad)).toMatchObject({ status: 400 });
    }
  });

  it('conta desconhecida dá 404', () => {
    const ctx = setup();
    seed(ctx.a1, ctx.a2);
    expect(ctx.history.resolve('nope', NEW1)).toMatchObject({ status: 404 });
  });

  it('conversa desconhecida dá 404', () => {
    const ctx = setup();
    seed(ctx.a1, ctx.a2);
    expect(ctx.history.resolve('acc1', 'conv-que-nao-existe')).toMatchObject({ status: 404 });
  });
});
