import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ptyRequestProblem } from '../http/pty';
import {
  claudeBinFrom,
  findExecutable,
  fixSpawnHelper,
  isExecutableFile,
  MAX_PTYS,
  PtyError,
  PtyManager,
  spawnProblem,
  type PtyAgentRef,
  type PtyManagerOptions,
  type PtyProcess,
  type PtyScreen,
  type SpawnPty,
} from './manager';
import type { ProcInfo } from './procinfo';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PID = 4242;
const STARTED = 1_791_557_339_236;

class FakeProc implements PtyProcess {
  data: (d: string) => void = () => {};
  exit: (e: { exitCode: number }) => void = () => {};
  written: string[] = [];
  constructor(readonly pid: number) {}
  onData(cb: (d: string) => void) {
    this.data = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  kill() {
    this.exit({ exitCode: 0 });
  }
}

interface Setup {
  manager: PtyManager;
  spawned: { args: string[]; cwd: string }[];
  alive: Set<number>;
  killPid: ReturnType<typeof vi.fn>;
  forceKill: ReturnType<typeof vi.fn>;
}

/** Gerenciador com tudo de fora trocado: um agente "acc:4242" aberto noutro terminal, vivo e conferido. */
function setup(over: Partial<Omit<PtyManagerOptions, 'agent'>> & { agent?: Partial<PtyAgentRef>; proc?: ProcInfo | undefined; session?: unknown } = {}): Setup {
  const { agent: agentOver, proc: procOver, session, ...opts } = over;
  const alive = new Set([PID]);
  const spawned: Setup['spawned'] = [];
  let nextPid = 9000;
  const agent: PtyAgentRef = { id: `acc:${PID}`, kind: 'main', account: 'acc', sessionId: SESSION, cwd: tmpdir(), ...agentOver };
  const proc = 'proc' in over ? procOver : { startMs: STARTED - 800, name: 'claude' };
  const killPid = vi.fn((pid: number) => void alive.delete(pid));
  const forceKill = vi.fn((pid: number) => void alive.delete(pid));
  const manager = new PtyManager({
    spawn: (_file, args, o) => {
      spawned.push({ args, cwd: o.cwd });
      return new FakeProc(++nextPid);
    },
    claudeBin: process.execPath,
    accounts: () => [{ id: 'acc', dir: join(tmpdir(), 'conta'), isDefault: true }],
    agent: (id) => (id === agent.id ? agent : undefined),
    onChange: () => {},
    readSession: () => session ?? { sessionId: SESSION, startedAt: STARTED },
    procInfo: async (pid) => (alive.has(pid) ? proc : undefined),
    isAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    killPid,
    forceKill,
    ...opts,
  });
  return { manager, spawned, alive, killPid, forceKill };
}

async function rejects(p: Promise<unknown>, status: number): Promise<PtyError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PtyError);
  expect((err as PtyError).status).toBe(status);
  return err as PtyError;
}

