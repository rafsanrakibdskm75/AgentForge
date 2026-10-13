// Gemini CLI history: listing of recent sessions, safe resolve(), and the terminal parser.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { GeminiHistory } from './history';
import { createGeminiTerminalParser } from './terminal';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-history-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ID_STALE = 'cccccccc-1111-2222-3333-444444444444';
const ID_SUB = 'dddddddd-1111-2222-3333-444444444444';
const ID_MISSING = 'eeeeeeee-1111-2222-3333-444444444444';

interface FakeHome {
  dir: string;
  chats: string;
}

function fakeHome(): FakeHome {
  const dir = tempDir();
  const chats = join(dir, 'tmp', 'hash1', 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ hash1: '/projetos/loja' }));
  return { dir, chats };
}

function sessionRecord(id: string, o: { at: number; kind?: 'main' | 'subagent'; firstUser?: string; last?: number; dirs?: string[] }): Record<string, unknown> {
  return {
    sessionId: id,
    projectHash: 'hash1',
    startTime: o.at,
    lastUpdated: o.last ?? o.at,
    kind: o.kind ?? 'main',
    directories: o.dirs ?? ['/projetos/loja'],
    messages: [
      { id: 'm1', timestamp: o.at, type: 'user', content: [{ text: o.firstUser ?? 'primeira pergunta' }] },
      { id: 'm2', timestamp: o.last ?? o.at, type: 'gemini', content: [{ text: 'resposta' }] },
    ],
  };
}

function writeSession(home: FakeHome, id: string, o: { at: number; kind?: 'main' | 'subagent'; firstUser?: string; last?: number; dirs?: string[]; jsonl?: boolean; mtime?: number }): string {
  const ext = o.jsonl ? 'jsonl' : 'json';
  const path = join(home.chats, `session-${id}.${ext}`);
  if (o.jsonl) {
    const rec = sessionRecord(id, o);
    const { messages, ...rest } = rec;
    const lines = (messages as unknown[]).map((m) => JSON.stringify({ ...rest, messages: [m] }));
    writeFileSync(path, `${lines.join('\n')}\n`);
  } else {
    writeFileSync(path, JSON.stringify(sessionRecord(id, o)));
  }
  if (o.mtime !== undefined) utimesSync(path, new Date(o.mtime), new Date(o.mtime));
  return path;
}

function setup(now: number) {
  const home = fakeHome();
  const history = new GeminiHistory({
    accounts: () => [{ id: '.gemini', dir: home.dir }],
    openAgentOf: () => undefined,
    now: () => now,
  });
  return { home, history };
}

describe('histórico do Gemini', () => {
  it('lista as sessões recentes (json e jsonl), sem as antigas e sem subagentes', async () => {
    const now = Date.now();
    const { home, history } = setup(now);
    writeSession(home, ID_A, { at: now - 3_600_000, last: now - 3_000_000, firstUser: 'Arrume o checkout com urgência' });
    writeSession(home, ID_B, { at: now - 7_200_000, last: now - 7_000_000, firstUser: 'pergunta antiga', jsonl: true });
    writeSession(home, ID_SUB, { at: now - 60_000, kind: 'subagent', firstUser: 'subagente' });
    writeSession(home, ID_STALE, { at: now - 10 * 86_400_000, mtime: now - 10 * 86_400_000, firstUser: 'antiga demais' });

    const list = await history.list();
    expect(list.map((s) => s.sessionId)).toEqual([ID_A, ID_B]);
    expect(list[0]).toMatchObject({
      account: '.gemini',
      provider: 'gemini',
      sessionId: ID_A,
      project: '/projetos/loja',
      projectDir: '-projetos-loja',
      title: 'Arrume o checkout com urgência',
      firstAt: now - 3_600_000,
      lastAt: now - 3_000_000,
      open: false,
    });
    expect(list[1]).toMatchObject({ title: 'pergunta antiga', open: false });
    expect(list[1].agentId).toBeUndefined();
  });

  it('resolve: só dentro da pasta da conta, com o parser do Gemini; id inválido 400, desconhecida 404', () => {
    const now = Date.now();
    const { home, history } = setup(now);
    writeSession(home, ID_A, { at: now - 1_000 });
    const r = history.resolve('.gemini', ID_A);
    expect('path' in r && r.path).toContain(`session-${ID_A}.json`);
    if ('path' in r) {
      expect(r.createParser).toBe(createGeminiTerminalParser);
      expect(typeof r.createParser).toBe('function');
    }
    expect(history.resolve('.gemini', '../x')).toEqual({ status: 400, error: 'invalid session id' });
    expect(history.resolve('.gemini', 'não-uuid')).toEqual({ status: 400, error: 'invalid session id' });
    expect(history.resolve('.outra', ID_A)).toEqual({ status: 404, error: 'unknown account' });
    expect(history.resolve('.gemini', ID_MISSING)).toEqual({ status: 404, error: 'session not found' });
  });

  it('o terminal lê uma sessão resolvida: user/assistant/thinking/tool/result/system, sem duplicar', () => {
    const now = Date.now();
    const { home, history } = setup(now);
    writeSession(home, ID_A, { at: now - 1_000, firstUser: 'leia o arquivo' });
    const r = history.resolve('.gemini', ID_A);
    expect('path' in r).toBe(true);
    if (!('path' in r)) return;
    const parser = r.createParser();
    const line = JSON.stringify({
      sessionId: ID_A,
      projectHash: 'hash1',
      startTime: now - 1_000,
      lastUpdated: now - 500,
      kind: 'main',
      directories: ['/projetos/loja'],
      messages: [
        { id: 'm1', timestamp: now - 1_000, type: 'user', content: [{ text: 'leia o arquivo' }] },
        {
          id: 'm2',
          timestamp: now - 900,
          type: 'gemini',
          content: [{ text: 'lendo agora' }],
          thoughts: ['vou ler o arquivo pedido'],
          toolCalls: [{ id: 'c1', name: 'read', args: { file_path: '/projetos/loja/index.ts' }, result: 'conteúdo', status: 'success' }],
        },
        { id: 'm3', timestamp: now - 500, type: 'info', content: [{ text: 'turno encerrado' }] },
      ],
    });
    const entries = parser.push(line);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'thinking', 'tool', 'result', 'system']);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'leia o arquivo' });
    expect(entries[3]).toMatchObject({ kind: 'tool', tool: 'Read', title: 'Read(/projetos/loja/index.ts)' });
    expect(entries[4]).toMatchObject({ kind: 'result', toolUseId: 'c1', text: 'conteúdo' });
    expect(entries[5]).toMatchObject({ kind: 'system', level: 'info' });
    // Re-feeding the same line emits nothing (dedupe by message id).
    expect(parser.push(line)).toEqual([]);
  });
});
