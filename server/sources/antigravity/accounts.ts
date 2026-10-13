// Antigravity accounts: one ~/.muse/antigravity* folder per account (~/.muse/antigravity,
// ~/.muse/antigravity-ide, ~/.muse/antigravity-cli...). Pure Node, no server dependencies: also
// imported by scripts/docker-up.ts (via tsx) on the host.
//
// Discovery: AGENTFORGE_ANTIGRAVITY_DIRS (comma-separated list) overrides everything; otherwise the
// ~/.muse/antigravity* homes found under ~/.muse that pass isAntigravityHome. Short: the shell alias
// `alias x='... antigravity ...'` (no alias = a derived letter that does not collide with other
// accounts). Color: from the account palette, skipping taken ones. Name: "Antigravity" (or
// "Antigravity X" with more than one account). No plan or e-mail: Antigravity exposes neither
// without credentials.
//
// PRIVACY: never opens oauth_creds.json, google_accounts.json, mcp-oauth-tokens.json, or other
// secret files (only existence checks, inside looksLikeAntigravityDir); from shell files, only
// `alias X='... antigravity ...'` lines. In Docker the host sends everything ready-made in
// AGENTFORGE_ACCOUNTS (`provider: 'antigravity'`, with the host's `configDir`: that is where the
// agent runs).
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  isClaudeDir,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type ClaudeAlias,
  type DetectedAccount,
} from '../../accounts/detect';
import { tr } from '../../../shared/i18n';
import type { Provider } from '../../../shared/types';
import { defaultAntigravityDirs, looksLikeAntigravityDir } from './files';

// 'antigravity' is not yet part of the Provider union in shared/types.ts (only the coordinator may
// extend that file); the cast below is a deliberate placeholder and compiles as the union member.
const PROVIDER: Provider = 'antigravity';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * True when the dir looks like an Antigravity home (looksLikeAntigravityDir:
 * conversation_summaries.db is a file) and is NOT a Claude home. A `projects/` (or `sessions/`)
 * subdir marks Claude Code's config layout; ~/.muse also hosts Claude/Gemini homes, so the
 * exclusion keeps accounts from being misattributed. Only existence checks: secret files are never
 * opened.
 */
export function isAntigravityHome(p: string): boolean {
  if (!looksLikeAntigravityDir(p)) return false;
  return !isClaudeDir(p);
}

/**
 * Antigravity folders under observation. AGENTFORGE_ANTIGRAVITY_DIRS (comma-separated list)
 * overrides discovery and is taken as-is (only needs to exist: a freshly created account may have
 * no conversations yet). Otherwise: the three known candidates (~/.muse/antigravity,
 * ~/.muse/antigravity-ide, ~/.muse/antigravity-cli) plus any other `antigravity*` folder under
 * ~/.muse that passes isAntigravityHome. Stable order: the known candidates first, then
 * alphabetical.
 */
export function discoverAntigravityDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.AGENTFORGE_ANTIGRAVITY_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  for (const p of defaultAntigravityDirs(home)) {
    if (isAntigravityHome(p)) found.push(p);
  }
  try {
    const parent = join(home, '.muse');
    for (const ent of readdirSync(parent, { withFileTypes: true })) {
      if (!ent.name.startsWith('antigravity')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(parent, ent.name);
      if (isAntigravityHome(p)) found.push(p);
    }
  } catch {
    // ~/.muse unreadable (e.g. container without home)
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  const known = defaultAntigravityDirs(home).map((p) => resolve(p));
  dirs.sort((a, b) => (known.includes(resolve(a)) ? 0 : 1) - (known.includes(resolve(b)) ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides of the Antigravity accounts in AGENTFORGE_ACCOUNTS (sent by the host, in Docker). */
export function antigravityOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => (o.provider as string) === 'antigravity');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/**
 * Shell aliases that invoke `antigravity` with a custom home dir. server/accounts/detect.ts has no
 * antigravity alias pattern yet (ALIAS_TOOLS only knows claude/codex/gemini/opencode), so
 * readShellAliases degrades to [] for now and starts working automatically when a pattern is added.
 */
function antigravityAliases(home: string): ClaudeAlias[] {
  try {
    return readShellAliases(home, PROVIDER);
  } catch {
    return [];
  }
}

/**
 * Candidate letters for an account without an alias: the suffix initial ("antigravity-work" -> W),
 * A, G, I, N, T, R, V, Y, then the alphabet.
 */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?antigravity[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('A', 'G', 'I', 'N', 'T', 'R', 'V', 'Y');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface AntigravityDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Shorts and colors already used by other accounts (not repeated). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * One account per Antigravity folder, IN THE SAME ORDER as `dirs`. `configDir` is the path for
 * display and for running the agent (in Docker, the host's one, from AGENTFORGE_ACCOUNTS). No
 * e-mail and no plan: Antigravity exposes neither without credentials.
 */
export function detectAntigravityAccounts(dirs: string[], opts: AntigravityDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = antigravityOverrides(env.AGENTFORGE_ACCOUNTS);
  const shortcuts = shortcutsByDir(antigravityAliases(home), home, defaultAntigravityDirs(home)[0] ?? join(home, '.muse', 'antigravity'));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    const acc: DetectedAccount = {
      id: p.id,
      provider: PROVIDER,
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? tr('Antigravity {0}', [short]) : tr('Antigravity')),
      color,
    };
    return acc;
  });
}
