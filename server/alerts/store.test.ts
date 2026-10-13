// Config store: defaults, save/load round-trip, env overrides, topic validation.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { AlertConfigStore, validateTopic } from './store';

setQuiet(true);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function storeInTmp(env: Record<string, string | undefined> = {}) {
  const tmp = tempDir('alerts-');
  cleanups.push(tmp.cleanup);
  return { store: new AlertConfigStore({ file: join(tmp.dir, 'alerts.json'), env }), file: join(tmp.dir, 'alerts.json') };
}

describe('AlertConfigStore', () => {
  it('returns defaults when the file does not exist', () => {
    const { store } = storeInTmp();
    const cfg = store.load();
    expect(cfg).toEqual({ enabled: true, topic: '', server: 'https://ntfy.sh' });
    expect(store.status(cfg)).toEqual({ active: false, reason: 'no-topic' });
  });

  it('round-trips save/load', () => {
    const { store } = storeInTmp();
    const saved = store.save({ enabled: false, topic: 'meu-topico', server: 'https://ntfy.exemplo' });
    expect(saved).toEqual({ enabled: false, topic: 'meu-topico', server: 'https://ntfy.exemplo' });
    expect(store.load()).toEqual(saved);
    expect(store.status(saved)).toEqual({ active: false, reason: 'disabled' });
  });

  it('treats a corrupt file as defaults', () => {
    const { store, file } = storeInTmp();
    store.save({ topic: 'ok' });
    writeFileSync(file, 'not json {{{');
    expect(store.load()).toEqual({ enabled: true, topic: '', server: 'https://ntfy.sh' });
  });

  it('is active only when enabled and a valid topic exists', () => {
    const { store } = storeInTmp();
    expect(store.status({ enabled: true, topic: 'meu-topico', server: 'https://ntfy.sh' })).toEqual({ active: true });
    expect(store.status({ enabled: false, topic: 'meu-topico', server: 'https://ntfy.sh' })).toEqual({
      active: false,
      reason: 'disabled',
    });
    expect(store.status({ enabled: true, topic: 'tem espaço', server: 'https://ntfy.sh' })).toEqual({
      active: false,
      reason: 'no-topic',
    });
  });

  it('AGENTFORGE_ALERTS_TOPIC enables with the topic', () => {
    const { store } = storeInTmp({ AGENTFORGE_ALERTS_TOPIC: 'env-topico' });
    const cfg = store.load();
    expect(cfg.enabled).toBe(true);
    expect(cfg.topic).toBe('env-topico');
    expect(store.status(cfg)).toEqual({ active: true });
  });

  it('AGENTFORGE_ALERTS_SERVER overrides the server', () => {
    const { store } = storeInTmp({ AGENTFORGE_ALERTS_SERVER: 'https://ntfy.exemplo' });
    expect(store.load().server).toBe('https://ntfy.exemplo');
  });

  it('AGENTFORGE_ALERTS=0 forces disabled while keeping the topic', () => {
    const { store } = storeInTmp({ AGENTFORGE_ALERTS: '0', AGENTFORGE_ALERTS_TOPIC: 'env-topico' });
    const cfg = store.load();
    expect(cfg.enabled).toBe(false);
    expect(cfg.topic).toBe('env-topico');
    expect(store.status(cfg)).toEqual({ active: false, reason: 'disabled' });
  });
});

describe('validateTopic', () => {
  it('accepts valid topics', () => {
    expect(validateTopic('a')).toBe('a');
    expect(validateTopic('Meu-Topico_123')).toBe('Meu-Topico_123');
    expect(validateTopic('x'.repeat(64))).toBe('x'.repeat(64));
  });

  it('rejects bad topics', () => {
    for (const bad of ['', 'tem espaço', 'com/barra', 'x'.repeat(65), 'çã', 42, null, undefined, {}]) {
      expect(() => validateTopic(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('throws an HttpError with status 400', () => {
    try {
      validateTopic('');
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
  });
});
