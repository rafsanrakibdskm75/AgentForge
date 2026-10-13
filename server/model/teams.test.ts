import { describe, expect, it } from 'vitest';
import type { Activity, AgentInfo, AgentStatus, Provider } from '../../shared/types';
import { computeTeams } from './office';

const activity = (text: string, icon: string): Activity => ({
  id: 'act-1',
  kind: 'edit',
  icon,
  text,
  at: 0,
});

let seq = 0;
const agent = (p: Partial<AgentInfo> & { status?: AgentStatus }): AgentInfo =>
  ({
    id: `a-${++seq}`,
    kind: 'main',
    roomId: '/proj',
    name: `Agent ${seq}`,
    look: 'f',
    role: 'main',
    sessionId: 's1',
    account: '.claude',
    status: p.status ?? 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: {},
    seed: 1,
    ...p,
  }) as AgentInfo;

const roomNameOf = (roomId: string): string => roomId.split('/').filter(Boolean).pop() ?? roomId;

describe('computeTeams', () => {
  it('no team when the room has a single provider', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/solo', name: 'Solo1' }),
      agent({ id: 'a2', roomId: '/solo', name: 'Solo2' }),
      // Same room, but provider absent = claude
      agent({ id: 'a3', roomId: '/mono', name: 'Mono1' }),
      agent({ id: 'a4', roomId: '/mono', name: 'Mono2' }),
    ];
    expect(computeTeams(agents, roomNameOf)).toEqual([]);
  });

  it('team when two providers share a room', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/proj', name: 'Claude One' }),
      agent({ id: 'a2', roomId: '/proj', name: 'Gemini One', provider: 'gemini' }),
      agent({ id: 'a3', roomId: '/other', name: 'Lonely' }),
    ];
    const teams = computeTeams(agents, roomNameOf);
    expect(teams).toHaveLength(1);
    expect(teams[0].roomId).toBe('/proj');
    expect(teams[0].roomName).toBe('proj');
    expect(teams[0].providers).toEqual(['claude', 'gemini']);
    expect(teams[0].members.map((m) => m.name)).toEqual(['Claude One', 'Gemini One']);
    expect(teams[0].members[0].provider).toBe('claude');
  });

  it('subagents are excluded even from different providers', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/proj', name: 'Main', provider: 'claude' }),
      agent({ id: 'a2', roomId: '/proj', name: 'Sub', kind: 'sub', provider: 'codex' }),
    ];
    expect(computeTeams(agents, roomNameOf)).toEqual([]);
  });

  it('offline and done mains are excluded', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/proj', name: 'Live', provider: 'claude' }),
      agent({ id: 'a2', roomId: '/proj', name: 'Gone', provider: 'codex', status: 'offline' }),
      agent({ id: 'a3', roomId: '/proj2', name: 'Live2', provider: 'claude' }),
      agent({ id: 'a4', roomId: '/proj2', name: 'Finished', provider: 'opencode', status: 'done' }),
    ];
    expect(computeTeams(agents, roomNameOf)).toEqual([]);
  });

  it('waiting/idle/shell agents still form a team', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/proj', name: 'W', provider: 'claude', status: 'waiting' }),
      agent({ id: 'a2', roomId: '/proj', name: 'I', provider: 'codex', status: 'idle' }),
      agent({ id: 'a3', roomId: '/proj', name: 'S', provider: 'antigravity', status: 'shell' }),
    ];
    const teams = computeTeams(agents, roomNameOf);
    expect(teams).toHaveLength(1);
    expect(teams[0].providers).toEqual(['claude', 'codex', 'antigravity']);
  });

  it('absent provider defaults to claude', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/proj', name: 'NoProvider' }),
      agent({ id: 'a2', roomId: '/proj', name: 'Gem', provider: 'gemini' }),
    ];
    const teams = computeTeams(agents, roomNameOf);
    expect(teams).toHaveLength(1);
    expect(teams[0].providers).toEqual(['claude', 'gemini']);
    expect(teams[0].members.find((m) => m.id === 'a1')?.provider).toBe('claude');
  });

  it('activity text and icon pass through', () => {
    const agents = [
      agent({
        id: 'a1',
        roomId: '/proj',
        name: 'Busy',
        activity: activity('Editando App.tsx', '✏️'),
      }),
      agent({ id: 'a2', roomId: '/proj', name: 'Quiet', provider: 'opencode' }),
    ];
    const teams = computeTeams(agents, roomNameOf);
    expect(teams).toHaveLength(1);
    const busy = teams[0].members.find((m) => m.id === 'a1');
    expect(busy?.activityText).toBe('Editando App.tsx');
    expect(busy?.activityIcon).toBe('✏️');
    const quiet = teams[0].members.find((m) => m.id === 'a2');
    expect(quiet?.activityText).toBeUndefined();
    expect(quiet?.activityIcon).toBeUndefined();
  });

  it('teams are sorted by room name', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/zeta', name: 'Z1' }),
      agent({ id: 'a2', roomId: '/zeta', name: 'Z2', provider: 'codex' }),
      agent({ id: 'a3', roomId: '/alpha', name: 'A1' }),
      agent({ id: 'a4', roomId: '/alpha', name: 'A2', provider: 'gemini' }),
      agent({ id: 'a5', roomId: '/mid', name: 'M1' }),
      agent({ id: 'a6', roomId: '/mid', name: 'M2', provider: 'opencode' }),
    ];
    const teams = computeTeams(agents, roomNameOf);
    expect(teams.map((t) => t.roomName)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('providers follow the Provider union order', () => {
    const agents = [
      agent({ id: 'a1', roomId: '/proj', name: 'N1', provider: 'antigravity' }),
      agent({ id: 'a2', roomId: '/proj', name: 'N2', provider: 'claude' }),
      agent({ id: 'a3', roomId: '/proj', name: 'N3', provider: 'opencode' }),
    ];
    const teams = computeTeams(agents, roomNameOf);
    const expected: Provider[] = ['claude', 'opencode', 'antigravity'];
    expect(teams[0].providers).toEqual(expected);
  });
});
