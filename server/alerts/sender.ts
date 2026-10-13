// Minimal ntfy.sh client (https://ntfy.sh, no account needed): one unauthenticated POST per alert.
// ntfy topics are guessable-public, so bodies carry only the agent name, the room/project and the
// short waiting reason — never file contents or secrets.
const TIMEOUT_MS = 10_000;

export interface NtfyOptions {
  /** Base URL, e.g. 'https://ntfy.sh' (a self-hosted ntfy server also works). */
  server: string;
  topic: string;
  title: string;
  body: string;
  /** ntfy tags; default 'raised_hand'. */
  tags?: string;
}

/** Throws an Error on non-2xx, timeout or network failure. */
export async function sendNtfy(opts: NtfyOptions): Promise<void> {
  const url = `${opts.server.replace(/\/+$/, '')}/${opts.topic}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Title: opts.title,
        Priority: 'high',
        Tags: opts.tags ?? 'raised_hand',
      },
      body: opts.body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('ntfy timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
