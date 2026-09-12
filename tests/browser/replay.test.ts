import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { expect, it, vi } from 'vitest';
import { createMockApp } from '../../mock-app/app.js';
import type { MockFault } from '../../mock-app/app.js';
import { parseReplayResult } from '../../src/artifact/result.js';
import type { ReplayResult } from '../../src/artifact/result.js';
import { EvidenceSink } from '../../src/evidence/evidence.js';
import type { SafeSnapshot } from '../../src/evidence/evidence.js';
import { loadPolicy, parsePolicy } from '../../src/policy/policy.js';
import { runReplay } from '../../src/replay/engine.js';
import { SurfaceError } from '../../src/surface/errors.js';
import { PlaywrightAdapter } from '../../src/surface/playwright-adapter.js';
import { makeArtifact } from '../fixtures/capability.js';

const credentials = { username: 'replay-synthetic-operator', password: 'replay-synthetic-password' };
const basePolicy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
// eslint-disable-next-line @typescript-eslint/unbound-method -- Originals are invoked with the live adapter instance via call.
const { act: originalAct, navigate: originalNavigate, checkCondition: originalCheckCondition, close: originalClose } = PlaywrightAdapter.prototype;

function fixture(stepTimeoutMs = 1000) {
  const artifact = makeArtifact();
  artifact.limits.stepTimeoutMs = stepTimeoutMs;
  artifact.limits.runTimeoutMs = 10_000;
  return artifact;
}

