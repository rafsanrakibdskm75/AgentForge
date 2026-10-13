// Gemini CLI accounts: one GEMINI_HOME folder per account (~/.muse, ~/.muse-work...). Pure Node, no
// server dependencies: also imported by scripts/docker-up.ts (via tsx) on the host.
//
// Discovery: AGENTFORGE_GEMINI_DIRS (comma-separated list) overrides everything; otherwise GEMINI_HOME and
// `$HOME/.gemini*` folders that look like a Gemini home (isGeminiHome). Short: the shell alias
// `alias x='GEMINI_HOME=... gemini'` (no GEMINI_HOME = the default folder); without an alias, a derived letter
// that does not collide with other accounts. Color: from the account palette, skipping taken ones. Name:
// "Gemini" (or "Gemini X" with more than one account). No plan or e-mail: Gemini exposes neither without
// credentials.
//
// PRIVACY: never opens `oauth_creds.json` or other secret files (only existence checks, inside
// looksLikeGeminiDir); from shell files, only `alias X='... gemini ...'` lines. In Docker the host sends
// everything ready-made in AGENTFORGE_ACCOUNTS (`provider: 'gemini'`, with the host's `configDir`: that is
// where the agent runs).
import { readdirSync, statSync } from 'node:fs';
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
import { looksLikeGeminiDir } from './files';

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

/** Default Gemini folder: GEMINI_HOME or $HOME/.muse. */
export function defaultGeminiHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.GEMINI_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.muse');
}

/**
 * True when the dir looks like a Gemini CLI home (looksLikeGeminiDir: tmp/<hash>/chats/ or projects.json)
 * and is NOT a Claude home (no `projects/` subdir). Only existence checks: secret files are never opened.
 */
export function isGeminiHome(p: string): boolean {
  if (!looksLikeGeminiDir(p)) return false;
  return !isDir(join(p, 'projects'));
}

/**
 * Gemini folders under observation. AGENTFORGE_GEMINI_DIRS (comma-separated list) overrides discovery and is taken
 * as-is (only needs to exist: a freshly created account may have no sessions yet). Otherwise: the default folder
 * (GEMINI_HOME or $HOME/.muse) and `$HOME/.gemini*` folders that pass isGeminiHome. Stable order: the default
 * first, then alphabetical.
 */
export function discoverGeminiDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.AGENTFORGE_GEMINI_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  const main = defaultGeminiHome(env, home);
  if (isGeminiHome(main)) found.push(main);
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.gemini')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isGeminiHome(p)) found.push(p);
    }
  } catch {
    // $HOME unreadable (e.g. container without home)
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides of the Gemini accounts in AGENTFORGE_ACCOUNTS (sent by the host, in Docker). */
export function geminiOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'gemini');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Shell aliases that invoke `gemini` with a GEMINI_HOME (empty when detect.ts has no gemini alias patterns yet). */
function geminiAliases(home: string): ClaudeAlias[] {
  try {
    return readShellAliases(home, 'gemini');
  } catch {
    return [];
  }
}

/**
 * Candidate letters for an account without an alias: the suffix initial (".gemini-work" -> W), G, H, J,
 * X, Y, Z, W, V, U and the alphabet.
 */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?gemini[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('G', 'H', 'J', 'X', 'Y', 'Z', 'W', 'V', 'U');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface GeminiDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Shorts and colors already used by other accounts (not repeated). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * One account per Gemini folder, IN THE SAME ORDER as `dirs`. `configDir` is the path for display and for
 * running the agent (in Docker, the host's one, from AGENTFORGE_ACCOUNTS). No e-mail and no plan: Gemini exposes
 * neither without credentials.
 */
export function detectGeminiAccounts(dirs: string[], opts: GeminiDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = geminiOverrides(env.AGENTFORGE_ACCOUNTS);
  const shortcuts = shortcutsByDir(geminiAliases(home), home, defaultGeminiHome(env, home));
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
      provider: 'gemini',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `Gemini ${short}` : 'Gemini'),
      color,
    };
    return acc;
  });
}
