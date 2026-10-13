import { describe, expect, it } from 'vitest';
import {
  calendarDayDiff,
  clampPercent,
  compactDuration,
  FIVE_HOURS_MS,
  formatCountdown,
  formatDuration,
  formatElapsed,
  formatInt,
  formatResetAt,
  formatTokens,
  formatUSD,
  normalizeSearch,
  permissionLabel,
  plural,
  prettyModel,
  relativeTime,
  shortPath,
  usageWindowView,
  WEEK_MS,
  usageLevel,
} from './format';

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe('relativeTime', () => {
  const now = new Date(2026, 9, 6, 14, 0, 0).getTime();
  it('uses "now" for under 5 s and for the future', () => {
    expect(relativeTime(now, now)).toBe('now');
    expect(relativeTime(now - 4 * S, now)).toBe('now');
    expect(relativeTime(now + 10 * S, now)).toBe('now');
  });
  it('formats seconds, minutes, hours and days', () => {
    expect(relativeTime(now - 5 * S, now)).toBe('5 s ago');
    expect(relativeTime(now - 59 * S, now)).toBe('59 s ago');
    expect(relativeTime(now - 3 * M, now)).toBe('3 min ago');
    expect(relativeTime(now - 2 * H - 10 * M, now)).toBe('2 h ago');
    expect(relativeTime(now - 3 * D, now)).toBe('3 d ago');
  });
  it('treats invalid values as "now"', () => {
    expect(relativeTime(Number.NaN, now)).toBe('now');
  });
});

describe('formatDuration / formatCountdown', () => {
  it('formats compound durations', () => {
    expect(formatDuration(12 * S)).toBe('12 s');
    expect(formatDuration(3 * M + 20 * S)).toBe('3 min');
    expect(formatDuration(2 * H)).toBe('2 h');
    expect(formatDuration(2 * H + 10 * M)).toBe('2 h 10 min');
    expect(formatDuration(3 * D + 4 * H)).toBe('3 d 4 h');
    expect(formatDuration(-5)).toBe('0 s');
  });
  it('formats countdown', () => {
    const now = 1_000_000;
    expect(formatCountdown(now - 1, now)).toBe('now');
    expect(formatCountdown(now + 30 * S, now)).toBe('in less than 1 min');
    expect(formatCountdown(now + 2 * H + 10 * M, now)).toBe('in 2 h 10 min');
  });
});

describe('formatResetAt', () => {
  const now = new Date(2026, 9, 6, 9, 15).getTime(); // Tuesday, 10/06/2026
  it('same day: "at HH:MM"', () => {
    expect(formatResetAt(new Date(2026, 9, 6, 14, 30).getTime(), now)).toBe('at 14:30');
  });
  it('next day: "tomorrow at HH:MM"', () => {
    expect(formatResetAt(new Date(2026, 9, 7, 1, 30).getTime(), now)).toBe('tomorrow at 01:30');
  });
  it('further out: abbreviated weekday', () => {
    expect(formatResetAt(new Date(2026, 9, 8, 20, 0).getTime(), now)).toBe('Thu, 20:00');
  });
  it('counts calendar days, not 24 h blocks', () => {
    expect(calendarDayDiff(new Date(2026, 9, 7, 0, 5).getTime(), new Date(2026, 9, 6, 23, 55).getTime())).toBe(1);
    expect(calendarDayDiff(new Date(2026, 9, 6, 23, 55).getTime(), new Date(2026, 9, 6, 0, 5).getTime())).toBe(0);
  });
});

describe('numbers', () => {
  it('formatTokens uses k and M with a decimal point', () => {
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(12_340)).toBe('12.3 k');
    expect(formatTokens(1_000)).toBe('1 k');
    expect(formatTokens(1_250_000)).toBe('1.3 M');
    expect(formatTokens(-3)).toBe('0');
  });
  it('formatUSD and formatInt in en-US', () => {
    expect(formatUSD(1.234)).toBe('$1.23');
    expect(formatUSD(0)).toBe('$0.00');
    expect(formatInt(12345)).toBe('12,345');
  });
  it('plural', () => {
    expect(plural(1, 'agente', 'agentes')).toBe('1 agente');
    expect(plural(0, 'agente', 'agentes')).toBe('0 agentes');
    expect(plural(3, 'agente', 'agentes')).toBe('3 agentes');
  });
});

describe('usage (percentages)', () => {
  it('clampPercent clamps and rounds', () => {
    expect(clampPercent(undefined)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(49.6)).toBe(50);
    expect(clampPercent(140)).toBe(100);
  });
  it('usageLevel: green < 50, amber 50–80, red >= 80', () => {
    expect(usageLevel(0)).toBe('ok');
    expect(usageLevel(49)).toBe('ok');
    expect(usageLevel(50)).toBe('warn');
    expect(usageLevel(79)).toBe('warn');
    expect(usageLevel(80)).toBe('crit');
    expect(usageLevel(100)).toBe('crit');
  });
});

