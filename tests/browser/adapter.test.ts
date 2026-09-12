import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { expect, it } from 'vitest';
import { createMockApp } from '../../mock-app/app.js';
import type { Target } from '../../src/artifact/schema.js';
import { EvidenceSink } from '../../src/evidence/evidence.js';
import { loadPolicy, parsePolicy } from '../../src/policy/policy.js';
import { PlaywrightAdapter } from '../../src/surface/playwright-adapter.js';
import type { SurfaceEvent } from '../../src/surface/playwright-adapter.js';

const credentials = { username: 'adapter-synthetic-operator', password: 'adapter-synthetic-password' };
const basePolicy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
const memberInput: Target = { strategies: [{ kind: 'label', text: { source: 'literal', value: 'Member ID' } }] };
const searchButton: Target = { strategies: [{ kind: 'role', role: 'button', name: { source: 'literal', value: 'Search' } }] };
const accountsScope: NonNullable<Target['scope']> = {
  frames: [{ kind: 'css', selector: 'iframe[title="Member accounts"]' }],
  container: { kind: 'css', selector: 'table' },
};

async function withAdapter(
  test: (fixture: {
    adapter: PlaywrightAdapter;
    count: (method: string, path: string) => number;
    events: SurfaceEvent[];
    deadline: number;
    releaseSearch: () => void;
  }) => Promise<void>,
  options: {
    authenticate?: boolean;
    holdSearch?: boolean;
    fault?: 'interstitial';
    connectSrc?: string;
    onEvent?: (event: SurfaceEvent) => Promise<void>;
  } = {},
) {
  const sandbox = createMockApp({ credentials, ...(options.fault ? { fault: options.fault } : {}) });
  const requests = new Map<string, number>();
  const events: SurfaceEvent[] = [];
  let releaseSearch = () => {};
  const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
  let server: ReturnType<typeof serve> | undefined;
  let adapter: PlaywrightAdapter | undefined;
  try {
    // Count upstream arrivals, even if a terminal mock-app handler rejects them.
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      const key = `${request.method} ${new URL(request.url).pathname}`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      if (options.holdSearch && key === 'POST /members/search') await searchGate;
      const response = await sandbox.app.fetch(request);
      if (options.connectSrc) {
        // Permit the synthetic fetch under test without relaxing the other mock CSP directives.
        response.headers.set('Content-Security-Policy',
          `${response.headers.get('Content-Security-Policy') ?? ''}; connect-src ${options.connectSrc}`);
      }
      return response;
    } });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const policy = parsePolicy({ ...basePolicy, allowedOrigins: [origin] });
    const deadline = Date.now() + 10_000;
    adapter = await PlaywrightAdapter.create({
      origin, policy, deadline, timeoutMs: 2000, headless: true,
      onEvent: async (event) => { events.push(event); await options.onEvent?.(event); },
    });
    if (options.authenticate !== false) {
      await adapter.authenticate(credentials);
      expect(adapter.page.url()).toBe(`${origin}${options.fault ? '/notice' : '/members/search'}`);
    }
    await test({ adapter, events, deadline, releaseSearch,
      count: (method, path) => requests.get(`${method} ${path}`) ?? 0 });
  } finally {
    releaseSearch();
    try { await adapter?.close(); } finally {
      if (server?.listening) {
        const closing = new Promise<void>((resolve, reject) => {
          server!.close((error) => error ? reject(error) : resolve());
        });
        if ('closeAllConnections' in server) server.closeAllConnections();
        await closing;
      }
    }
  }
}

it('uses the first matching fallback and reports its zero-based strategy index', async () => {
  await withAdapter(async ({ adapter, events }) => {
    const resolved = await adapter.resolve({ strategies: [
      { kind: 'css', selector: '#missing-member-input' },
      ...memberInput.strategies,
      { kind: 'css', selector: 'input' },
    ] }, {});
    expect(resolved.strategyIndex).toBe(1);
    await adapter.act(resolved.ref, 'fill', '12345');
    expect(await adapter.page.getByLabel('Member ID', { exact: true }).inputValue()).toBe('12345');
    expect(events.at(-1)).toEqual({ type: 'action_authorized', action: 'fill', targetKey: 'member_id', strategyIndex: 1 });
  });
});