async function withSandbox(
  fault: MockFault,
  test: (context: {
    run: (overrides?: Partial<Parameters<typeof runReplay>[0]>) => Promise<ReplayResult>;
    count: (method: string, path: string) => number;
    evidence: (result: ReplayResult) => Promise<string[]>;
  }) => Promise<void>,
  options: {
    repeatExpiry?: boolean;
    respond?: (request: Request, response: Response) => Response | Promise<Response>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'harbor-replay-'));
  const sandbox = createMockApp({ credentials, fault, slowLoadMs: 50 });
  const requests = new Map<string, number>();
  let server: ReturnType<typeof serve> | undefined;
  try {
    // Count before the factory's routes, including requests that its terminal handlers reject.
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      const key = `${request.method} ${new URL(request.url).pathname}`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      if (options.repeatExpiry && key === 'POST /login') sandbox.reset('session_expired');
      const response = await sandbox.app.fetch(request);
      return options.respond ? options.respond(request, response) : response;
    } });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const policy = parsePolicy({ ...basePolicy, allowedOrigins: [origin] });
    await test({
      run: (overrides = {}) => runReplay({
        artifact: fixture(), inputs: { memberId: '12345' }, mode: 'verification',
        origin, policy, credentials, evidenceRoot: root, headless: true, ...overrides,
      }),
      count: (method, path) => requests.get(`${method} ${path}`) ?? 0,
      evidence: async (result) => {
        const directory = join(root, result.runId);
        expect((await readdir(directory)).sort()).toEqual([...result.evidence].sort());
        return Promise.all(result.evidence.map((file) => readFile(join(directory, file), 'utf8')));
      },
    });
  } finally {
    vi.restoreAllMocks();
    try {
      if (server?.listening) {
        const closing = new Promise<void>((resolve, reject) => {
          server!.close((error) => error ? reject(error) : resolve());
        });
        if ('closeAllConnections' in server) server.closeAllConnections();
        await closing;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

it.each([
  ['12345', 123456], ['67890', 987654],
] as const)('returns only validated savings outputs for member %s', async (memberId, balance) => {
  await withSandbox('none', async ({ run, count, evidence }) => {
    const artifact = fixture(5000);
    const result = await run({ artifact, inputs: { memberId } });
    expect(result).toMatchObject({ kind: 'SUCCESS', atStep: 'extract_currency', recoveries: [],
      outputs: { savingsBalanceCents: balance, currency: 'USD' } });
    expect(parseReplayResult(result, artifact)).toEqual(result);
    expect(count('POST', '/members/search')).toBe(1);
    const files = await evidence(result);
    expect(result.evidence).toContain('events.jsonl');
    for (const secret of [credentials.username, credentials.password, memberId, String(balance),
      '$1,234.56', '$9,876.54', 'USD', 'Avery Sample', 'Morgan Demo']) {
      expect(files.join('\n')).not.toContain(secret);
    }
  });
});

it.each([
  ['none', '99999', 'MEMBER_NOT_FOUND'],
  ['validation_error', '12345', 'INVALID_MEMBER_ID'],
] as const)('recognizes %s business outcomes without waiting for a missing results heading', async (fault, memberId, code) => {
  await withSandbox(fault, async ({ run, count }) => {
    const result = await run({ inputs: { memberId } });
    expect(result).toMatchObject({ kind: 'BUSINESS_OUTCOME', code, atStep: 'search', recoveries: [] });
    expect(count('POST', '/members/search')).toBe(1);
  });
});

it('reauthenticates in the owned browser and restarts entry navigation once', async () => {
  await withSandbox('session_expired', async ({ run, count }) => {
    const create = vi.spyOn(PlaywrightAdapter, 'create');
    const result = await run({ artifact: fixture(5000) });
    expect(result).toMatchObject({ kind: 'SUCCESS', outputs: { savingsBalanceCents: 123456, currency: 'USD' },
      recoveries: [{ code: 'SESSION_EXPIRED', atStep: 'search', attempt: 1, outcome: 'recovered' }] });
    expect(create).toHaveBeenCalledTimes(1);
    expect(count('POST', '/login')).toBe(2);
    expect(count('POST', '/members/search')).toBe(2);
  });
});

it('dismisses a known notice once and asserts its postcondition', async () => {
  await withSandbox('interstitial', async ({ run, count }) => {
    const result = await run({ artifact: fixture(5000) });
    expect(result).toMatchObject({ kind: 'SUCCESS', recoveries: [
      { code: 'SYSTEM_NOTICE', atStep: 'open_search', attempt: 1, outcome: 'recovered' },
    ] });
    expect(count('POST', '/notice')).toBe(1);
    expect(count('POST', '/login')).toBe(1);
    expect(count('GET', '/members/search')).toBe(3);
  });
});

it.each([1, 2])('recollects outputs when a notice replaces the page after extraction %s', async (afterExtraction) => {
  let balanceChanged = false;
  await withSandbox('none', async ({ run, count }) => {
    const artifact = fixture(5000);
    const balance = artifact.steps.find((step) => step.id === 'extract_balance')!;
    const recovery = artifact.recoveries.find((handler) => handler.code === 'SYSTEM_NOTICE')!.recovery;
    if (balance.action !== 'extract' || recovery.kind !== 'dismiss' || artifact.checkpoint.kind !== 'all') {
      throw new Error('Expected balance and notice fixture');
    }
    recovery.postcondition = { kind: 'path_equals', path: '/members/12345' };
    artifact.checkpoint.conditions.push({ kind: 'text_equals', target: balance.target,
      expected: { source: 'literal', value: '$9,876.54' } });
    let extractions = 0;
    vi.spyOn(PlaywrightAdapter.prototype, 'act').mockImplementation(async function (this: PlaywrightAdapter, ref, action, value) {
      const raw = await originalAct.call(this, ref, action, value);
      if (action === 'extract' && ++extractions === afterExtraction) {
        await this.page.goto(`${this.origin}/notice`);
      }
      return raw;
    });
    const result = await run({ artifact });
    expect(result).toMatchObject({ kind: 'SUCCESS', outputs: { savingsBalanceCents: 987654, currency: 'USD' },
      recoveries: [{ code: 'SYSTEM_NOTICE', attempt: 1, outcome: 'recovered' }] });
    expect(parseReplayResult(result, artifact)).toEqual(result);
    expect(extractions).toBe(afterExtraction + 2);
    expect(count('POST', '/notice')).toBe(1);
    expect(count('POST', '/members/search')).toBe(2);
    expect(count('POST', '/login')).toBe(1);
  }, { respond: async (request, response) => {
    const path = new URL(request.url).pathname;
    if (path === '/notice') {
      if (request.method === 'POST') {
        balanceChanged = true;
        return new Response(null, { status: 303, headers: { location: '/members/12345' } });
      }
      return new Response('<section role="dialog" aria-label="System notice"><form method="post" action="/notice"><button type="submit">OK</button></form></section>',
        { headers: { 'content-type': 'text/html' } });
    }
    if (balanceChanged && path === '/members/12345/accounts') {
      return new Response((await response.text()).replace('$1,234.56', '$9,876.54'),
        { status: response.status, headers: response.headers });
    }
    return response;
  } });
});

it.each(['action', 'navigation'] as const)('inspects a session-expiry transition after a failed %s', async (operation) => {
  await withSandbox('none', async ({ run, count }) => {
    let injected = false;
    vi.spyOn(PlaywrightAdapter.prototype, 'act').mockImplementation(async function (this: PlaywrightAdapter, ref, action, value) {
      if (operation === 'action' && !injected && action === 'click' && new URL(this.page.url()).pathname === '/members/search') {
        injected = true;
        await this.page.goto(`${this.origin}/login`);
      }
      return originalAct.call(this, ref, action, value);
    });
    vi.spyOn(PlaywrightAdapter.prototype, 'navigate').mockImplementation(async function (this: PlaywrightAdapter, path) {
      if (operation === 'navigation' && !injected && path === '/members/search') {
        injected = true;
        await originalNavigate.call(this, '/login');
        throw new SurfaceError('NAVIGATION_FAILED');
      }
      return originalNavigate.call(this, path);
    });
    expect(await run({ artifact: fixture(5000) })).toMatchObject({ kind: 'SUCCESS',
      recoveries: [{ code: 'SESSION_EXPIRED', atStep: operation === 'action' ? 'search' : 'open_search',
        attempt: 1, outcome: 'recovered' }] });
    expect(injected).toBe(true);
    expect(count('POST', '/login')).toBe(2);
    expect(count('POST', '/members/search')).toBe(1);
  });
});

it.each([
  ['member_not_found', 1, 'BUSINESS_OUTCOME', 'MEMBER_NOT_FOUND'],
  ['permission_denied', 2, 'FAILURE', 'PERMISSION_DENIED'],
] as const)('detects %s even when the triggering action rejects', async (fault, throwAt, kind, code) => {
  await withSandbox(fault, async ({ run, count }) => {
    let clicks = 0;
    vi.spyOn(PlaywrightAdapter.prototype, 'act').mockImplementation(async function (this: PlaywrightAdapter, ref, action, value) {
      const reject = action === 'click' && new URL(this.page.url()).pathname === '/members/search' && ++clicks === throwAt;
      const raw = await originalAct.call(this, ref, action, value);
      if (reject) {
        await this.page.getByText(fault === 'member_not_found' ? 'No member found' : 'Permission denied', { exact: true }).waitFor();
        throw new SurfaceError('ACTION_FAILED');
      }
      return raw;
    });
    expect(await run({ artifact: fixture(5000) })).toMatchObject({ kind, code, recoveries: [] });
    expect(count('POST', '/members/search')).toBe(1);
  });
});

it.each(['action', 'navigation'] as const)('preserves an unhandled %s error after exactly one detector pass', async (operation) => {
  await withSandbox('none', async ({ run, count }) => {
    const artifact = fixture(5000);
    const firstDetector = JSON.stringify(artifact.failures[0]!.when);
    let injected = false;
    let scans = 0;
    vi.spyOn(PlaywrightAdapter.prototype, 'checkCondition').mockImplementation(async function (this: PlaywrightAdapter, condition, inputs) {
      if (injected && JSON.stringify(condition) === firstDetector) scans++;
      return originalCheckCondition.call(this, condition, inputs);
    });
    vi.spyOn(PlaywrightAdapter.prototype, 'act').mockImplementation(async function (this: PlaywrightAdapter, ref, action, value) {
      if (operation === 'action' && action === 'click' && new URL(this.page.url()).pathname === '/members/search') {
        injected = true;
        throw new SurfaceError('ACTION_FAILED');
      }
      return originalAct.call(this, ref, action, value);
    });
    vi.spyOn(PlaywrightAdapter.prototype, 'navigate').mockImplementation(async function (this: PlaywrightAdapter, path) {
      if (operation === 'navigation' && path === '/members/search') {
        injected = true;
        throw new SurfaceError('NAVIGATION_FAILED');
      }
      return originalNavigate.call(this, path);
    });
    expect(await run({ artifact })).toMatchObject({ kind: 'FAILURE',
      code: operation === 'action' ? 'ACTION_FAILED' : 'NAVIGATION_FAILED', recoveries: [] });
    expect(scans).toBe(1);
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/login')).toBe(1);
  });
});

it.each(['POLICY_BLOCKED', 'NETWORK_ERROR', 'EVIDENCE_FAILED', 'RUN_TIMEOUT', 'STEP_TIMEOUT'])(
  'does not inspect or retry over sticky %s after an incidental action error', async (code) => {
    await withSandbox('none', async ({ run, count }) => {
      const checks = vi.spyOn(PlaywrightAdapter.prototype, 'checkCondition');
      let checksAtFailure = -1;
      vi.spyOn(PlaywrightAdapter.prototype, 'act').mockImplementation(async function (this: PlaywrightAdapter, ref, action, value) {
        if (action === 'click' && new URL(this.page.url()).pathname === '/members/search') {
          await this.page.goto(`${this.origin}/login`);
          checksAtFailure = checks.mock.calls.length;
          vi.spyOn(this, 'health').mockImplementation(() => { throw new SurfaceError(code); });
          throw new SurfaceError('STALE_REF');
        }
        return originalAct.call(this, ref, action, value);
      });
      expect(await run({ artifact: fixture(5000) })).toMatchObject({ kind: 'FAILURE', code, recoveries: [] });
      expect(checksAtFailure).toBeGreaterThan(0);
      expect(checks).toHaveBeenCalledTimes(checksAtFailure);
      expect(count('POST', '/members/search')).toBe(0);
      expect(count('POST', '/login')).toBe(1);
    });
  },
);

it.each(['step', 'run'] as const)('does not grant a fresh %s budget to post-error inspection', async (budget) => {
  await withSandbox('none', async ({ run, count }) => {
    const artifact = fixture();
    const checks = vi.spyOn(PlaywrightAdapter.prototype, 'checkCondition');
    let checksAtFailure = -1;
    vi.spyOn(PlaywrightAdapter.prototype, 'act').mockImplementation(async function (this: PlaywrightAdapter, ref, action, value) {
      if (action === 'click' && new URL(this.page.url()).pathname === '/members/search') {
        checksAtFailure = checks.mock.calls.length;
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (budget === 'step' ? artifact.limits.stepTimeoutMs : artifact.limits.runTimeoutMs) + 1);
        throw new SurfaceError('ACTION_FAILED');
      }
      return originalAct.call(this, ref, action, value);
    });
    expect(await run({ artifact })).toMatchObject({ kind: 'FAILURE',
      code: budget === 'step' ? 'STEP_TIMEOUT' : 'RUN_TIMEOUT', recoveries: [] });
    expect(checksAtFailure).toBeGreaterThan(0);
    expect(checks).toHaveBeenCalledTimes(checksAtFailure);
    expect(count('POST', '/members/search')).toBe(0);
  });
});

it('fails on an unknown notice without clicking it or inventing human intervention', async () => {
  await withSandbox('unexpected_confirm', async ({ run, count, evidence }) => {
    const result = await run();
    expect(result).toMatchObject({ kind: 'FAILURE', code: 'UNEXPECTED_DIALOG', recoveries: [] });
    expect(count('POST', '/notice')).toBe(0);
    expect(count('POST', '/members/search')).toBe(0);
    expect(result.evidence).toContain('events.jsonl');
    expect(result.evidence).toContain('snapshot_1.json');
    const files = await evidence(result);
    const snapshot = JSON.parse(files[result.evidence.indexOf('snapshot_1.json')]!) as SafeSnapshot;
    expect(snapshot.frames[0]).toMatchObject({ allowed: true, path: '/notice' });
    expect(snapshot.frames[0]?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'section', role: 'dialog', visible: true, textPresent: true }),
    ]));
    for (const secret of [credentials.username, credentials.password, '12345', 'Operator review required',
      'Acknowledge notice', 'http://', '127.0.0.1']) expect(files.join('\n')).not.toContain(secret);
  });
});