describe('PtyManager: check the process before closing', () => {
  it('closes when record, start and executable match', async () => {
    const s = setup();
    await s.manager.stop(`acc:${PID}`);
    expect(s.killPid).toHaveBeenCalledWith(PID, expect.objectContaining({ name: 'claude' }));
  });

  it('refuses when the record is from another session', async () => {
    const s = setup({ session: { sessionId: 'outra', startedAt: STARTED } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('refuses a reused PID (the live process started well after the record)', async () => {
    const s = setup({ proc: { startMs: STARTED + 3_600_000, name: 'claude' } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('refuses when the executable is not Claude Code', async () => {
    const s = setup({ proc: { startMs: STARTED - 800, name: 'chrome' } });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('on Windows, the record FILETIME must be the exact one', async () => {
    const reg = { sessionId: SESSION, startedAt: STARTED, procStart: '134360309381229341' };
    const other = setup({ session: reg, proc: { startMs: STARTED - 800, name: 'claude', fileTime: '134360309381229342' } });
    await rejects(other.manager.stop(`acc:${PID}`), 409);
    const same = setup({ session: reg, proc: { startMs: STARTED - 800, name: 'claude', fileTime: '134360309381229341' } });
    await same.manager.stop(`acc:${PID}`);
    expect(same.killPid).toHaveBeenCalledOnce();
  });

  it('refuses when nothing can be known about the process', async () => {
    const s = setup({ proc: undefined });
    await rejects(s.manager.stop(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
  });
});

describe('PtyManager: takeover', () => {
  it('closes there and resumes the same conversation here', async () => {
    const s = setup();
    const info = await s.manager.takeover(`acc:${PID}`);
    expect(s.killPid).toHaveBeenCalledOnce();
    expect(s.spawned).toEqual([{ args: ['--resume', SESSION], cwd: tmpdir() }]);
    expect(info).toMatchObject({ resumed: SESSION, fromAgent: `acc:${PID}` });
  });

  it('folder that does not exist: refuses before closing the session there', async () => {
    const s = setup({ agent: { cwd: join(tmpdir(), 'nao-existe-agentforge-teste') } });
    await rejects(s.manager.takeover(`acc:${PID}`), 400);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.alive.has(PID)).toBe(true);
  });

  it('unknown account: refuses before closing', async () => {
    const s = setup({ agent: { account: 'sumiu', id: `sumiu:${PID}` } });
    await rejects(s.manager.takeover(`sumiu:${PID}`), 400);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('terminal limit: refuses before closing', async () => {
    const s = setup();
    for (let i = 0; i < MAX_PTYS; i++) s.manager.create({ cwd: tmpdir() });
    await rejects(s.manager.takeover(`acc:${PID}`), 429);
    expect(s.killPid).not.toHaveBeenCalled();
  });

  it('the last slot stays with the takeover in progress', async () => {
    const s = setup();
    for (let i = 0; i < MAX_PTYS - 1; i++) s.manager.create({ cwd: tmpdir() });
    const run = s.manager.takeover(`acc:${PID}`);
    expect(() => s.manager.create({ cwd: tmpdir() })).toThrow(/limit/);
    await run;
    expect(s.spawned).toHaveLength(MAX_PTYS);
  });

  it('simultaneous requests from the same agent open a single terminal', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.manager.takeover(`acc:${PID}`), s.manager.takeover(`acc:${PID}`)]);
    expect(a.id).toBe(b.id);
    expect(s.killPid).toHaveBeenCalledOnce();
    expect(s.spawned).toHaveLength(1);
  });

  it('did not exit in time: force-closes and continues with --resume', async () => {
    const s = setup({ killPid: vi.fn() });
    await s.manager.takeover(`acc:${PID}`);
    expect(s.forceKill).toHaveBeenCalledWith(PID);
    expect(s.spawned).toHaveLength(1);
  });

  it('not even by force: error, without opening the second copy of the conversation', async () => {
    const s = setup({ killPid: vi.fn(), forceKill: vi.fn() });
    const err = await rejects(s.manager.takeover(`acc:${PID}`), 500);
    expect(err.message).toMatch(/still open there/);
    expect(s.spawned).toHaveLength(0);
  });

  it('claude that does not run: refuses before closing', async () => {
    const s = setup({ claudeBin: join(tmpdir(), 'nao-existe-agentforge-claude') });
    await rejects(s.manager.takeover(`acc:${PID}`), 503);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.alive.has(PID)).toBe(true);
  });

  it('did not open here after closing there: the error says how to continue the conversation', async () => {
    const s = setup({
      spawn: () => {
        throw new Error('posix_spawnp failed.');
      },
    });
    const err = await rejects(s.manager.takeover(`acc:${PID}`), 500);
    expect(err.message).toContain(`claude --resume ${SESSION}`);
    expect(err.message).toContain('posix_spawnp failed');
  });

  it('old record (reused PID): closes nobody', async () => {
    const s = setup({ proc: { startMs: STARTED + 86_400_000, name: 'node' } });
    await rejects(s.manager.takeover(`acc:${PID}`), 409);
    expect(s.killPid).not.toHaveBeenCalled();
    expect(s.spawned).toHaveLength(0);
  });
});

/** Resposta SSE de mentira: guarda o que foi escrito. */
function fakeStream(): { req: IncomingMessage; res: ServerResponse; out: string[] } {
  const out: string[] = [];
  const req = Object.assign(new EventEmitter(), { socket: { setTimeout() {}, setNoDelay() {} } }) as unknown as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead() {},
    write(chunk: string) {
      out.push(chunk);
      return true;
    },
    end() {
      (this as { writableEnded: boolean }).writableEnded = true;
    },
  }) as unknown as ServerResponse;
  return { req, res, out };
}

describe('PtyManager: screen for who connects', () => {
  it('sends the assembled screen and then the output that arrived while it finished processing', () => {
    const pendingWrites: (() => void)[] = [];
    let content = '';
    const screen: PtyScreen = {
      write(data, done) {
        // Processa depois, como o xterm.
        pendingWrites.push(() => {
          content += data;
          done?.();
        });
      },
      resize() {},
      serialize: () => `[tela:${content}]`,
      dispose() {},
    };
    let proc: FakeProc | undefined;
    const manager = new PtyManager({
      spawn: () => (proc = new FakeProc(77)),
      claudeBin: process.execPath,
      accounts: () => [{ id: 'acc', dir: tmpdir(), isDefault: true }],
      agent: () => undefined,
      onChange: () => {},
      createScreen: () => screen,
    });
    const info = manager.create({ cwd: tmpdir() });
    proc!.data('antes ');
    const { req, res, out } = fakeStream();
    manager.attach(info.id, req, res);
    proc!.data('durante');
    // Nada além do cabeçalho até a tela processar o que veio antes.
    expect(out.join('')).not.toContain('tela');
    for (const w of pendingWrites.splice(0)) w();
    const text = out.join('');
    expect(text.indexOf('[tela:antes ]')).toBeGreaterThan(-1);
    expect(text.indexOf('durante')).toBeGreaterThan(text.indexOf('[tela:antes ]'));
    proc!.data('depois');
    expect(out.join('')).toContain('depois');
  });
});

describe('ptyRequestProblem', () => {
  const req = (h: Record<string, string>, addr = '127.0.0.1') => ({ socket: { remoteAddress: addr }, headers: h }) as unknown as IncomingMessage;

  it('accepts the computer itself, same origin', () => {
    expect(ptyRequestProblem(req({ host: 'localhost:4747', origin: 'http://localhost:4747', 'sec-fetch-site': 'same-origin' }))).toBeNull();
    expect(ptyRequestProblem(req({ host: '127.0.0.1:4747' }, '::ffff:127.0.0.1'))).toBeNull();
  });

  it('refuses outside connections, network Host, other origin and cross-site requests', () => {
    expect(ptyRequestProblem(req({ host: 'localhost:4747' }, '192.168.0.9'))).toMatch(/the computer running AgentForge/);
    expect(ptyRequestProblem(req({ host: 'meu-mac.local:4747' }))).toMatch(/localhost/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', origin: 'http://evil.example' }))).toMatch(/origin/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', 'sec-fetch-site': 'same-site' }))).toMatch(/origin/);
    expect(ptyRequestProblem(req({ host: 'localhost:4747', 'sec-fetch-site': 'cross-site' }))).toMatch(/origin/);
  });
});

describe('loading node-pty and finding claude', () => {
  const unix = process.platform !== 'win32';

  /** Pasta temporária, apagada no fim. */
  function withDir(fn: (dir: string) => void | Promise<void>) {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentforge-pty-'));
      try {
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it.runIf(unix)(
    'gives execute permission back to the spawn-helper (node-pty 1.1.0 publishes without it)',
    withDir((dir) => {
      const sub = join(dir, 'prebuilds', 'darwin-arm64');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, 'spawn-helper'), '');
      chmodSync(join(sub, 'spawn-helper'), 0o644);
      fixSpawnHelper(dir, 'darwin', 'arm64');
      expect(statSync(join(sub, 'spawn-helper')).mode & 0o777).toBe(0o755);
      // Sem spawn-helper nenhum: nada a fazer, sem erro.
      expect(() => fixSpawnHelper(join(dir, 'vazia'), 'darwin', 'arm64')).not.toThrow();
    }),
  );

  it('test terminal: points to the reason when spawn fails or the process exits with an error', async () => {
    const failing: SpawnPty = () => {
      throw new Error('posix_spawnp failed.');
    };
    expect(await spawnProblem(failing)).toMatch(/posix_spawnp failed/);
    const exiting = (code: number): SpawnPty => () => {
      const p = new FakeProc(1);
      queueMicrotask(() => p.exit({ exitCode: code }));
      return p;
    };
    expect(await spawnProblem(exiting(0))).toBeNull();
    expect(await spawnProblem(exiting(1))).toMatch(/code 1/);
  });

  it.runIf(unix)(
    'executable: must exist and be runnable; PATH skips what does not run',
    withDir((dir) => {
      const a = join(dir, 'a');
      const b = join(dir, 'b');
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(join(a, 'claude'), '#!/bin/sh\n');
      chmodSync(join(a, 'claude'), 0o644);
      writeFileSync(join(b, 'claude'), '#!/bin/sh\n');
      chmodSync(join(b, 'claude'), 0o755);
      expect(isExecutableFile(join(a, 'claude'))).toBe(false);
      expect(isExecutableFile(join(b, 'claude'))).toBe(true);
      expect(isExecutableFile(dir)).toBe(false);
      const env = { PATH: `${a}:${b}` };
      expect(findExecutable('claude', env)).toBe(join(b, 'claude'));
      expect(claudeBinFrom(env)).toBe(join(b, 'claude'));
      // AGENTFORGE_CLAUDE_BIN: um caminho vale como está; um nome é procurado no PATH.
      expect(claudeBinFrom({ ...env, AGENTFORGE_CLAUDE_BIN: join(a, 'claude') })).toBe(join(a, 'claude'));
      expect(claudeBinFrom({ ...env, AGENTFORGE_CLAUDE_BIN: 'claude' })).toBe(join(b, 'claude'));
      expect(claudeBinFrom({ ...env, AGENTFORGE_CLAUDE_BIN: 'outro' })).toBeUndefined();
    }),
  );
});
