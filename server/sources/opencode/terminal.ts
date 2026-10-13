// OpenCode terminal: a session's SQLite rows (messages, tool calls, todos) materialized as a
// line-based text transcript, parsed back into TerminalEntry by createOpencodeTerminalParser().
//
// The transcript file is a snapshot, not a live tail: it is rewritten only when the session got
// newer (module-level `materialized` map). OpenCode exposes no reasoning parts through files.ts,
// so the materializer never emits THINKING lines; the parser still understands them.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import {
  marked,
  prepare,
  RESULT_MAX,
  RESULT_MAX_LINES,
  TEXT_MAX,
  THINKING_MAX,
  TITLE_ARG_MAX,
  type TerminalParser,
} from '../terminal';
import {
  listSessions,
  readSessionMessages,
  readSessionParts,
  readSessionTodos,
  type OpencodeMessage,
  type OpencodeTodo,
  type OpencodeToolPart,
} from './files';

/** Session ids look like `ses_…`; anything else is rejected (the filename is derived from the id). */
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/i;
/** Tool input shown on a TOOL line: the first 120 chars of the JSON/string input. */
const INPUT_SHORT_MAX = 120;
/** Tool output shown on a RESULT line (the parser re-truncates to RESULT_MAX on the way in). */
const OUTPUT_SHORT_MAX = 2_000;
/** Todo content shown on a TODO line. */
const TODO_MAX = 400;
/** Transcript snapshots live in <dataDir>/opencode-transcripts/<sessionId>.txt. */
const DIR_NAME = 'opencode-transcripts';

/** Last materialized updatedAt per `home\nsessionId`: unchanged sessions are never rewritten. */
const materialized = new Map<string, number>();

/** The transcript is line-based: real newlines become literal `\n` escapes. */
function oneLine(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n');
}

/** Masked and truncated text for a transcript line. */
function textOf(raw: string, max: number): string {
  return truncate(maskSecrets(oneLine(raw)), max);
}

