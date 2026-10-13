// OpenCode accounts: one data folder per account (~/.local/share/opencode, $XDG_DATA_HOME/opencode...).
// Pure Node, no server dependencies: also imported by scripts/docker-up.ts (via tsx) on the host.
//
// Discovery: AGENTFORGE_OPENCODE_DIRS (comma-separated list) overrides everything; otherwise
// OPENCODE_DATA_DIR or the default data dir ($XDG_DATA_HOME/opencode, else ~/.local/share/opencode),
// kept when it looks like an OpenCode home (isOpencodeHome). Short: the shell alias
// `alias x='OPENCODE_DATA_DIR=... opencode'` (no OPENCODE_DATA_DIR = the default folder); without an
// alias, a derived letter that does not collide with other accounts. Color: from the account palette,
// skipping taken ones. Name: "OpenCode" (or "OpenCode X" with more than one account). No plan or e-mail:
// OpenCode exposes neither without credentials.
//
// PRIVACY: never opens auth.json or other secret files (only existence checks, inside
// looksLikeOpencodeDir); from shell files, only `alias X='... opencode ...'` lines. In Docker the host sends
// everything ready-made in AGENTFORGE_ACCOUNTS (`provider: 'opencode'`, with the host's `configDir`: that is
// where the agent runs).
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type ClaudeAlias,
  type DetectedAccount,
} from '../../accounts/detect';
import { defaultOpencodeDataDir, looksLikeOpencodeDir } from './files';

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
 * True when the dir looks like an OpenCode data dir (looksLikeOpencodeDir: opencode.db is a file or
 * storage/ exists) and is NOT a Claude home (no `projects/` subdir). Only existence checks: secret
 * files are never opened.
 */
export function isOpencodeHome(p: string): boolean {
  if (!looksLikeOpencodeDir(p)) return false;
  return !isDir(join(p, 'projects'));
}

/**
 * OpenCode data folders under observation. AGENTFORGE_OPENCODE_DIRS (comma-separated list) overrides
 * discovery and is taken as-is (only needs to exist: a freshly created account may have no sessions
 * yet). Otherwise: OPENCODE_DATA_DIR when set, else the default data dir ($XDG_DATA_HOME/opencode, else
 * ~/.local/share/opencode) — kept when it passes isOpencodeHome. Stable order, deduplicated.
 */
export function discoverOpencodeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.AGENTFORGE_OPENCODE_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const raw = env.OPENCODE_DATA_DIR?.trim();
  const main = raw ? expandHome(raw, home) : defaultOpencodeDataDir(env, home);
  return isOpencodeHome(main) ? [main] : [];
}

/** Overrides of the OpenCode accounts in AGENTFORGE_ACCOUNTS (sent by the host, in Docker). */
export function opencodeOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'opencode');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Shell aliases that invoke `opencode` with an OPENCODE_DATA_DIR (empty when detect.ts has no matches). */
function opencodeAliases(home: string): ClaudeAlias[] {
  try {
    return readShellAliases(home, 'opencode');
  } catch {
    return [];
  }
}

/**
 * Candidate letters for an account without an alias: the suffix initial ("opencode-work" -> W), O, C, D,
 * E, P, Q, R, S, T, then the alphabet.
 */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?opencode[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('O', 'C', 'D', 'E', 'P', 'Q', 'R', 'S', 'T');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface OpenCodeDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Shorts and colors already used by other accounts (not repeated). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * One account per OpenCode folder, IN THE SAME ORDER as `dirs`. `configDir` is the path for display and for
 * running the agent (in Docker, the host's one, from AGENTFORGE_ACCOUNTS). No e-mail and no plan: OpenCode
 * exposes neither without credentials.
 */
export function detectOpencodeAccounts(dirs: string[], opts: OpenCodeDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = opencodeOverrides(env.AGENTFORGE_ACCOUNTS);
  const shortcuts = shortcutsByDir(opencodeAliases(home), home, defaultOpencodeDataDir(env, home));
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
      provider: 'opencode',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `OpenCode ${short}` : 'OpenCode'),
      color,
    };
    return acc;
  });
}
