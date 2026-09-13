import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { expect, it, vi } from 'vitest';
import { createMockApp } from '../../mock-app/app.js';
import type { MockFault } from '../../mock-app/app.js';
import type { ReplayResult } from '../../src/artifact/result.js';
import type { InterventionRecord } from '../../src/evidence/evidence.js';
import { InterventionBroker } from '../../src/hitl/interventions.js';
import type { InterventionView } from '../../src/hitl/interventions.js';
import { startHitlServer } from '../../src/hitl/server.js';
import { loadPolicy, parsePolicy } from '../../src/policy/policy.js';
import { runReplay } from '../../src/replay/engine.js';
import { PlaywrightAdapter } from '../../src/surface/playwright-adapter.js';
import { makeArtifact } from '../fixtures/capability.js';

const credentials = { username: 'hitl-synthetic-operator', password: 'hitl-synthetic-password' };
const basePolicy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
const originalCreate = PlaywrightAdapter.create.bind(PlaywrightAdapter);
type Operator = {
  token: string;
  api: (method: 'GET' | 'POST', path: string, body?: unknown, token?: string) => Promise<{ status: number; json: Record<string, unknown> }>;
  waitForIntervention: () => Promise<InterventionView>;
};

async function withHandoff(
  fault: MockFault,
  test: (context: {
    run: (overrides?: Partial<Parameters<typeof runReplay>[0]>, maxWaitMs?: number) => Promise<ReplayResult>;
    /** The very same page the engine drives: this is what the operator sees in the headed window. */
    page: () => Awaited<ReturnType<typeof originalCreate>>['page'];
    origin: string;
    count: (method: string, path: string) => number;
    evidence: (result: ReplayResult) => Promise<Record<string, string>>;
    operator: Operator;
  }) => Promise<void>,
  runTimeoutMs = 10_000,
) {
  const root = await mkdtemp(join(tmpdir(), 'harbor-hitl-'));
  const sandbox = createMockApp({ credentials, fault, slowLoadMs: 50 });
  const requests = new Map<string, number>();
  let adapter: Awaited<ReturnType<typeof originalCreate>> | undefined;
  vi.spyOn(PlaywrightAdapter, 'create').mockImplementation(async (options) => { adapter = await originalCreate(options); return adapter; });
  const token = InterventionBroker.generateToken();
  const broker = new InterventionBroker(token);
  const hitl = await startHitlServer({ broker });
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);
    return sandbox.app.fetch(request);
  } });
  try {
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const policy = parsePolicy({ ...basePolicy, allowedOrigins: [origin] });
    const api: Operator['api'] = async (method, path, body, bearer = token) => {
      const response = await fetch(`${hitl.origin}${path}`, {
        method, headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, json: await response.json() as Record<string, unknown> };
    };
    await test({
      run: (overrides = {}, maxWaitMs = 20_000) => {
        const artifact = makeArtifact();
        artifact.limits.stepTimeoutMs = 1000;
        artifact.limits.runTimeoutMs = runTimeoutMs;
        return runReplay({ artifact, inputs: { memberId: '12345' }, mode: 'verification', origin, policy, credentials,
          evidenceRoot: root, headless: true, hitl: { broker, maxWaitMs }, ...overrides });
      },
      page: () => { if (!adapter) throw new Error('Adapter not created yet'); return adapter.page; },
      origin,
      count: (method, path) => requests.get(`${method} ${path}`) ?? 0,
      evidence: async (result) => {
        const directory = join(root, result.runId);
        expect((await readdir(directory)).sort()).toEqual([...result.evidence].sort());
        const entries = await Promise.all(result.evidence.map(async (file): Promise<[string, string]> => [file, await readFile(join(directory, file), 'utf8')]));
        return Object.fromEntries(entries);
      },
      operator: {
        token, api,
        waitForIntervention: async () => {
          for (let attempt = 0; attempt < 200; attempt++) {
            const { json } = await api('GET', '/interventions');
            const open = (json.interventions as InterventionView[]).find((view) => view.state === 'waiting');
            if (open) return open;
            await delay(50);
          }
          throw new Error('No intervention was opened');
        },
      },
    });
  } finally {
    vi.restoreAllMocks();
    await hitl.close();
    try {
      if (server.listening) {
        const closing = new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
        if ('closeAllConnections' in server) server.closeAllConnections();
        await closing;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

const parseEvents = (text: string) => text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

it('hands the same browser session to an operator, records what they did, and resumes after validation', async () => {
  await withHandoff('unexpected_confirm', async ({ run, page, count, evidence, operator }) => {
    const pending = run();
    const intervention = await operator.waitForIntervention();
    expect(intervention).toMatchObject({ stepId: 'open_search', reason: 'UNEXPECTED_DIALOG', path: '/notice', controlOwner: 'none' });
    expect(count('POST', '/notice')).toBe(0);

    // Unauthenticated and competing operators are refused; only the claimant may resume.
    expect((await operator.api('GET', '/interventions', undefined, 'f'.repeat(48))).status).toBe(401);
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'alice', action: 'retry_step' }))
      .toMatchObject({ status: 409, json: { code: 'NOT_UNDER_HUMAN_CONTROL' } });
    expect(await operator.api('POST', `/interventions/${intervention.id}/claim`, { operatorId: 'alice' }))
      .toMatchObject({ status: 200, json: { intervention: { state: 'human_control', controlOwner: 'human', operatorId: 'alice' } } });
    expect(await operator.api('POST', `/interventions/${intervention.id}/claim`, { operatorId: 'bob' })).toMatchObject({ status: 409, json: { code: 'ALREADY_CLAIMED' } });
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'bob', action: 'retry_step' })).toMatchObject({ status: 409, json: { code: 'NOT_OWNER' } });

    // Resuming while the unknown dialog is still on screen is rejected; the human keeps control.
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'alice', action: 'retry_step' }))
      .toMatchObject({ status: 409, json: { code: 'DIALOG_STILL_PRESENT' } });
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'alice', action: 'skip_step' }))
      .toMatchObject({ status: 409, json: { code: 'DIALOG_STILL_PRESENT' } });
    expect((await operator.api('GET', '/interventions')).json).toMatchObject({ interventions: [{ state: 'human_control' }] });

    // The operator acts in the same page, through the same proxy. The automation clock is paused meanwhile:
    // this pause alone exceeds the run's whole automation budget below.
    await delay(6500);
    const live = page();
    expect(new URL(live.url()).pathname).toBe('/notice');
    await live.getByRole('button', { name: 'Acknowledge notice', exact: true }).click();
    await expect.poll(() => new URL(live.url()).pathname).toBe('/members/search');
    expect(count('POST', '/notice')).toBe(1);

    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'alice', action: 'retry_step', note: 'acknowledged the notice' }))
      .toMatchObject({ status: 200, json: { state: 'resumed' } });
    const result = await pending;
    expect(result).toMatchObject({ kind: 'SUCCESS', atStep: 'extract_currency', outputs: { savingsBalanceCents: 123456, currency: 'USD' } });
    expect(result.evidence).toEqual(['events.jsonl', 'snapshot_1.json', 'intervention_1.json']);
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'alice', action: 'abort' })).toMatchObject({ status: 409, json: { code: 'INTERVENTION_CLOSED' } });

    const files = await evidence(result);
    const events = parseEvents(files['events.jsonl']!);
    const kinds = events.map((event) => event.type);
    expect(kinds).toEqual(expect.arrayContaining(['intervention_opened', 'intervention_claimed', 'human_action', 'intervention_closed']));
    expect(kinds.indexOf('intervention_closed')).toBeLessThan(kinds.lastIndexOf('step_started'));
    expect(events.filter((event) => event.type === 'human_action')).toEqual([
      expect.objectContaining({ action: 'click', targetKey: 'operator_notice_acknowledge', outcome: 'recorded', stepId: 'open_search' }),
      expect.objectContaining({ action: 'submit', targetKey: 'operator_notice_acknowledge', outcome: 'allowed', stepId: 'open_search' }),
    ]);
    expect(events.find((event) => event.type === 'intervention_closed')).toMatchObject({ outcome: 'resumed', action: 'retry_step' });
    const record = JSON.parse(files['intervention_1.json']!) as InterventionRecord;
    expect(record).toMatchObject({ id: intervention.id, runId: result.runId, stepId: 'open_search', reason: 'UNEXPECTED_DIALOG', path: '/notice', state: 'resumed', operatorId: 'alice' });
    expect(record.transitions.map((transition) => transition.state)).toEqual(['waiting', 'human_control', 'validating', 'human_control', 'validating', 'human_control', 'validating', 'resumed']);
    expect(record.transitions.filter((transition) => transition.code).map((transition) => transition.code)).toEqual(['DIALOG_STILL_PRESENT', 'DIALOG_STILL_PRESENT']);
    expect(record.humanActions.map((action) => `${action.action}:${action.outcome}:${action.path}`)).toEqual(['click:recorded:/notice', 'submit:allowed:/notice']);
    const text = JSON.stringify(files);
    for (const value of ['12345', '123456', '1,234', 'acknowledged the notice', operator.token, ...Object.values(credentials)]) expect(text).not.toContain(value);
  }, 6000);
}, 60_000);

