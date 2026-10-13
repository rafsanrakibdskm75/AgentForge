import { describe, expect, it } from 'vitest';
import type { AgentInfo, AskQuestion, PermissionRequestInfo } from '../../../shared/types';
import {
  answerFor,
  buildAnswers,
  CODEX_PERMISSION_NOTE,
  destinationLabel,
  expiryText,
  isLocalHostname,
  isQuestionRequest,
  nextPermissionAgent,
  permissionAgents,
  permissionOptions,
  type AskChoice,
} from './permission';

function agent(id: string, permission?: Partial<PermissionRequestInfo>, status: AgentInfo['status'] = 'waiting'): AgentInfo {
  const a: AgentInfo = {
    id,
    kind: 'main',
    roomId: 'r',
    name: id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: 'acc',
    status,
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
  };
  if (permission) a.permission = { id: `p-${id}`, tool: 'Bash', title: 'Bash(ls)', text: 'Listando', icon: '💻', createdAt: 0, expiresAt: 1, ...permission };
  return a;
}

describe('answering from the office (pure pieces)', () => {
  it('expiryText: how long until the request returns to the terminal', () => {
    expect(expiryText(10 * 60_000, 0)).toBe('returns to the terminal in 10 min');
    expect(expiryText(30_000, 0)).toBe('returns to the terminal in under 1 min');
    expect(expiryText(0, 5)).toBe('returning to the terminal…');
  });

  it('expiryText with seconds (short Codex deadline)', () => {
    expect(expiryText(25_000, 0, true)).toBe('returns to the terminal in 25 s');
    expect(expiryText(25_000, 24_200, true)).toBe('returns to the terminal in 1 s');
    expect(expiryText(25_000, 25_000, true)).toBe('returning to the terminal…');
    expect(expiryText(5 * 60_000, 0, true)).toBe('returns to the terminal in 5 min');
  });

  it('Codex card: no "always allow" nor "interrupt", refusal with reason and the terminal warning', () => {
    const suggestions = [{ index: 0, rules: ['Bash(npm test:*)'], destination: 'localSettings' }];
    expect(permissionOptions({ provider: 'codex', suggestions }, { kind: 'main' })).toEqual({
      always: false,
      interrupt: false,
      reasonRequired: true,
      seconds: true,
      note: CODEX_PERMISSION_NOTE,
    });
    expect(CODEX_PERMISSION_NOTE).toBe('In Codex, the approval only shows up in the terminal after you answer here or the time runs out.');
    // Claude Code: as before.
    expect(permissionOptions({ suggestions }, { kind: 'main' })).toEqual({ always: true, interrupt: true, reasonRequired: false, seconds: false, note: '' });
    expect(permissionOptions({}, { kind: 'main' }).always).toBe(false);
    expect(permissionOptions({}, { kind: 'sub', background: true }).note).toMatch(/^This subagent runs in the background/);
  });

  it('destinationLabel', () => {
    expect(destinationLabel('localSettings')).toBe('in this project, just for you');
    expect(destinationLabel('userSettings')).toBe('in all projects');
    expect(destinationLabel('session')).toBe('this session only');
    expect(destinationLabel('outro')).toBe('outro');
  });

  it('request queue: oldest to newest, going through all and back to the first', () => {
    const list = [agent('b', { createdAt: 20 }), agent('x'), agent('a', { createdAt: 10 }), agent('gone', { createdAt: 5 }, 'offline')];
    delete list[1].permission;
    expect(permissionAgents(list).map((a) => a.id)).toEqual(['a', 'b']);
    expect(nextPermissionAgent(list)?.id).toBe('a');
    expect(nextPermissionAgent(list, 'a')?.id).toBe('b');
    expect(nextPermissionAgent(list, 'b')?.id).toBe('a');
    expect(nextPermissionAgent(list, 'x')?.id).toBe('a');
    expect(nextPermissionAgent([agent('y')])).toBeUndefined();
  });

  it('isLocalHostname: the same server rule for accepting answers', () => {
    for (const h of ['localhost', 'agentforge.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'LOCALHOST']) expect(isLocalHostname(h), h).toBe(true);
    for (const h of ['192.168.0.10', 'meu-mac.local', 'agentforge.lan', '128.0.0.1', '127.0.0.1.nip.io']) expect(isLocalHostname(h), h).toBe(false);
  });
});

describe('question card (AskUserQuestion)', () => {
  // Positions from the original: option 1 of the first question and question 1 were skipped.
  const single: AskQuestion = { index: 0, header: 'Banco', question: 'Qual banco usar?', options: [{ index: 0, label: 'Postgres' }, { index: 2, label: 'SQLite' }] };
  const multi: AskQuestion = { index: 2, question: 'Quais testes rodar?', multiSelect: true, options: [{ index: 0, label: 'Unidade' }, { index: 1, label: 'E2E' }] };
  const choice = (options: number[], otherOn = false, otherText = ''): AskChoice => ({ options, otherOn, otherText });

  it('isQuestionRequest: only AskUserQuestion with questions', () => {
    expect(isQuestionRequest({ tool: 'AskUserQuestion', questions: [single] })).toBe(true);
    expect(isQuestionRequest({ tool: 'AskUserQuestion', questions: [] })).toBe(false);
    expect(isQuestionRequest({ tool: 'Bash' })).toBe(false);
    expect(isQuestionRequest(undefined)).toBe(false);
    // Codex never asks from the office: it never becomes a question card.
    expect(isQuestionRequest({ tool: 'AskUserQuestion', questions: [single], provider: 'codex' })).toBe(false);
  });

  it('answerFor: single choice = the option OR "Other"; multiple = everything together; "Other" without text = no answer', () => {
    expect(answerFor(single, choice([2]))).toEqual({ question: 0, options: [2] });
    expect(answerFor(single, choice([2], true, '  MySQL '))).toEqual({ question: 0, other: 'MySQL' });
    expect(answerFor(single, choice([], true, '   '))).toBeUndefined();
    expect(answerFor(single, choice([]))).toBeUndefined();
    expect(answerFor(single, undefined)).toBeUndefined();
    expect(answerFor(multi, choice([1, 0], true, 'lint'))).toEqual({ question: 2, options: [1, 0], other: 'lint' });
    expect(answerFor(multi, choice([0], false, 'ignorado'))).toEqual({ question: 2, options: [0] });
    expect(answerFor(multi, choice([0], true, ''))).toBeUndefined();
    // A position the question does not show: stays out.
    expect(answerFor(multi, choice([7]))).toBeUndefined();
    expect(answerFor(single, choice([], true, 'x'.repeat(2_500)))!.other).toHaveLength(2_000);
  });

  it('buildAnswers: the body only goes out with all questions answered (normalized as the server checks)', () => {
    const qs = [single, multi];
    expect(buildAnswers(qs, new Map([[0, choice([0])]]))).toBeUndefined();
    expect(buildAnswers(qs, new Map([[0, choice([0])], [2, choice([])]]))).toBeUndefined();
    const ready = new Map([
      [2, choice([1, 0], true, ' lint ')],
      [0, choice([2])],
    ]);
    expect(buildAnswers(qs, ready)).toEqual([
      { question: 0, options: [2] },
      { question: 2, options: [0, 1], other: 'lint' },
    ]);
  });
});