it.each([
  ['app_error', 'APP_ERROR'], ['permission_denied', 'PERMISSION_DENIED'],
] as const)('detects %s before output extraction, including iframe failures', async (fault, code) => {
  await withSandbox(fault, async ({ run, evidence }) => {
    const result = await run();
    expect(result).toMatchObject({ kind: 'FAILURE', code, recoveries: [] });
    expect(result).not.toHaveProperty('outputs');
    expect(result.evidence).toContain('snapshot_1.json');
    const files = await evidence(result);
    for (const secret of [credentials.username, credentials.password, '12345', '123456', '$1,234.56',
      'Avery Sample', 'USD', 'Account service unavailable']) expect(files.join('\n')).not.toContain(secret);
    if (fault === 'app_error') {
      const snapshot = JSON.parse(files[result.evidence.indexOf('snapshot_1.json')]!) as SafeSnapshot;
      const accounts = snapshot.frames.find((frame) => frame.path === '/members/:memberId/accounts');
      expect(accounts?.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ tag: 'h1', textPresent: true, visible: true }),
      ]));
    }
  });
});

it('waits for the mock slow response without repeating a dispatched search', async () => {
  await withSandbox('slow_load', async ({ run, count }) => {
    expect(await run({ artifact: fixture(5000) })).toMatchObject({ kind: 'SUCCESS' });
    expect(count('POST', '/members/search')).toBe(1);
  });
});