it('accepts skip_step only once the page proves the human completed the step', async () => {
  await withHandoff('unexpected_confirm', async ({ run, page, origin, evidence, operator }) => {
    const pending = run();
    const intervention = await operator.waitForIntervention();
    expect((await operator.api('POST', `/interventions/${intervention.id}/claim`, { operatorId: 'carol' })).status).toBe(200);
    const live = page();
    await live.getByRole('button', { name: 'Acknowledge notice', exact: true }).click();
    await expect.poll(() => new URL(live.url()).pathname).toBe('/members/search');
    // Human wandered off: the step's postcondition (Member search heading) does not hold on /login.
    await live.goto(`${origin}/login`);
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'carol', action: 'skip_step' }))
      .toMatchObject({ status: 409, json: { code: 'POSTCONDITION_NOT_MET' } });
    await live.goto(`${origin}/members/search`);
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'carol', action: 'skip_step' }))
      .toMatchObject({ status: 200, json: { state: 'resumed' } });
    const result = await pending;
    expect(result).toMatchObject({ kind: 'SUCCESS', outputs: { savingsBalanceCents: 123456, currency: 'USD' } });
    const events = parseEvents((await evidence(result))['events.jsonl']!);
    expect(events.filter((event) => event.type === 'step_finished' && event.stepId === 'open_search')).toEqual([
      expect.objectContaining({ outcome: 'human' }),
    ]);
    expect(events.filter((event) => event.type === 'action_started' && event.stepId === 'open_search')).toEqual([]);
    // Recording kept working after the human navigated between documents.
    expect(events.filter((event) => event.type === 'human_action').length).toBeGreaterThanOrEqual(2);
  });
}, 60_000);

