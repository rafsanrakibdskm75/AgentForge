// Team view support: a team is a room where 2+ main agents from 2+ providers work
// together. The server publishes them as `snapshot.teams` (`TeamInfo[]` on
// OfficeSnapshot, shared/types.ts); this module reads them and draws the small,
// subtle team indicator the 3D world shows on/near team rooms.
//
// Visual language: the world already marks accounts on room signs and pills with
// small colored dots, so the team indicator follows the same idiom — the providers'
// dots overlapped, each in its provider color. Subtle, no emoji, no flash.
import type { OfficeSnapshot, Provider, TeamInfo } from '../../../shared/types';

/** Re-exported for world modules that deal with teams. */
export type { TeamInfo, TeamMemberInfo } from '../../../shared/types';

/** The known providers; unknown values in the snapshot are ignored defensively. */
const KNOWN_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'gemini', 'opencode', 'antigravity'];

/**
 * Fixed dot color per provider. Not a brand claim — just five hues that stay
 * readable on the dark room signs and pills (provider names live in
 * client/src/ui/provider.ts).
 */
export const PROVIDER_DOT: Record<Provider, string> = {
  claude: '#d97757',
  codex: '#4ade80',
  gemini: '#60a5fa',
  opencode: '#a78bfa',
  antigravity: '#f472b6',
};

/**
 * roomId -> providers of the team currently in that room, from the snapshot.
 * Entries with fewer than 2 distinct known providers are dropped (not a team);
 * unknown provider values are filtered out defensively.
 */
export function teamProvidersOf(snap: OfficeSnapshot): Map<string, Provider[]> {
  const out = new Map<string, Provider[]>();
  for (const t of snap.teams ?? []) {
    if (!t || typeof t.roomId !== 'string' || !t.roomId || !Array.isArray(t.providers)) continue;
    const ps = [...new Set(t.providers.filter((p): p is Provider => KNOWN_PROVIDERS.includes(p as Provider)))];
    if (ps.length < 2) continue;
    out.set(t.roomId, ps);
  }
  return out;
}

/** Screen width of n overlapping dots (radius r), for pill layout math. */
export function teamDotsWidth(count: number, r: number): number {
  if (count <= 0) return 0;
  return Math.round(2 * r + (count - 1) * (r * 1.25));
}

/**
 * Draws the overlapping provider dots centered at (cx, cy): the subtle team
 * indicator. Each dot keeps a dark ring so adjacent dots stay distinct at
 * pixel-art scale.
 */
export function drawTeamDots(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, providers: readonly Provider[]): void {
  if (!providers.length) return;
  const step = r * 1.25;
  const x0 = cx - ((providers.length - 1) * step) / 2;
  for (let i = 0; i < providers.length; i++) {
    const x = Math.round(x0 + i * step);
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = PROVIDER_DOT[providers[i]];
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(10,13,22,0.8)';
    ctx.stroke();
  }
}

/**
 * Small badge plate that sits right above a room sign: a dark rounded plate with
 * the overlapping provider dots. Returns the badge rect so the overlay can reserve
 * the space (collision) like every other floating item.
 */
export function drawTeamBadge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  bottomY: number,
  providers: readonly Provider[],
): { x: number; y: number; w: number; h: number } {
  const r = 4;
  const pad = 3;
  const w = Math.round(teamDotsWidth(providers.length, r) + pad * 2);
  const h = Math.round(2 * r + pad * 2);
  const x = Math.round(cx - w / 2);
  const y = Math.round(bottomY - h);
  ctx.fillStyle = 'rgba(22,27,40,0.9)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 5);
  ctx.fill();
  drawTeamDots(ctx, cx, y + h / 2 + 0.5, r, providers);
  return { x, y, w, h };
}