it('bounds missing-target polling and performs no substitute action', async () => {
  await withSandbox('none', async ({ run, count }) => {
    const artifact = fixture(500);
    const step = artifact.steps.find((candidate) => candidate.id === 'search')!;
    if (step.action !== 'click') throw new Error('Expected click fixture');
    step.target = { strategies: [{ kind: 'css', selector: '#missing-search-control' }] };
    expect(await run({ artifact })).toMatchObject({ kind: 'FAILURE', code: 'TARGET_NOT_FOUND', atStep: 'search' });
    expect(count('POST', '/members/search')).toBe(0);
  });
});

it('blocks a risky click mislabelled read-only before any sub-account request', async () => {
  await withSandbox('none', async ({ run, count }) => {
    const artifact = fixture();
    artifact.steps.splice(4, 0, { id: 'risky_click', action: 'click', risk: 'read_only',
      target: { strategies: [{ kind: 'role', role: 'button', name: { source: 'literal', value: 'Open sub-account' } }] },
      postcondition: { kind: 'path_equals', path: '/members/search' } });
    expect(await run({ artifact })).toMatchObject({ kind: 'FAILURE', code: 'POLICY_BLOCKED', atStep: 'risky_click' });
    expect(count('POST', '/members/12345/sub-accounts')).toBe(0);
    expect(count('GET', '/members/12345/sub-accounts')).toBe(0);
  });
});