it('blocks operator submissions the policy does not list for humans, then honours abort', async () => {
  await withHandoff('unexpected_confirm', async ({ run, page, origin, count, evidence, operator }) => {
    const pending = run();
    const intervention = await operator.waitForIntervention();
    expect((await operator.api('POST', `/interventions/${intervention.id}/claim`, { operatorId: 'dave' })).status).toBe(200);
    const live = page();
    // Reads are fine (governed by the request allowlist); a sign-in POST is not a human action.
    await live.goto(`${origin}/login`);
    await live.getByLabel('Operator ID', { exact: true }).fill('someone');
    await live.getByLabel('Password', { exact: true }).fill('secret-typed-by-human');
    const before = count('POST', '/login');
    await live.getByRole('button', { name: 'Sign in', exact: true }).click();
    await delay(500);
    expect(count('POST', '/login')).toBe(before);
    expect(new URL(live.url()).pathname).toBe('/login');
    expect(await operator.api('POST', `/interventions/${intervention.id}/resume`, { operatorId: 'dave', action: 'abort' }))
      .toMatchObject({ status: 200, json: { state: 'aborted' } });
    const result = await pending;
    expect(result).toMatchObject({ kind: 'FAILURE', code: 'ABORTED_BY_OPERATOR', atStep: 'open_search' });
    expect(count('POST', '/notice')).toBe(0);
    const files = await evidence(result);
    const events = parseEvents(files['events.jsonl']!);
    expect(events.filter((event) => event.type === 'human_action' && event.action === 'submit')).toEqual([
      expect.objectContaining({ targetKey: 'sign_in', outcome: 'blocked' }),
    ]);
    const record = JSON.parse(files['intervention_1.json']!) as InterventionRecord;
    expect(record.state).toBe('aborted');
    expect(record.humanActions.some((action) => action.action === 'submit' && action.outcome === 'blocked' && action.path === '/login')).toBe(true);
    expect(JSON.stringify(files)).not.toContain('secret-typed-by-human');
    expect(JSON.stringify(files)).not.toContain('someone');
  });
}, 60_000);

it('ends unattended runs with NEEDS_HUMAN and a persisted intervention instead of guessing', async () => {
  await withHandoff('unexpected_confirm', async ({ run, count, evidence, operator }) => {
    const result = await run({}, 1500);
    expect(result).toMatchObject({ kind: 'NEEDS_HUMAN', reason: 'UNEXPECTED_DIALOG', atStep: 'open_search' });
    if (result.kind !== 'NEEDS_HUMAN') throw new Error('unreachable');
    expect(result.interventionId).toMatch(/^iv_[a-f0-9]{32}$/);
    expect(count('POST', '/notice')).toBe(0);
    expect(count('POST', '/members/search')).toBe(0);
    const files = await evidence(result);
    expect(Object.keys(files).sort()).toEqual(['events.jsonl', 'intervention_1.json', 'snapshot_1.json']);
    const record = JSON.parse(files['intervention_1.json']!) as InterventionRecord;
    expect(record).toMatchObject({ id: result.interventionId, state: 'expired', humanActions: [] });
    expect(record.operatorId).toBeUndefined();
    expect((await operator.api('GET', '/interventions')).json).toMatchObject({ interventions: [{ id: result.interventionId, state: 'expired' }] });
    expect(await operator.api('POST', `/interventions/${result.interventionId}/claim`, { operatorId: 'erin' })).toMatchObject({ status: 409, json: { code: 'INTERVENTION_CLOSED' } });
    const finished = parseEvents(files['events.jsonl']!).at(-1);
    expect(finished).toMatchObject({ type: 'run_finished', outcome: 'NEEDS_HUMAN' });
  });
}, 60_000);