import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { layout, loginPage, searchPage } from './views.js';

export const mockFaultSchema = z.enum([
  'none', 'member_not_found', 'validation_error', 'session_expired', 'slow_load',
  'interstitial', 'permission_denied', 'app_error', 'unexpected_confirm',
]);
export type MockFault = z.infer<typeof mockFaultSchema>;

const members = new Map([
  ['12345', { id: '12345', name: 'Avery Sample', savingsCents: 123456, checkingCents: 25000 }],
  ['67890', { id: '67890', name: 'Morgan Demo', savingsCents: 987654, checkingCents: 8000 }],
]);
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const sessionCookie = 'harbor_session';
type Session = { expiresAt: number; noticeAccepted: boolean };
type AppEnv = { Variables: { session: Session; sessionId: string; generation: number } };

export function createMockApp(options: {
  credentials: { username: string; password: string };
  fault?: MockFault;
  slowLoadMs?: number;
}) {
  const { username, password } = options.credentials;
  const initialFault = mockFaultSchema.parse(options.fault ?? 'none');
  const slowLoadMs = z.number().int().min(1).max(10_000).parse(options.slowLoadMs ?? 3000);
  let fault = initialFault;
  let expiredOnce = false;
  let delayedOnce = false;
  let generation = 0;
  const sessions = new Map<string, Session>();
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('generation', generation);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'");
    const url = new URL(c.req.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return c.text('Local sandbox only.', 403);
    }
    const origin = c.req.header('origin');
    if (c.req.method === 'POST' && origin && origin !== url.origin) {
      return c.text('Cross-origin form submission denied.', 403);
    }
    await next();
  });

  // Auth/session checks apply to the iframe too; its URL is not a data API bypass.
  app.use('*', createMiddleware<AppEnv>(async (c, next) => {
    if (!c.req.path.startsWith('/members/') && c.req.path !== '/notice') {
      return next();
    }
    const id = getCookie(c, sessionCookie);
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session || session.expiresAt <= Date.now()) {
      if (id) sessions.delete(id);
      deleteCookie(c, sessionCookie, { path: '/' });
      return c.redirect('/login', 303);
    }
    c.set('session', session);
    c.set('sessionId', id);
    if (c.req.path.startsWith('/members/') && !session.noticeAccepted
      && (fault === 'interstitial' || fault === 'unexpected_confirm')) {
      return c.redirect('/notice', 303);
    }
    await next();
  }));

  app.get('/', (c) => c.redirect('/members/search', 303));
  app.get('/login', (c) => c.html(loginPage(
    c.req.query('reason') === 'expired' ? 'Session expired. Sign in again to continue.' : undefined,
  )));
  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    if (c.get('generation') !== generation) {
      return c.text('Sandbox reset. Reload the sign-in page.', 409);
    }
    if (form.username !== username || form.password !== password) {
      return c.html(loginPage('Invalid demo credentials.'), 401);
    }
    const oldId = getCookie(c, sessionCookie);
    if (oldId) sessions.delete(oldId);
    for (const [id, session] of sessions) {
      if (session.expiresAt <= Date.now()) sessions.delete(id);
    }
    const id = randomUUID();
    sessions.set(id, { expiresAt: Date.now() + 15 * 60_000, noticeAccepted: false });
    setCookie(c, sessionCookie, id, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 900 });
    return c.redirect('/members/search', 303);
  });
  app.post('/logout', (c) => {
    const id = getCookie(c, sessionCookie);
    if (id) sessions.delete(id);
    deleteCookie(c, sessionCookie, { path: '/' });
    return c.redirect('/login', 303);
  });

  app.get('/notice', (c) => {
    if (c.get('session').noticeAccepted || (fault !== 'interstitial' && fault !== 'unexpected_confirm')) {
      return c.redirect('/members/search', 303);
    }
    const known = fault === 'interstitial';
    const heading = known ? 'System notice' : 'Operator review required';
    return c.html(layout(heading, html`
      <section class="panel" role="dialog" aria-labelledby="notice-title">
        <h1 id="notice-title">${heading}</h1>
        <p>${known ? 'Scheduled maintenance is complete. Acknowledge this notice to continue.'
          : 'An unfamiliar servicing notice needs an operator to review it before continuing.'}</p>
        <p class="muted">Acknowledgement does not change any member or account data.</p>
        <form method="post" action="/notice"><button type="submit">${known ? 'OK' : 'Acknowledge notice'}</button></form>
      </section>
    `));
  });
  app.post('/notice', (c) => {
    c.get('session').noticeAccepted = true;
    return c.redirect('/members/search', 303);
  });

  app.get('/members/search', (c) => c.html(searchPage()));
  app.post('/members/search', async (c) => {
    const form = await c.req.parseBody();
    // Reset/logout can revoke a request while its form body is still arriving.
    if (c.get('generation') !== generation || sessions.get(c.get('sessionId')) !== c.get('session')
      || c.get('session').expiresAt <= Date.now()) {
      return c.redirect('/login', 303);
    }
    const memberId = form.memberId;
    if (typeof memberId !== 'string' || !/^\d{5}$/.test(memberId) || fault === 'validation_error') {
      return c.html(searchPage('Member ID must be 5 digits'), 422);
    }
    if (fault === 'session_expired' && !expiredOnce) {
      expiredOnce = true;
      sessions.delete(c.get('sessionId'));
      deleteCookie(c, sessionCookie, { path: '/' });
      return c.redirect('/login?reason=expired', 303);
    }
    if (fault === 'slow_load' && !delayedOnce) {
      delayedOnce = true;
      await new Promise((resolve) => setTimeout(resolve, slowLoadMs));
      if (sessions.get(c.get('sessionId')) !== c.get('session')) {
        return c.redirect('/login', 303);
      }
    }
    const member = fault === 'member_not_found' ? undefined : members.get(memberId);
    return c.html(member ? searchPage(undefined, member) : searchPage('No member found'));
  });

  app.get('/members/:id', (c) => {
    if (fault === 'permission_denied') {
      return c.html(layout('Permission denied', html`<h1>Permission denied</h1><p role="alert">This operator cannot view member records.</p>`), 403);
    }
    const member = members.get(c.req.param('id'));
    if (!member) return c.html(searchPage('No member found'), 404);
    return c.html(layout('Member details', html`
      <a href="/members/search">Back to member search</a>
      <h1>Member details</h1>
      <section class="panel">
        <table><tbody>
          <tr><th>Member ID</th><td>${member.id}</td></tr>
          <tr><th>Name</th><td>${member.name}</td></tr>
          <tr><th>Status</th><td>Active</td></tr>
        </tbody></table>
      </section>
      <h2>Accounts</h2>
      <iframe title="Member accounts" src="/members/${member.id}/accounts"></iframe>
      <section class="panel">
        <h2>Servicing actions</h2>
        <p class="muted">Account creation is disabled in this read-only sandbox.</p>
        <form method="post" action="/members/${member.id}/sub-accounts">
          <button class="secondary" type="submit">Open sub-account</button>
        </form>
      </section>
    `));
  });

  app.get('/members/:id/accounts', (c) => {
    if (fault === 'permission_denied') {
      return c.html(layout('Permission denied', html`<h1>Permission denied</h1>`, true), 403);
    }
    if (fault === 'app_error') {
      return c.html(layout('Account service unavailable', html`
        <h1>Account service unavailable</h1><p role="alert">Unable to load account information. Contact an operator.</p>
      `, true), 500);
    }
    const member = members.get(c.req.param('id'));
    if (!member) return c.html(layout('No member found', html`<h1>No member found</h1>`, true), 404);
    return c.html(layout('Member accounts', html`
      <h2>Account summary</h2>
      <p>Member ID: <strong>${member.id}</strong></p>
      <div class="scroll"><table>
        <thead><tr><th>Account type</th><th>Currency</th><th>Current balance</th></tr></thead>
        <tbody>
          <tr><td>Savings</td><td>USD</td><td class="amount">${dollars.format(member.savingsCents / 100)}</td></tr>
          <tr><td>Checking</td><td>USD</td><td class="amount">${dollars.format(member.checkingCents / 100)}</td></tr>
        </tbody>
      </table></div>
    `, true));
  });

  app.post('/members/:id/sub-accounts', (c) => c.html(layout('Action blocked', html`
    <h1>Account creation is disabled</h1>
    <p role="alert" class="alert">No account was created. This sandbox supports read-only servicing.</p>
    <a href="/members/search">Back to member search</a>
  `), 403));

  app.notFound((c) => c.html(layout('Page not found', html`<h1>Page not found</h1><a href="/">Return to sign in</a>`), 404));
  app.onError((_error, c) => c.html(layout('Application error', html`<h1>Application error</h1><p role="alert">The sandbox could not process this request.</p>`), 500));

  return {
    app,
    // Harness-only control: deliberately not reachable over HTTP or through agent tools.
    reset(nextFault: MockFault = initialFault) {
      fault = mockFaultSchema.parse(nextFault);
      generation++;
      sessions.clear();
      expiredOnce = false;
      delayedOnce = false;
    },
  };
}
