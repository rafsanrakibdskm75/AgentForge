// Low-level reading of a Gemini CLI home (~/.muse): session files under tmp/<projectHash>/chats/
// and the project mapping in projects.json. Read-only.
//
// Layout (researched from Gemini CLI's storage format):
//   ~/.muse/tmp/<projectHash>/chats/session-<uuid>.json   (some installs: .jsonl)
//   ~/.muse/projects.json                                 (shortId -> real project path)
//   ~/.muse/history/<id>/, ~/.muse/tmp/<id>/<sessionId>/{plans,tasks,tracker}/
//
// A session file holds a JSON ConversationRecord (or append-only JSONL of records) with:
//   sessionId, projectHash, startTime, lastUpdated, kind ("main"|"subagent"), directories[],
//   messages[]: { id, timestamp, type ("user"|"gemini"|"info"|"error"),
//                 content: [{text}], toolCalls: [{id,name,args,result,status,agentId}],
//                 thoughts[], tokens: {input,output,cached,thoughts,tool,total}, model }
//
// Live signal: there is no explicit in-progress flag; recency of lastUpdated (or the file mtime)
// is the presence signal. Note tokens.input is PEAK context, not cumulative.
//
// PRIVACY: this module never opens oauth_creds.json, google_accounts.json, mcp-oauth-tokens.json,
// and never reads secret values from settings.json. Only existence of directories/files is checked.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const SESSION_NAME = /^session-([^/\\]+)\.(json|jsonl)$/i;
/** Refuse to read absurdly large session files (a runaway tool result can bloat them). */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export interface GeminiContentPart {
  text?: string;
  [k: string]: unknown;
}

export interface GeminiToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  /** Session id of the spawned subagent, when this call spawned one. */
  agentId?: string;
  [k: string]: unknown;
}

export interface GeminiThought {
  text?: string;
  [k: string]: unknown;
}

export interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
  [k: string]: unknown;
}

export interface GeminiMessage {
  id?: string;
  /** ISO string or epoch (seconds or ms); normalized by toMs(). */
  timestamp?: string | number;
  type?: string;
  content?: GeminiContentPart[];
  toolCalls?: GeminiToolCall[];
  thoughts?: Array<GeminiThought | string>;
  tokens?: GeminiTokens;
  model?: string;
  [k: string]: unknown;
}

export interface GeminiSession {
  sessionId: string;
  projectHash: string;
  startTime: number;
  lastUpdated: number;
  kind: 'main' | 'subagent';
  directories: string[];
  messages: GeminiMessage[];
  model?: string;
}

export interface SessionFileRef {
  path: string;
  sessionId: string;
  projectHash: string;
  mtimeMs: number;
  size: number;
}

