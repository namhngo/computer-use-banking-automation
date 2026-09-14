import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy, parsePolicy } from '../../src/policy/policy.js';
import type { Policy } from '../../src/policy/policy.js';
import { startPolicyProxy } from '../../src/surface/network.js';

const html = '<!doctype html><link rel="icon" href="data:,"><body>Synthetic page</body>';
type Hit = { method: string | undefined; path: string | undefined; body: string; headers: IncomingHttpHeaders };

async function fixture() {
  const hits: Hit[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let connections = 0;
  let upgrades = 0;
  let handler = (_incoming: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(html);
  };
  const server = createServer((incoming, response) => {
    const hit: Hit = { method: incoming.method, path: incoming.url, body: '', headers: incoming.headers };
    hits.push(hit);
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk: string) => { hit.body += chunk; });
    incoming.on('end', () => handler(incoming, response));
  });
  server.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_incoming, socket) => { upgrades++; socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback listener.');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    hits,
    get connections() { return connections; },
    get upgrades() { return upgrades; },
    get openSockets() { return sockets.size; },
    handle(next: typeof handler) { handler = next; },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

let rootPolicy: Policy;
let policy: Policy;
let app: Awaited<ReturnType<typeof fixture>>;
let other: Awaited<ReturnType<typeof fixture>>;
let proxy: Awaited<ReturnType<typeof startPolicyProxy>>;
let browser: Browser | undefined;
let context: BrowserContext;
let page: Page;
let codes: ('POLICY_BLOCKED' | 'NETWORK_ERROR')[];

async function startBrowser(sessionToken?: string) {
  proxy = await startPolicyProxy({ policy, origin: app.origin, onViolation: (code) => codes.push(code), timeoutMs: 2000,
    ...(sessionToken === undefined ? {} : { sessionToken }) });
  browser = await chromium.launch({ headless: true, proxy: { server: proxy.server, bypass: proxy.bypass } });
  context = await browser.newContext({ serviceWorkers: 'block',
    ...(sessionToken === undefined ? {} : { extraHTTPHeaders: { 'x-automation-session': sessionToken } }) });
  page = await context.newPage();
}

beforeAll(async () => {
  rootPolicy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
});

beforeEach(async () => {
  codes = [];
  app = await fixture();
  other = await fixture();
  policy = parsePolicy({
    ...rootPolicy,
    allowedOrigins: [app.origin, other.origin],
    pages: rootPolicy.pages.filter((rule) => ['/login', '/members/search', '/members/:id'].includes(rule.path)),
    forms: rootPolicy.forms.filter((rule) => ['/login', '/members/search', '/logout'].includes(rule.path)),
  });
  await startBrowser();
});

afterEach(async () => {
  try { await browser?.close(); } finally {
    browser = undefined;
    await proxy?.close();
    await Promise.all([app?.close(), other?.close()]);
  }
});

async function post(path: string, body = 'synthetic=value') {
  return page.evaluate(async ({ target, body }) => {
    try {
      const response = await fetch(target, { method: 'POST', body });
      return { status: response.status, text: await response.text() };
    } catch { return null; }
  }, { target: path, body });
}

async function grantedPost(path: string, body = 'synthetic=value') {
  const revoke = proxy.grantPost(`${app.origin}${path}`, body);
  try { return await post(path, body); } finally { revoke(); }
}

// Chromium normalizes URL spellings before sending them; raw probes exercise the proxy boundary too.
async function rawRequest(message: string | Buffer): Promise<string> {
  const address = new URL(proxy.server);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(address.port), address.hostname);
    let result = '';
    socket.setEncoding('utf8');
    socket.setTimeout(4000, () => socket.destroy(new Error('Synthetic probe timeout.')));
    socket.on('connect', () => socket.write(message));
    socket.on('data', (chunk: string) => { result += chunk; });
    socket.on('error', () => reject(new Error('Synthetic probe failed.')));
    socket.on('close', () => resolve(result));
  });
}