it('rejects an ambiguous primary instead of falling through to a unique Search button', async () => {
  await withAdapter(async ({ adapter, count, events }) => {
    expect(await adapter.page.locator('button').count()).toBe(2);
    expect(await adapter.page.getByRole('button', { name: 'Search', exact: true }).count()).toBe(1);
    const before = events.length;
    await expect(adapter.resolve({ strategies: [
      { kind: 'css', selector: 'button' }, ...searchButton.strategies,
    ] }, {})).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
    expect(events).toHaveLength(before);
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/logout')).toBe(0);
  });
});

it('extracts a Savings table cell by header and one-based numeric column inside the accounts iframe', async () => {
  await withAdapter(async ({ adapter }) => {
    await adapter.navigate('/members/12345');
    await adapter.page.frameLocator('iframe[title="Member accounts"]').getByRole('table').waitFor();
    for (const column of [{ source: 'literal', value: 'Current balance' } as const, 3]) {
      const resolved = await adapter.resolve({ scope: accountsScope, strategies: [
        { kind: 'table_cell', row: { source: 'literal', value: 'Savings' }, column },
      ] }, {});
      expect(resolved.strategyIndex).toBe(0);
      expect(await adapter.act(resolved.ref, 'extract')).toBe('$1,234.56');
    }
  });
});

it('rejects duplicate Savings rows rather than extracting an arbitrary balance', async () => {
  await withAdapter(async ({ adapter }) => {
    await adapter.navigate('/members/12345');
    const table = adapter.page.frameLocator('iframe[title="Member accounts"]').getByRole('table');
    await table.waitFor();
    await table.evaluate((element) => {
      const row = element.querySelector('tbody tr');
      if (!row) throw new Error('Missing Savings row');
      row.after(row.cloneNode(true));
    });
    await expect(adapter.resolve({ scope: accountsScope, strategies: [
      { kind: 'table_cell', row: { source: 'literal', value: 'Savings' }, column: 3 },
      { kind: 'css', selector: 'tbody tr:first-child td.amount' },
    ] }, {})).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
  });
});

it('observes real unique refs that can fill a live input without exposing its value', async () => {
  await withAdapter(async ({ adapter }) => {
    const observation = await adapter.observe();
    expect(observation.controls.length).toBeGreaterThan(0);
    expect(new Set(observation.controls.map((control) => control.ref)).size).toBe(observation.controls.length);
    const input = observation.controls.find((control) => control.tag === 'input' && control.label === 'Member ID');
    expect(input).toBeDefined();
    expect(input!.ref).toMatch(new RegExp(`^e${observation.generation}_\\d+$`));
    await adapter.act(input!.ref, 'fill', '12345');
    expect(await adapter.page.getByLabel('Member ID', { exact: true }).inputValue()).toBe('12345');
    const next = await adapter.observe();
    expect(next.generation).toBeGreaterThan(observation.generation);
    expect(next.controls.find((control) => control.label === 'Member ID')).toMatchObject({ text: '' });
    expect(JSON.stringify(next)).not.toContain('12345');
  });
});

it('rejects old refs after another observation, navigation, DOM replacement, or form attribute mutation', async () => {
  await withAdapter(async ({ adapter, count }) => {
    for (const change of ['observe', 'navigate', 'detach', 'form-attribute'] as const) {
      await adapter.navigate('/members/search');
      const observation = await adapter.observe();
      const input = observation.controls.find((control) => control.label === 'Member ID');
      expect(input).toBeDefined();
      if (change === 'observe') await adapter.observe();
      if (change === 'navigate') await adapter.navigate('/members/search');
      if (change === 'detach') await adapter.page.getByLabel('Member ID', { exact: true }).evaluate((element) => {
        element.replaceWith(element.cloneNode(true));
      });
      if (change === 'form-attribute') await adapter.page.locator('form[action="/members/search"]').evaluate((element) => {
        element.setAttribute('action', '/members/12345/sub-accounts');
      });
      await expect(adapter.act(input!.ref, 'fill', '67890'), change).rejects.toMatchObject({ code: 'STALE_REF' });
      expect(await adapter.page.getByLabel('Member ID', { exact: true }).inputValue()).toBe('');
    }
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/members/12345/sub-accounts')).toBe(0);
  });
});