it('fails immediately on an ambiguous target rather than choosing a button', async () => {
  await withSandbox('none', async ({ run, count }) => {
    const artifact = fixture();
    const step = artifact.steps.find((candidate) => candidate.id === 'search')!;
    if (step.action !== 'click') throw new Error('Expected click fixture');
    step.target = { strategies: [{ kind: 'css', selector: 'button' }] };
    expect(await run({ artifact })).toMatchObject({ kind: 'FAILURE', code: 'AMBIGUOUS_TARGET', atStep: 'search' });
    expect(count('POST', '/members/search')).toBe(0);
    expect(count('POST', '/logout')).toBe(0);
  });
});

it('rejects invalid inputs, artifacts, invocation modes, and auth setup before creating a browser', async () => {
  await withSandbox('none', async ({ run, count }) => {
    const create = vi.spyOn(PlaywrightAdapter, 'create');
    const wrongApp = fixture();
    wrongApp.app.appVersion = '2.0';
    for (const [overrides, code] of [
      [{ inputs: { memberId: 'bad' } }, 'INPUT_INVALID'],
      [{ artifact: {} }, 'ARTIFACT_INVALID'],
      [{ mode: 'replay' }, 'INVOCATION_INVALID'],
      [{ artifact: wrongApp }, 'INVOCATION_INVALID'],
      [{ credentials: { username: '', password: '' } }, 'AUTH_SETUP_INVALID'],
    ] as const) {
      expect(await run(overrides)).toMatchObject({ kind: 'FAILURE', code, atStep: null, recoveries: [] });
    }
    expect(create).not.toHaveBeenCalled();
    expect(count('GET', '/login')).toBe(0);
  });
});

