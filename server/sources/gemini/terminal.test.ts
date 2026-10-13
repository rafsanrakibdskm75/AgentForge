// Gemini CLI terminal parser: pretty-printed records split across pushes, JSONL lines,
// message types, tool name mapping and dedupe.
import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { createGeminiTerminalParser } from './terminal';

const NOW = 1_790_000_000_000;

function record(messages: unknown[]): string {
  return JSON.stringify({
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    projectHash: 'hash1',
    startTime: NOW - 10_000,
    lastUpdated: NOW,
    kind: 'main',
    directories: ['/projetos/loja'],
    messages,
  });
}

function kinds(entries: TerminalEntry[]): string[] {
  return entries.map((e) => e.kind);
}

describe('terminal do Gemini', () => {
  it('lê um registro pretty-printed em 3 pedaços: user/assistant/thinking/tool/result', () => {
    const parser = createGeminiTerminalParser();
    const pretty = JSON.stringify(
      JSON.parse(
        record([
          { id: 'u1', timestamp: NOW - 9_000, type: 'user', content: [{ text: 'rode os testes' }] },
          {
            id: 'g1',
            timestamp: NOW - 8_000,
            type: 'gemini',
            content: [{ text: 'rodando' }],
            thoughts: ['melhor rodar com coverage'],
            toolCalls: [{ id: 'c1', name: 'run_shell', args: { command: 'npm test' }, result: 'ok', status: 'success' }],
          },
        ]),
      ),
      null,
      2,
    );
    const lines = pretty.split('\n');
    const third = Math.ceil(lines.length / 3);
    let entries: TerminalEntry[] = [];
    for (const chunk of [lines.slice(0, third), lines.slice(third, 2 * third), lines.slice(2 * third)]) {
      for (const line of chunk) entries = [...entries, ...parser.push(line)];
    }
    expect(kinds(entries)).toEqual(['user', 'assistant', 'thinking', 'tool', 'result']);
    expect(entries[0]).toMatchObject({ kind: 'user', id: 'u1:u', text: 'rode os testes' });
    expect(entries[2]).toMatchObject({ kind: 'thinking', id: 'g1:t0', text: 'melhor rodar com coverage' });
    expect(entries[3]).toMatchObject({ kind: 'tool', id: 'c1', tool: 'Bash', title: 'Bash(npm test)' });
    expect(entries[4]).toMatchObject({ kind: 'result', toolUseId: 'c1', text: 'ok' });
    // Incomplete fragments emitted nothing until the record completed.
    const again = createGeminiTerminalParser();
    expect(again.push(lines[0])).toEqual([]);
    expect(again.push(lines[1])).toEqual([]);
  });

  it('lê linhas JSONL e mensagens info/error como system; re-feeding não duplica', () => {
    const parser = createGeminiTerminalParser();
    const line = record([
      { id: 'u2', timestamp: NOW - 7_000, type: 'user', content: [{ text: 'oi' }] },
      { id: 'i1', timestamp: NOW - 6_000, type: 'info', content: [{ text: 'compactado' }] },
      { id: 'e1', timestamp: NOW - 5_000, type: 'error', content: [{ text: 'falhou feio' }] },
    ]);
    const entries = parser.push(line);
    expect(kinds(entries)).toEqual(['user', 'system', 'system']);
    expect(entries[1]).toMatchObject({ kind: 'system', level: 'info', text: 'compactado' });
    expect(entries[2]).toMatchObject({ kind: 'system', level: 'error', text: 'falhou feio' });
    expect(parser.push(line)).toEqual([]);
  });

  it('mapeia nomes de ferramentas e marca erro quando o status falha', () => {
    const parser = createGeminiTerminalParser();
    const entries = parser.push(
      record([
        {
          id: 'g2',
          timestamp: NOW - 4_000,
          type: 'gemini',
          content: [{ text: '' }],
          toolCalls: [
            { id: 'c2', name: 'edit', args: { file_path: '/a.ts', old_string: 'x', new_string: 'y' }, result: 'aplicado', status: 'failed' },
            { id: 'c3', name: 'web_search', args: { query: 'vitest' }, result: 'achados', status: 'success' },
          ],
        },
      ]),
    );
    const tools = entries.filter((e) => e.kind === 'tool');
    const results = entries.filter((e) => e.kind === 'result');
    expect(tools.map((t) => (t.kind === 'tool' ? t.tool : ''))).toEqual(['Edit', 'WebFetch']);
    expect(results[0]).toMatchObject({ kind: 'result', toolUseId: 'c2', error: true, text: 'aplicado' });
    expect(results[1]).toMatchObject({ kind: 'result', toolUseId: 'c3', text: 'achados' });
    expect(results[1]).not.toHaveProperty('error');
  });

  it('ignora linhas inválidas e mensagens sem texto', () => {
    const parser = createGeminiTerminalParser();
    expect(parser.push('not json at all')).toEqual([]);
    expect(parser.push('')).toEqual([]);
    expect(parser.push(record([{ id: 'g3', timestamp: NOW, type: 'gemini', content: [{ text: '   ' }] }]))).toEqual([]);
  });
});