it('blocks a fake Search submitter with a dangerous destination before authorization or any upstream POST', async () => {
  await withAdapter(async ({ adapter, count, events }) => {
    await adapter.page.locator('form[action="/members/search"]').evaluate((element) => {
      element.remove();
      const form = document.createElement('form');
      form.method = 'post';
      form.action = '/members/12345/sub-accounts';
      const input = document.createElement('input');
      input.name = 'memberId';
      input.value = '12345';
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = 'Search';
      form.append(input, button);
      document.querySelector('main')!.append(form);
    });
    const resolved = await adapter.resolve(searchButton, {});
    const before = events.length;
    await expect(adapter.act(resolved.ref, 'click')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(events).toHaveLength(before);
    await expect.poll(() => adapter.page.isClosed()).toBe(true);
    expect(count('POST', '/members/12345/sub-accounts')).toBe(0);
    expect(count('GET', '/members/12345/sub-accounts')).toBe(0);
    expect(count('POST', '/members/search')).toBe(0);
  });
});

it('blocks forbidden paths and raw absolute, javascript, and data navigation URLs', async () => {
  for (const badPath of ['/members/12345/sub-accounts', 'absolute',
    'javascript:document.body.dataset.executed="yes"', 'data:text/html,synthetic-private-page']) {
    await withAdapter(async ({ adapter, count, events }) => {
      const before = events.length;
      const context = adapter.page.context();
      let contextClosed = false;
      context.once('close', () => { contextClosed = true; });
      const path = badPath === 'absolute' ? `${adapter.origin}/members/search` : badPath;
      await expect(adapter.navigate(path), path).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
      await expect.poll(() => contextClosed).toBe(true);
      expect(adapter.page.isClosed()).toBe(true);
      expect(context.pages()).toHaveLength(0);
      expect(events).toHaveLength(before);
      expect(count('GET', '/members/12345/sub-accounts')).toBe(0);
      expect(count('POST', '/members/12345/sub-accounts')).toBe(0);
      expect(count('GET', '/members/search')).toBe(1);
      expect(count('POST', '/members/search')).toBe(0);
    });
  }
});

it('allows filling the genuine password control but never authorizes its extraction', async () => {
  await withAdapter(async ({ adapter, count, events }) => {
    await adapter.navigate('/login');
    const target: Target = { strategies: [{ kind: 'label', text: { source: 'literal', value: 'Password' } }] };
    await adapter.act((await adapter.resolve(target, {})).ref, 'fill', credentials.password);
    expect(await adapter.page.getByLabel('Password', { exact: true }).inputValue()).toBe(credentials.password);
    const resolved = await adapter.resolve(target, {});
    const before = events.length;
    await expect(adapter.act(resolved.ref, 'extract')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(events).toHaveLength(before);
    expect(count('POST', '/login')).toBe(1);
  });
});

it('automatically cancels an unknown native confirm and reports UNEXPECTED_DIALOG', async () => {
  await withAdapter(async ({ adapter, count }) => {
    const context = adapter.page.context();
    let contextClosed = false;
    context.once('close', () => { contextClosed = true; });
    await adapter.page.getByRole('button', { name: 'Search', exact: true }).evaluate((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        if (window.confirm('Synthetic unknown confirmation')) {
          document.querySelector<HTMLFormElement>('form[action="/logout"]')?.requestSubmit();
        }
      });
    });
    const resolved = await adapter.resolve(searchButton, {});
    await expect(adapter.act(resolved.ref, 'click')).rejects.toMatchObject({ code: 'UNEXPECTED_DIALOG' });
    await expect.poll(() => contextClosed).toBe(true);
    expect(adapter.page.isClosed()).toBe(true);
    expect(context.pages()).toHaveLength(0);
    expect(() => adapter.health()).toThrow(expect.objectContaining({ code: 'UNEXPECTED_DIALOG' }));
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/logout')).toBe(0);
  });
});

