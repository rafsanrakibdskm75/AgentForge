// Pure rules of the Team view indicator: reading snapshot.teams into room -> providers.
import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot, Provider, TeamInfo } from '../../../shared/types';
import { teamDotsWidth, teamProvidersOf } from './team';

function snap(teams: unknown = []): OfficeSnapshot {
  return {
    rev: 1,
    serverTime: 0,
    rooms: [],
    agents: [],
    accounts: [],
    teams: teams as TeamInfo[],
    meta: { demo: true, sources: [], startedAt: 0, version: 'test' },
  };
}

describe('teamProvidersOf', () => {
  it('maps roomId -> distinct providers of each team', () => {
    const m = teamProvidersOf(
      snap([
        { roomId: 'r1', roomName: 'Sala 1', providers: ['claude', 'gemini'], members: [] },
        { roomId: 'r2', roomName: 'Sala 2', providers: ['codex', 'antigravity', 'opencode'], members: [] },
      ]),
    );
    expect(m.get('r1')).toEqual(['claude', 'gemini']);
    expect(m.get('r2')).toEqual(['codex', 'antigravity', 'opencode']);
  });

  it('drops entries with fewer than 2 distinct providers', () => {
    const m = teamProvidersOf(
      snap([
        { roomId: 'solo', providers: ['claude'], members: [] },
        { roomId: 'dup', providers: ['claude', 'claude'], members: [] },
      ]),
    );
    expect(m.size).toBe(0);
  });

  it('ignores unknown providers and malformed entries', () => {
    const m = teamProvidersOf(
      snap([
        { roomId: 'r1', providers: ['claude', 'watson' as Provider, 'gemini'], members: [] },
        { roomId: 'r2', providers: ['claude', 'watson' as Provider], members: [] },
        null,
        { roomId: 42, providers: ['claude', 'gemini'] },
        { roomId: 'r3', providers: 'claude' },
      ]),
    );
    expect(m.get('r1')).toEqual(['claude', 'gemini']);
    expect(m.has('r2')).toBe(false);
    expect(m.size).toBe(1);
  });

  it('returns an empty map when the snapshot has no teams (backend not yet sending them)', () => {
    expect(teamProvidersOf(snap()).size).toBe(0);
    expect(teamProvidersOf(snap('nope')).size).toBe(0);
  });
});

describe('teamDotsWidth', () => {
  it('zero dots take no space; one dot is a diameter; more overlap', () => {
    expect(teamDotsWidth(0, 4)).toBe(0);
    expect(teamDotsWidth(1, 4)).toBe(8);
    expect(teamDotsWidth(3, 4)).toBe(Math.round(8 + 2 * 5));
  });
});
