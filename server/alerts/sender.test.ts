// Minimal ntfy client: request shape, error on non-2xx, error on timeout/abort.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendNtfy } from './sender';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('sendNtfy', () => {
  it('POSTs to ${server}/${topic} with Title/Priority/Tags headers and the body text', async () => {
    const calls: { url: unknown; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await sendNtfy({ server: 'https://ntfy.sh', topic: 'meu-topico', title: 'T', body: 'B' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ntfy.sh/meu-topico');
    expect(calls[0].init.method).toBe('POST');
    const h = new Headers(calls[0].init.headers as HeadersInit);
    expect(h.get('Title')).toBe('T');
    expect(h.get('Priority')).toBe('high');
    expect(h.get('Tags')).toBe('raised_hand');
    expect(calls[0].init.body).toBe('B');
  });

  it('uses custom tags and strips trailing slashes from the server', async () => {
    let url = '';
    globalThis.fetch = (async (u: unknown, _init: RequestInit) => {
      url = String(u);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await sendNtfy({ server: 'https://ntfy.sh///', topic: 't', title: 'T', body: 'B', tags: 'alerta' });
    expect(url).toBe('https://ntfy.sh/t');
  });

  it('throws on non-2xx', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(sendNtfy({ server: 'https://ntfy.sh', topic: 't', title: 'T', body: 'B' })).rejects.toThrow('503');
  });

  it('throws when the network fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('rede caiu');
    }) as typeof fetch;
    await expect(sendNtfy({ server: 'https://ntfy.sh', topic: 't', title: 'T', body: 'B' })).rejects.toThrow('rede caiu');
  });

  it('throws after the 10s timeout when fetch hangs', async () => {
    // A hanging fetch that rejects on abort: the client's own timeout must kick in.
    globalThis.fetch = ((url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_ok, fail) => {
        init.signal?.addEventListener('abort', () => fail(new DOMException('The operation was aborted.', 'AbortError')));
      })) as typeof fetch;
    const t0 = Date.now();
    await expect(sendNtfy({ server: 'https://ntfy.sh', topic: 't', title: 'T', body: 'B' })).rejects.toThrow('ntfy timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9_000);
  }, 15_000);
});