it('revokes an action paused at authorization when a network violation closes the context', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withAdapter(async ({ adapter, count, events }) => {
    await adapter.act((await adapter.resolve(memberInput, {})).ref, 'fill', '12345');
    const resolved = await adapter.resolve(searchButton, {});
    const context = adapter.page.context();
    let contextClosed = false;
    context.once('close', () => { contextClosed = true; });
    const pending = adapter.act(resolved.ref, 'click').then(
      () => ({ code: 'ACTION_COMPLETED' }), (error: unknown) => error,
    );
    try {
      await expect.poll(() => events.some((event) => event.targetKey === 'search_member')).toBe(true);
      expect(count('POST', '/members/search')).toBe(0);
      // The mock CSP permits same-origin frames, so this reaches the proxy rather than being stopped by CSP.
      await adapter.page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.src = '/members/12345/sub-accounts';
        document.body.append(frame);
      }).catch(() => {});
      await expect.poll(() => contextClosed).toBe(true);
      expect(() => adapter.health()).toThrow(expect.objectContaining({ code: 'POLICY_BLOCKED' }));
    } finally { release(); }
    expect(await pending).toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(context.pages()).toHaveLength(0);
    await expect(adapter.act(resolved.ref, 'click')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(count('GET', '/members/12345/sub-accounts')).toBe(0);
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/logout')).toBe(0);
  }, { onEvent: (event) => event.targetKey === 'search_member' ? gate : Promise.resolve() });
});

it('makes a controlled-page HTTPS fetch fatal even though the proxy silently denies unmarked CONNECT', async () => {
  await withAdapter(async ({ adapter, count }) => {
    // Obtain an unused loopback port, then close it: no HTTPS service or external domain is involved.
    const unused = createServer();
    unused.listen(0, '127.0.0.1');
    await once(unused, 'listening');
    const address = unused.address();
    await new Promise<void>((resolve, reject) => unused.close((error) => error ? reject(error) : resolve()));
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral loopback port.');
    const target = `https://127.0.0.1:${String(address.port)}/login`;
    const context = adapter.page.context();
    const observed: string[] = [];
    context.on('request', (request) => {
      if (request.url() === target) observed.push(`${request.method()} ${request.resourceType()}`);
    });
    let contextClosed = false;
    context.once('close', () => { contextClosed = true; });
    await adapter.page.evaluate((url) => { void fetch(url).catch(() => {}); }, target).catch(() => {});
    await expect.poll(() => observed).toEqual(['GET fetch']);
    await expect.poll(() => contextClosed).toBe(true);
    expect(() => adapter.health()).toThrow(expect.objectContaining({ code: 'POLICY_BLOCKED' }));
    expect(adapter.page.isClosed()).toBe(true);
    expect(context.pages()).toHaveLength(0);
    expect(count('GET', '/members/search')).toBe(1);
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/logout')).toBe(0);
    await expect(adapter.navigate('/members/search')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  }, { connectSrc: 'https://127.0.0.1:*' });
});

it.each(['absent', 'wrong'] as const)('makes a controlled-page request with an %s session marker fatal via the denied response', async (marker) => {
  await withAdapter(async ({ adapter, count }) => {
    const context = adapter.page.context();
    await context.setExtraHTTPHeaders(marker === 'absent' ? {} : { 'x-automation-session': 'wrong-synthetic-marker' });
    const target = `${adapter.origin}/members/search`;
    const denied: Array<{ status: number; marker: string | undefined }> = [];
    context.on('response', (response) => {
      if (response.url() === target) denied.push({ status: response.status(), marker: response.headers()['x-automation-denied'] });
    });
    let contextClosed = false;
    context.once('close', () => { contextClosed = true; });
    await adapter.page.evaluate(() => { void fetch('/members/search').catch(() => {}); }).catch(() => {});
    await expect.poll(() => denied).toEqual([{ status: 403, marker: '1' }]);
    await expect.poll(() => contextClosed).toBe(true);
    expect(() => adapter.health()).toThrow(expect.objectContaining({ code: 'POLICY_BLOCKED' }));
    expect(adapter.page.isClosed()).toBe(true);
    expect(context.pages()).toHaveLength(0);
    // The request's URL and method are allowed; only the response monitor can flag this marker denial.
    expect(count('GET', '/members/search')).toBe(1);
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/logout')).toBe(0);
  }, { connectSrc: "'self'" });
});

it('does not submit a changed form after an awaited authorization callback', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withAdapter(async ({ adapter, count, events }) => {
    await adapter.act((await adapter.resolve(memberInput, {})).ref, 'fill', '12345');
    const resolved = await adapter.resolve(searchButton, {});
    const pending = adapter.act(resolved.ref, 'click').then(
      () => ({ code: 'ACTION_COMPLETED' }), (error: unknown) => error,
    );
    try {
      await expect.poll(() => events.some((event) => event.targetKey === 'search_member')).toBe(true);
      await adapter.page.locator('form[action="/members/search"]').evaluate((element) => {
        element.setAttribute('action', '/logout');
        element.querySelector('button')!.textContent = 'Unclassified action';
      });
    } finally { release(); }
    expect(await pending).toHaveProperty('code', expect.stringMatching(/^(STALE_REF|POLICY_BLOCKED)$/));
    expect(events.filter((event) => event.action === 'click' && event.targetKey !== 'sign_in'))
      .toEqual([{ type: 'action_authorized', action: 'click', targetKey: 'search_member', strategyIndex: 0 }]);
    expect(count('POST', '/logout')).toBe(0);
    expect(count('POST', '/members/search')).toBe(0);
  }, { onEvent: (event) => event.targetKey === 'search_member' ? gate : Promise.resolve() });
});

