// "Needs you" phone alerts (see server/alerts/service.ts): polls the office snapshot and fires a
// notification for every *main* agent that just entered the `waiting` status (raised hand: needs the
// user). Pure diff logic; the actual delivery lives in `deps.send`.
import type { OfficeSnapshot } from '../../shared/types';
import { DEMO_ID_PREFIX } from '../history/daystats';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

/** What goes into one "needs you" push notification (never file contents or secrets). */
export interface WaitingAlert {
  agentId: string;
  agentName: string;
  /** Display name of the room (project) the agent is in. */
  room: string;
  /** Short reason (`AgentInfo.waitingFor`), may be empty. */
  reason: string;
}

export interface AlertWatcherDeps {
  /** Current office state (only `agents` and `rooms` are read). */
  snapshot: () => Pick<OfficeSnapshot, 'agents' | 'rooms'>;
  send: (a: WaitingAlert) => Promise<void>;
  now?: () => number;
}

export class AlertWatcher {
  private readonly snapshot: () => Pick<OfficeSnapshot, 'agents' | 'rooms'>;
  private readonly send: (a: WaitingAlert) => Promise<void>;
  private readonly now: () => number;
  /** Ids already known to be waiting (main agents only); fires only on transitions into waiting. */
  private waiting = new Set<string>();

  constructor(deps: AlertWatcherDeps) {
    this.snapshot = deps.snapshot;
    this.send = deps.send;
    this.now = deps.now ?? Date.now;
  }

  /** One diff cycle: alerts for main agents that entered `waiting` since the last poll. */
  async poll(): Promise<void> {
    const snap = this.snapshot();
    const rooms = new Map(snap.rooms.map((r) => [r.id, r.name]));
    const current = new Set<string>();
    for (const a of snap.agents) {
      if (a.status !== 'waiting') continue;
      if (a.parentId) continue; // subagents answer through their main agent
      if (a.id.startsWith(DEMO_ID_PREFIX)) continue; // demo agents are not real
      current.add(a.id);
      if (this.waiting.has(a.id)) continue; // already waiting: no duplicate
      try {
        await this.send({
          agentId: a.id,
          agentName: a.name,
          room: rooms.get(a.roomId) ?? a.roomId,
          reason: a.waitingFor ?? '',
        });
      } catch (err) {
        log.warnOnce(
          `alerts:${a.id}`,
          tr('não foi possível avisar que {0} precisa de você ({1})', [a.name, errMsg(err)]),
        );
      }
    }
    // Agents that left `waiting` or vanished are forgotten: entering again alerts again.
    this.waiting = current;
  }
}
