// Integration of the Antigravity source: a fake conversation catalog (the sibling's files.ts contract),
// the AccountsService and the Office. files.ts and accounts.ts are built by a sibling worker, so the
// test stubs their exact contracts with vi.mock; source.ts keeps the real imports.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { AntigravitySource } from './source';

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
  failOn: new Set<string>(),
}));

vi.mock('./files', () => ({
  listConversations: (dir: string): FakeConversation[] => {
    if (store.failOn.has(dir)) throw new Error('catalog unreadable');
    return store.conversations.get(dir)?.map((c) => ({ ...c })) ?? [];
  },
  isAntigravityHome: () => true,
}));

vi.mock('./accounts', () => ({
  discoverAntigravityDirs: () => [] as string[],
  detectAntigravityAccounts: (dirs: string[]) =>
    dirs.map((dir: string) => ({ id: '.antigravity', configDir: dir, short: 'A', name: 'Antigravity A', color: '#7c5cff' })),
}));

setQuiet(true);

const MAIN = 'conv-main-001';
const MAIN2 = 'conv-main-002';
const SUB = 'conv-sub-003';
const ORPHAN = 'conv-orphan-004';
const KEY = `.antigravity:${MAIN}`;
const KEY2 = `.antigravity:${MAIN2}`;
const SUB_KEY = `.antigravity:${SUB}`;
const ORPHAN_KEY = `.antigravity:${ORPHAN}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  store.conversations.clear();
  store.failOn.clear();
  for (const c of cleanups) c();
  cleanups = [];
});

function conv(id: string, o: Partial<FakeConversation> & { t0: number; ageMs?: number }): FakeConversation {
  const age = o.ageMs ?? 1_000;
  return {
    id,
    title: o.title,
    workspace: o.workspace,
    status: o.status,
    parentId: o.parentId,
    createdAt: o.t0 - 60_000,
    updatedAt: o.t0 - age,
  };
}

function setup() {
  const tmp = tempDir('agentforge-antigravity-');
  cleanups.push(tmp.cleanup);
  const dir = tmp.dir;
  let clock = Date.now();
  const now = () => clock;
  const accounts = new AccountsService({ dirs: [], home: dir, env: {}, now, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  const source = new AntigravitySource({ accounts, office, dirs: [dir], home: dir, now, watch: false });
  // Stops before the folders are deleted (no scheduled cycle runs after).
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  return {
    dir,
    accounts,
    office,
    source,
    notices,
    now,
    advance(ms: number) {
      clock += ms;
    },
    setConvs(convs: FakeConversation[]) {
      store.conversations.set(dir, convs);
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

describe('fonte do Antigravity', () => {
  it('conversas recentes entram como principais trabalhando', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([
      conv(MAIN, { t0, title: 'Refatorar o login', workspace: '/projetos/api' }),
      conv(MAIN2, { t0, title: 'Revisar o diff', workspace: '/projetos/web' }),
    ]);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({
      kind: 'main',
      provider: 'antigravity',
      sessionId: MAIN,
      role: tr('Agente principal (Antigravity)'),
      status: 'working',
      title: 'Refatorar o login',
    });
    expect(ctx.agent(KEY2)?.status).toBe('working');
    // The single honest catalog activity carries the title; no messages are invented.
    const hist = ctx.history();
    expect(hist).toHaveLength(1);
    expect(hist[0].text).toBe('Refatorar o login');
  });

  it('conversa sem título ganha a atividade genérica', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([conv(MAIN, { t0, workspace: '/projetos/api' })]);
    ctx.source.boot();
    expect(ctx.history()[0].text).toBe(tr('Conversa'));
  });

  it('conversa antiga fica ociosa, além da presença não entra', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([
      conv(MAIN, { t0, ageMs: 5 * 60_000, title: 'Antiga' }),
      conv(MAIN2, { t0, ageMs: 11 * 60_000, title: 'Velha demais' }),
    ]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent(KEY2)).toBeUndefined();
  });

  it('working vira idle com o tempo', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([conv(MAIN, { t0, title: 'Esfria' })]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(2 * 60_000);
    ctx.setConvs([conv(MAIN, { t0, ageMs: 2 * 60_000, title: 'Esfria' })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('conversa que some da listagem fecha depois da folga', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([conv(MAIN, { t0, title: 'Some' })]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    ctx.setConvs([]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.notices.some((n) => n.agentId === KEY)).toBe(true);
  });

  it('conversa arquivada nunca entra; arquivada no meio sai na hora', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([conv(MAIN, { t0, status: 'archived', title: 'Morta' })]);
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
    ctx.setConvs([conv(MAIN, { t0, title: 'Viva' })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    ctx.setConvs([conv(MAIN, { t0, status: 'archived', title: 'Viva' })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('falha de leitura não derruba o ciclo e vira erro na conta', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([conv(MAIN, { t0, title: 'Resiliente' })]);
    ctx.source.boot();
    store.failOn.add(ctx.dir);
    expect(() => (ctx.source as unknown as { safePoll(): void }).safePoll()).not.toThrow();
    expect(ctx.source.sources()[0].ok).toBe(false);
    store.failOn.clear();
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.source.sources()[0].ok).toBe(true);
  });

  it('sources() lista a conta com a contagem de sessões', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([conv(MAIN, { t0 }), conv(MAIN2, { t0 })]);
    ctx.source.boot();
    const infos = ctx.source.sources();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ provider: 'antigravity', sessions: 2, ok: true });
  });
});

describe('fonte do Antigravity: subagentes', () => {
  it('conversa com parentId entra como sub do pai', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([
      conv(MAIN, { t0, ageMs: 2_000, title: 'Pai', workspace: '/projetos/api' }),
      // The child is newer than the parent: exercises the settle pass at the end of the poll.
      conv(SUB, { t0, ageMs: 1_000, parentId: MAIN, title: 'Pesquisar o login' }),
    ]);
    ctx.source.boot();
    expect(ctx.agent(SUB_KEY)).toMatchObject({
      kind: 'sub',
      provider: 'antigravity',
      parentId: KEY,
      sessionId: SUB,
      role: tr('Subagente (Antigravity)'),
      title: 'Pesquisar o login',
      status: 'working',
    });
    expect(ctx.agent()?.stats.subagents).toBe(1);
    // O subagente some da listagem: entrega.
    ctx.setConvs([conv(MAIN, { t0, ageMs: 2_000, title: 'Pai', workspace: '/projetos/api' })]);
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
    ctx.setConvs([conv(ORPHAN, { t0, parentId: 'conv-missing', title: 'Órfão' })]);
    ctx.source.boot();
    expect(ctx.agent(ORPHAN_KEY)).toMatchObject({ kind: 'main', provider: 'antigravity', role: tr('Subagente (Antigravity)') });
  });

  it('subagente ocioso não entra enquanto o pai trabalha', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.setConvs([
      conv(MAIN, { t0, ageMs: 1_000, title: 'Pai' }),
      conv(SUB, { t0, ageMs: 5 * 60_000, parentId: MAIN, title: 'Quieto' }),
    ]);
    ctx.source.boot();
    expect(ctx.agent()).toBeDefined();
    expect(ctx.agent(SUB_KEY)).toBeUndefined();
  });
});
