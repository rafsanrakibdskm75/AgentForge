import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModSummary, OfficeSnapshot, PermissionRequestInfo, UpdateStatus } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office, type OfficeDeps } from '../model/office';
import { tempDir } from '../test/fixtures';
import { createApiHandler, type ApiDeps } from './app';
import { createRequestGuard, hostAllowed, hostnameOf, isLoopbackHost, originAllowed, parseAllowedHosts } from './guard';
import { Hub } from './sse';
import { createStaticHandler, IMMUTABLE, REVALIDATE } from './static';

setQuiet(true);

interface Env {
  base: string;
  office: Office;
  close: () => Promise<void>;
}

async function start(extra: Partial<ApiDeps> = {}, officeExtra: Partial<OfficeDeps> = {}): Promise<Env & { cleanup: () => void }> {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const dist = join(tmp.dir, 'dist');
  mkdirSync(join(dist, 'assets', 'brand'), { recursive: true });
  mkdirSync(join(dist, 'bundle'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>AgentForge</title>');
  writeFileSync(join(dist, 'bundle', 'main-abc12345.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'brand', 'logo-mark.png'), 'png');
  writeFileSync(join(dist, 'assets', 'manifest.json'), '{}');
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
    ...officeExtra,
  });
  late.office = office;
  const hub = new Hub(office, { throttleMs: 10 });
  hub.start();
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: '9.9.9', inDocker: false, ...extra });
  const serveStatic = createStaticHandler(dist);
  const guard = createRequestGuard({ allowedHosts: new Set(['agentforge.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) serveStatic(req, res, url.pathname);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  office.addMain({ id: '.claude:1', account: '.claude', sessionId: 's1', cwd: '/p/loja', role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  return {
    base: `http://127.0.0.1:${port}`,
    office,
    close: () =>
      new Promise((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
    cleanup: tmp.cleanup,
  };
}

async function snapshotOf(base: string): Promise<OfficeSnapshot> {
  return (await (await fetch(`${base}/api/snapshot`)).json()) as OfficeSnapshot;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Requisição crua (o fetch não deixa trocar o cabeçalho Host). */
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end(opts.body);
  });
}

describe('API HTTP', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start();
  });
  afterEach(async () => {
    await env.close();
    env.cleanup();
  });

  it('GET /api/snapshot', async () => {
    const res = await fetch(`${env.base}/api/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const snap = (await res.json()) as OfficeSnapshot;
    expect(snap.rev).toBeGreaterThan(0);
    expect(snap.agents.map((a) => a.id)).toEqual(['.claude:1']);
    expect(snap.accounts[0]).toMatchObject({ id: '.claude', sessions: 1 });
    expect(snap.meta.version).toBe('9.9.9');
  });

  it('GET /api/stream sends retry, snapshot and feed; then the changes', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${env.base}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (re: RegExp) => {
      while (!re.test(text)) text += dec.decode((await reader.read()).value, { stream: true });
    };
    await readUntil(/event: feed\n/);
    expect(text).toMatch(/^retry: 2000\n\nevent: snapshot\ndata: \{/);
    env.office.addActivity('.claude:1', { id: 'act-x', at: Date.now(), kind: 'read', icon: '📖', text: 'Lendo a.ts' }, true);
    await readUntil(/"id":"act-x"/);
    expect(text).toContain('event: feed\ndata: [{"id":"act-x"');
    ctrl.abort();
  });

  it('GET /api/agents/:id and /api/health', async () => {
    const ok = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ agent: { id: '.claude:1' }, history: [] });
    expect((await fetch(`${env.base}/api/agents/nao-existe`)).status).toBe(404);
    const health = await (await fetch(`${env.base}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, version: '9.9.9', demo: false, docker: false, terminal: false, accounts: [{ id: '.claude', usageStatus: 'disabled' }] });
  });

  it('GET /api/updates and POST /api/updates/check without a checker: off', async () => {
    expect(await (await fetch(`${env.base}/api/updates`)).json()).toEqual({ version: '9.9.9', state: 'off', available: false });
    const check = await fetch(`${env.base}/api/updates/check`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(await check.json()).toMatchObject({ state: 'off' });
    expect((await fetch(`${env.base}/api/updates/check`)).status).toBe(405);
    expect(((await (await fetch(`${env.base}/api/health`)).json()) as { updates: unknown }).updates).toEqual({ state: 'off', available: false });
  });

  it('with a checker: GET returns the status and POST requests a manual check', async () => {
    const status: UpdateStatus = { state: 'ok', repo: 'dono/nome', checkedAt: 1, latest: '10.0.0', url: 'https://github.com/dono/nome/releases/tag/v10.0.0', available: true };
    const calls: { manual?: boolean }[] = [];
    const other = await start({ updates: { status: () => status, check: async (o) => (calls.push(o), status) } });
    try {
      expect(await (await fetch(`${other.base}/api/updates`)).json()).toEqual({ version: '9.9.9', ...status });
      const res = await fetch(`${other.base}/api/updates/check`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      expect(await res.json()).toMatchObject({ latest: '10.0.0', available: true });
      expect(calls).toEqual([{ manual: true }]);
      expect(((await (await fetch(`${other.base}/api/health`)).json()) as { updates: unknown }).updates).toEqual({ state: 'ok', latest: '10.0.0', available: true });
    } finally {
      await other.close();
      other.cleanup();
    }
  });

  it('terminal off: 403 JSON and meta.terminal false', async () => {
    const res = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}/terminal`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/disabled/);
    expect((await snapshotOf(env.base)).meta.terminal).toBe(false);
  });

  it('character: PUT and DELETE off without the terminal (403)', async () => {
    const res = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}/character`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Ana', seed: 1, parts: {} }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/disabled/);
    const del = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}/character`, { method: 'DELETE', headers: JSON_HEADERS, body: '{}' });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: string }).error).toMatch(/disabled/);
  });

  it('POST /api/demo turns on and off', async () => {
    const on = await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) });
    expect(await on.json()).toEqual({ ok: true, demo: true });
    expect((await snapshotOf(env.base)).meta.demo).toBe(true);
    expect((await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":1}' })).status).toBe(400);
    expect((await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: '{' })).status).toBe(400);
    expect((await fetch(`${env.base}/api/demo`)).status).toBe(405);
  });

  it('DNS rebinding: Host from another domain is refused on any route', async () => {
    const port = new URL(env.base).port;
    for (const path of ['/api/snapshot', '/api/stream', '/', '/bundle/main-abc12345.js']) {
      const r = await raw(env.base, path, { headers: { Host: `attacker.example:${port}` } });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('"agents"');
    }
    expect((await raw(env.base, '/api/health', { headers: { Host: `localhost:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `[::1]:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `192.168.0.10:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `agentforge.lan:${port}` } })).status).toBe(200);
  });

  it('CSRF: POST requires JSON and local origin', async () => {
    const demoOn = JSON.stringify({ enabled: true });
    // Formulário/fetch "simples" de outro site: text/plain, sem preflight.
    const plain = await fetch(`${env.base}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: demoOn });
    expect(plain.status).toBe(415);
    const form = await raw(env.base, '/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'enabled=true' });
    expect(form.status).toBe(415);
    const cross = await raw(env.base, '/api/demo', { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'http://attacker.example' }, body: demoOn });
    expect(cross.status).toBe(403);
    expect((await snapshotOf(env.base)).meta.demo).toBe(false);
    const port = new URL(env.base).port;
    const same = await raw(env.base, '/api/demo', { method: 'POST', headers: { ...JSON_HEADERS, Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, body: demoOn });
    expect(same.status).toBe(200);
  });

  it('JSON responses with nosniff and CORP same-origin; no CORS', async () => {
    const res = await fetch(`${env.base}/api/snapshot`, { headers: { Origin: 'http://attacker.example' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unknown routes: 404 JSON (including the old POST /api/usage, which no longer exists)', async () => {
    const res = await fetch(`${env.base}/api/nada`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown route' });
    const usage = await fetch(`${env.base}/api/usage`, { method: 'POST', headers: JSON_HEADERS, body: '{"accounts":[]}' });
    expect(usage.status).toBe(404);
  });

  it('statics: SPA fallback, immutable only on /bundle (hash) and revalidation elsewhere', async () => {
    const page = await fetch(`${env.base}/sala/qualquer`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>AgentForge</title>');
    expect(page.headers.get('cache-control')).toBe(REVALIDATE);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const bundle = await fetch(`${env.base}/bundle/main-abc12345.js`);
    expect(bundle.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(bundle.headers.get('content-type')).toMatch(/javascript/);
    // client/public: nome fixo, pode mudar a cada build.
    for (const path of ['/assets/brand/logo-mark.png', '/assets/manifest.json']) {
      const res = await fetch(`${env.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(REVALIDATE);
      const etag = res.headers.get('etag')!;
      expect(etag).toMatch(/^W\/"/);
      expect(res.headers.get('last-modified')).toBeTruthy();
      const again = await fetch(`${env.base}${path}`, { headers: { 'If-None-Match': etag } });
      expect(again.status).toBe(304);
      const since = await fetch(`${env.base}${path}`, { headers: { 'If-Modified-Since': res.headers.get('last-modified')! } });
      expect(since.status).toBe(304);
      const stale = await fetch(`${env.base}${path}`, { headers: { 'If-None-Match': 'W/"outro"' } });
      expect(stale.status).toBe(200);
    }
    expect((await fetch(`${env.base}/assets/nao-existe.js`)).status).toBe(404);
    expect((await fetch(`${env.base}/bundle/nao-existe.js`)).status).toBe(404);
    // Tentativa de sair da pasta cai no index.html, nunca em arquivos de fora.
    const escape = await fetch(`${env.base}/..%2F..%2Fetc%2Fpasswd`);
    expect(await escape.text()).toContain('<title>AgentForge</title>');
  });
});