it('returns an initial authentication failure with no current step', async () => {
  await withSandbox('none', async ({ run, count }) => {
    expect(await run({ credentials: { ...credentials, password: 'incorrect-synthetic-password' } }))
      .toMatchObject({ kind: 'FAILURE', code: 'AUTH_FAILED', atStep: null, recoveries: [] });
    expect(count('POST', '/login')).toBe(1);
    expect(count('POST', '/members/search')).toBe(0);
  });
});

it('does not invent an extra recovery attempt when a handler recurs beyond its budget', async () => {
  await withSandbox('session_expired', async ({ run, count }) => {
    const result = await run({ artifact: fixture(5000) });
    expect(result).toMatchObject({ kind: 'FAILURE', code: 'RECOVERY_EXHAUSTED', atStep: 'search',
      recoveries: [{ code: 'SESSION_EXPIRED', atStep: 'search', attempt: 1, outcome: 'recovered' }] });
    expect(count('POST', '/login')).toBe(2);
    expect(count('POST', '/members/search')).toBe(2);
  }, { repeatExpiry: true });
});

it.each(['target', 'postcondition'] as const)('records a missing recovery %s as exhausted without retrying', async (missing) => {
  await withSandbox('interstitial', async ({ run, count, evidence }) => {
    const artifact = fixture();
    const recovery = artifact.recoveries.find((handler) => handler.code === 'SYSTEM_NOTICE')!.recovery;
    if (recovery.kind !== 'dismiss') throw new Error('Expected dismissal fixture');
    if (missing === 'target') recovery.target = { strategies: [{ kind: 'css', selector: '#missing-dismissal' }] };
    else recovery.postcondition = { kind: 'path_equals', path: '/never' };
    const result = await run({ artifact });
    expect(result).toMatchObject({ kind: 'FAILURE', code: 'RECOVERY_EXHAUSTED',
      recoveries: [{ code: 'SYSTEM_NOTICE', atStep: 'open_search', attempt: 1, outcome: 'exhausted' }] });
    expect(result).toHaveProperty('expected', expect.stringContaining('SYSTEM_NOTICE'));
    const files = await evidence(result);
    const events = files[result.evidence.indexOf('events.jsonl')]!.trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(events).toContainEqual(expect.objectContaining({ type: 'recovery_finished', code: 'SYSTEM_NOTICE',
      stepId: 'open_search', attempt: 1, outcome: 'exhausted' }));
    expect(count('POST', '/notice')).toBe(missing === 'target' ? 0 : 1);
    expect(count('POST', '/members/search')).toBe(0);
  });
});

it.each(['POLICY_BLOCKED', 'NETWORK_ERROR', 'EVIDENCE_FAILED', 'RUN_TIMEOUT'])(
  'preserves %s when a recovery fails and records its terminal attempt', async (code) => {
    await withSandbox('interstitial', async ({ run, count, evidence }) => {
      vi.spyOn(PlaywrightAdapter.prototype, 'act').mockImplementation(async function (this: PlaywrightAdapter, ref, action, value) {
        if (action === 'click' && new URL(this.page.url()).pathname === '/notice') throw new SurfaceError(code);
        return originalAct.call(this, ref, action, value);
      });
      const result = await run({ artifact: fixture(5000) });
      expect(result).toMatchObject({ kind: 'FAILURE', code,
        recoveries: [{ code: 'SYSTEM_NOTICE', attempt: 1, outcome: 'exhausted' }] });
      const files = await evidence(result);
      const events = files[result.evidence.indexOf('events.jsonl')]!.trim().split('\n').map((line) => JSON.parse(line) as unknown);
      expect(events).toContainEqual(expect.objectContaining({ type: 'recovery_finished', code: 'SYSTEM_NOTICE', outcome: 'exhausted' }));
      expect(count('POST', '/notice')).toBe(0);
      expect(count('POST', '/members/search')).toBe(0);
    });
  },
);