it('does not click a known notice whose ancestor identity changes during authorization', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withAdapter(async ({ adapter, count, events }) => {
    const dialog = adapter.page.getByRole('dialog', { name: 'System notice', exact: true });
    await dialog.evaluate((element) => {
      element.removeAttribute('aria-labelledby');
      element.setAttribute('aria-label', 'System notice');
    });
    const target: Target = { strategies: [{ kind: 'role', role: 'button', name: { source: 'literal', value: 'OK' } }] };
    const resolved = await adapter.resolve(target, {});
    const formBefore = await dialog.locator('form').evaluate((element) => element.outerHTML);
    const pending = adapter.act(resolved.ref, 'click').then(
      () => ({ code: 'ACTION_COMPLETED' }), (error: unknown) => error,
    );
    try {
      await expect.poll(() => events.some((event) => event.targetKey === 'system_notice_ok')).toBe(true);
      await dialog.evaluate((element) => element.setAttribute('aria-label', 'Unknown confirmation'));
      expect(await adapter.page.locator('form[action="/notice"]').evaluate((element) => element.outerHTML)).toBe(formBefore);
    } finally { release(); }
    expect(await pending).toHaveProperty('code', expect.stringMatching(/^(STALE_REF|UNEXPECTED_DIALOG|POLICY_BLOCKED)$/));
    expect(count('POST', '/notice')).toBe(0);
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/logout')).toBe(0);
  }, { fault: 'interstitial', onEvent: (event) => event.targetKey === 'system_notice_ok' ? gate : Promise.resolve() });
});

