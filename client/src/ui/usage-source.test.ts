import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { cardState, codexUsageNote, showsUsageAge, sourceLabel, usageMessage, usageSubtitle } from './usage';

const MIN = 60_000;
type Acc = Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider' | 'email' | 'plan' | 'configDir'>;
const codex = (over: Partial<Acc> = {}): Acc => ({ provider: 'codex', usageStatus: 'ok', configDir: '~/.codex', plan: 'Team', ...over });
const win = { utilization: 42, resetsAt: 10 * 60 * MIN };

describe('sourceLabel', () => {
  it('says who recorded the usage live', () => {
    expect(sourceLabel({ source: 'statusline', via: 'mod', fetchedAt: 0 })).toBe('live (AgentForge mod)');
    expect(sourceLabel({ source: 'statusline', via: 'tap', fetchedAt: 0 })).toBe('live (Claude Code statusline)');
    expect(sourceLabel({ source: 'statusline', fetchedAt: 0 })).toBe('live (Claude Code statusline)');
    expect(sourceLabel({ source: 'cache', fetchedAt: 0 })).toBe('Claude Code /usage cache');
    expect(sourceLabel({ source: 'codex', fetchedAt: 0 })).toBe('Codex files');
  });
});

describe('usage card of a Codex account', () => {
  it('"no quota" is its own state (never 0% nor "no data")', () => {
    const noQuota = codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } });
    expect(cardState(noQuota)).toBe('noquota');
    expect(usageMessage(noQuota)).toEqual(['no quota', 'no quota']);
    expect(codexUsageNote(noQuota, 3 * MIN)).toMatch(/^At the last reading \(3 min ago\), the account had no quota or credits .*It's not 0%/);
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 } }))).toBe('ok');
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 }, usageStatus: 'stale' }))).toBe('stale');
    expect(cardState(codex())).toBe('empty');
  });

  it('the age is always visible on Codex (only refreshes with a running session); on Claude Code, only when old', () => {
    const fresh = { source: 'codex' as const, fiveHour: win, fetchedAt: 0 };
    expect(showsUsageAge(codex({ usage: fresh }))).toBe(true);
    expect(showsUsageAge(codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } }))).toBe(true);
    expect(showsUsageAge(codex())).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'statusline' }, usageStatus: 'ok' })).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'cache' }, usageStatus: 'stale' })).toBe(true);
    expect(codexUsageNote(codex({ usage: fresh }), 12 * MIN)).toBe('Codex only records usage while a session is running: these numbers are from the last reading (12 min ago).');
  });

  it('no numbers: nothing to install; under the name, the plan (no email)', () => {
    expect(usageMessage(codex())).toEqual(['no data yet', 'no data']);
    expect(codexUsageNote(codex(), 0)).toBe('Nothing to install: the numbers arrive with the next Codex session.');
    expect(usageSubtitle(codex())).toBe('Team plan');
    expect(usageSubtitle(codex({ plan: undefined }))).toBe('Codex');
    // Claude Code: as before.
    expect(usageMessage({ usageStatus: 'disabled' })).toEqual(['no usage data', 'no data']);
    expect(usageSubtitle({ email: 'a@b.c', configDir: '~/.claude' })).toBe('a@b.c');
    expect(usageSubtitle({ configDir: '~/.claude' })).toBe('~/.claude');
    expect(codexUsageNote({ usageStatus: 'ok' }, 0)).toBe('');
  });
});
