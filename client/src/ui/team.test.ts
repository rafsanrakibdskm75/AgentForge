// Pure helpers of the Team view panel (ui/team.ts); the panel itself needs a DOM.
import { describe, expect, it } from 'vitest';
import type { TeamInfo } from '../../../shared/types';
import { teamForRoom, teamProviderNames } from './team';

const TEAM: TeamInfo = {
  roomId: 'r1',
  roomName: 'Projeto',
  providers: ['claude', 'codex', 'claude'],
  members: [
    { id: 'a1', name: 'Ada', provider: 'claude', status: 'working', activityText: 'Editing main.ts', activityIcon: '⌨️' },
    { id: 'a2', name: 'Beto', provider: 'codex', status: 'waiting' },
  ],
};

describe('teamForRoom', () => {
  it('finds the team of the room', () => {
    expect(teamForRoom([TEAM], 'r1')).toBe(TEAM);
  });

  it('returns undefined when the room has no team', () => {
    expect(teamForRoom([TEAM], 'r2')).toBeUndefined();
    expect(teamForRoom([], 'r1')).toBeUndefined();
    expect(teamForRoom(undefined, 'r1')).toBeUndefined();
  });
});

describe('teamProviderNames', () => {
  it('dedupes the provider display names, in snapshot order', () => {
    expect(teamProviderNames(TEAM)).toEqual(['Claude Code', 'Codex']);
  });
});
