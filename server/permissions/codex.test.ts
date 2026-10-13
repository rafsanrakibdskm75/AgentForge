// Pedidos de aprovação do Codex no registro de permissões: o agente pelo thread (agent_id ?? session_id) entre os
// agentes do Codex (a conta só desempata), sem sugestões nem perguntas, recusa só com motivo (interromper e "sempre
// permitir" = unsupported), sem a busca da resposta no transcript, waitingFor "aprovar um comando", e os títulos pelos
// nomes do Codex (Bash, acesso à rede, apply_patch, request_permissions, mcp__…, write_stdin). Dados sintéticos.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { codexToolView, patchFiles } from './codex';
import { PermissionRegistry, type WaitResult } from './registry';

setQuiet(true);

const THREAD = '0199b0c0-1234-7abc-8def-0123456789ab';
const CHILD = '0199b0c0-5678-7abc-8def-0123456789ab';
const MAIN = `.codex:${THREAD}`;
const SUB = `.codex:${CHILD}`;
const CLAUDE = 'acc:1';

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, provider: 'codex', account: '.codex', sessionId: THREAD, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  office.addSub({ id: SUB, parentId: MAIN, sessionId: CHILD, role: 'worker', background: false, startedAt: 0 });
  office.addMain({ id: CLAUDE, account: 'acc', sessionId: 'sess-1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  const scans: string[] = [];
  permissions = new PermissionRegistry({
    office,
    viewers: () => 1,
    transcriptPathOf: (id) => {
      scans.push(id);
      return undefined;
    },
    codexAccount: (account, codexHome) => (codexHome === '/u/.codex-dois' ? '.codex~2' : account),
    now: clock.now,
  });
  return { office, registry: permissions, clock, scans };
}

function codexInput(over: Record<string, unknown> = {}) {
  return {
    provider: 'codex',
    account: '.codex',
    codexHome: '/u/.codex',
    session_id: THREAD,
    cwd: '/p/loja',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run the tests' },
    timeout_ms: 25_000,
    ...over,
  };
}

function registered(r: ReturnType<PermissionRegistry['register']>): string {
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
}

const snapAgent = (office: Office, id: string) => office.commit().snapshot.agents.find((a) => a.id === id);

describe('PermissionRegistry: Codex requests', () => {
  it('publishes on the Codex agent: provider codex, "approve a command", no suggestions', () => {
    const { office, registry } = setup();
    const permission_suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }];
    const id = registered(registry.register(codexInput({ permission_suggestions })));
    const a = snapAgent(office, MAIN)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'approve a command' });
    expect(a.permission).toMatchObject({ id, provider: 'codex', tool: 'Bash', title: 'Bash(npm test)', expiresAt: 1_025_000 });
    expect(a.permission!.suggestions).toBeUndefined();
    expect(registry.detail(id)).toMatchObject({ input: 'npm test', inputKind: 'command' });
    // O agente do Claude Code não é tocado.
    expect(snapAgent(office, CLAUDE)!.permission).toBeUndefined();
  });

  it('matches by thread: known subagent agent_id goes to it; unknown goes to the main with the type', () => {
    const { office, registry } = setup();
    registered(registry.register(codexInput({ agent_id: CHILD, agent_type: 'worker' })));
    expect(snapAgent(office, SUB)!.permission).toMatchObject({ provider: 'codex' });
    expect(snapAgent(office, SUB)!.permission!.subagent).toBeUndefined();
    registered(registry.register(codexInput({ agent_id: '0199b0c0-9999-7abc-8def-0123456789ab', agent_type: 'explorer' })));
    expect(snapAgent(office, MAIN)!.permission).toMatchObject({ subagent: 'explorer' });
  });

  it('the account only breaks ties (via the CODEX_HOME folder); unknown thread or Claude Code agent: unknown-session', () => {
    const { office, registry } = setup();
    office.addMain({ id: `.codex~2:${THREAD}`, provider: 'codex', account: '.codex~2', sessionId: THREAD, cwd: '/p/api', role: 'Agente principal', startedAt: 0, status: 'working' });
    registered(registry.register(codexInput({ account: '.codex-dois', codexHome: '/u/.codex-dois' })));
    expect(snapAgent(office, `.codex~2:${THREAD}`)!.permission).toBeDefined();
    expect(snapAgent(office, MAIN)!.permission).toBeUndefined();
    // Conta que ninguém tem: vale o thread.
    registered(registry.register(codexInput({ account: '.codex-x', codexHome: '/outra' })));
    expect(snapAgent(office, MAIN)!.permission).toBeDefined();
    expect(registry.register(codexInput({ session_id: 'sess-1' }))).toEqual({ skip: 'unknown-session' });
    // Pedido do Claude Code (sem provider) com o thread do Codex: não acha o agente do Codex.
    expect(registry.register({ session_id: THREAD, tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({ skip: 'unknown-session' });
  });

  it('decisions: allow and deny with reason count; interrupt and "always allow" = unsupported; answer = invalid-answer; terminal releases', async () => {
    const { registry } = setup();
    const id = registered(registry.register(codexInput()));
    expect(registry.decide(id, { behavior: 'deny', message: 'não', interrupt: true })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    const w = registry.wait(id, 10_000)!;
    expect(registry.decide(id, { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    expect(await w.result).toEqual({ status: 'decided', behavior: 'deny', message: 'use pnpm' } satisfies WaitResult);

    const id2 = registered(registry.register(codexInput()));
    const w2 = registry.wait(id2, 10_000)!;
    expect(registry.decide(id2, { behavior: 'terminal' })).toBe('ok');
    expect(await w2.result).toEqual({ status: 'released', reason: 'terminal' });
  });

  it('AskUserQuestion from Codex is not a question: approved like the other requests', () => {
    const { registry } = setup();
    const id = registered(registry.register(codexInput({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Qual?', options: [{ label: 'A' }] }] } })));
    expect(registry.detail(id)!.questions).toBeUndefined();
    expect(registry.decide(id, { behavior: 'allow' })).toBe('ok');
  });

  it('without fetching the answer in the terminal: the transcript is never read and the main that stops waiting does not release the request', () => {
    const { office, registry, clock, scans } = setup();
    const id = registered(registry.register(codexInput()));
    const w = registry.wait(id, 25_000)!;
    office.setStatus(MAIN, 'waiting', 'aprovar um comando');
    for (let i = 0; i < 20; i++) {
      clock.advance(500);
      if (i === 5) office.setStatus(MAIN, 'working');
      registry.tick();
    }
    expect(scans).toEqual([]);
    expect(registry.size).toBe(1);
    w.cancel();
  });
});

describe('codexToolView: Codex tool names', () => {
  it('Bash: title and summary; network access with its own title', () => {
    expect(codexToolView('Bash', { command: 'npm test' }, '/p')).toMatchObject({ title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' });
    const net = codexToolView('Bash', { command: 'curl https://api.exemplo.dev', description: 'network-access api.exemplo.dev:443' });
    expect(net).toMatchObject({ title: 'Network(api.exemplo.dev:443)', text: 'Access the network: api.exemplo.dev:443', icon: '🌐', input: 'curl https://api.exemplo.dev' });
  });

  it('apply_patch: patch files in the title and the patch as diff', () => {
    const patch = ['*** Begin Patch', '*** Update File: /p/src/app.ts', '@@', '-antes', '+depois', '*** Add File: /p/src/novo.ts', '+export {};', '*** End Patch'].join('\n');
    expect(patchFiles(patch)).toEqual([
      { op: 'Update', path: '/p/src/app.ts' },
      { op: 'Add', path: '/p/src/novo.ts' },
    ]);
    const v = codexToolView('apply_patch', { command: patch }, '/p');
    expect(v).toMatchObject({ title: 'apply_patch(src/app.ts +1)', text: 'Editing 2 files', inputKind: 'diff' });
    expect(v.input).toContain('-antes\n+depois');
    expect(codexToolView('apply_patch', { command: '*** Begin Patch\n*** Add File: novo.md\n+oi\n*** End Patch' })).toMatchObject({ title: 'apply_patch(novo.md)', text: 'Creating novo.md', icon: '📝' });
    expect(codexToolView('apply_patch', { command: '*** Begin Patch\n*** Delete File: velho.md\n*** End Patch' })).toMatchObject({ text: 'Deleting velho.md', icon: '🗑️' });
  });

  it('request_permissions, mcp__ and write_stdin (session_id there is a process one; text only in the detail, masked)', () => {
    expect(codexToolView('request_permissions', { reason: 'Preciso gravar fora do projeto', permissions: { fileSystem: { write: ['/tmp/x'] } } })).toMatchObject({
      title: 'request_permissions(Preciso gravar fora do projeto)',
      text: 'Asking for more permissions',
      icon: '🔐',
      inputKind: 'json',
    });
    expect(codexToolView('mcp__github__create_issue', { title: 'Bug' }).title).toBe('github - create_issue (MCP)');
    const stdin = codexToolView('write_stdin', { session_id: 42, chars: 'y\n', parent_call_id: 'c1' });
    expect(stdin).toMatchObject({ title: 'write_stdin(2 characters)', text: 'Typing into a terminal process', input: 'y\\n', inputKind: 'text' });
    expect(JSON.stringify(stdin)).not.toContain('42');
    const secret = codexToolView('write_stdin', { session_id: 7, chars: 'Authorization: Bearer abcdef1234567890abcdef\n' });
    expect(secret.title).not.toContain('abcdef');
    expect(secret.input).not.toContain('abcdef1234567890abcdef');
  });
});
