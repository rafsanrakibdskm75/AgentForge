import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import {
  canSend,
  CODEX_BRIDGE_HINT,
  CODEX_TIMEOUT_ERROR,
  composerMode,
  composerTip,
  DELIVERED_SHOW_MS,
  enterSends,
  isSettled,
  messageText,
  PLUGIN_HINT,
  pollDelay,
  sendStatusText,
  timeoutError,
  TIMEOUT_ERROR,
  type ComposerEnv,
} from './composer-model';

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'acc:1',
    kind: 'main',
    roomId: 'r',
    name: 'Marina',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's-1',
    account: 'acc',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    canMessage: true,
    ...over,
  };
}

const ON: ComposerEnv = { enabled: true, local: true, replaying: false };

describe('message box (pure pieces)', () => {
  it('composerMode: ready only for a present main agent with the plugin, feature on and local page', () => {
    expect(composerMode(agent(), ON)).toEqual({ kind: 'ready' });
    for (const status of ['working', 'waiting', 'shell'] as const) expect(composerMode(agent({ status }), ON).kind).toBe('ready');
    // Feature on, but the session without the plugin: the install hint.
    expect(composerMode(agent({ canMessage: undefined }), ON)).toEqual({ kind: 'hint', text: PLUGIN_HINT });
    expect(PLUGIN_HINT).toBe('To send messages from here: npm run mod:install (plugin agentforge-mensagens)');
  });

  it('composerMode: when it cannot, it says why (the drawer hides, the terminal shows the reason)', () => {
    const off = (a: AgentInfo | undefined, env: Partial<ComposerEnv> = {}) => {
      const m = composerMode(a, { ...ON, ...env });
      expect(m.kind).toBe('off');
      return m.kind === 'off' ? m.text : '';
    };
    expect(off(agent({ kind: 'sub', parentId: 'acc:1' }))).toMatch(/^Subagents don't receive/);
    expect(off(agent({ kind: 'sub', status: 'done' }))).toMatch(/^Subagents/);
    expect(off(agent({ status: 'offline' }))).toBe('Session ended');
    expect(off(undefined)).toBe('Session ended');
    expect(off(agent(), { enabled: false })).toMatch(/Claude Code terminal/);
    expect(off(agent({ canMessage: undefined }), { enabled: false })).toMatch(/Claude Code terminal/);
    expect(off(agent(), { local: false })).toMatch(/localhost/);
    expect(off(agent(), { replaying: true })).toMatch(/timelapse/);
  });

  it('text: trailing spaces trimmed; empty or too long does not send', () => {
    expect(messageText('  oi\n  tudo bem?  \n\n')).toBe('  oi\n  tudo bem?');
    expect(canSend('oi')).toBe(true);
    expect(canSend(' \n\t ')).toBe(false);
    expect(canSend('x'.repeat(20_000))).toBe(true);
    expect(canSend('x'.repeat(20_001))).toBe(false);
    // Trailing spaces do not count toward the limit (they are trimmed first).
    expect(canSend(`${'x'.repeat(20_000)}\n\n`)).toBe(true);
  });

  it('Enter sends; Shift+Enter and Alt+Enter break the line; Enter while composing an accent (IME) does not send', () => {
    const k = (over: Partial<Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>> = {}) =>
      enterSends({ key: 'Enter', shiftKey: false, altKey: false, isComposing: false, ...over });
    expect(k()).toBe(true);
    expect(k({ shiftKey: true })).toBe(false);
    expect(k({ altKey: true })).toBe(false);
    expect(k({ isComposing: true })).toBe(false);
    expect(k({ key: 'a' })).toBe(false);
  });

  it('status line: sending, queued, delivering, delivered (disappears after a while) and the errors', () => {
    expect(sendStatusText(undefined, 0)).toBe('');
    expect(sendStatusText({ phase: 'sending', at: 0 }, 0)).toBe('Sending…');
    expect(sendStatusText({ phase: 'queued', at: 0 }, 0)).toMatch(/^Queued/);
    expect(sendStatusText({ phase: 'sent', at: 0 }, 0)).toMatch(/^Delivering/);
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000)).toMatch(/^Delivered ✓ \(if the agent is busy, it goes in when it finishes\)$/);
    expect(sendStatusText({ phase: 'delivered', at: 0 }, DELIVERED_SHOW_MS)).toBe('');
    expect(sendStatusText({ phase: 'rejected', error: 'já há 5 mensagens', at: 0 }, 0)).toBe("Couldn't send: já há 5 mensagens");
    expect(sendStatusText({ phase: 'failed', error: 'a sessão não confirmou a entrega', at: 0 }, 99_999)).toBe('Not delivered: a sessão não confirmou a entrega');
    expect(['delivered', 'failed', 'rejected'].every((p) => isSettled(p as never))).toBe(true);
    expect(['sending', 'queued', 'sent'].some((p) => isSettled(p as never))).toBe(false);
  });

  it('Codex: with a deliverer, same as Claude Code; without it, the codex:bridge hint; feature off sends to Codex', () => {
    const codex = (over: Partial<AgentInfo> = {}) => agent({ provider: 'codex', ...over });
    expect(composerMode(codex(), ON)).toEqual({ kind: 'ready' });
    expect(composerMode(codex({ canMessage: undefined }), ON)).toEqual({ kind: 'hint', text: CODEX_BRIDGE_HINT });
    expect(CODEX_BRIDGE_HINT).toBe('To send messages to Codex: with AgentForge in Docker, keep npm run codex:bridge running; in Node mode it works on its own');
    expect(composerMode(codex(), { ...ON, enabled: false })).toEqual({ kind: 'off', text: 'To reply, use Codex' });
    expect(composerMode(codex({ kind: 'sub', parentId: 'acc:1' }), ON).kind).toBe('off');
    expect(composerMode(codex({ status: 'offline' }), ON)).toEqual({ kind: 'off', text: 'Session ended' });
  });

  it('Codex: "Delivered" is the session queue; tip and deadline talk about Codex', () => {
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000, 'codex')).toBe("Delivered ✓ to the session queue: goes in when Codex finishes what it's doing (up to ~10 s)");
    expect(sendStatusText({ phase: 'delivered', at: 0 }, DELIVERED_SHOW_MS, 'codex')).toBe('');
    expect(sendStatusText({ phase: 'queued', at: 0 }, 0, 'codex')).toBe('Queued: delivering to Codex…');
    // Claude Code stays as before.
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000, 'claude')).toBe(sendStatusText({ phase: 'delivered', at: 0 }, 1_000));
    expect(composerTip('codex')).toMatch(/^Joins the session queue and becomes the next prompt when Codex finishes/);
    expect(composerTip()).toBe('Goes into the session as if you had typed it. Enter sends; Shift+Enter adds a new line.');
    expect(timeoutError('codex')).toBe(CODEX_TIMEOUT_ERROR);
    expect(timeoutError()).toBe(TIMEOUT_ERROR);
  });

  it('delivery polling: fast at first, more spaced out later', () => {
    expect(pollDelay(0)).toBeLessThan(1_000);
    expect(pollDelay(20_000)).toBeGreaterThan(pollDelay(0));
    expect(pollDelay(60_000)).toBeGreaterThanOrEqual(pollDelay(20_000));
  });
});