it('does not try to finish a recovery log after evidence has become unwritable', async () => {
  await withSandbox('interstitial', async ({ run, count, evidence }) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the original sink instance via call.
    const original = EvidenceSink.prototype.event;
    const write = vi.spyOn(EvidenceSink.prototype, 'event').mockImplementation(async function (this: EvidenceSink, metadata: unknown) {
      if (typeof metadata === 'object' && metadata !== null && 'type' in metadata && metadata.type === 'action_started'
        && 'action' in metadata && metadata.action === 'click') throw new Error('synthetic-private-evidence-error');
      await original.call(this, metadata);
    });
    const result = await run({ artifact: fixture(5000) });
    expect(result).toMatchObject({ kind: 'FAILURE', code: 'EVIDENCE_FAILED',
      recoveries: [{ code: 'SYSTEM_NOTICE', attempt: 1, outcome: 'exhausted' }] });
    expect(write.mock.calls).not.toContainEqual([expect.objectContaining({ type: 'recovery_finished' })]);
    expect(count('POST', '/notice')).toBe(0);
    const files = await evidence(result);
    expect(`${JSON.stringify(result)}${files.join('\n')}`).not.toContain('synthetic-private-evidence-error');
  });
});

it.each(['none', 'member_not_found', 'permission_denied'] as const)('keeps failure evidence when cleanup rejects after %s', async (fault) => {
  await withSandbox(fault, async ({ run, evidence }) => {
    vi.spyOn(PlaywrightAdapter.prototype, 'close').mockImplementation(async function (this: PlaywrightAdapter) {
      await originalClose.call(this);
      throw new Error('synthetic-private-close-error');
    });
    const result = await run({ artifact: fixture(5000) });
    const code = fault === 'permission_denied' ? 'PERMISSION_DENIED' : 'RESOURCE_CLOSE_FAILED';
    expect(result).toMatchObject({ kind: 'FAILURE', code, evidence: ['events.jsonl', 'snapshot_1.json'] });
    expect(result).not.toHaveProperty('outputs');
    const files = await evidence(result);
    if (fault !== 'permission_denied') {
      expect(JSON.parse(files[result.evidence.indexOf('snapshot_1.json')]!) as unknown).toEqual({
        frames: [{ index: 0, allowed: false, path: '[unavailable]', nodes: [], truncated: true }],
      });
    }
    const events = files[result.evidence.indexOf('events.jsonl')]!.trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', outcome: 'FAILURE', code });
    expect(`${JSON.stringify(result)}${files.join('\n')}`).not.toContain('synthetic-private-close-error');
  });
});

it('fails closed if evidence cannot be written before an action', async () => {
  await withSandbox('none', async ({ run, count }) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the original instance via call below.
    const original = EvidenceSink.prototype.event;
    const write = vi.spyOn(EvidenceSink.prototype, 'event');
    write.mockImplementation(async function (this: EvidenceSink, metadata: unknown) {
      if (typeof metadata === 'object' && metadata !== null && 'stepId' in metadata && metadata.stepId === 'search') {
        throw new Error('synthetic-private-filesystem-error');
      }
      await original.call(this, metadata);
    });
    expect(await run()).toMatchObject({ kind: 'FAILURE', code: 'EVIDENCE_FAILED', atStep: 'search' });
    expect(count('POST', '/members/search')).toBe(0);
  });
});

it('maps extraction parser failures and final checkpoint failures to structural codes', async () => {
  await withSandbox('none', async ({ run }) => {
    const invalidOutput = fixture();
    const extraction = invalidOutput.steps.find((step) => step.action === 'extract')!;
    if (extraction.action !== 'extract') throw new Error('Expected extraction fixture');
    extraction.parser = 'integer';
    expect(await run({ artifact: invalidOutput })).toMatchObject({ kind: 'FAILURE', code: 'OUTPUT_INVALID', atStep: 'extract_balance' });
    const checkpoint = fixture(500);
    checkpoint.checkpoint = { kind: 'path_equals', path: '/never' };
    expect(await run({ artifact: checkpoint })).toMatchObject({ kind: 'FAILURE', code: 'CHECKPOINT_FAILED', atStep: 'extract_currency' });
  });
});
