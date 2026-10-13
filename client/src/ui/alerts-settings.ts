// "Needs you" phone alerts: ntfy push configuration (enable switch, topic, server, test).
// Server-side config only: fetched/saved through /api/alerts/config (never stored in local prefs).
import type { UiContext } from './context';
import { h, setAttr, setText } from './dom';
import { tr } from '../../../shared/i18n';

type IdleReason = 'disabled' | 'no-topic';

interface AlertsConfig {
  enabled: boolean;
  topic: string;
  server: string;
  active: boolean;
  reason?: IdleReason;
}

const CONFIG_URL = '/api/alerts/config';
const TEST_URL = '/api/alerts/test';
const DEFAULT_SERVER = 'https://ntfy.sh';
const TOPIC_PLACEHOLDER = 'agentforge-7f3a-9c2e';
/** Debounce for text inputs before POSTing the config (ms). */
const SAVE_DELAY_MS = 500;

export class AlertsSettingsGroup {
  readonly el: HTMLElement;
  private toggle: HTMLButtonElement;
  private topic: HTMLInputElement;
  private server: HTMLInputElement;
  private testBtn: HTMLButtonElement;
  private testStatus: HTMLElement;
  private status: HTMLElement;
  private enabled = false;
  private loaded = false;
  private testing = false;
  private active = false;
  private reason: IdleReason | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Transient notice (save error) shown instead of the base status. */
  private notice: string | null = null;

  constructor(private ctx: UiContext) {
    const toggleId = 'ui-alerts-enable';
    this.toggle = h('button', { class: 'ui-switch', type: 'button', role: 'switch', attrs: { 'aria-checked': 'false', 'aria-labelledby': toggleId } }, h('span', { class: 'ui-switch__knob' }));
    this.toggle.addEventListener('click', () => {
      this.enabled = !this.enabled;
      setAttr(this.toggle, 'aria-checked', String(this.enabled));
      void this.save({ enabled: this.enabled });
    });

    this.topic = h('input', {
      class: 'ui-alerts__input',
      type: 'text',
      attrs: { id: 'ui-alerts-topic', placeholder: TOPIC_PLACEHOLDER, autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('Tópico do ntfy') },
    });
    this.topic.addEventListener('input', () => this.scheduleSave());

    this.server = h('input', {
      class: 'ui-alerts__input',
      type: 'url',
      attrs: { id: 'ui-alerts-server', placeholder: DEFAULT_SERVER, autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('Servidor ntfy') },
    });
    this.server.addEventListener('input', () => this.scheduleSave());

    this.testBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Enviar teste') });
    this.testBtn.addEventListener('click', () => void this.sendTest());
    this.testStatus = h('span', { class: 'ui-set__hint' });

    this.status = h('span', { class: 'ui-set__hint' });

    this.el = h(
      'div',
      { class: 'ui-set-group ui-alerts' },
      h('h3', { text: tr('Alertas no celular') }),
      h('div', { class: 'ui-set' }, h('div', { class: 'ui-set__text' }, this.status)),
      h(
        'div',
        { class: 'ui-set' },
        h(
          'div',
          { class: 'ui-set__text' },
          h('span', { class: 'ui-set__label', text: tr('Avisar quando um agente precisar de você'), attrs: { id: toggleId } }),
          h('span', { class: 'ui-set__hint', text: tr('O servidor manda uma notificação push via ntfy quando um agente levanta a mão.') }),
        ),
        this.toggle,
      ),
      h(
        'div',
        { class: 'ui-set ui-set--stack' },
        h('label', { class: 'ui-set__label', text: tr('Tópico do ntfy'), attrs: { for: 'ui-alerts-topic' } }),
        this.topic,
        h(
          'span',
          { class: 'ui-set__hint' },
          tr('Instale o app ntfy (ntfy.sh) e inscreva-se neste tópico. O tópico é público para quem adivinhar: use um nome difícil e saiba que os alertas mostram nomes de agentes e projetos.'),
          ' ',
          h('a', { text: 'ntfy.sh', attrs: { href: 'https://ntfy.sh', target: '_blank', rel: 'noopener' } }),
        ),
      ),
      h(
        'div',
        { class: 'ui-set ui-set--stack' },
        h('label', { class: 'ui-set__label', text: tr('Servidor ntfy'), attrs: { for: 'ui-alerts-server' } }),
        this.server,
        h('span', { class: 'ui-set__hint', text: tr('Deixe vazio para usar o servidor público.') }),
      ),
      h('div', { class: 'ui-set' }, this.testBtn, this.testStatus),
    );

    void this.load();
  }

  /** Base status text from the last loaded config (before any transient notice). */
  private baseStatus(): string {
    if (!this.loaded) return '';
    if (this.active) return tr('Ativo: alertas ligados.');
    if (this.reason === 'no-topic') return tr('Sem tópico: configure um tópico para ativar.');
    return tr('Desligado.');
  }

  private showStatus(): void {
    setText(this.status, this.notice ?? this.baseStatus());
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cfg = (await res.json()) as AlertsConfig;
      this.enabled = !!cfg.enabled;
      this.active = !!cfg.active;
      this.reason = cfg.reason;
      if (document.activeElement !== this.topic) this.topic.value = cfg.topic ?? '';
      if (document.activeElement !== this.server) this.server.value = cfg.server ?? '';
      this.loaded = true;
      this.notice = null;
    } catch {
      this.notice = tr('Sem conexão com o servidor.');
    }
    this.render();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save({ topic: this.topic.value.trim(), server: this.server.value.trim() });
    }, SAVE_DELAY_MS);
  }

  private async save(patch: Partial<Pick<AlertsConfig, 'enabled' | 'topic' | 'server'>>): Promise<void> {
    try {
      const res = await fetch(CONFIG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = (await res.json()) as { config?: AlertsConfig; error?: string };
      if (!res.ok || !body.config) {
        this.notice = body.error ?? tr('Sem conexão com o servidor.');
      } else {
        this.enabled = !!body.config.enabled;
        this.active = !!body.config.active;
        this.reason = body.config.reason;
        this.notice = null;
      }
    } catch {
      this.notice = tr('Sem conexão com o servidor.');
    }
    this.render();
  }

  private async sendTest(): Promise<void> {
    if (this.testing) return;
    this.testing = true;
    setText(this.testStatus, tr('Enviando…'));
    this.render();
    try {
      const res = await fetch(TEST_URL, { method: 'POST', headers: { accept: 'application/json' } });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (body.ok) {
        setText(this.testStatus, tr('Teste enviado! Confira o celular.'));
      } else {
        setText(this.testStatus, body.error ?? tr('Sem conexão com o servidor.'));
      }
    } catch {
      setText(this.testStatus, tr('Sem conexão com o servidor.'));
    } finally {
      this.testing = false;
      this.render();
    }
  }

  render(): void {
    setAttr(this.toggle, 'aria-checked', String(this.enabled));
    // Inputs are only overwritten on load/save; never here, so typing is never clobbered.
    this.toggle.disabled = !this.loaded;
    this.topic.disabled = !this.loaded;
    this.server.disabled = !this.loaded;
    this.testBtn.disabled = this.testing || !this.loaded;
    setText(this.testBtn, this.testing ? tr('Enviando…') : tr('Enviar teste'));
    this.showStatus();
  }
}

export function createAlertsSettingsGroup(ctx: UiContext): AlertsSettingsGroup {
  return new AlertsSettingsGroup(ctx);
}
