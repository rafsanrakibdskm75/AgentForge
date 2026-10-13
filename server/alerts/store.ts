// Server-side config for the "needs you" alerts (see server/alerts/service.ts), persisted in
// `<dataDir>/alerts.json`. Environment variables override the file so containers can set it up
// without touching disk.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from '../http/app';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

export interface AlertConfig {
  enabled: boolean;
  topic: string;
  server: string;
}

export const DEFAULT_ALERT_SERVER = 'https://ntfy.sh';
const DEFAULTS: AlertConfig = { enabled: true, topic: '', server: DEFAULT_ALERT_SERVER };

/** ntfy topic rules: 1–64 chars, `[A-Za-z0-9_-]`. Throws an HttpError (400) on violation. */
export function validateTopic(t: unknown): string {
  if (typeof t !== 'string' || t.length < 1 || t.length > 64 || !/^[A-Za-z0-9_-]+$/.test(t))
    throw new HttpError(400, tr('tópico inválido: use de 1 a 64 caracteres [A-Za-z0-9_-]'));
  return t;
}

export type AlertInactiveReason = 'disabled' | 'no-topic';

export class AlertConfigStore {
  constructor(private readonly deps: { file: string; env: Record<string, string | undefined> }) {}

  /** File values, then env overrides; missing/corrupt file falls back to the defaults. */
  load(): AlertConfig {
    return this.applyEnv(this.readFile());
  }

  /** Merges `partial` into the file (env overrides still apply on read) and returns the result. */
  save(partial: Partial<AlertConfig>): AlertConfig {
    const cfg = this.applyEnv({ ...this.readFile(), ...partial });
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      renameSync(tmp, this.deps.file);
    } catch (err) {
      log.warnOnce('alerts-write', tr('não foi possível gravar {0} ({1})', [this.deps.file, errMsg(err)]));
    }
    return cfg;
  }

  /** Alerts only go out when enabled *and* a valid topic is set. */
  status(cfg: AlertConfig): { active: boolean; reason?: AlertInactiveReason } {
    if (!cfg.enabled) return { active: false, reason: 'disabled' };
    try {
      validateTopic(cfg.topic);
    } catch {
      return { active: false, reason: 'no-topic' };
    }
    return { active: true };
  }

  private readFile(): AlertConfig {
    let raw: string;
    try {
      raw = readFileSync(this.deps.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        log.warnOnce('alerts-read', tr('não foi possível ler {0} ({1}); usando os padrões.', [this.deps.file, errMsg(err)]));
      return { ...DEFAULTS };
    }
    try {
      const p = JSON.parse(raw) as Partial<AlertConfig>;
      return {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULTS.enabled,
        topic: typeof p.topic === 'string' ? p.topic : DEFAULTS.topic,
        server: typeof p.server === 'string' && p.server ? p.server : DEFAULTS.server,
      };
    } catch {
      log.warnOnce('alerts-corrupt', tr('{0} está ilegível; usando os padrões.', [this.deps.file]));
      return { ...DEFAULTS };
    }
  }

  private applyEnv(cfg: AlertConfig): AlertConfig {
    const env = this.deps.env;
    const topic = env.AGENTFORGE_ALERTS_TOPIC;
    if (topic) cfg = { ...cfg, enabled: true, topic };
    const server = env.AGENTFORGE_ALERTS_SERVER;
    if (server) cfg = { ...cfg, server };
    // AGENTFORGE_ALERTS=0 forces the switch off (the topic is kept).
    if (env.AGENTFORGE_ALERTS === '0') cfg = { ...cfg, enabled: false };
    return cfg;
  }
}