describe('texts', () => {
  it('normalizeSearch removes accents and case', () => {
    expect(normalizeSearch('  João Ávila ')).toBe('joao avila');
  });
  it('prettyModel recognizes the id formats', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4');
    expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(prettyModel('gpt-x')).toBe('gpt-x');
    // Codex.
    expect(prettyModel('gpt-5.3-codex')).toBe('GPT-5.3 Codex');
    expect(prettyModel('gpt-5.1-codex-mini')).toBe('GPT-5.1 Codex Mini');
    expect(prettyModel('gpt-5-codex')).toBe('GPT-5 Codex');
    expect(prettyModel('gpt-5')).toBe('GPT-5');
    expect(prettyModel('gpt-4o')).toBe('GPT-4o');
    expect(prettyModel(undefined)).toBe('—');
  });
  it('permissionLabel translates known modes', () => {
    expect(permissionLabel('acceptEdits')).toBe('Accepts edits');
    expect(permissionLabel('custom')).toBe('custom');
    expect(permissionLabel(undefined)).toBe('—');
  });
  it('shortPath shortens the home folder', () => {
    expect(shortPath('/Users/ana/projetos/x')).toBe('~/projetos/x');
    expect(shortPath('/home/bob')).toBe('~');
    expect(shortPath('/srv/app')).toBe('/srv/app');
  });
});

describe('usage window restarts', () => {
  const now = new Date(2026, 9, 6, 9, 15).getTime(); // Tuesday, 10/06/2026
  const H = 3_600_000;
  const D = 24 * H;

  it('formatResetAt never shows a restart in the past', () => {
    expect(formatResetAt(now - 60_000, now)).toBe('');
    expect(formatResetAt(now, now)).toBe('');
  });

  it('compactDuration', () => {
    expect(compactDuration(45_000)).toBe('45s');
    expect(compactDuration(29 * 60_000)).toBe('29min');
    expect(compactDuration(H + 9 * 60_000)).toBe('1h09');
    expect(compactDuration(2 * H)).toBe('2h');
    expect(compactDuration(3 * D + 4 * H)).toBe('3d4h');
  });

  it('current window: percentage and countdown (< 24 h) or day and time', () => {
    const five = usageWindowView({ utilization: 35.4, resetsAt: now + H + 29 * 60_000 }, now - 60_000, now, FIVE_HOURS_MS)!;
    expect(five).toMatchObject({ pct: 35, renewed: false, reset: 'in 1 h 29 min', resetShort: '1h29' });
    expect(five.summary).toBe('35% used · resets at 10:44 (in 1 h 29 min)');
    const week = usageWindowView({ utilization: 12, resetsAt: new Date(2026, 9, 8, 13, 49).getTime() }, now, now, WEEK_MS)!;
    expect(week.reset).toBe('Thu, 13:49');
    const tomorrow = usageWindowView({ utilization: 12, resetsAt: new Date(2026, 9, 7, 13, 49).getTime() }, now, now, WEEK_MS)!;
    expect(tomorrow.reset).toBe('tomorrow, 13:49');
  });

  it('window that already renewed after the read: no percentage', () => {
    const v = usageWindowView({ utilization: 35, resetsAt: now - H }, now - 3 * H, now, FIVE_HOURS_MS)!;
    expect(v).toMatchObject({ pct: null, renewed: true, reset: 'renewed' });
    // Without a restart time: numbers older than the window are invalid too.
    expect(usageWindowView({ utilization: 10 }, now - 6 * H, now, FIVE_HOURS_MS)!.renewed).toBe(true);
    expect(usageWindowView({ utilization: 10 }, now - 6 * H, now, WEEK_MS)!.pct).toBe(10);
    expect(usageWindowView(undefined, now, now, WEEK_MS)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('m:ss stopwatch under 1 hour', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7 * S + 999)).toBe('0:07');
    expect(formatElapsed(59 * S)).toBe('0:59');
    expect(formatElapsed(M)).toBe('1:00');
    expect(formatElapsed(12 * M + 31 * S)).toBe('12:31');
    expect(formatElapsed(H - S)).toBe('59:59');
  });
  it('h:mm:ss from 1 hour and readable duration from 1 day', () => {
    expect(formatElapsed(H)).toBe('1:00:00');
    expect(formatElapsed(H + 2 * M + 10 * S)).toBe('1:02:10');
    expect(formatElapsed(23 * H + 59 * M + 59 * S)).toBe('23:59:59');
    expect(formatElapsed(D + 2 * H)).toBe('1 d 2 h');
  });
  it('negative or invalid values become 0:00', () => {
    expect(formatElapsed(-5 * S)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
  });
});
