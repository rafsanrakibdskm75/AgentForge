// Team view: a room with 2+ main agents from 2+ different providers, shown as a "shared activity"
// panel (who is doing what right now). The pure helpers (teamForRoom, teamProviderNames) are tested
// in ui/team.test.ts; the panel itself needs a DOM.
import type { TeamInfo, TeamMemberInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setText, setTitle } from './dom';
import { activityFallback, statusLabel } from './model';
import { PROVIDER_NAME } from './provider';
import { createStatusDot, updateStatusDot } from './widgets';
import { tr } from '../../../shared/i18n';

/** The team of a room (null when the room has no team). */
export function teamForRoom(teams: readonly TeamInfo[] | undefined, roomId: string): TeamInfo | undefined {
  return teams?.find((t) => t.roomId === roomId);
}

/** Deduped provider display names, in snapshot order (ex.: ["Claude Code", "Codex"]). */
export function teamProviderNames(team: TeamInfo): string[] {
  return [...new Set(team.providers)].map((p) => PROVIDER_NAME[p]);
}

interface MemberRefs {
  row: HTMLButtonElement;
  dot: HTMLElement;
  name: HTMLElement;
  provider: HTMLElement;
  icon: HTMLElement;
  activity: HTMLElement;
}

const memberRefs = new WeakMap<HTMLElement, MemberRefs>();

function createTeamMemberRow(m: TeamMemberInfo, onPick: (id: string) => void): HTMLLIElement {
  const dot = createStatusDot();
  const name = h('span', { class: 'ui-tm__name' });
  const provider = h('span', { class: 'ui-tm__provider' });
  const icon = h('span', { class: 'ui-tm__icon', attrs: { 'aria-hidden': 'true' } });
  const activity = h('span', { class: 'ui-tm__text' });
  const row = h(
    'button',
    { class: 'ui-tm__row', type: 'button', on: { click: () => onPick(m.id) } },
    dot,
    h(
      'span',
      { class: 'ui-tm__main' },
      h('span', { class: 'ui-tm__top' }, name, provider),
      h('span', { class: 'ui-tm__act' }, icon, activity),
    ),
  );
  const li = h('li', { class: 'ui-tm__item' }, row);
  memberRefs.set(li, { row, dot, name, provider, icon, activity });
  return li;
}

function updateTeamMemberRow(li: HTMLLIElement, m: TeamMemberInfo, clickable: boolean): void {
  const r = memberRefs.get(li)!;
  updateStatusDot(r.dot, m.status);
  setText(r.name, m.name);
  const providerName = PROVIDER_NAME[m.provider];
  setText(r.provider, providerName);
  setText(r.icon, m.activityIcon ?? '·');
  const activity = m.activityText ?? activityFallback({ status: m.status });
  setText(r.activity, activity);
  setTitle(r.activity, activity);
  // A member may have left since the snapshot was built: dim and don't navigate.
  li.classList.toggle('is-offline', !clickable);
  setAttr(r.row, 'aria-disabled', clickable ? null : 'true');
  r.row.classList.toggle('is-disabled', !clickable);
  // "{name} (Codex) — waiting: approve a permission…" (the label comes in the current UI language).
  setAttr(r.row, 'aria-label', tr('{0} ({1}) — {2}: {3}', [m.name, providerName, statusLabel(m.status), activity]));
}

export class TeamPanel {
  readonly el: HTMLElement;
  private extra: HTMLElement;
  private subtitle: HTMLElement;
  private members: KeyedList<TeamMemberInfo>;

  constructor(private ctx: UiContext) {
    this.extra = h('span', { class: 'ui-sec__extra' });
    this.subtitle = h('p', { class: 'ui-tm__sub' });
    const list = h('ul', { class: 'ui-tm' });
    this.members = new KeyedList<TeamMemberInfo, HTMLLIElement>(list, {
      key: (m) => m.id,
      create: (m) => createTeamMemberRow(m, (id) => this.pick(id)),
      update: (li, m) => updateTeamMemberRow(li, m, this.ctx.agent(m.id) !== undefined),
    });
    this.el = h(
      'section',
      { class: 'ui-sec ui-sec--team', hidden: true },
      h('div', { class: 'ui-sec__head' }, h('h3', { class: 'ui-sec__title', text: tr('Equipe') }), this.extra),
      this.subtitle,
      list,
    );
  }

  /** Show the room's team; null/undefined hides the panel (rooms without a team). */
  render(team: TeamInfo | null | undefined): void {
    setHidden(this.el, !team);
    if (!team) return;
    setText(this.extra, team.members.length ? String(team.members.length) : '');
    const names = teamProviderNames(team);
    setHidden(this.subtitle, names.length === 0);
    if (names.length) setText(this.subtitle, tr('{0} trabalhando juntos', [names.join(' + ')]));
    this.members.sync(team.members);
  }

  /** Open the member's agent drawer (only when the agent is still in the office). */
  private pick(id: string): void {
    if (this.ctx.agent(id)) this.ctx.select({ type: 'agent', id }, { focus: true });
  }
}