it('forwards allowed GET and POST with their bodies through a private loopback proxy', async () => {
  expect(proxy.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(proxy.bypass).toBe('<-loopback>');
  expect((await page.goto(`${app.origin}/login`))?.status()).toBe(200);
  expect((await grantedPost('/members/search'))?.status).toBe(200);
  expect(app.hits.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
    { method: 'GET', path: '/login', body: '' },
    { method: 'POST', path: '/members/search', body: 'synthetic=value' },
  ]);
  expect(other.connections).toBe(0);
});

it.each(['no-grant', 'wrong-url', 'wrong-body', 'equivalent-encoding', 'revoked'] as const)(
  'denies a Chromium POST with %s before opening an upstream connection', async (scenario) => {
    await page.goto(`${app.origin}/login`);
    app.hits.length = 0;
    const connectionsBefore = app.connections;
    const expected = scenario === 'equivalent-encoding' ? 'synthetic=value+plus' : 'synthetic=value';
    const revoke = scenario === 'no-grant' ? () => undefined
      : proxy.grantPost(`${app.origin}/members/search`, expected);
    try {
      if (scenario === 'revoked') revoke();
      const body = scenario === 'wrong-body' ? 'synthetic=changed'
        : scenario === 'equivalent-encoding' ? 'synthetic=value%20plus' : expected;
      // /logout is independently POST-allowed, but is not the destination granted by the adapter.
      expect((await post(scenario === 'wrong-url' ? '/logout' : '/members/search', body))?.status).toBe(403);
      expect((await post('/members/search', expected))?.status).toBe(403);
      expect(app.hits).toHaveLength(0);
      expect(app.connections).toBe(connectionsBefore);
      expect(other.connections).toBe(0);
      expect(codes).toContain('POLICY_BLOCKED');
    } finally { revoke(); }
  },
);

it('consumes a POST grant once, rejects overlapping grants, and isolates stale revokers', async () => {
  await page.goto(`${app.origin}/login`);
  app.hits.length = 0;
  const revoke = proxy.grantPost(`${app.origin}/members/search`, 'synthetic=value');
  try {
    expect(() => proxy.grantPost(`${app.origin}/login`, 'synthetic=value')).toThrow('Invalid POST grant.');
    expect((await post('/members/search'))?.status).toBe(200);
    expect((await post('/members/search'))?.status).toBe(403);
    expect(app.hits).toHaveLength(1);
    const revokeNext = proxy.grantPost(`${app.origin}/members/search`, 'synthetic=value');
    try {
      revoke();
      revoke();
      expect((await post('/members/search'))?.status).toBe(200);
    } finally { revokeNext(); }
    expect(app.hits).toHaveLength(2);
  } finally { revoke(); }
});