describe('project character (PUT/DELETE /api/agents/:id/character)', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start({ terminal: true });
  });
  afterEach(async () => {
    await env.close();
    env.cleanup();
  });

  const url = (id = '.claude:1') => `${env.base}/api/agents/${encodeURIComponent(id)}/character`;
  const put = (body: unknown, id?: string) => fetch(url(id), { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const agentOf = async (id = '.claude:1') => (await snapshotOf(env.base)).agents.find((a) => a.id === id)!;

  it('PUT saves and the snapshot brings name, seed, parts and custom; DELETE goes back to random', async () => {
    const before = await agentOf();
    const res = await put({ name: '  Ana   Backend ', seed: 7, parts: { hairStyle: 'bob', skin: '#5A3623' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(async () =>
      expect(await agentOf()).toMatchObject({ name: 'Ana Backend', seed: 7, parts: { skin: '#5a3623', hairStyle: 'bob' }, custom: true }),
    );
    const del = await fetch(url(), { method: 'DELETE', headers: JSON_HEADERS, body: '{}' });
    expect(del.status).toBe(200);
    await vi.waitFor(async () => expect(await agentOf()).toMatchObject({ name: before.name, seed: before.seed }));
    expect((await agentOf()).custom).toBeUndefined();
  });

  it('400 for invalid name, seed or parts', async () => {
    for (const body of [
      { name: '', seed: 1, parts: {} },
      { name: 'a'.repeat(25), seed: 1, parts: {} },
      { name: 'Ana', seed: -1, parts: {} },
      { name: 'Ana', seed: 1, parts: { skin: 'red' } },
      { name: 'Ana', seed: 1, parts: { lanyard: '#ffffff' } },
      { name: 'Ana', seed: 1 },
      { name: 'Ana', seed: 1, parts: null },
    ]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('404 for subagent and unknown agent; 409 for the name of someone in the office', async () => {
    env.office.addSub({ id: 's1:x', parentId: '.claude:1', sessionId: 's1', role: 'Explore', background: false, startedAt: Date.now() });
    expect((await put({ name: 'Ana', seed: 1, parts: {} }, 's1:x')).status).toBe(404);
    expect((await put({ name: 'Ana', seed: 1, parts: {} }, 'nao-existe')).status).toBe(404);
    for (const id of ['s1:x', 'nao-existe']) expect((await fetch(url(id), { method: 'DELETE', headers: JSON_HEADERS, body: '{}' })).status).toBe(404);
    env.office.addMain({ id: '.claude:2', account: '.claude', sessionId: 's2', cwd: '/p/web', role: 'Agente principal', startedAt: Date.now(), status: 'working' });
    const other = env.office.get('.claude:2')!.name;
    const res = await put({ name: other, seed: 1, parts: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(`${other} is already in the office, in web`);
  });

  it('403 with non-local Host (even allowed in AGENTFORGE_ALLOWED_HOSTS); 405 for GET', async () => {
    const port = new URL(env.base).port;
    const r = await raw(env.base, `/api/agents/${encodeURIComponent('.claude:1')}/character`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, Host: `agentforge.lan:${port}` },
      body: JSON.stringify({ name: 'Ana', seed: 1, parts: {} }),
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/computer running/);
    const get = await fetch(url());
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('PUT, DELETE');
  });
});

describe('GET /api/mod/summary (Claude Code mod)', () => {
  let env: Awaited<ReturnType<typeof start>>;
  const perms = new Map<string, PermissionRequestInfo>();
  const summary = async (query = ''): Promise<ModSummary> => (await (await fetch(`${env.base}/api/mod/summary${query}`)).json()) as ModSummary;

  beforeEach(async () => {
    perms.clear();
    env = await start({}, { permissions: () => perms });
    const now = Date.now();
    // .claude:1 (sessão s1, /p/loja, trabalhando) vem do start(); um subagente dela espera em segundo plano.
    env.office.addSub({ id: 's1:a1', parentId: '.claude:1', sessionId: 's1', role: 'Explore', background: true, startedAt: now });
    env.office.setStatus('s1:a1', 'waiting', 'aprovar uma permissão');
    // Outra sessão da mesma conta, esperando há mais tempo, e uma da outra conta com o mesmo id de sessão.
    env.office.addMain({ id: '.claude:2', account: '.claude', sessionId: 's2', cwd: '/p/app', role: 'Agente principal', startedAt: now, status: 'waiting', waitingFor: 'responder no terminal' });
    env.office.addMain({ id: '.claude-conta2:3', account: '.claude-conta2', sessionId: 's1', cwd: '/p/site', role: 'Agente principal', startedAt: now, status: 'idle' });
  });
  afterEach(async () => {
    await env.close();
    env.cleanup();
  });

  it('no params: the whole office (present, working, waiting from oldest to newest)', async () => {
    const s = await summary();
    expect(s).toMatchObject({ version: '9.9.9', agents: 4, working: 1 });
    expect(s.waiting.map((w) => w.id).sort()).toEqual(['.claude:2', 's1:a1']);
    const app = s.waiting.find((w) => w.id === '.claude:2')!;
    expect(app).toEqual({ id: '.claude:2', name: app.name, room: 'app', account: '.claude', waitingFor: 'responder no terminal', since: app.since, answerable: false });
    expect(typeof app.since).toBe('number');
    expect(s.waiting.map((w) => w.since)).toEqual([...s.waiting.map((w) => w.since!)].sort((a, b) => a - b));
  });

  it('?account&session: removes its own session (main and subagents); the same session on another account stays', async () => {
    const s = await summary('?account=.claude&session=s1');
    expect(s).toMatchObject({ agents: 2, working: 0 });
    expect(s.waiting.map((w) => w.id)).toEqual(['.claude:2']);
    // Só a sessão (sem conta) também basta; só a conta não exclui nada.
    expect((await summary('?session=s1')).agents).toBe(1);
    expect((await summary('?account=.claude')).agents).toBe(4);
  });

  it('answerable = there is a permission request to answer from the office', async () => {
    perms.set('.claude:2', { id: 'p1', tool: 'Bash', title: 'Bash(npm test)', text: 'Rodando os testes', icon: '🧪', createdAt: Date.now(), expiresAt: Date.now() + 300_000 });
    env.office.markDirty();
    const s = await summary('?account=.claude&session=s1');
    expect(s.waiting).toMatchObject([{ id: '.claude:2', answerable: true, waitingFor: 'responder no terminal' }]);
  });

  it('demo agents stay out (even waiting); finished ones too', async () => {
    await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) });
    const snap = await snapshotOf(env.base);
    expect(snap.agents.some((a) => a.id.startsWith('demo:'))).toBe(true);
    env.office.closeMain('.claude-conta2:3');
    const s = await summary();
    expect(s.agents).toBe(3);
    expect(s.waiting.every((w) => !w.id.startsWith('demo:'))).toBe(true);
  });

  it('GET/HEAD only (405 with Allow)', async () => {
    const res = await fetch(`${env.base}/api/mod/summary`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect((await fetch(`${env.base}/api/mod/summary`, { method: 'HEAD' })).status).toBe(200);
  });
});

describe('Host/Origin guard', () => {
  const allowed = parseAllowedHosts(' Meu-Mac.local:4747 , agentforge.lan ');

  it('hostnameOf e AGENTFORGE_ALLOWED_HOSTS', () => {
    expect([...allowed]).toEqual(['meu-mac.local', 'agentforge.lan']);
    expect(hostnameOf('LocalHost:4747')).toBe('localhost');
    expect(hostnameOf('[::1]:4747')).toBe('::1');
    expect(hostnameOf('a b')).toBeUndefined();
    expect(hostnameOf('[::1]lixo')).toBeUndefined();
  });

  it('Host: IPs, localhost and allowed ones yes; outside domains no', () => {
    expect(hostAllowed(undefined, allowed)).toBe(true);
    for (const h of ['localhost:4747', 'app.localhost', '127.0.0.1:4747', '[::1]:1', '10.0.0.5:4747', 'meu-mac.local:4747']) expect(hostAllowed(h, allowed)).toBe(true);
    for (const h of ['attacker.example:4747', 'localhost.attacker.example', '127.0.0.1.nip.io', '', 'x y']) expect(hostAllowed(h, allowed)).toBe(false);
  });

  it('isLoopbackHost: only localhost, *.localhost, 127.x and ::1 (terminal)', () => {
    for (const h of ['localhost:4747', 'LOCALHOST', 'app.localhost:1', '127.0.0.1:4747', '127.8.9.10', '[::1]:4747']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of [undefined, '', '10.0.0.5:4747', '192.168.0.10', '0.0.0.0:4747', 'agentforge.lan', 'meu-mac.local:4747', '[::]:4747', 'localhost.attacker.example', '127.0.0.1.nip.io', 'x y']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('Origin: absent, same origin or local', () => {
    expect(originAllowed(undefined, 'localhost:4747', allowed)).toBe(true);
    expect(originAllowed('http://localhost:4747', 'localhost:4747', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', '127.0.0.1:4747', allowed)).toBe(true); // Vite dev com proxy
    expect(originAllowed('http://192.168.0.10:4747', '192.168.0.10:4747', allowed)).toBe(true);
    expect(originAllowed('http://attacker.example', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('http://1.2.3.4', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('null', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('file://', 'localhost:4747', allowed)).toBe(false);
  });
});
