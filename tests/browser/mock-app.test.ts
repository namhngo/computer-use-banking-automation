import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createMockApp } from '../../mock-app/app.js';

let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: ReturnType<typeof serve>;
let closeResources: (() => Promise<void>) | undefined;
let sandbox: ReturnType<typeof createMockApp>;
let baseUrl: string;
const credentials = { username: 'test-operator', password: 'test-only-password' };

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
  closeResources = undefined;
  sandbox = createMockApp({ credentials, slowLoadMs: 50 });
  const localServer = serve({ fetch: sandbox.app.fetch, hostname: '127.0.0.1', port: 0 });
  server = localServer;
  let localContext: BrowserContext | undefined = undefined;
  closeResources = async () => {
    try {
      await localContext?.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        if (!localServer.listening) return resolve();
        localServer.close((error) => error ? reject(error) : resolve());
      });
    }
  };
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP port');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  context = await browser.newContext({ serviceWorkers: 'block' });
  localContext = context;
  // Keep the test self-contained; this is not the future replay policy implementation.
  await context.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl
    ? route.continue() : route.abort());
  page = await context.newPage();
});

afterEach(async () => {
  await closeResources?.();
});

afterAll(async () => {
  await browser.close();
});

async function signIn() {
  await page.goto(baseUrl);
  await page.getByRole('textbox', { name: 'Operator ID', exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function search(memberId: string) {
  await page.getByRole('textbox', { name: 'Member ID', exact: true }).fill(memberId);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}

it.each([1280, 375])('reads the correct member and savings row at viewport width %i', async (width) => {
  await page.setViewportSize({ width, height: 900 });
  await signIn();
  for (const [id, balance] of [['12345', '$1,234.56'], ['67890', '$9,876.54']] as const) {
    await search(id);
    await page.getByRole('link', { name: 'View member', exact: true }).click();
    await page.waitForURL(`${baseUrl}/members/${id}`);
    expect(await page.getByRole('row').filter({ hasText: 'Member ID' }).textContent()).toContain(id);
    const accounts = page.frameLocator('iframe[title="Member accounts"]');
    const savings = accounts.getByRole('row').filter({ hasText: 'Savings' });
    await expect.poll(() => savings.textContent()).toContain(balance);
    expect(await accounts.getByText(`Member ID: ${id}`, { exact: true }).count()).toBe(1);
    expect(await page.locator('[data-testid]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await accounts.locator('body').evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Back to member search', exact: true }).click();
  }
});

it('shows invalid credentials, validation errors, and a legitimate not-found outcome', async () => {
  await page.goto(baseUrl);
  expect(await page.content()).not.toContain(credentials.username);
  expect(await page.content()).not.toContain(credentials.password);
  await page.getByLabel('Operator ID', { exact: true }).fill(credentials.username);
  await page.getByLabel('Password', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(() => page.getByRole('alert').textContent()).toContain('Invalid demo credentials.');
  await signIn();
  await search('abc');
  await expect.poll(() => page.getByRole('alert').textContent()).toContain('Member ID must be 5 digits');
  await search('99999');
  await expect.poll(() => page.getByRole('alert').textContent()).toContain('No member found');
  expect(await page.getByRole('link', { name: 'View member' }).count()).toBe(0);
});

it('allows re-login after a one-shot session expiry in the same browser context', async () => {
  sandbox.reset('session_expired');
  await signIn();
  await search('12345');
  await page.waitForURL(`${baseUrl}/login?reason=expired`);
  expect(await page.getByRole('alert').textContent()).toContain('Session expired');
  await signIn();
  await search('12345');
  expect(await page.getByRole('link', { name: 'View member' }).count()).toBe(1);
});

it.each([
  ['interstitial', 'System notice', 'OK'],
  ['unexpected_confirm', 'Operator review required', 'Acknowledge notice'],
] as const)('renders %s and preserves the session across manual-style acknowledgement', async (fault, heading, button) => {
  sandbox.reset(fault);
  await signIn();
  const dialog = page.getByRole('dialog', { name: heading, exact: true });
  await expect.poll(() => dialog.count()).toBe(1);
  const before = (await context.cookies()).find((cookie) => cookie.name === 'harbor_session')?.value;
  expect(before).toBeTruthy();
  expect(await page.getByRole('textbox', { name: 'Member ID' }).count()).toBe(0);
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await search('12345');
  expect(await page.getByRole('link', { name: 'View member' }).count()).toBe(1);
  expect((await context.cookies()).find((cookie) => cookie.name === 'harbor_session')?.value).toBe(before);
});

it('exposes a permission denial at member detail rather than stale account data', async () => {
  sandbox.reset('permission_denied');
  await signIn();
  await search('12345');
  const [response] = await Promise.all([
    page.waitForResponse(`${baseUrl}/members/12345`),
    page.getByRole('link', { name: 'View member' }).click(),
  ]);
  expect(response.status()).toBe(403);
  expect(await page.getByRole('heading', { name: 'Permission denied', exact: true }).count()).toBe(1);
  expect(await page.locator('iframe').count()).toBe(0);
});

it('exposes the account service failure inside the iframe', async () => {
  sandbox.reset('app_error');
  await signIn();
  await search('12345');
  const [response] = await Promise.all([
    page.waitForResponse(`${baseUrl}/members/12345/accounts`),
    page.getByRole('link', { name: 'View member' }).click(),
  ]);
  expect(response.status()).toBe(500);
  const accounts = page.frameLocator('iframe[title="Member accounts"]');
  await expect.poll(() => accounts.getByRole('heading', { name: 'Account service unavailable' }).count()).toBe(1);
  expect(await accounts.getByRole('row').count()).toBe(0);
});

it.each([
  ['member_not_found', 'No member found'],
  ['validation_error', 'Member ID must be 5 digits'],
] as const)('shows injected %s for valid inputs', async (fault, message) => {
  sandbox.reset(fault);
  await signIn();
  await search('12345');
  await expect.poll(() => page.getByRole('alert').textContent()).toContain(message);
});

it('waits for a delayed search response without requiring a second submission', async () => {
  sandbox.reset('slow_load');
  await signIn();
  await search('12345');
  await page.getByRole('link', { name: 'View member' }).click();
  await page.waitForURL(`${baseUrl}/members/12345`);
});

it('blocks account creation and invalidates the existing browser session on reset', async () => {
  await signIn();
  await search('12345');
  await page.getByRole('link', { name: 'View member' }).click();
  const [response] = await Promise.all([
    page.waitForResponse(`${baseUrl}/members/12345/sub-accounts`),
    page.getByRole('button', { name: 'Open sub-account' }).click(),
  ]);
  expect(response.status()).toBe(403);
  expect(await page.getByRole('heading', { name: 'Account creation is disabled' }).count()).toBe(1);
  sandbox.reset();
  await page.goto(`${baseUrl}/members/12345/accounts`);
  await page.waitForURL(`${baseUrl}/login`);
  await signIn();
  await search('12345');
  await page.getByRole('link', { name: 'View member' }).click();
  const accounts = page.frameLocator('iframe[title="Member accounts"]');
  await expect.poll(() => accounts.getByRole('row').filter({ hasText: 'Savings' }).textContent()).toContain('$1,234.56');
});