it('matches the exact URLSearchParams encoding of a native Chromium form submission', async () => {
  await page.goto(`${app.origin}/login`);
  await page.setContent('<form method="post" action="/members/search">'
    + '<input name="member" value="12345"><input name="note" value="synthetic + value">'
    + '<button>Submit synthetic form</button></form>');
  app.hits.length = 0;
  const body = new URLSearchParams({ member: '12345', note: 'synthetic + value' }).toString();
  const revoke = proxy.grantPost(`${app.origin}/members/search`, body);
  try {
    const [response] = await Promise.all([
      page.waitForResponse(`${app.origin}/members/search`),
      page.getByRole('button', { name: 'Submit synthetic form' }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(app.hits.map(({ method, path, body }) => [method, path, body])).toEqual([
      ['POST', '/members/search', body],
    ]);
  } finally { revoke(); }
});

it('rejects invalid POST grants with sanitized errors, including noncanonical URLs and oversized UTF-8 bodies', () => {
  for (const url of [
    `${other.origin}/login`, `${app.origin}/members/12345`, `${app.origin}/forbidden`,
    `${app.origin}/members/../login`, `${app.origin}/%6cogin`, `${app.origin}/login?reason=other`,
    `${app.origin.replace('http://', 'http://synthetic:secret@')}/login`, 'not-a-url',
  ]) {
    expect(() => proxy.grantPost(url, 'synthetic=value')).toThrow(new Error('Invalid POST grant.'));
  }
  for (const body of ['x'.repeat(32769), '\u00e9'.repeat(16385)]) {
    expect(() => proxy.grantPost(`${app.origin}/login`, body)).toThrow(new Error('Invalid POST grant.'));
  }
  expect(app.connections).toBe(0);
  expect(other.connections).toBe(0);
});

it.each([0, 32768])('accepts an exactly granted body of %i bytes', async (length) => {
  const body = 'x'.repeat(length);
  const revoke = proxy.grantPost(`${app.origin}/login`, body);
  try {
    const response = await rawRequest(`POST ${app.origin}/login HTTP/1.1\r\nHost: synthetic\r\nConnection: close\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`);
    expect(response).toContain('200 OK');
    expect(app.hits).toHaveLength(1);
    expect(app.hits[0]?.body).toBe(body);
  } finally { revoke(); }
});

it.each(['content-length', 'chunked'] as const)('rejects oversized %s POSTs before any upstream connection', async (framing) => {
  const revoke = proxy.grantPost(`${app.origin}/login`, 'x'.repeat(32768));
  try {
    const body = 'x'.repeat(32769);
    const payload = framing === 'content-length' ? `Content-Length: 32769\r\n\r\n${body}`
      : `Transfer-Encoding: chunked\r\n\r\n8001\r\n${body}\r\n0\r\n\r\n`;
    const response = await rawRequest(`POST ${app.origin}/login HTTP/1.1\r\nHost: synthetic\r\nConnection: close\r\n${payload}`);
    expect(response).toContain('403 Forbidden');
    expect(app.hits).toHaveLength(0);
    expect(app.connections).toBe(0);
    expect(codes).toContain('POLICY_BLOCKED');
  } finally { revoke(); }
});

it('compares POST bytes without lossy UTF-8 decoding', async () => {
  const revoke = proxy.grantPost(`${app.origin}/login`, '\ufffd');
  try {
    const response = await rawRequest(Buffer.concat([
      Buffer.from(`POST ${app.origin}/login HTTP/1.1\r\nHost: synthetic\r\nConnection: close\r\nContent-Length: 1\r\n\r\n`),
      Buffer.from([0xff]),
    ]));
    expect(response).toContain('403 Forbidden');
    expect(app.hits).toHaveLength(0);
    expect(app.connections).toBe(0);
    expect(codes).toContain('POLICY_BLOCKED');
  } finally { revoke(); }
});

it.each(['complete', 'revoke', 'close', 'timeout'] as const)(
  'buffers POST before upstream connection and handles %s safely', async (scenario) => {
    const revoke = proxy.grantPost(`${app.origin}/login`, 'synthetic=value');
    const probe = request(proxy.server, {
      method: 'POST', path: `${app.origin}/login`, agent: false,
      headers: { expect: '100-continue', 'content-length': '15' },
    });
    const responsePromise = new Promise<number | undefined>((resolve) => {
      probe.on('response', (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      probe.on('error', () => resolve(undefined));
    });
    try {
      const ready = once(probe, 'continue');
      probe.flushHeaders();
      await ready;
      probe.write('synthetic=');
      expect(app.connections).toBe(0);
      expect(app.hits).toHaveLength(0);
      // The grant is already consumed while the first body is incomplete.
      const repeated = await rawRequest(`POST ${app.origin}/login HTTP/1.1\r\nHost: synthetic\r\nConnection: close\r\nContent-Length: 15\r\n\r\nsynthetic=value`);
      expect(repeated).toContain('403 Forbidden');
      if (scenario === 'revoke') revoke();
      if (scenario === 'close') {
        const closed = proxy.close();
        expect(() => proxy.grantPost(`${app.origin}/login`, 'synthetic=value')).toThrow('Invalid POST grant.');
        await closed;
      } else if (scenario !== 'timeout') probe.end('value');
      const status = await responsePromise;
      if (scenario === 'complete') {
        expect(status).toBe(200);
        expect(app.hits).toHaveLength(1);
        expect(app.hits[0]?.body).toBe('synthetic=value');
      } else {
        expect(app.connections).toBe(0);
        expect(app.hits).toHaveLength(0);
        if (scenario === 'revoke') expect(status).toBe(403);
        if (scenario === 'timeout') {
          expect(status).toBe(502);
          expect(codes).toContain('NETWORK_ERROR');
        }
      }
    } finally { revoke(); probe.destroy(); }
  },
);

it('preserves a 303 login redirect and every hop of an allowed redirect chain', async () => {
  await page.goto(`${app.origin}/login`);
  app.hits.length = 0;
  app.handle((incoming, response) => {
    if (incoming.url === '/login' && incoming.method === 'POST') {
      response.writeHead(303, { location: '/members/search', 'set-cookie': 'synthetic_session=yes; Path=/' });
    } else if (incoming.url === '/members/search') {
      response.writeHead(302, { location: '/members/12345' });
    } else if (incoming.url === '/members/12345') {
      response.writeHead(301, { location: '/login?reason=expired' });
    } else response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  const statuses: number[] = [];
  page.on('response', (response) => { statuses.push(response.status()); });
  expect((await grantedPost('/login'))?.status).toBe(200);
  expect(statuses).toEqual([303, 302, 301, 200]);
  expect(app.hits.map(({ method, path, body }) => [method, path, body])).toEqual([
    ['POST', '/login', 'synthetic=value'],
    ['GET', '/members/search', ''],
    ['GET', '/members/12345', ''],
    ['GET', '/login?reason=expired', ''],
  ]);
  expect(app.hits[1]?.headers.cookie).toBe('synthetic_session=yes');
});

it.each(['same-origin', 'separate-port'] as const)('blocks the third redirect hop before a %s target is hit', async (destination) => {
  app.handle((incoming, response) => {
    response.writeHead(302, { location: incoming.url === '/login' ? '/members/search'
      : destination === 'same-origin' ? '/forbidden' : `${other.origin}/members/12345` });
    response.end();
  });
  const response = await page.goto(`${app.origin}/login`).catch(() => null);
  expect(response?.status()).toBe(403);
  expect(app.hits.map((hit) => hit.path)).toEqual(['/login', '/members/search']);
  expect(other.hits).toHaveLength(0);
  expect(other.connections).toBe(0);
  expect(codes).toContain('POLICY_BLOCKED');
});

it.each(['same-origin', 'separate-port', 'allowed-post', 'same-url'] as const)('blocks a 307 redirect without leaking POST to a %s target', async (destination) => {
  await page.goto(`${app.origin}/login`);
  app.hits.length = 0;
  app.handle((_incoming, response) => {
    const locations = { 'same-origin': '/members/12345', 'separate-port': `${other.origin}/login`,
      'allowed-post': '/members/search', 'same-url': '/login' };
    response.writeHead(307, { location: locations[destination] });
    response.end();
  });
  await grantedPost('/login');
  expect(app.hits.map(({ method, path, body }) => [method, path, body])).toEqual([
    ['POST', '/login', 'synthetic=value'],
  ]);
  expect(other.hits).toHaveLength(0);
  expect(other.connections).toBe(0);
  expect(codes).toContain('POLICY_BLOCKED');
});

it('denies query changes and forbidden POST before any target request', async () => {
  await page.goto(`${app.origin}/login`);
  app.hits.length = 0;
  for (const path of ['/login?reason=other', '/login?reason=expired&reason=expired', '/members/search?reason=expired']) {
    expect((await page.goto(`${app.origin}${path}`).catch(() => null))?.status()).toBe(403);
  }
  expect((await post('/members/12345'))?.status).toBe(403);
  expect(app.hits).toHaveLength(0);
  expect(other.hits).toHaveLength(0);
  expect(codes).toContain('POLICY_BLOCKED');
});

it('enforces policy on the initial request of a popup without page interception', async () => {
  await page.goto(`${app.origin}/login`);
  app.hits.length = 0;
  const popupPromise = context.waitForEvent('page');
  await page.evaluate((target) => { window.open(target); }, `${other.origin}/login`);
  const popup = await popupPromise;
  await popup.waitForLoadState().catch(() => undefined);
  expect(other.hits).toHaveLength(0);
  expect(other.connections).toBe(0);
  expect(app.hits).toHaveLength(0);
  expect(codes).toContain('POLICY_BLOCKED');
});

it('blocks Chromium WebSocket upgrades and HTTPS CONNECT without a target connection', async () => {
  await page.goto(`${app.origin}/login`);
  const connectionsBefore = app.connections;
  app.hits.length = 0;
  const outcome = await page.evaluate((target) => new Promise<string>((resolve) => {
    const socket = new WebSocket(target);
    socket.onopen = () => { socket.close(); resolve('opened'); };
    socket.onerror = () => resolve('blocked');
  }), `${app.origin.replace('http:', 'ws:')}/login`);
  expect(outcome).toBe('blocked');
  await page.goto(`${other.origin.replace('http:', 'https:')}/login`).catch(() => null);
  expect(app.connections).toBe(connectionsBefore);
  expect(app.upgrades).toBe(0);
  expect(app.hits).toHaveLength(0);
  expect(other.connections).toBe(0);
  expect(codes).toContain('POLICY_BLOCKED');
});

it('rejects raw credentials, malformed targets, canonicalization spoofing, missing and unsupported methods', async () => {
  const targets = [
    `${app.origin.replace('http://', 'http://synthetic:secret@')}/login`,
    `${app.origin}/members/../login`, `${app.origin}/%6cogin`, `${app.origin}/login#fragment`,
    `${app.origin}/login?`, `${app.origin.replace('127.0.0.1', '127.1')}/login`,
    `${app.origin}/members\\..\\login`, '/login', 'not-a-url',
  ];
  for (const target of targets) {
    const before = codes.length;
    await rawRequest(`GET ${target} HTTP/1.1\r\nHost: ${new URL(app.origin).host}\r\nConnection: close\r\n\r\n`);
    expect(codes.slice(before)).toContain('POLICY_BLOCKED');
  }
  for (const method of ['DELETE', 'HEAD', 'get', '']) {
    const before = codes.length;
    await rawRequest(`${method} ${app.origin}/login HTTP/1.1\r\nHost: synthetic\r\nConnection: close\r\n\r\n`);
    expect(codes.slice(before)).toContain('POLICY_BLOCKED');
  }
  await rawRequest(`CONNECT ${new URL(app.origin).host} HTTP/1.1\r\nHost: synthetic\r\n\r\n`);
  expect(app.connections).toBe(0);
  expect(app.hits).toHaveLength(0);
  expect(other.connections).toBe(0);
});

it('strips hop-by-hop and proxy authentication headers in both directions and replaces Host', async () => {
  app.handle((_incoming, response) => {
    response.writeHead(200, {
      connection: 'close, x-response-hop', 'x-response-hop': 'remove',
      'proxy-authenticate': 'Synthetic', 'proxy-authorization': 'remove',
      'set-cookie': ['first=synthetic', 'second=synthetic'],
    });
    response.end('synthetic response');
  });
  const revoke = proxy.grantPost(`${app.origin}/login`, 'test');
  let response: string;
  try {
    response = await rawRequest(`POST ${app.origin}/login HTTP/1.1\r\nHost: spoof.invalid\r\nConnection: close, x-request-hop\r\nX-Request-Hop: remove\r\nProxy-Authorization: Synthetic\r\nProxy-Connection: keep-alive\r\nTE: trailers\r\nContent-Length: 4\r\n\r\ntest`);
  } finally { revoke(); }
  expect(app.hits).toHaveLength(1);
  expect(app.hits[0]?.headers.host).toBe(new URL(app.origin).host);
  for (const header of ['x-request-hop', 'proxy-authorization', 'proxy-connection', 'te']) {
    expect(app.hits[0]?.headers[header]).toBeUndefined();
  }
  expect(app.hits[0]?.body).toBe('test');
  expect(response.toLowerCase()).not.toMatch(/x-response-hop|proxy-authenticate|proxy-authorization/);
  expect(response).toContain('first=synthetic');
  expect(response).toContain('second=synthetic');
});

it('bounds stalled upstreams, reports only generic failures, and never retries', async () => {
  app.handle(() => { /* Deliberately never send response headers. */ });
  await page.goto(`${app.origin}/login`).catch(() => null);
  expect(app.hits).toHaveLength(1);
  await expect.poll(() => app.openSockets).toBe(0);
  expect(codes).toContain('NETWORK_ERROR');
  expect(codes.every((code) => code === 'POLICY_BLOCKED' || code === 'NETWORK_ERROR')).toBe(true);
});

it('still streams GET responses without waiting for the complete body', async () => {
  let finishResponse: (() => void) | undefined;
  app.handle((_incoming, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('response-first');
    finishResponse = () => response.end('-last');
  });
  const probe = request(proxy.server, { path: `${app.origin}/login`, agent: false });
  const replyPromise = new Promise<IncomingMessage>((resolve, reject) => {
    probe.on('response', resolve);
    probe.on('error', () => reject(new Error('Synthetic streaming probe failed.')));
  });
  probe.end();
  const reply = await replyPromise;
  let body = '';
  reply.setEncoding('utf8');
  reply.on('data', (chunk: string) => { body += chunk; });
  const ended = once(reply, 'end');
  await expect.poll(() => body).toBe('response-first');
  expect(app.hits[0]?.body).toBe('');
  expect(finishResponse).toBeDefined();
  finishResponse?.();
  await ended;
  expect(body).toBe('response-first-last');
});

it('closes in-flight requests and idle sockets idempotently', async () => {
  app.handle(() => { /* Remain in flight until proxy shutdown. */ });
  const pending = page.goto(`${app.origin}/login`).catch(() => null);
  await expect.poll(() => app.hits.length).toBe(1);
  const address = new URL(proxy.server);
  const idle = connect(Number(address.port), address.hostname);
  idle.on('error', () => { /* Shutdown can reset an idle TCP connection. */ });
  await once(idle, 'connect');
  const idleClosed = new Promise<void>((resolve) => { idle.once('close', () => resolve()); });
  expect(proxy.close()).toBe(proxy.close());
  await proxy.close();
  await Promise.all([pending, idleClosed]);
  await expect.poll(() => app.openSockets).toBe(0);
});

it('sanitizes startup errors and connection failures', async () => {
  await expect(startPolicyProxy({ policy, origin: 'http://synthetic:secret@invalid',
    onViolation: (code) => codes.push(code), timeoutMs: 1000 })).rejects.toThrow('Policy proxy startup failed.');
  await expect(startPolicyProxy({ policy, origin: app.origin,
    onViolation: (code) => codes.push(code), timeoutMs: 0 })).rejects.toThrow('Policy proxy startup failed.');
  await app.close();
  const status = await new Promise<number | undefined>((resolve) => {
    const probe = request(proxy.server, { path: `${app.origin}/login` }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    probe.on('error', () => resolve(undefined));
    probe.end();
  });
  expect(status).toBe(502);
  expect(codes).toContain('NETWORK_ERROR');
});

describe('session-marked proxy', () => {
  const sessionToken = 'a'.repeat(32);

  beforeEach(async () => {
    await browser?.close();
    await proxy.close();
    codes = [];
    await startBrowser(sessionToken);
  });

  it.each(['absent', 'wrong'] as const)('silently rejects an %s marker without consuming a POST grant', async (marker) => {
    const header = marker === 'absent' ? '' : `X-Automation-Session: ${'b'.repeat(32)}\r\n`;
    const deniedGet = await rawRequest(`GET ${app.origin}/login HTTP/1.1\r\nHost: synthetic\r\n${header}Connection: close\r\n\r\n`);
    expect(deniedGet).toContain('403 Forbidden');
    expect(deniedGet.toLowerCase()).toContain('x-automation-denied: 1');
    const revoke = proxy.grantPost(`${app.origin}/members/search`, 'synthetic=value');
    try {
      const deniedPost = await rawRequest(`POST ${app.origin}/members/search HTTP/1.1\r\nHost: synthetic\r\n${header}Connection: close\r\nContent-Length: 15\r\n\r\nsynthetic=value`);
      expect(deniedPost).toContain('403 Forbidden');
      expect(deniedPost.toLowerCase()).toContain('x-automation-denied: 1');
      expect(app.hits).toHaveLength(0);
      expect(app.connections).toBe(0);
      expect(other.connections).toBe(0);
      expect(codes).toEqual([]);

      expect((await page.goto(`${app.origin}/login`))?.status()).toBe(200);
      // Reuse the original grant: background POSTs must not steal it.
      expect((await post('/members/search'))?.status).toBe(200);
      expect(codes).toEqual([]);
      expect((await post('/members/search'))?.status).toBe(403);
      expect(codes).toEqual(['POLICY_BLOCKED']);
      expect(app.hits.map(({ method, path, body }) => [method, path, body])).toEqual([
        ['GET', '/login', ''], ['POST', '/members/search', 'synthetic=value'],
      ]);
      for (const hit of app.hits) {
        expect(hit.headers).not.toHaveProperty('x-automation-session');
        expect(JSON.stringify(hit.headers)).not.toContain(sessionToken);
      }
    } finally { revoke(); }
  });

  it('reports a correctly marked forbidden browser request before upstream contact', async () => {
    expect((await page.goto(`${app.origin}/forbidden`))?.status()).toBe(403);
    expect(codes).toEqual(['POLICY_BLOCKED']);
    expect(app.hits).toHaveLength(0);
    expect(app.connections).toBe(0);
    expect(other.connections).toBe(0);
  });

  it('silently denies unmarked CONNECT, including Chromium HTTPS, without target connections', async () => {
    for (const header of ['', `X-Automation-Session: ${'b'.repeat(32)}\r\n`]) {
      const response = await rawRequest(`CONNECT ${new URL(other.origin).host} HTTP/1.1\r\nHost: synthetic\r\n${header}\r\n`);
      expect(response).toContain('403 Forbidden');
    }
    // Context extraHTTPHeaders do not mark Chromium's CONNECT handshake.
    const response = await page.goto(`${other.origin.replace('http:', 'https:')}/login`).catch(() => null);
    expect(response).toBeNull();
    expect(other.connections).toBe(0);
    expect(other.hits).toHaveLength(0);
    expect(app.connections).toBe(0);
    expect(codes).toEqual([]);
    // The failed HTTPS navigation may still be committing Chromium's internal error page.
    const allowedPage = await context.newPage();
    expect((await allowedPage.goto(`${app.origin}/login`))?.status()).toBe(200);
    expect(codes).toEqual([]);
    expect(app.hits).toHaveLength(1);
    expect(app.hits[0]?.headers).not.toHaveProperty('x-automation-session');
  });
});
