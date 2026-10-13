// Diff logic of the "needs you" alerts: only *main* agents entering `waiting` fire, once each.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { AlertWatcher, type WaitingAlert } from './watcher';

setQuiet(true);

let seq = 0;
function agent(o: Partial<AgentInfo>): AgentInfo {
  return {
    id: `a${++seq}`,
    kind: 'main',
    roomId: 'r1',
    name: `Agente ${seq}`,
    look: 'm',
    role: 'Agente principal',
    sessionId: 'sess-1',
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 1,
    lastEventAt: 1,
    statusSince: 1,
    stats: {} as AgentInfo['stats'],
    seed: 7,
    ...o,
  };
}

function room(id: string, name: string): RoomInfo {
  return { id, name, path: `/p/${id}`, slot: 0, seed: 1, createdAt: 1 };
}

function snap(agents: AgentInfo[], rooms: RoomInfo[] = [room('r1', 'Loja')]): Pick<OfficeSnapshot, 'agents' | 'rooms'> {
  return { agents, rooms };
}

function setup() {
  const sent: WaitingAlert[] = [];
  let state: AgentInfo[] = [];
  const watcher = new AlertWatcher({
    snapshot: () => snap(state),
    send: async (a) => {
      sent.push(a);
    },
  });
  return { sent, watcher, set: (agents: AgentInfo[]) => (state = agents) };
}

describe('AlertWatcher', () => {
  afterEach(() => vi.restoreAllMocks());

  it('alerts once when a main agent enters waiting, with resolved room and reason', async () => {
    const { sent, watcher, set } = setup();
    const a = agent({ id: 'main-1', name: 'Marina', roomId: 'r1', status: 'waiting', waitingFor: 'aprovar uma permissão' });
    set([a]);
    await watcher.poll();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ agentId: 'main-1', agentName: 'Marina', room: 'Loja', reason: 'aprovar uma permissão' });
  });

  it('does not duplicate while the agent stays waiting', async () => {
    const { sent, watcher, set } = setup();
    const a = agent({ id: 'main-1', status: 'waiting' });
    set([a]);
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    expect(sent).toHaveLength(1);
  });

  it('forgets agents that leave waiting, so re-entering alerts again', async () => {
    const { sent, watcher, set } = setup();
    const a = agent({ id: 'main-1', status: 'waiting' });
    set([a]);
    await watcher.poll();
    expect(sent).toHaveLength(1);
    set([{ ...a, status: 'working' }]);
    await watcher.poll();
    expect(sent).toHaveLength(1);
    set([{ ...a, status: 'waiting' }]);
    await watcher.poll();
    expect(sent).toHaveLength(2);
  });

  it('forgets agents that vanish, so a returning agent alerts again', async () => {
    const { sent, watcher, set } = setup();
    const a = agent({ id: 'main-1', status: 'waiting' });
    set([a]);
    await watcher.poll();
    expect(sent).toHaveLength(1);
    set([]);
    await watcher.poll();
    set([a]);
    await watcher.poll();
    expect(sent).toHaveLength(2);
  });

  it('ignores waiting subagents (parentId set)', async () => {
    const { sent, watcher, set } = setup();
    set([agent({ id: 'sub-1', status: 'waiting', parentId: 'main-1' })]);
    await watcher.poll();
    expect(sent).toHaveLength(0);
  });

  it('ignores demo agents', async () => {
    const { sent, watcher, set } = setup();
    set([agent({ id: 'demo:abc', status: 'waiting' })]);
    await watcher.poll();
    expect(sent).toHaveLength(0);
  });

  it('falls back to the room id when the room is unknown', async () => {
    const { sent, watcher, set } = setup();
    set([agent({ id: 'main-1', roomId: 'r-unknown', status: 'waiting' })]);
    await watcher.poll();
    expect(sent).toHaveLength(1);
    expect(sent[0].room).toBe('r-unknown');
    expect(sent[0].reason).toBe('');
  });

  it('never throws when send fails', async () => {
    const watcher = new AlertWatcher({
      snapshot: () => snap([agent({ id: 'main-1', status: 'waiting' })]),
      send: async () => {
        throw new Error('rede caiu');
      },
    });
    await expect(watcher.poll()).resolves.toBeUndefined();
  });
});