/** First 120 chars of the tool input (JSON for objects, raw for strings). */
function shortInput(input: unknown): string {
  if (input === undefined) return '';
  let s: string;
  if (typeof input === 'string') {
    s = input;
  } else {
    try {
      s = JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }
  return truncate(maskSecrets(oneLine(s)), INPUT_SHORT_MAX);
}

interface Rec {
  time: number;
  seq: number;
  line: string;
}

function buildLines(messages: OpencodeMessage[], parts: OpencodeToolPart[], todos: OpencodeTodo[]): string[] {
  const recs: Rec[] = [];
  let seq = 0;
  const add = (time: number, line: string) => {
    recs.push({ time, seq: seq++, line });
  };
  const stamp = (time: number) => new Date(time).toISOString();
  for (const m of messages) {
    const text = textOf(m.text, TEXT_MAX);
    if (!text) continue;
    add(m.time, `[${stamp(m.time)}] ${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}`);
  }
  for (const p of parts) {
    const status = p.status ?? 'pending';
    add(p.time, `[${stamp(p.time)}] TOOL ${p.tool} (${status}): ${shortInput(p.input)}`);
    const output = p.output !== undefined ? textOf(p.output, OUTPUT_SHORT_MAX) : '';
    add(p.time, `[${stamp(p.time)}] RESULT ${p.tool}: ${output}`);
  }
  // Todos carry no time: they go last, stamped with the session's latest activity.
  const latest = recs.reduce((mx, r) => Math.max(mx, r.time), 0);
  for (const t of todos) {
    const content = textOf(t.content, TODO_MAX);
    if (!content) continue;
    add(latest, `[${stamp(latest)}] TODO [${t.status}] ${content}`);
  }
  recs.sort((a, b) => a.time - b.time || a.seq - b.seq);
  return recs.map((r) => r.line);
}

/**
 * Materialize the session transcript to <dataDir>/opencode-transcripts/<sessionId>.txt.
 * Rewrites only when the session got newer; returns the path, or undefined on any failure
 * (bad id, unknown session, unreadable database, unwritable directory).
 */
export function materializeTranscript(home: string, dataDir: string, sessionId: string): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  try {
    const session = listSessions(home).find((s) => s.id === sessionId);
    if (!session) return undefined;
    const key = `${home}\n${sessionId}`;
    const path = join(dataDir, DIR_NAME, `${sessionId}.txt`);
    if ((materialized.get(key) ?? -1) >= session.updatedAt && existsSync(path)) return path;
    const lines = buildLines(
      readSessionMessages(home, sessionId),
      readSessionParts(home, sessionId),
      readSessionTodos(home, sessionId),
    );
    mkdirSync(join(dataDir, DIR_NAME), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    materialized.set(key, session.updatedAt);
    return path;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ parser

type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;

const LINE = /^\[([^\]]+)\]\s+(.+)$/s;
const KIND = /^(USER|ASSISTANT|THINKING): ?(.*)$/s;
const TOOL = /^TOOL\s+(.+?)\s*\(([^()]*)\)(?::\s?(.*))?$/s;
const RESULT = /^RESULT\s+(.+?)(?::\s?(.*))?$/s;
const TODO = /^TODO\s*\[([^\]]*)\]\s?(.*)$/s;
const FAILED = /error|fail|reject|denied|cancel/i;
/** Todo status markers, same style as the Claude Code terminal. */
const STATUS_MARK: Record<string, string> = { completed: '☒', in_progress: '◐', pending: '☐' };

/** The transcript's literal `\n` escapes back into real newlines. */
function unescape(s: string): string {
  return s.split('\\n').join('\n');
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

class OpencodeTerminalParser implements TerminalParser {
  private seq = 0;
  private out: TerminalEntry[] = [];
  /** Last TOOL line not yet consumed by its RESULT (pairs the result with its tool). */
  private lastTool?: { id: string; name: string; error: boolean };

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.feed(line);
    } catch {
      // Line too weird: keep whatever it already produced; reading continues.
    }
    return this.out;
  }

  private feed(raw: string): void {
    if (!raw.trim()) return;
    const m = LINE.exec(raw);
    if (!m) return;
    const parsed = Date.parse(m[1]);
    const at = Number.isNaN(parsed) ? Date.now() : parsed;
    const id = `oc:${++this.seq}`;
    const body = m[2];
    const k = KIND.exec(body);
    if (k) return this.kind(id, at, k[1], k[2]);
    const t = TOOL.exec(body);
    if (t) return this.tool(id, at, t[1], t[2], t[3] ?? '');
    const r = RESULT.exec(body);
    if (r) return this.result(id, at, r[1], r[2] ?? '');
    const d = TODO.exec(body);
    if (d) return this.todo(id, at, d[1], d[2]);
    // Unrecognized line: [].
  }

  private kind(id: string, at: number, which: string, payload: string): void {
    if (which === 'THINKING') {
      const e: TerminalEntry = { kind: 'thinking', id: `${id}:t`, at };
      const t = marked(prepare(unescape(payload), THINKING_MAX));
      if (t) e.text = t;
      this.out.push(e);
      return;
    }
    const t = marked(prepare(unescape(payload), TEXT_MAX));
    if (!t) return;
    this.out.push(
      which === 'USER'
        ? { kind: 'user', id: `${id}:u`, at, text: t }
        : { kind: 'assistant', id: `${id}:a`, at, text: t },
    );
  }

  private tool(id: string, at: number, name: string, status: string, input: string): void {
    const toolId = `${id}:c`;
    const short = unescape(input).trim();
    const arg = short ? truncate(short, TITLE_ARG_MAX) : '';
    const e: ToolEntry = { kind: 'tool', id: toolId, at, tool: name, title: maskSecrets(arg ? `${name}(${arg})` : name) };
    if (short) {
      e.input = short;
      e.inputKind = isJson(short) ? 'json' : 'text';
    }
    this.out.push(e);
    this.lastTool = { id: toolId, name, error: FAILED.test(status) };
  }

  private result(id: string, at: number, name: string, output: string): void {
    // A result always follows its tool in the materialized file; pair them. A stray RESULT
    // line (hand-written or truncated file) gets a synthetic tool id instead of a wrong one.
    const tool = this.lastTool?.name === name ? this.lastTool : undefined;
    const toolId = tool?.id ?? `${id}:r:t`;
    const p = prepare(unescape(output), RESULT_MAX, RESULT_MAX_LINES);
    const e: ResultEntry = {
      kind: 'result',
      id: `${toolId}:r`,
      at,
      toolUseId: toolId,
      text: marked(p) || tr('(sem saída)'),
    };
    if (tool?.error) e.error = true;
    if (p.truncated) e.truncated = true;
    this.out.push(e);
    this.lastTool = undefined;
  }

  private todo(id: string, at: number, status: string, content: string): void {
    // TODO lines are session events (no user/assistant/thinking/tool shape fits), so they
    // surface as system entries, like other session events in the Claude Code terminal.
    const t = marked(prepare(unescape(content), TODO_MAX));
    if (!t) return;
    this.out.push({
      kind: 'system',
      id: `${id}:s`,
      at,
      text: `${STATUS_MARK[status] ?? '☐'} ${t}`,
      level: 'info',
    });
  }
}

/** Parser with state: one instance per file read, fed in file order. */
export function createOpencodeTerminalParser(): TerminalParser {
  return new OpencodeTerminalParser();
}
