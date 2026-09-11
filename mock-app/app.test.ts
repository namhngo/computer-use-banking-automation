import { describe, expect, it, vi } from 'vitest';
import { createMockApp } from './app.js';

type Mock = ReturnType<typeof createMockApp>;
const origin = 'http://localhost:4000';
const credentials = { username: 'test-operator', password: 'test-only-password' };

function request(mock: Mock, path: string, cookie = '', fields?: Record<string, string>) {
  return mock.app.request(`${origin}${path}`, {
    method: fields ? 'POST' : 'GET',
    headers: { Cookie: cookie },
    ...(fields ? { body: new URLSearchParams(fields) } : {}),
  });
}

async function login(mock: Mock) {
  const response = await request(mock, '/login', '', credentials);
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/members/search');
  const header = response.headers.get('set-cookie');
  expect(header).toMatch(/;\s*HttpOnly\b/i);
  expect(header).toMatch(/;\s*SameSite=Strict\b/i);
  const cookie = header?.split(';')[0];
  if (!cookie) throw new Error('Login did not issue a session cookie');
  return cookie;
}

describe('Phase 1 mock banking app', () => {
  it('uses injected credentials without publishing them or accepting the former defaults', async () => {
    const mock = createMockApp({ credentials });
    const page = await request(mock, '/login');
    const html = await page.text();
    expect(html).not.toContain(credentials.username);
    expect(html).not.toContain(credentials.password);
    expect(html).not.toContain('Demo credentials:');
    const oldDefaults = await request(mock, '/login', '', { username: 'operator', password: 'demo-only' });
    expect(oldDefaults.status).toBe(401);
    const rejected = await request(mock, '/login', '', { username: credentials.username, password: 'bad' });
    const errorPage = await rejected.text();
    expect(errorPage).not.toContain(credentials.username);
    expect(errorPage).not.toContain(credentials.password);
    expect(await login(mock)).toMatch(/^harbor_session=/);
  });

  it('serves both synthetic members and never mutates balances through account creation', async () => {
    const mock = createMockApp({ credentials });
    const cookie = await login(mock);
    expect((await request(mock, '/members/search', cookie)).status).toBe(200);
    let previousAmounts: string[] = [];
    for (const [id, savings] of [['12345', '$1,234.56'], ['67890', '$9,876.54']] as const) {
      const results = await request(mock, '/members/search', cookie, { memberId: id });
      expect(results.status).toBe(200);
      expect(await results.text()).toMatch(new RegExp(`<a\\b[^>]*href=["']/members/${id}["'][^>]*>\\s*View member\\s*</a>`, 'i'));
      const detail = await request(mock, `/members/${id}`, cookie);
      expect(detail.status).toBe(200);
      expect(await detail.text()).toMatch(new RegExp(`<iframe\\b[^>]*src=["']/members/${id}/accounts["']`, 'i'));
      const accounts = await request(mock, `/members/${id}/accounts`, cookie);
      expect(accounts.status).toBe(200);
      expect(accounts.headers.get('content-type')).toContain('text/html');
      const html = await accounts.text();
      expect(html).toContain('Savings');
      expect(html).toContain(savings);
      expect(html).toContain('Checking');
      const amounts = html.match(/\$[\d,]+\.\d{2}/g) ?? [];
      expect(new Set(amounts).size).toBeGreaterThanOrEqual(2);
      expect(amounts.some((amount) => previousAmounts.includes(amount))).toBe(false);
      previousAmounts = amounts;
      const denied = await request(mock, `/members/${id}/sub-accounts`, cookie, { name: 'New savings', balance: '999999' });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toContain('Account creation is disabled');
      const after = await request(mock, `/members/${id}/accounts`, cookie);
      expect(after.status).toBe(200);
      expect((await after.text()).match(/\$[\d,]+\.\d{2}/g)).toEqual(amounts);
    }
  });

  it('rejects bad credentials and anonymous/invalid sessions, and invalidates logout cookies', async () => {
    const mock = createMockApp({ credentials });
    const invalid = await request(mock, '/login', '', { ...credentials, password: 'wrong' });
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).toContain('Invalid demo credentials.');
    for (const cookie of ['', 'harbor_session=forged']) {
      for (const path of ['/members/search', '/members/12345', '/members/12345/accounts', '/notice']) {
        const response = await request(mock, path, cookie);
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/login');
      }
    }
    const cookie = await login(mock);
    await request(mock, '/logout', cookie, {});
    const response = await request(mock, '/members/search', cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('validates IDs, handles missing members, and does not render raw injected markup', async () => {
    const mock = createMockApp({ credentials });
    const cookie = await login(mock);
    for (const memberId of ['', '1234', '123456', 'abcde', '<script>alert("x")</script>']) {
      const response = await request(mock, '/members/search', cookie, { memberId });
      expect(response.status).toBe(422);
      const html = await response.text();
      expect(html).toContain('Member ID must be 5 digits');
      expect(html).not.toContain('<script>alert("x")</script>');
    }
    const missing = await request(mock, '/members/search', cookie, { memberId: '99999' });
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain('No member found');
    expect((await request(mock, '/members/99999', cookie)).status).toBe(404);
    for (const id of ['constructor', '__proto__']) {
      expect((await request(mock, `/members/${id}`, cookie)).status).toBe(404);
      expect((await request(mock, `/members/${id}/accounts`, cookie)).status).toBe(404);
    }
  });

  it.each([
    ['member_not_found', 200], ['validation_error', 422],
  ] as const)('injects %s into valid searches', async (fault, status) => {
    const mock = createMockApp({ credentials, fault });
    const response = await request(mock, '/members/search', await login(mock), { memberId: '12345' });
    expect(response.status).toBe(status);
    const html = await response.text();
    if (fault === 'member_not_found') expect(html).toContain('No member found');
    expect(html).not.toContain('View member');
  });

  it('expires once on valid search; reset revokes sessions, rearms the startup fault, or selects none', async () => {
    const mock = createMockApp({ credentials, fault: 'session_expired' });
    for (let cycle = 0; cycle < 2; cycle++) {
      const cookie = await login(mock);
      expect((await request(mock, '/members/search', cookie, { memberId: 'bad' })).status).toBe(422);
      const expired = await request(mock, '/members/search', cookie, { memberId: '12345' });
      expect(expired.status).toBe(303);
      expect(expired.headers.get('location')).toBe('/login?reason=expired');
      expect((await request(mock, '/members/search', cookie)).headers.get('location')).toBe('/login');
      const fresh = await login(mock);
      expect((await request(mock, '/members/search', fresh, { memberId: '12345' })).status).toBe(200);
      mock.reset();
      const revoked = await request(mock, '/members/search', fresh);
      expect(revoked.status).toBe(303);
      expect(revoked.headers.get('location')).toBe('/login');
    }
    mock.reset('none');
    const clean = await request(mock, '/members/search', await login(mock), { memberId: '12345' });
    expect(clean.status).toBe(200);
    expect(await clean.text()).toContain('View member');
  });

  it('delays only the first valid search, and rearms the delay after reset', async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockApp({ credentials, fault: 'slow_load', slowLoadMs: 25 });
      for (let cycle = 0; cycle < 2; cycle++) {
        const cookie = await login(mock);
        expect((await request(mock, '/members/search', cookie, { memberId: 'bad' })).status).toBe(422);
        let settled = false;
        const pending = Promise.resolve(request(mock, '/members/search', cookie, { memberId: '12345' }))
          .then((response) => { settled = true; return response; });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(24);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect((await pending).status).toBe(200);
        expect((await request(mock, '/members/search', cookie, { memberId: '12345' })).status).toBe(200);
        mock.reset();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an in-flight login that was started before reset', async () => {
    const mock = createMockApp({ credentials });
    const pending = request(mock, '/login', '', credentials);
    mock.reset();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await request(mock, '/members/search', await login(mock))).status).toBe(200);
  });

  it('does not let an obsolete search consume the next run\'s expiry fault', async () => {
    const mock = createMockApp({ credentials });
    const cookie = await login(mock);
    const pending = request(mock, '/members/search', cookie, { memberId: '12345' });
    mock.reset('session_expired');
    const obsolete = await pending;
    expect(obsolete.status).toBe(303);
    expect(obsolete.headers.get('location')).toBe('/login');
    const fresh = await request(mock, '/members/search', await login(mock), { memberId: '12345' });
    expect(fresh.headers.get('location')).toBe('/login?reason=expired');
  });

  it('revokes pending searches on logout and expires idle sessions after 15 minutes', async () => {
    const mock = createMockApp({ credentials });
    const cookie = await login(mock);
    const pending = request(mock, '/members/search', cookie, { memberId: '12345' });
    await request(mock, '/logout', cookie, {});
    expect((await pending).headers.get('location')).toBe('/login');
    vi.useFakeTimers();
    try {
      const fresh = await login(mock);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect((await request(mock, '/members/12345/accounts', fresh)).headers.get('location')).toBe('/login');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['permission_denied', 'app_error'] as const)('scopes %s to the specified member routes', async (fault) => {
    const mock = createMockApp({ credentials, fault });
    const cookie = await login(mock);
    expect((await request(mock, '/members/search', cookie, { memberId: '12345' })).status).toBe(200);
    const detail = await request(mock, '/members/12345', cookie);
    expect(detail.status).toBe(fault === 'permission_denied' ? 403 : 200);
    if (fault === 'permission_denied') expect(await detail.text()).toContain('Permission denied');
    const accounts = await request(mock, '/members/12345/accounts', cookie);
    expect(accounts.status).toBe(fault === 'permission_denied' ? 403 : 500);
    expect(await accounts.text()).toContain(fault === 'permission_denied' ? 'Permission denied' : 'Account service unavailable');
  });

  it.each([
    ['interstitial', 'System notice'], ['unexpected_confirm', 'Operator review required'],
  ] as const)('requires a per-session acknowledgement for %s', async (fault, heading) => {
    const mock = createMockApp({ credentials, fault });
    for (let session = 0; session < 2; session++) {
      const cookie = await login(mock);
      for (const path of ['/members/search', '/members/12345', '/members/12345/accounts']) {
        const blocked = await request(mock, path, cookie);
        expect(blocked.status).toBe(303);
        expect(blocked.headers.get('location')).toBe('/notice');
      }
      const blockedPost = await request(mock, '/members/search', cookie, { memberId: '12345' });
      expect(blockedPost.status).toBe(303);
      expect(blockedPost.headers.get('location')).toBe('/notice');
      const notice = await request(mock, '/notice', cookie);
      expect(notice.status).toBe(200);
      const html = await notice.text();
      expect(html).toMatch(/role=["']dialog["']/);
      expect(html).toMatch(new RegExp(`<h[1-6]\\b[^>]*>\\s*${heading}\\s*</h[1-6]>`, 'i'));
      const accepted = await request(mock, '/notice', cookie, {});
      expect(accepted.status).toBe(303);
      expect(accepted.headers.get('location')).toBe('/members/search');
      expect((await request(mock, '/members/search', cookie, { memberId: '12345' })).status).toBe(200);
      expect((await request(mock, '/members/12345/accounts', cookie)).status).toBe(200);
      await request(mock, '/logout', cookie, {});
    }
  });

  it('enforces local hosts, same-origin POSTs, security headers, and no reset/JSON endpoints', async () => {
    const mock = createMockApp({ credentials });
    const cookie = await login(mock);
    for (const path of ['/login', '/members/search', '/notice', '/logout', '/members/12345/sub-accounts']) {
      const response = await mock.app.request(`${origin}${path}`, {
        method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' },
        body: new URLSearchParams({ ...credentials, memberId: '12345' }),
      });
      expect(response.status).toBe(403);
    }
    const sameOrigin = await mock.app.request(`${origin}/members/search`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin },
      body: new URLSearchParams({ memberId: '12345' }),
    });
    expect(sameOrigin.status).toBe(200);
    for (const host of ['example.com', 'localhost.evil.example']) {
      expect((await mock.app.request(`http://${host}/login`)).status).toBe(403);
    }
    for (const path of ['/login', '/members/search', '/members/12345/accounts', '/api/members', '/__test/reset']) {
      const response = await request(mock, path, cookie);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toBeTruthy();
      if (path.startsWith('/api/') || path.startsWith('/__test/')) expect(response.status).toBe(404);
    }
    expect((await request(mock, '/__test/reset', cookie, {})).status).toBe(404);
  });
});