it('requires a fresh target after a disabled Search becomes ready and submits it exactly once', async () => {
  await withAdapter(async ({ adapter, count, events }) => {
    await adapter.act((await adapter.resolve(memberInput, {})).ref, 'fill', '12345');
    const button = adapter.page.getByRole('button', { name: 'Search', exact: true });
    const old = await adapter.resolve(searchButton, {});
    await button.evaluate((element) => { (element as HTMLButtonElement).disabled = true; });
    await expect(adapter.resolve(searchButton, {})).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    await expect(adapter.act(old.ref, 'click')).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(events.some((event) => event.targetKey === 'search_member')).toBe(false);
    expect(count('POST', '/members/search')).toBe(0);
    await button.evaluate((element) => { (element as HTMLButtonElement).disabled = false; });
    const fresh = await adapter.resolve(searchButton, {});
    expect(fresh.ref).not.toBe(old.ref);
    await adapter.act(fresh.ref, 'click');
    expect(count('POST', '/members/search')).toBe(1);
    expect(count('POST', '/logout')).toBe(0);
    expect(await adapter.page.getByRole('link', { name: 'View member', exact: true }).getAttribute('href')).toBe('/members/12345');
    expect(events.filter((event) => event.targetKey === 'search_member')).toHaveLength(1);
    await expect(adapter.act(fresh.ref, 'click')).rejects.toMatchObject({ code: 'STALE_REF' });
    expect(count('POST', '/members/search')).toBe(1);
  });
});

it('returns only schema-safe snapshot metadata without raw text, credentials, member values, or custom roles', async () => {
  await withAdapter(async ({ adapter }) => {
    const root = await mkdtemp(join(tmpdir(), 'harbor-adapter-'));
    let sink: EvidenceSink | undefined;
    try {
      // No sensitiveValues: the adapter output must be safe before sink redaction.
      sink = await EvidenceSink.create({ root, runId: 'adapter-snapshot' });
      await adapter.navigate('/login');
      for (const [label, value] of [['Operator ID', credentials.username], ['Password', credentials.password]] as const) {
        const resolved = await adapter.resolve({ strategies: [{ kind: 'label', text: { source: 'literal', value: label } }] }, {});
        await adapter.act(resolved.ref, 'fill', value);
      }
      const observation = await adapter.observe();
      expect(JSON.stringify(observation)).not.toContain(credentials.username);
      expect(JSON.stringify(observation)).not.toContain(credentials.password);
      const login = await adapter.snapshot();
      expect(login.frames[0]?.nodes.filter((node) => node.tag === 'input' && node.valuePresent)).toHaveLength(2);
      await adapter.navigate('/members/12345');
      await adapter.page.frameLocator('iframe[title="Member accounts"]').getByRole('table').waitFor();
      await adapter.page.evaluate(() => {
        const element = document.createElement('private-account-secret');
        element.setAttribute('role', 'custom-role-secret');
        element.textContent = 'raw-text-secret';
        const input = document.createElement('input');
        input.value = 'member-input-secret';
        document.querySelector('main')!.append(element, input);
      });
      const runtime = await adapter.observe();
      expect(runtime.controls.some((control) => control.text === 'Avery Sample')).toBe(true);
      const balance = runtime.controls.find((control) => control.text === '$1,234.56');
      expect(balance?.target.scope?.frames).toMatchObject([{ kind: 'css' }]);
      expect(balance?.target.strategies).toEqual([{ kind: 'table_cell', row: { source: 'literal', value: 'Savings' },
        column: { source: 'literal', value: 'Current balance' } }]);
      expect(JSON.stringify(balance!.target)).not.toContain('$1,234.56');
      expect(await adapter.checkCondition({ kind: 'visible', target: balance!.target }, {})).toBe(true);
      expect(await adapter.act(balance!.ref, 'extract')).toBe('$1,234.56');
      expect(JSON.stringify(runtime)).not.toContain('member-input-secret');
      const member = await adapter.snapshot();
      expect(member.frames.map((frame) => frame.path)).toEqual(['/members/:memberId', '/members/:memberId/accounts']);
      expect(member.frames[0]?.nodes).toContainEqual({
        tag: 'other', role: 'other', visible: true, childCount: 0, textPresent: true, valuePresent: false,
      });
      for (const snapshot of [login, member]) {
        expect(Object.keys(snapshot)).toEqual(['frames']);
        for (const frame of snapshot.frames) {
          expect(Object.keys(frame).sort()).toEqual(['allowed', 'index', 'nodes', 'path', 'truncated']);
          expect(frame.allowed).toBe(true);
          expect(frame.nodes.length).toBeGreaterThan(0);
          for (const node of frame.nodes) {
            expect(Object.keys(node).sort()).toEqual(['childCount', 'role', 'tag', 'textPresent', 'valuePresent', 'visible']);
          }
        }
        const serialized = JSON.stringify(snapshot);
        for (const secret of [credentials.username, credentials.password, '12345', 'Avery Sample', '$1,234.56',
          'USD', 'raw-text-secret', 'custom-role-secret', 'private-account-secret', 'member-input-secret', adapter.origin]) {
          expect(serialized).not.toContain(secret);
        }
        const filename = await sink.snapshot(snapshot);
        expect(JSON.parse(await readFile(join(sink.directory, filename), 'utf8'))).toEqual(snapshot);
      }
    } finally {
      try { await sink?.close(); } finally { await rm(root, { recursive: true, force: true }); }
    }
  });
});

