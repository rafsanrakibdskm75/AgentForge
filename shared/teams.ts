import type { AgentInfo, Provider, TeamInfo } from './types';

/** Provider union order (same as shared/types.ts): used for the stable team provider list. */
const PROVIDER_ORDER: Provider[] = ['claude', 'codex', 'gemini', 'opencode', 'antigravity'];

/**
 * Pure: teams for the Team view. Groups live main agents by room; a room is a team when it has
 * 2+ main agents from 2+ distinct providers. Teams are sorted by room name.
 */
export function computeTeams(agents: AgentInfo[], roomNameOf: (roomId: string) => string): TeamInfo[] {
  const byRoom = new Map<string, AgentInfo[]>();
  for (const a of agents) {
    if (a.kind !== 'main') continue;
    if (a.status === 'offline' || a.status === 'done') continue;
    const list = byRoom.get(a.roomId);
    if (list) list.push(a);
    else byRoom.set(a.roomId, [a]);
  }
  const teams: TeamInfo[] = [];
  for (const [roomId, mains] of byRoom) {
    const providers = [...new Set(mains.map((a) => a.provider ?? 'claude'))]
      .sort((a, b) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b));
    if (mains.length < 2 || providers.length < 2) continue;
    teams.push({
      roomId,
      roomName: roomNameOf(roomId),
      providers,
      members: mains.map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider ?? 'claude',
        status: a.status,
        ...(a.activity?.text ? { activityText: a.activity.text } : {}),
        ...(a.activity?.icon ? { activityIcon: a.activity.icon } : {}),
      })),
    });
  }
  return teams.sort((a, b) => a.roomName.localeCompare(b.roomName));
}