/** "session-<uuid>.json" -> "<uuid>"; undefined when the name is not a session file. */
export function sessionIdFromName(name: string): string | undefined {
  const m = SESSION_NAME.exec(name);
  return m ? m[1] : undefined;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Existing tmp/<projectHash>/chats/ directories of a Gemini home. */
export function chatDirs(home: string): string[] {
  const out: string[] = [];
  const tmp = join(home, 'tmp');
  for (const hash of listDir(tmp)) {
    const chats = join(tmp, hash, 'chats');
    if (isDir(chats)) out.push(chats);
  }
  return out;
}

/** Every session file of the home, newest first (one entry per file; a resumed session keeps its file). */
export function listSessionFiles(home: string): SessionFileRef[] {
  const out: SessionFileRef[] = [];
  for (const chats of chatDirs(home)) {
    const projectHash = basename(dirname(chats));
    for (const name of listDir(chats)) {
      const sessionId = sessionIdFromName(name);
      if (!sessionId) continue;
      const path = join(chats, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        out.push({ path, sessionId, projectHash, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // vanished between listing and stat
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** ISO string or epoch (seconds or ms) -> epoch ms; undefined when unparseable. */
export function toMs(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  const n = num(v);
  if (n === undefined) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function asMessages(v: unknown): GeminiMessage[] {
  if (!Array.isArray(v)) return [];
  return v.filter((m): m is GeminiMessage => !!m && typeof m === 'object');
}

function asStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string');
}

/** Merge one parsed record into the accumulator (JSONL append-only shape). */
function mergeRecord(acc: { messages: GeminiMessage[]; directories: string[] } & Partial<GeminiSession>, rec: Record<string, unknown>): void {
  const sid = str(rec.sessionId);
  if (sid && !acc.sessionId) acc.sessionId = sid;
  const ph = str(rec.projectHash);
  if (ph && !acc.projectHash) acc.projectHash = ph;
  const st = toMs(rec.startTime);
  if (st !== undefined && (acc.startTime === undefined || st < acc.startTime)) acc.startTime = st;
  const lu = toMs(rec.lastUpdated);
  if (lu !== undefined && (acc.lastUpdated === undefined || lu > acc.lastUpdated)) acc.lastUpdated = lu;
  if (rec.kind === 'subagent' || rec.kind === 'main') acc.kind = rec.kind;
  for (const d of asStrings(rec.directories)) if (!acc.directories.includes(d)) acc.directories.push(d);
  const model = str(rec.model);
  if (model && !acc.model) acc.model = model;
  for (const m of asMessages(rec.messages)) acc.messages.push(m);
}

/**
 * Read and parse a session file (.json single ConversationRecord, or .jsonl of records).
 * Returns undefined when the file is missing, too big, or unparseable. Never throws.
 */
export function readSessionFile(path: string): GeminiSession | undefined {
  let st: { size: number; isFile(): boolean };
  try {
    st = statSync(path);
    if (!st.isFile() || st.size > MAX_SESSION_BYTES) return undefined;
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  if (!raw.trim()) return undefined;
  const records: Record<string, unknown>[] = [];
  const trimmed = raw.trim();
  // One JSON document for the whole file (single-line or pretty-printed): parse it directly. A JSONL
  // file never parses as a whole (it holds several top-level values), so it falls through to the
  // line-by-line branch below.
  let single: unknown;
  try {
    single = JSON.parse(trimmed);
  } catch {
    single = undefined;
  }
  if (single && typeof single === 'object' && !Array.isArray(single)) {
    records.push(single as Record<string, unknown>);
  } else {
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const one = JSON.parse(t) as unknown;
        if (one && typeof one === 'object' && !Array.isArray(one)) records.push(one as Record<string, unknown>);
      } catch {
        // a torn last line (mid-write): skip it
      }
    }
    if (!records.length) return undefined;
  }
  const acc: { messages: GeminiMessage[]; directories: string[] } & Partial<GeminiSession> = { messages: [], directories: [] };
  for (const r of records) mergeRecord(acc, r);
  const name = basename(path);
  const sessionId = acc.sessionId ?? sessionIdFromName(name);
  if (!sessionId) return undefined;
  // projectHash from the record, else from tmp/<hash>/chats/<file>.
  const projectHash = acc.projectHash ?? basename(dirname(dirname(path)));
  const now = Date.now();
  return {
    sessionId,
    projectHash,
    startTime: acc.startTime ?? now,
    lastUpdated: acc.lastUpdated ?? now,
    kind: acc.kind ?? 'main',
    directories: acc.directories,
    messages: acc.messages,
    model: acc.model,
  };
}

const projectsCache = new Map<string, { mtimeMs: number; map: Record<string, string> }>();

function readProjectsJson(home: string): Record<string, string> {
  const path = join(home, 'projects.json');
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    projectsCache.delete(home);
    return {};
  }
  const hit = projectsCache.get(home);
  if (hit && hit.mtimeMs === mtimeMs) return hit.map;
  let map: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v) map[k] = v;
      }
    }
  } catch {
    map = {};
  }
  projectsCache.set(home, { mtimeMs, map });
  return map;
}

/**
 * Real project path for a tmp/<projectHash> dir, via projects.json (shortId -> path).
 * Falls back to the session's own directories[0] at the call site.
 */
export function projectPathOf(home: string, projectHash: string): string | undefined {
  const map = readProjectsJson(home);
  const direct = map[projectHash];
  if (direct) return direct;
  // Some installs key by a shortened hash; try prefix match (first 8+ chars).
  for (const [k, v] of Object.entries(map)) {
    if (k && (projectHash.startsWith(k) || k.startsWith(projectHash))) return v;
  }
  return undefined;
}

/** True when the path looks like a Gemini CLI home: has tmp/ with chats, or a projects.json. Never reads secrets. */
export function looksLikeGeminiDir(p: string): boolean {
  if (isDir(join(p, 'tmp')) && chatDirs(p).length > 0) return true;
  try {
    return statSync(join(p, 'projects.json')).isFile();
  } catch {
    return false;
  }
}

export function geminiHomeExists(home: string): boolean {
  return existsSync(home);
}
