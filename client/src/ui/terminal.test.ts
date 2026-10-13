import { describe, expect, it } from 'vitest';
import type { AgentInfo, ShellJob, TerminalEntry } from '../../../shared/types';
import {
  diffLineKind,
  entryKey,
  footerGlyph,
  entryTimeTitle,
  moreLabel,
  parseAppend,
  parseInit,
  previewText,
  sessionEndedText,
  sessionKey,
  sessionProjectName,
  sessionTerminalUrl,
  showToolInput,
  spinnerFrames,
  splitPreview,
  splitToolTitle,
  TerminalLog,
  terminalFooter,
  terminalUrl,
} from './terminal';

const user = (id: string, text = 'oi'): TerminalEntry => ({ kind: 'user', id, at: 1, text });
const tool = (id: string, title = 'Bash(npm test)'): TerminalEntry => ({ kind: 'tool', id, at: 2, tool: 'Bash', title });
const result = (id: string, toolUseId: string, extra: Partial<Extract<TerminalEntry, { kind: 'result' }>> = {}): TerminalEntry => ({
  kind: 'result',
  id,
  at: 3,
  toolUseId,
  text: 'ok',
  ...extra,
});

function agent(p: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'a1',
    kind: 'main',
    roomId: 'r1',
    name: 'Marina',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's1',
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 1_000,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...p,
  };
}

describe('TerminalLog', () => {
  it('attaches the result to the tool of the same batch', () => {
    const log = new TerminalLog();
    const b = log.push([user('u1'), tool('t1'), result('r1', 't1')]);
    expect(b.attached).toEqual([]);
    expect(b.added.map((i) => i.type)).toEqual(['entry', 'tool']);
    const t = b.added[1];
    expect(t.type === 'tool' && t.result?.id).toBe('r1');
  });

  it('a late result becomes an update of the tool already on screen', () => {
    const log = new TerminalLog();
    log.push([tool('t1')]);
    const b = log.push([result('r1', 't1', { error: true })]);
    expect(b.added).toEqual([]);
    expect(b.attached).toEqual([{ toolKey: 'tool:t1', result: expect.objectContaining({ id: 'r1', error: true }) }]);
  });

  it('a result without its tool (or repeated for the same tool) shows up alone', () => {
    const log = new TerminalLog();
    const b = log.push([result('r0', 'sumiu'), tool('t1'), result('r1', 't1'), result('r2', 't1')]);
    expect(b.added.map((i) => `${i.type}:${i.key}`)).toEqual(['orphan:result:r0', 'tool:tool:t1', 'orphan:result:r2']);
  });

  it('dedupes by id (within and across batches)', () => {
    const log = new TerminalLog();
    expect(log.push([user('u1'), user('u1')]).added).toHaveLength(1);
    expect(log.push([user('u1'), user('u2')]).added.map((i) => i.key)).toEqual(['user:u2']);
    expect(log.size).toBe(2);
  });

  it('the result id may repeat the tool one without being dropped', () => {
    const log = new TerminalLog();
    const b = log.push([tool('x'), result('x', 'x')]);
    const t = b.added[0];
    expect(t.type === 'tool' && t.result?.id).toBe('x');
  });

  it('reset forgets everything (init replaces the conversation)', () => {
    const log = new TerminalLog();
    log.push([user('u1')]);
    log.reset();
    expect(log.size).toBe(0);
    expect(log.push([user('u1')]).added).toHaveLength(1);
  });

  it('trim drops the oldest items and frees their ids', () => {
    const log = new TerminalLog();
    log.push([user('u1'), tool('t1'), result('r1', 't1'), user('u2'), user('u3')]);
    expect(log.trim(2)).toEqual(['user:u1', 'tool:t1']);
    expect(log.size).toBe(2);
    expect(log.trim(2)).toEqual([]);
    // Um resultado atrasado da ferramenta descartada aparece sozinho.
    expect(log.push([result('r9', 't1')]).added.map((i) => i.type)).toEqual(['orphan']);
  });
});

describe('parseInit / parseAppend', () => {
  it('accepts init and ignores malformed entries', () => {
    const data = JSON.stringify({
      agentId: 'a1',
      truncated: true,
      entries: [user('u1'), { kind: 'user', id: 'sem-texto' }, { kind: 'xyz', id: 'k', text: 'x' }, null, result('r1', 't1'), { kind: 'result', id: 'r2', text: 'x' }],
    });
    const init = parseInit(data);
    expect(init?.agentId).toBe('a1');
    expect(init?.truncated).toBe(true);
    expect(init?.entries.map(entryKey)).toEqual(['user:u1', 'result:r1']);
  });

  it('invalid JSON: null init and empty append', () => {
    expect(parseInit('{')).toBeNull();
    expect(parseInit('[1]')).toBeNull();
    expect(parseAppend('{')).toEqual([]);
    expect(parseAppend(JSON.stringify({ not: 'array' }))).toEqual([]);
  });

  it('append with textless thinking (signature only) is valid', () => {
    expect(parseAppend(JSON.stringify([{ kind: 'thinking', id: 'th', at: 1 }]))).toHaveLength(1);
  });
});