it('blocks extraction when the accounts iframe belongs to a different member than its parent', async () => {
  await withAdapter(async ({ adapter, events }) => {
    await adapter.navigate('/members/12345');
    await adapter.page.frameLocator('iframe[title="Member accounts"]').getByRole('table').waitFor();
    await adapter.page.locator('iframe[title="Member accounts"]').evaluate((element) => {
      element.setAttribute('src', '/members/67890/accounts');
    });
    await adapter.page.frameLocator('iframe[title="Member accounts"]').getByText('$9,876.54', { exact: true }).waitFor();
    expect(adapter.page.url()).toBe(`${adapter.origin}/members/12345`);
    const resolved = await adapter.resolve({ scope: accountsScope, strategies: [
      { kind: 'table_cell', row: { source: 'literal', value: 'Savings' }, column: 3 },
    ] }, {});
    const before = events.length;
    await expect(adapter.act(resolved.ref, 'extract')).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(events).toHaveLength(before);
  });
});

it('rejects invalid credentials without entering the authenticated member surface', async () => {
  await withAdapter(async ({ adapter, count }) => {
    await expect(adapter.authenticate({ ...credentials, password: 'incorrect-synthetic-password' }))
      .rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(adapter.page.url()).toBe(`${adapter.origin}/login`);
    expect(count('POST', '/login')).toBe(1);
    expect(count('GET', '/members/search')).toBe(0);
  }, { authenticate: false });
});

it('closes the context at the deadline, aborting a dispatched action and its delayed browser continuation', async () => {
  await withAdapter(async ({ adapter, count, deadline, releaseSearch }) => {
    await adapter.act((await adapter.resolve(memberInput, {})).ref, 'fill', '12345');
    await adapter.page.getByRole('button', { name: 'Search', exact: true }).evaluate((element, expires) => {
      element.addEventListener('click', () => {
        // A pending navigation leaves the old document alive until context shutdown.
        setTimeout(() => {
          const form = document.querySelector<HTMLFormElement>('form[action="/logout"]');
          form?.requestSubmit();
        }, Math.max(0, expires + 400 - Date.now()));
      });
    }, deadline);
    const resolved = await adapter.resolve(searchButton, {});
    await delay(Math.max(0, deadline - Date.now() - 800));
    const context = adapter.page.context();
    let contextClosed = false;
    context.once('close', () => { contextClosed = true; });
    const pending = adapter.act(resolved.ref, 'click').then(
      () => ({ code: 'ACTION_COMPLETED' }),
      (error: unknown) => error,
    );
    await expect.poll(() => count('POST', '/members/search'), { timeout: 1000 }).toBe(1);
    expect(await pending).toMatchObject({ code: 'RUN_TIMEOUT' });
    await expect.poll(() => contextClosed).toBe(true);
    expect(adapter.page.isClosed()).toBe(true);
    expect(context.pages()).toHaveLength(0);
    releaseSearch();
    await delay(Math.max(0, deadline + 800 - Date.now()));
    expect(count('POST', '/members/search')).toBe(1);
    expect(count('POST', '/logout')).toBe(0);
    await expect(adapter.navigate('/members/search')).rejects.toMatchObject({ code: 'RUN_TIMEOUT' });
  }, { holdSearch: true });
});
