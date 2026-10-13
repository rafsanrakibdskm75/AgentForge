// Owns the "needs you" phone alerts: a config store (<dataDir>/alerts.json + env), a watcher that
// diffs the office snapshot and a sender that POSTs to ntfy. Bodies carry only the agent name, the
// room/project and the short waiting reason — never file contents or secrets (ntfy topics are
// guessable-public; the client UI carries that warning).
import { join } from 'node:path';
import type { OfficeSnapshot } from '../../shared/types';
import { HttpError } from '../http/app';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';
import { sendNtfy } from './sender';
import { AlertConfigStore, validateTopic, type AlertConfig, type AlertInactiveReason } from './store';
import { AlertWatcher, type WaitingAlert } from './watcher';

export interface AlertServiceDeps {
  dataDir: string;
  env: Record<string, string | undefined>;
  snapshot: () => Pick<OfficeSnapshot, 'agents' | 'rooms'>;
  pollMs?: number;
}

export interface AlertStatus {
  enabled: boolean;
  topic: string;
  server: string;
  active: boolean;
  reason?: AlertInactiveReason;
}

const EXPECTED_SHAPE = 'esperado {enabled: boolean, topic?: string, server?: string}';

export class AlertService {
  private readonly store: AlertConfigStore;
  private readonly watcher: AlertWatcher;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: AlertServiceDeps) {
    this.store = new AlertConfigStore({ file: join(deps.dataDir, 'alerts.json'), env: deps.env });
    this.pollMs = deps.pollMs ?? 5000;
    this.watcher = new AlertWatcher({ snapshot: deps.snapshot, send: (a) => this.notify(a) });
  }

  /** Boot: starts the poll loop (unref'd so it never holds the process open). */
  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  /** Stops the poll loop (call before shutting down). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll cycle; exposed for tests. Send failures are logged inside `notify`. */
  async poll(): Promise<void> {
    try {
      await this.watcher.poll();
    } catch (err) {
      log.warnOnce('alerts-poll', tr('falha na checagem dos alertas ({0})', [errMsg(err)]));
    }
  }

  private async notify(a: WaitingAlert): Promise<void> {
    const cfg = this.store.load();
    if (!this.store.status(cfg).active) return; // nothing configured: stay idle
    const title = tr('🤚 {0} precisa de você', [a.agentName]);
    const body = a.reason ? tr('{0} · {1}', [a.room, a.reason]) : a.room;
    try {
      await sendNtfy({ server: cfg.server, topic: cfg.topic, title, body });
    } catch (err) {
      log.warnOnce(`alerts-send:${a.agentId}`, tr('falha ao enviar o alerta do ntfy ({0})', [errMsg(err)]));
    }
  }

  getConfig(): AlertStatus {
    const cfg = this.store.load();
    const s = this.store.status(cfg);
    return {
      enabled: cfg.enabled,
      topic: cfg.topic,
      server: cfg.server,
      active: s.active,
      ...(s.reason ? { reason: s.reason } : {}),
    };
  }

  setConfig(partial: { enabled?: unknown; topic?: unknown; server?: unknown }): AlertStatus {
    const patch: Partial<AlertConfig> = {};
    if (partial.enabled !== undefined) {
      if (typeof partial.enabled !== 'boolean') throw new HttpError(400, tr(EXPECTED_SHAPE));
      patch.enabled = partial.enabled;
    }
    if (partial.topic !== undefined) patch.topic = validateTopic(partial.topic);
    if (partial.server !== undefined) {
      if (typeof partial.server !== 'string' || !partial.server.trim()) throw new HttpError(400, tr(EXPECTED_SHAPE));
      patch.server = partial.server.trim().replace(/\/+$/, '');
    }
    this.store.save(patch);
    return this.getConfig();
  }

  async sendTest(): Promise<{ ok: true } | { ok: false; error: string }> {
    const cfg = this.store.load();
    let topic: string;
    try {
      topic = validateTopic(cfg.topic);
    } catch {
      return { ok: false, error: tr('configure um tópico para testar os alertas') };
    }
    try {
      await sendNtfy({
        server: cfg.server,
        topic,
        title: tr('🔔 Alerta de teste do AgentForge'),
        body: tr('Se você leu isto, os alertas estão funcionando.'),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
}