describe('previewText', () => {
  it('short text is not collapsed', () => {
    const p = previewText('a\nb\nc', 6);
    expect(p.collapsed).toBe(false);
    expect(p.head).toBe('a\nb\nc');
  });

  it('does not collapse for just 1 or 2 extra lines', () => {
    expect(previewText(Array.from({ length: 8 }, (_, i) => `l${i}`).join('\n'), 6).collapsed).toBe(false);
  });

  it('long text shows the first lines and counts the hidden ones', () => {
    const text = Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join('\n');
    const p = previewText(`${text}\n\n`, 6);
    expect(p.collapsed).toBe(true);
    expect(p.head.split('\n')).toHaveLength(6);
    expect(p.hiddenLines).toBe(14);
    expect(p.total).toBe(20);
    expect(p.text).toBe(text);
  });

  it('a single overlong line is cut by characters', () => {
    const p = previewText('x'.repeat(5_000), 6, 100);
    expect(p.collapsed).toBe(true);
    expect(p.head).toHaveLength(101);
    expect(p.head.endsWith('…')).toBe(true);
    expect(p.hiddenLines).toBe(0);
  });

  it('splitPreview: the preview is a prefix of the text (the rest stays in the DOM, hidden, for search)', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join('\n');
    const p = splitPreview(lines, 6);
    expect(p.text.slice(0, p.headEnd)).toBe(previewText(lines, 6).head);
    expect(p.text.slice(p.headEnd).startsWith('\nlinha 7')).toBe(true);
    expect(p.ellipsis).toBe(false);
    const long = splitPreview(`${'x'.repeat(98)}   ${'y'.repeat(50)}`, 6, 100);
    expect(long).toMatchObject({ headEnd: 98, ellipsis: true, collapsed: true, hiddenLines: 0 });
    expect(splitPreview('curto', 6)).toMatchObject({ headEnd: 5, collapsed: false });
  });

  it('button label', () => {
    expect(moreLabel(1)).toBe('… +1 line');
    expect(moreLabel(14)).toBe('… +14 lines');
    expect(moreLabel(0)).toBe('… show all');
  });
});

