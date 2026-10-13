// Gemini CLI terminal: converts a session file into TerminalEntry (prompts, answers, thinking, tool
// calls with their results), with secrets masked and texts truncated by the same rules as the Claude Code
// terminal (sources/terminal.ts).
//
// A session file holds ONE JSON ConversationRecord (possibly pretty-printed, split across push() calls)
// or JSONL of records. Each record carries `messages[]`: { id, timestamp, type ("user"|"gemini"|"info"|
// "error"), content: [{text}], toolCalls: [{id,name,args,result,status}], thoughts[] }. A line that fails
// to parse is buffered and retried together with the next line (a pretty-printed record spread over many
// pushes); the buffer is capped at BUFFER_MAX, then dropped. Each message is turned into entries once
// (dedupe by message id, capped).
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { marked, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import type { GeminiMessage, GeminiToolCall } from './files';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;

/** Unparseable lines are kept while a pretty-printed record completes; past this the buffer is dropped. */
const BUFFER_MAX = 2 * 1024 * 1024;
/** Message ids already turned into entries (a re-fed line emits nothing). */
const MSG_SEEN_MAX = 20_000;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Gemini's raw tool name -> the display name toolView() knows how to render ("Bash(npm test)"). */
function toolName(raw: string): string {
  const n = raw.toLowerCase().replace(/^functions?\./, '');
  if (n === 'read' || n === 'read_file') return 'Read';
  if (n === 'edit' || n === 'edit_file' || n === 'write' || n === 'write_file') return 'Edit';
  if (n === 'shell' || n === 'bash' || n === 'exec' || n === 'run_shell' || n === 'run_shell_command') return 'Bash';
  if (n === 'grep' || n === 'glob' || n === 'search' || n === 'search_files') return 'Search';
  if (n === 'webfetch' || n === 'web_fetch' || n === 'websearch' || n === 'web_search' || n === 'google_web_search') return 'WebFetch';
  if (n === 'todowrite' || n === 'todo_write') return 'TodoWrite';
  // Prettified raw name as a last resort ("my_tool" -> "My Tool").
  return raw
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Tool args as an object: the record, JSON when it arrives as a string, {} when unusable. */
function argsOf(v: unknown): Rec {
  const r = rec(v);
  if (r) return r;
  if (typeof v === 'string' && v.trim()) {
    const j = rec(tryParse(v));
    if (j) return j;
    return { input: v };
  }
  return {};
}

/** Text of a message: the text parts joined; image-ish parts become "[imagem]" markers. */
function messageText(content: unknown): { text: string; images: number } {
  const parts: string[] = [];
  let images = 0;
  for (const raw of Array.isArray(content) ? content : []) {
    const p = rec(raw);
    if (!p) continue;
    const t = str(p.text);
    if (t !== undefined) parts.push(t);
    else images++;
  }
  const pics = images ? Array.from({ length: Math.min(images, 10) }, () => tr('[imagem]')).join(' ') : '';
  return { text: [parts.join('\n'), pics].filter(Boolean).join('\n'), images };
}

/** Text of a tool result: string as-is, content parts joined, or the object stringified. */
function resultText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  const o = rec(raw);
  if (o) {
    if (Array.isArray(o.content)) return messageText(o.content).text;
    if (typeof o.output === 'string') return o.output;
    try {
      return JSON.stringify(o);
    } catch {
      return '';
    }
  }
  if (Array.isArray(raw)) return messageText(raw).text;
  return '';
}

class GeminiTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  /** Pretty-printed record still arriving (unparseable lines so far). */
  private pending = '';
  /** Message ids already turned into entries. */
  private readonly seenMsg = new Set<string>();
  private lastAt?: number;

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
    if (this.pending) {
      this.pending += `\n${raw}`;
      if (this.pending.length > BUFFER_MAX) {
        this.pending = '';
        return;
      }
      const parsed = tryParse(this.pending);
      if (parsed === undefined) return; // still incomplete: wait for more lines
      this.pending = '';
      this.record(parsed);
      return;
    }
    const parsed = tryParse(raw);
    if (parsed === undefined) {
      if (raw.length <= BUFFER_MAX) this.pending = raw; // maybe a pretty-printed record
      return;
    }
    this.record(parsed);
  }

  private record(parsed: unknown): void {
    const j = rec(parsed);
    if (!j) return;
    const at = toMs(j.lastUpdated) ?? toMs(j.startTime);
    if (at !== undefined) this.lastAt = at;
    const raw: unknown[] = Array.isArray(j.messages) ? j.messages : str(j.type) ? [j] : [];
    for (const m of raw) {
      const msg = rec(m);
      if (msg) this.message(msg as GeminiMessage);
    }
  }

  private message(m: GeminiMessage): void {
    const type = str(m.type);
    const { text } = messageText(m.content);
    // Messages without an id (should not happen) still get a stable key from their content.
    const mid = str(m.id) ?? `${type ?? ''}:${toMs(m.timestamp) ?? ''}:${text.slice(0, 80)}`;
    if (this.seenMsg.has(mid)) return;
    this.seenMsg.add(mid);
    if (this.seenMsg.size > MSG_SEEN_MAX) this.seenMsg.delete(this.seenMsg.values().next().value as string);
    const at = toMs(m.timestamp) ?? this.lastAt ?? Date.now();
    if (toMs(m.timestamp) !== undefined) this.lastAt = at;
    switch (type) {
      case 'user':
        return this.user(mid, at, text);
      case 'gemini':
        return this.agent(mid, at, m, text);
      case 'info':
      case 'error':
        return this.info(mid, at, type, text);
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ entries

  private emit(e: TerminalEntry): void {
    this.out.push(e);
  }

  private user(id: string, at: number, text: string): void {
    const t = marked(prepare(text, TEXT_MAX));
    if (t) this.emit({ kind: 'user', id: `${id}:u`, at, text: t });
  }

  private agent(id: string, at: number, m: GeminiMessage, text: string): void {
    const t = marked(prepare(text, TEXT_MAX));
    if (t) this.emit({ kind: 'assistant', id: `${id}:a`, at, text: t });
    const thoughts = Array.isArray(m.thoughts) ? m.thoughts : [];
    thoughts.forEach((raw, i) => {
      const rawText = typeof raw === 'string' ? raw : str(rec(raw)?.text);
      const e: TerminalEntry = { kind: 'thinking', id: `${id}:t${i}`, at };
      if (rawText?.trim()) {
        const t2 = marked(prepare(rawText, THINKING_MAX));
        if (t2) e.text = t2;
      }
      this.emit(e);
    });
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    calls.forEach((raw, i) => {
      const call = rec(raw);
      if (call) this.toolCall(id, at, i, call as GeminiToolCall);
    });
  }

  private toolCall(mid: string, at: number, i: number, call: GeminiToolCall): void {
    const name = toolName(str(call.name) ?? tr('ferramenta'));
    const tid = str(call.id) ?? `${mid}:c${i}`;
    const view = toolView(name, argsOf(call.args));
    const e: ToolEntry = { kind: 'tool', id: tid, at, tool: name, title: maskSecrets(view.title) };
    if (view.input) {
      e.input = view.input;
      e.inputKind = view.inputKind;
    }
    this.emit(e);
    const failed = typeof call.status === 'string' && /fail|error|denied|reject|cancel/i.test(call.status);
    const p = prepare(resultText(call.result), RESULT_MAX, RESULT_MAX_LINES);
    const r: ResultEntry = { kind: 'result', id: `${tid}:r`, at, toolUseId: tid, text: p.text || tr('(sem saída)') };
    if (failed) r.error = true;
    if (p.truncated) r.truncated = true;
    this.emit(r);
  }

  private info(id: string, at: number, type: string, text: string): void {
    const t = marked(prepare(text, TEXT_MAX));
    if (!t) return;
    const e: SystemEntry = { kind: 'system', id: `${id}:s`, at, text: t, level: type === 'error' ? 'error' : 'info' };
    this.emit(e);
  }
}

/** Parser with state: one instance per file read, fed in file order. */
export function createGeminiTerminalParser(): TerminalParser {
  return new GeminiTerminalParser();
}