describe('tools', () => {
  it('splitToolTitle splits the name from the arguments', () => {
    expect(splitToolTitle('Bash(npm test)')).toEqual({ name: 'Bash', args: '(npm test)' });
    expect(splitToolTitle('Read(server/index.ts)')).toEqual({ name: 'Read', args: '(server/index.ts)' });
    expect(splitToolTitle('Pesquisa na web')).toEqual({ name: 'Pesquisa na web', args: '' });
    expect(splitToolTitle('Tarefa (x)')).toEqual({ name: 'Tarefa (x)', args: '' });
  });

  it('showToolInput does not repeat the command already in the title', () => {
    expect(showToolInput({ title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' })).toBe(false);
    expect(showToolInput({ title: 'Bash(npm run build && …)', input: 'npm run build && npm test', inputKind: 'command' })).toBe(true);
    expect(showToolInput({ title: 'Bash(x)', input: 'x\ny', inputKind: 'command' })).toBe(true);
    expect(showToolInput({ title: 'Edit(a.ts)', input: '- a\n+ b', inputKind: 'diff' })).toBe(true);
    expect(showToolInput({ title: 'Edit(a.ts)', input: '   ' })).toBe(false);
    expect(showToolInput({ title: 'Edit(a.ts)' })).toBe(false);
  });

  it('diffLineKind', () => {
    expect(diffLineKind('+ nova')).toBe('add');
    expect(diffLineKind('- antiga')).toBe('del');
    expect(diffLineKind('@@ -1,2 +1,3 @@')).toBe('hunk');
    expect(diffLineKind('  igual')).toBe('ctx');
  });
});

describe('terminalFooter', () => {
  const now = 100_000;

  it('working: activity text with ellipsis (no doubling)', () => {
    const a = agent({ activity: { id: 'x', kind: 'edit', icon: '✏️', text: 'Editando App.tsx', at: 0 } });
    expect(terminalFooter(a, [a], now)).toEqual({ kind: 'working', text: 'Editando App.tsx…', since: 1_000 });
    const b = agent({ activity: { id: 'x', kind: 'think', icon: '💭', text: 'Pensando…', at: 0 } });
    expect(terminalFooter(b, [b], now).text).toBe('Pensando…');
    expect(terminalFooter(agent(), [], now).text).toBe('Working…');
  });

  it('waiting on you, idle and ended', () => {
    const perm = { id: 'p1', tool: 'Bash', title: 'Bash(ls)' } as unknown as NonNullable<AgentInfo['permission']>;
    expect(terminalFooter(agent({ status: 'waiting', waitingFor: 'aprovar uma permissão', permission: perm }), [], now).text).toBe('Waiting on you: aprovar uma permissão');
    expect(terminalFooter(agent({ status: 'waiting', waitingFor: 'aprovar uma permissão' }), [], now).text).toBe(
      "Waiting on you: aprovar uma permissão · answer in Claude Code: this request didn't reach AgentForge or timed out",
    );
    expect(terminalFooter(agent({ status: 'waiting', provider: 'codex' }), [], now).text).toMatch(/^Waiting on you · answer in Codex:/);
    expect(terminalFooter(agent({ status: 'idle' }), [], now)).toEqual({ kind: 'idle', text: 'Waiting for the next prompt' });
    expect(terminalFooter(agent({ status: 'offline' }), [], now).kind).toBe('ended');
    expect(terminalFooter(agent({ kind: 'sub', status: 'done' }), [], now).kind).toBe('ended');
    expect(terminalFooter(undefined, [], now)).toEqual({ kind: 'ended', text: 'Session ended' });
  });

  it('waiting on the shell (background or long foreground command)', () => {
    const job: ShellJob = { id: 'j', label: 'Rodar a suíte', startedAt: 40_000, background: true, kind: 'shell' };
    const a = agent({ status: 'shell', shells: [job, { ...job, id: 'k', startedAt: 50_000 }] });
    expect(terminalFooter(a, [a], now)).toEqual({ kind: 'shell', text: 'Waiting on shell: Rodar a suíte (+1)', since: 40_000 });
    const fg = agent({ status: 'working', shells: [{ ...job, background: false, startedAt: now - 60_000 }] });
    expect(terminalFooter(fg, [fg], now).kind).toBe('shell');
  });
});

describe('utilities', () => {
  it('terminalUrl encodes the id', () => {
    expect(terminalUrl('.claude:123')).toBe('/api/agents/.claude%3A123/terminal');
    expect(terminalUrl('s/1:a b')).toBe('/api/agents/s%2F1%3Aa%20b/terminal');
  });

  it('history sessions: stream URL, key and project name', () => {
    const sid = '00000000-0000-4000-8000-000000000001';
    expect(sessionTerminalUrl('.claude-conta2', sid)).toBe(`/api/sessions/.claude-conta2/${sid}/terminal`);
    expect(sessionTerminalUrl('a/b', 'x y')).toBe('/api/sessions/a%2Fb/x%20y/terminal');
    expect(sessionKey('.claude', sid)).toBe(`session:.claude:${sid}`);
    expect(sessionProjectName({ project: '/Users/ana/projetos/loja/', projectDir: '-x' })).toBe('loja');
    expect(sessionProjectName({ project: 'C:\\proj\\api', projectDir: '-x' })).toBe('api');
    expect(sessionProjectName({ projectDir: '-Users-ana-projetos-site' })).toBe('-Users-ana-projetos-site');
  });

  it('ended session footer: today, yesterday or the date', () => {
    const now = new Date(2026, 9, 8, 15, 0, 0).getTime();
    expect(sessionEndedText(new Date(2026, 9, 8, 14, 30).getTime(), now)).toBe('Session ended at 14:30');
    expect(sessionEndedText(new Date(2026, 9, 7, 23, 5).getTime(), now)).toBe('Session ended yesterday at 23:05');
    expect(sessionEndedText(new Date(2026, 9, 3, 9, 0).getTime(), now)).toMatch(/^Session ended on Oct 03 at 09:00$/);
    expect(sessionEndedText(NaN, now)).toBe('Session ended');
  });

  it('entryTimeTitle: time today, date on another day, empty without a time', () => {
    const now = new Date(2026, 9, 8, 15, 0, 0).getTime();
    expect(entryTimeTitle(new Date(2026, 9, 8, 14, 30, 5).getTime(), now)).toMatch(/14:30:05/);
    expect(entryTimeTitle(new Date(2026, 9, 6, 9, 5).getTime(), now)).toMatch(/06.*09:05/);
    expect(entryTimeTitle(NaN, now)).toBe('');
  });
});

describe('Codex footer', () => {
  it('neutral spinner and glyph (✻ belongs to Claude Code); the rest is the same', () => {
    expect(spinnerFrames('claude')).toContain('✻');
    expect(spinnerFrames('codex')).not.toContain('✻');
    expect(spinnerFrames('codex')).toHaveLength(spinnerFrames('claude').length);
    expect(footerGlyph('working', 'claude')).toBe('✻');
    expect(footerGlyph('working', 'codex')).toBe('•');
    expect(footerGlyph('waiting', 'codex')).toBe('✋');
    expect(footerGlyph('ended', 'claude')).toBe('■');
  });
});
