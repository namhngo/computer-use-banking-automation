import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, it, vi } from 'vitest';
import { createMockApp, type MockFault } from '../../mock-app/app.js';
import { runDiscovery } from '../../src/discovery/engine.js';
import { discoveryResultSchema, ModelCallError, transcriptSchema, type DiscoveryDecision, type DiscoveryIntent, type DiscoveryResult } from '../../src/discovery/contracts.js';
import { createDiscoveryModel, type DiscoveryModel } from '../../src/discovery/model.js';
import { EvidenceSink } from '../../src/evidence/evidence.js';
import { loadPolicy, parsePolicy } from '../../src/policy/policy.js';
import { SurfaceError } from '../../src/surface/errors.js';
import { PlaywrightAdapter } from '../../src/surface/playwright-adapter.js';

const credentials = { username: 'discovery-synthetic-operator', password: 'discovery-synthetic-password' };
const secret = 'synthetic-private-provider-key';
const basePolicy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
type Context = {
  goal: string; inputs: { memberId: string };
  observation: { path: string; controls: Array<{
    ref: string; tag: string; label: string; text: string; href: string | null;
    scope: 'main' | 'frame'; row?: string; column?: string | number;
  }> };
  actions: Array<{ tool: string; status: string; code?: string }>;
  extracted: Array<{ field: string; scope: string }>;
};
const human: DiscoveryDecision = { tool: 'request_human', input: { reason: 'ask_human', code: 'stuck' } };
const complete: DiscoveryDecision = { tool: 'complete', input: { reason: 'confirm_completion', outcome: 'success', ref: null } };
const wait: DiscoveryDecision = { tool: 'wait', input: { reason: 'wait_for_ui', ms: 50 } };
const click = (ref: string): DiscoveryDecision => ({ tool: 'click', input: { ref, reason: 'locate_record' } });

function fakeModel(choose: (context: Context, turn: number, signal: AbortSignal) => DiscoveryDecision | Promise<DiscoveryDecision>,
  intent: DiscoveryIntent = { status: 'ready', memberId: '12345' }): DiscoveryModel {
  let turn = 0;
  const reply = <T>(value: T) => ({ value, usage: { inputTokens: 10, outputTokens: 2 },
    modelId: 'actual-test-model', responseId: `test-response-${turn}` });
  return {
    source: 'test', provider: 'synthetic', modelId: 'configured-test-model', secretValues: [secret],
    intent: () => Promise.resolve(reply(intent)),
    decide: async (input, signal) => {
      const serialized = JSON.stringify(input);
      for (const forbidden of [secret, credentials.username, credentials.password, '"target"', '"strategies"',
        '"selector"', '"formValues"', '"targetKey"', 'member_identity', 'savings_balance']) {
        expect(serialized).not.toContain(forbidden);
      }
      const context = input as Context;
      expect(context.goal).toContain(context.inputs.memberId);
      expect(context.actions.length).toBeLessThanOrEqual(5);
      return reply(await choose(context, ++turn, signal));
    },
  };
}

// This explicitly test-only chooser uses fresh visible semantics, never production selectors.
function chooseRead(context: Context, reverse = false): DiscoveryDecision {
  const controls = context.observation.controls;
  const notice = controls.find((control) => control.tag === 'button' && control.text === 'OK');
  if (notice) return click(notice.ref);
  const alert = controls.find((control) => ['No member found', 'Member ID must be 5 digits'].includes(control.text));
  if (alert) return { tool: 'complete', input: { reason: 'confirm_completion', ref: alert.ref,
    outcome: alert.text === 'No member found' ? 'member_not_found' : 'invalid_member_id' } };
  const member = controls.find((control) => control.tag === 'a' && control.text === 'View member');
  if (member) return click(member.ref);
  const input = controls.find((control) => control.tag === 'input' && control.label === 'Member ID');
  if (input) {
    if (!context.actions.some((action) => action.tool === 'fill' && action.status === 'succeeded')) {
      return { tool: 'fill', input: { ref: input.ref, input: 'memberId', reason: 'enter_input' } };
    }
    return click(controls.find((control) => control.tag === 'button' && control.text === 'Search')!.ref);
  }
  const fields = [
    { field: 'memberId', scope: 'main', control: controls.find((control) => control.scope === 'main' && control.row === 'Member ID') },
    { field: 'memberId', scope: 'frame', control: controls.find((control) => control.scope === 'frame' && control.tag === 'strong' && control.text === context.inputs.memberId) },
    { field: 'savingsBalanceCents', scope: 'frame', control: controls.find((control) => control.row === 'Savings' && control.column === 'Current balance') },
    { field: 'currency', scope: 'frame', control: controls.find((control) => control.row === 'Savings' && control.column === 'Currency') },
  ] as const;
  for (const next of reverse ? [...fields].reverse() : fields) {
    if (!context.extracted.some((read) => read.field === next.field && read.scope === next.scope)) {
      return next.control ? { tool: 'extract', input: { ref: next.control.ref, field: next.field, reason: 'read_value' } } : wait;
    }
  }
  return complete;
}

it('connects the real SDK tool parser to the real browser with an explicitly test-only model', async () => {
  await withApp(async ({ run, transcript, count }) => {
    let sequence = 0;
    const sdk = new MockLanguageModelV4({
      modelId: 'test-sdk-model',
      doGenerate: (options) => {
        const message = options.prompt.findLast((entry) => entry.role === 'user');
        if (!message || message.role !== 'user') throw new Error('Expected user context');
        const text = message.content.find((entry) => entry.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Expected text context');
        const intent = options.toolChoice?.type === 'tool' && options.toolChoice.toolName === 'plan_goal';
        const choice = intent ? { tool: 'plan_goal', input: { status: 'ready', memberId: '12345' } }
          : chooseRead(JSON.parse(text.text) as Context);
        sequence++;
        return Promise.resolve({
          content: [{ type: 'tool-call', toolCallId: `call_${sequence}`, toolName: choice.tool, input: JSON.stringify(choice.input) }],
          finishReason: { unified: 'tool-calls', raw: 'completed' },
          usage: { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 7, text: 7, reasoning: 0 } },
          response: { modelId: 'test-sdk-model', id: `response_${sequence}` }, warnings: [],
        });
      },
    });
    const model = createDiscoveryModel({ model: sdk, modelId: 'test-sdk-model', provider: 'test-sdk', source: 'test' });
    const result = await run(model);
    expect(result).toMatchObject({ kind: 'SUCCESS', source: 'test', usageComplete: true,
      outputs: { savingsBalanceCents: 123456, currency: 'USD' } });
    expect(count('POST', '/members/search')).toBe(1);
    expect(sdk.doGenerateCalls.length).toBeGreaterThan(5);
    expect((await transcript(result)).calls).toHaveLength(sdk.doGenerateCalls.length);
  });
});

async function withApp(test: (fixture: {
  run: (model: DiscoveryModel, options?: Partial<Parameters<typeof runDiscovery>[0]>) => Promise<DiscoveryResult>;
  count: (method: string, path: string) => number;
  transcript: (result: DiscoveryResult) => Promise<ReturnType<typeof transcriptSchema.parse>>;
  root: string; adapters: PlaywrightAdapter[];
}) => Promise<void>, fault: MockFault = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'discovery-test-'));
  const sandbox = createMockApp({ credentials, fault });
  const requests = new Map<string, number>();
  const adapters: PlaywrightAdapter[] = [];
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);
    return sandbox.app.fetch(request);
  } });
  try {
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected ephemeral test server');
    const origin = `http://127.0.0.1:${address.port}`;
    const policy = parsePolicy({ ...basePolicy, allowedOrigins: [origin] });
    await test({ root, adapters, count: (method, path) => requests.get(`${method} ${path}`) ?? 0,
      transcript: async (result) => transcriptSchema.parse(JSON.parse(await readFile(join(root, result.runId, 'discovery.json'), 'utf8'))),
      run: async (model, options = {}) => {
        const result = await runDiscovery({ goal: 'Read savings balance and currency for member 12345.', model,
          origin, policy, credentials, headless: true, evidenceRoot: root,
          createSurface: async (configuration) => {
            const adapter = await PlaywrightAdapter.create(configuration);
            adapters.push(adapter);
            return adapter;
          }, ...options });
        expect(discoveryResultSchema.safeParse(result).success).toBe(true);
        for (const adapter of adapters) expect(adapter.page.isClosed()).toBe(true);
        return result;
      },
    });
  } finally {
    for (const adapter of adapters) await adapter.close();
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if ('closeAllConnections' in server) server.closeAllConnections();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}

it.each([
  ['12345', 123456, '$1,234.56', false], ['67890', 987654, '$9,876.54', true],
] as const)('reads %s from selected live fields in varying order, with private test evidence', async (id, cents, amount, reverse) => {
  await withApp(async ({ run, transcript, root }) => {
    const result = await run(fakeModel((context) => chooseRead(context, reverse), { status: 'ready', memberId: id }),
      { goal: `Read savings balance and currency for member ${id}.` });
    expect(result).toMatchObject({ kind: 'SUCCESS', source: 'test', usageComplete: true, outputs: { savingsBalanceCents: cents, currency: 'USD' } });
    const trace = await transcript(result);
    expect(trace.source).toBe('test');
    expect(trace.modelId).toBe('configured-test-model');
    expect(trace.calls.every((call) => call.status === 'returned' && call.usage !== null
      && call.modelId === 'actual-test-model' && call.responseId?.startsWith('test-response-'))).toBe(true);
    expect(result.usage.inputTokens).toBe(trace.calls.length * 10);
    expect(trace.records.filter((record) => record.tool === 'extract').map((record) => record.field)).toEqual(
      reverse ? ['currency', 'savingsBalanceCents', 'memberId', 'memberId'] : ['memberId', 'memberId', 'savingsBalanceCents', 'currency']);
    expect(trace.records.find((record) => record.tool === 'fill')?.value).toEqual({ source: 'input', name: 'memberId' });
    for (const filename of await readdir(join(root, result.runId))) {
      const content = await readFile(join(root, result.runId, filename), 'utf8');
      for (const privateValue of [id, String(cents), amount, credentials.username, credentials.password, secret, 'Read savings balance', '"outputs"']) {
        expect(content).not.toContain(privateValue);
      }
    }
  }, reverse ? 'interstitial' : 'none');
});

it('rejects premature completion, then lets fresh model choices supply the evidence', async () => {
  await withApp(async ({ run, transcript, adapters }) => {
    const result = await run(fakeModel(async (context, turn) => {
      const decision = turn === 1 ? complete : chooseRead(context);
      if (turn > 1 && decision.tool === 'complete') {
        await adapters[0]!.page.frameLocator('iframe').locator('tr').filter({ hasText: 'Savings' }).locator('td').nth(2)
          .evaluate((cell) => { cell.textContent = '$2,345.67'; });
      }
      return decision;
    }));
    expect(result).toMatchObject({ kind: 'SUCCESS', outputs: { savingsBalanceCents: 234567, currency: 'USD' } });
    expect((await transcript(result)).records[0]).toMatchObject({ tool: 'complete', status: 'rejected', code: 'INCOMPLETE_EVIDENCE' });
  });
});

it('requires the sole standalone goal ID to match intent, before creating any UI', async () => {
  await withApp(async ({ run, adapters, transcript }) => {
    for (const goal of ['Read savings balance.', 'Read savings for 12345 and 67890.', 'Read savings for 67890.',
      'Read savings for x12345y.', `Read savings for ${Array.from({ length: 110 }, (_, index) => 10000 + index).join(' ')}.`]) {
      const result = await run(fakeModel(() => human), { goal });
      expect(result.kind).toBe('CLARIFICATION_REQUIRED');
      expect((await transcript(result)).records).toEqual([]);
    }
    expect(adapters).toHaveLength(0);
  });
});

it('honors unsupported and clarification intent without a browser, and rejects secret goals before SDK calls', async () => {
  await withApp(async ({ run, adapters }) => {
    for (const status of ['unsupported', 'clarify'] as const) {
      const result = await run(fakeModel(() => human, { status, memberId: null }));
      expect(result.kind).toBe(status === 'unsupported' ? 'UNSUPPORTED_GOAL' : 'CLARIFICATION_REQUIRED');
    }
    const model = fakeModel(() => human);
    model.intent = () => { throw new Error('Intent must not run'); };
    expect(await run(model, { goal: `Read 12345 using ${secret}` })).toMatchObject({ code: 'UNSAFE_GOAL', usageComplete: true, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(adapters).toHaveLength(0);
  });
});

it('reparses decisions and rejects stale refs without persisting unsafe proposals', async () => {
  await withApp(async ({ run, transcript, count, adapters }) => {
    const result = await run(fakeModel((_context, turn) => turn === 1
      ? { tool: 'fill', input: { ref: 'e0_999', input: 'memberId', reason: 'enter_input', value: '67890' } } as unknown as DiscoveryDecision
      : turn === 2 ? click('e0_999') : human));
    expect(result.code).toBe('HUMAN_REQUIRED');
    const records = (await transcript(result)).records;
    expect(records[0]).toEqual({ turn: 2, tool: 'click', reason: 'locate_record', status: 'rejected', code: 'STALE_REF' });
    expect(count('POST', '/members/search')).toBe(0);
    let choices = 0;
    const uncertain = await run(fakeModel((context) => {
      choices++;
      adapters.at(-1)!.act = () => Promise.reject(new SurfaceError('ACTION_FAILED'));
      return chooseRead(context);
    }));
    expect(uncertain).toMatchObject({ kind: 'FAILURE', code: 'ACTION_FAILED' });
    expect(choices).toBe(1);
    expect((await transcript(uncertain)).records[0]).not.toHaveProperty('target');
  });
});

it('blocks dangerous model-selected clicks before any servicing POST', async () => {
  await withApp(async ({ run, count, transcript }) => {
    const result = await run(fakeModel((context) => {
      const dangerous = context.observation.controls.find((control) => control.text === 'Open sub-account' && control.tag === 'button');
      return dangerous ? click(dangerous.ref) : chooseRead(context);
    }));
    expect(result).toMatchObject({ kind: 'BLOCKED', code: 'POLICY_BLOCKED' });
    expect(count('POST', '/members/12345/sub-accounts')).toBe(0);
    expect((await transcript(result)).records.at(-1)).not.toHaveProperty('target');
  });
});

it('checks the actual submitted member before Search, without submitting an empty or different ID', async () => {
  await withApp(async ({ run, count, transcript, adapters }) => {
    const result = await run(fakeModel((context) => click(context.observation.controls.find((control) => control.text === 'Search')!.ref)));
    expect(result).toMatchObject({ kind: 'BLOCKED', code: 'DEAD_END' });
    expect(count('POST', '/members/search')).toBe(0);
    const records = (await transcript(result)).records;
    expect(records).toHaveLength(3);
    expect(records.slice(0, 2).every((record) => record.code === 'WRONG_MEMBER')).toBe(true);
    const duplicate = await run(fakeModel(async (context, turn) => {
      if (turn === 2) {
        await adapters.at(-1)!.page.getByRole('button', { name: 'Search', exact: true }).evaluate((button) => {
          button.setAttribute('name', 'memberId');
          button.setAttribute('value', '67890');
        });
        return wait;
      }
      return chooseRead(context);
    }));
    expect(duplicate.kind).not.toBe('SUCCESS');
    expect((await transcript(duplicate)).records.some((record) => record.code === 'CAPTURE_FAILED')).toBe(true);
    expect(count('POST', '/members/search')).toBe(0);
  });
});

it('blocks unknown notices before asking the model for an action', async () => {
  await withApp(async ({ run, count, transcript }) => {
    const result = await run(fakeModel(() => { throw new Error('Must not choose through an unknown dialog'); }));
    expect(result).toMatchObject({ kind: 'BLOCKED', code: 'UNEXPECTED_DIALOG' });
    expect(count('POST', '/notice')).toBe(0);
    expect((await transcript(result)).records).toEqual([]);
  }, 'unexpected_confirm');
});

it('reports human assistance without inventing an intervention or live session', async () => {
  await withApp(async ({ run, transcript }) => {
    const result = await run(fakeModel(() => human));
    expect(result).toMatchObject({ kind: 'BLOCKED', code: 'HUMAN_REQUIRED', source: 'test' });
    const text = JSON.stringify({ result, transcript: await transcript(result) });
    expect(text).not.toMatch(/interventionId|sessionId|liveSession/);
    expect(result.outputs).toBeUndefined();
  });
});

it('enforces token, step, repeated-state and runtime option bounds', async () => {
  await withApp(async ({ run, adapters, transcript }) => {
    expect(await run(fakeModel(() => human), { limits: { maxTokens: 12 } })).toMatchObject({ code: 'TOKEN_LIMIT', turns: 0 });
    for (const status of ['clarify', 'unsupported'] as const) {
      const stopped = await run(fakeModel(() => human, { status, memberId: null }), { limits: { maxTokens: 11 } });
      expect(stopped).toMatchObject({ code: 'TOKEN_LIMIT', usageComplete: true, usage: { inputTokens: 10, outputTokens: 2 } });
      expect((await transcript(stopped)).calls[0]?.status).toBe('returned');
    }
    expect(adapters).toHaveLength(0);
    expect(await run(fakeModel(() => human), { limits: { maxTokens: 24 } })).toMatchObject({ code: 'TOKEN_LIMIT', usage: { inputTokens: 20, outputTokens: 4 } });
    expect(await run(fakeModel(() => wait), { limits: { maxSteps: 2 } })).toMatchObject({ code: 'STEP_LIMIT', turns: 2 });
    expect(await run(fakeModel((_context, turn) => ({ tool: 'wait', input: { ms: 50,
      reason: turn % 2 ? 'inspect_state' : 'wait_for_ui' } })))).toMatchObject({ code: 'DEAD_END', turns: 3 });
    for (const limits of [{ maxSteps: 51 }, { maxDurationMs: 300001 }, { modelTimeoutMs: 60001 }, { maxTokens: 200001 }, { maxSteps: NaN }]) {
      expect(await run(fakeModel(() => human), { limits })).toMatchObject({ code: 'INVALID_OPTIONS' });
    }
  });
});

it('aborts SDK deadlines, ignores late model choices, and closes a late-created surface', async () => {
  await withApp(async ({ run, count, adapters, transcript }) => {
    let aborted = false;
    const result = await run(fakeModel(async (context, turn, signal) => {
      if (turn === 1) return chooseRead(context);
      signal.addEventListener('abort', () => { aborted = true; });
      await delay(150);
      return chooseRead(context);
    }), { limits: { modelTimeoutMs: 40 } });
    expect(result).toMatchObject({ code: 'MODEL_TIMEOUT', usageComplete: false, usage: { inputTokens: 20, outputTokens: 4 } });
    expect((await transcript(result)).calls.at(-1)).toEqual({ turn: 2, phase: 'action',
      modelId: 'configured-test-model', usage: null, status: 'failed' });
    expect(aborted).toBe(true);
    await delay(170);
    expect(count('POST', '/members/search')).toBe(0);
    const pendingIntent = fakeModel(() => human);
    pendingIntent.intent = async (_goal, signal) => {
      await delay(100);
      expect(signal.aborted).toBe(true);
      return { value: { status: 'ready', memberId: '12345' }, usage: { inputTokens: 10, outputTokens: 2 }, modelId: 'actual-test-model' };
    };
    expect(await run(pendingIntent, { limits: { maxDurationMs: 40 } })).toMatchObject({ code: 'RUN_TIMEOUT', turns: 0 });
    await delay(120);
    let late: PlaywrightAdapter | undefined;
    const lateResult = await run(fakeModel(() => human), {
      limits: { maxDurationMs: 500 }, createSurface: async (configuration) => {
        // Keep this browser alive past the engine deadline so its own timer cannot
        // mask a missing late-factory cleanup in the engine.
        late = await PlaywrightAdapter.create({ ...configuration, deadline: Date.now() + 10_000 });
        await delay(600);
        adapters.push(late);
        return late;
      },
    });
    expect(lateResult.code).toBe('RUN_TIMEOUT');
    await expect.poll(() => late?.page.isClosed(), { timeout: 5000 }).toBe(true);
  });
});

it('retains accounted usage on malformed replies and sanitizes client exceptions', async () => {
  await withApp(async ({ run, transcript }) => {
    const metadata = fakeModel(() => human);
    metadata.intent = () => Promise.resolve({ value: { status: 'ready', memberId: '12345' }, usage: { inputTokens: 7, outputTokens: 3 }, modelId: '' });
    const invalidMetadata = await run(metadata);
    expect(invalidMetadata).toMatchObject({ code: 'MODEL_ERROR', usageComplete: true, usage: { inputTokens: 7, outputTokens: 3 } });
    expect((await transcript(invalidMetadata)).calls[0]).toEqual({ turn: 0, phase: 'intent',
      status: 'failed', usage: { inputTokens: 7, outputTokens: 3 }, modelId: 'configured-test-model' });
    const malformed = fakeModel(() => human);
    malformed.intent = () => Promise.resolve({ value: { status: 'ready', memberId: '12345' }, modelId: 'actual-test-model' }) as never;
    const missingUsage = await run(malformed);
    expect(missingUsage).toMatchObject({ code: 'MODEL_ERROR', usageComplete: false });
    expect((await transcript(missingUsage)).calls[0]).toMatchObject({ status: 'failed', usage: null });
    const throwing = fakeModel(() => { throw new Error(`${secret} https://private.invalid/credentials`); });
    const result = await run(throwing);
    expect(result).toMatchObject({ code: 'MODEL_ERROR', usageComplete: false, usage: { inputTokens: 10, outputTokens: 2 } });
    expect((await transcript(result)).calls.at(-1)).toMatchObject({ status: 'failed', usage: null });
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const receipt of [
      { usage: { inputTokens: 7, outputTokens: 3 }, modelId: 'failed-actual-model', responseId: 'failed-response' },
      { usage: { inputTokens: 7, outputTokens: 3 } },
    ]) {
      const failed = await run(fakeModel(() => { throw new ModelCallError(receipt); }));
      expect(failed).toMatchObject({ code: 'MODEL_ERROR', usageComplete: true, usage: { inputTokens: 17, outputTokens: 5 } });
      expect((await transcript(failed)).calls.at(-1)).toEqual({ turn: 1, phase: 'action', status: 'failed',
        modelId: 'configured-test-model', ...receipt });
    }
  });
});

it('verifies business outcomes against an actual bound Search submission and refuses session recovery', async () => {
  for (const [fault, code] of [['member_not_found', 'MEMBER_NOT_FOUND'], ['validation_error', 'INVALID_MEMBER_ID'], ['session_expired', 'SESSION_REQUIRED']] as const) {
    await withApp(async ({ run, count }) => {
      const result = await run(fakeModel((context) => chooseRead(context)));
      expect(result).toMatchObject({ code, kind: fault === 'session_expired' ? 'BLOCKED' : 'BUSINESS_OUTCOME' });
      expect(result.outputs).toBeUndefined();
      expect(count('POST', '/members/search')).toBe(1);
      expect(count('POST', '/login')).toBe(1);
    }, fault);
  }
});

it('halts on pre-dispatch evidence failure and never publishes an unsafe transcript', async () => {
  await withApp(async ({ run, root, count }) => {
    const failed = await run(fakeModel(async (context) => {
      const [directory] = await readdir(root);
      await unlink(join(root, directory!, 'events.jsonl'));
      return chooseRead(context);
    }));
    expect(failed.code).toBe('EVIDENCE_ERROR');
    expect(count('POST', '/members/search')).toBe(0);
    const unsafe = fakeModel(() => human);
    const intent = unsafe.intent.bind(unsafe);
    unsafe.intent = async (...args) => ({ ...await intent(...args), responseId: 'opaque-12345' });
    const result = await run(unsafe);
    expect(result.code).toBe('TRANSCRIPT_UNSAFE');
    expect(result.evidence).not.toContain('discovery.json');
    expect(await readdir(join(root, result.runId))).not.toContain('discovery.json');
  });
});

it('redacts whole UI strings and rejects form-encoded known secrets before any API call', async () => {
  await withApp(async ({ run, adapters, transcript }) => {
    const privateValue = 'private provider + key';
    const encoded = new URLSearchParams({ value: privateValue }).toString().slice(6);
    const intent = vi.fn<DiscoveryModel['intent']>(() => { throw new Error('Must not call intent'); });
    for (const value of [privateValue, encoded, encodeURIComponent(encoded)]) {
      const result = await run({ ...fakeModel(() => human), secretValues: [privateValue], intent },
        { goal: `Read 12345 using ${value}` });
      expect(result).toMatchObject({ code: 'UNSAFE_GOAL', usageComplete: true });
      expect((await transcript(result)).calls).toEqual([]);
    }
    expect(intent).not.toHaveBeenCalled();
    expect(adapters).toHaveLength(0);
    let inspected = false;
    const result = await run({ ...fakeModel(async (context, turn) => {
      if (turn === 1) {
        await adapters[0]!.page.evaluate((text) => {
          const notice = document.createElement('p');
          notice.textContent = `prefix ${text} suffix`;
          document.querySelector('main')!.append(notice);
        }, encoded);
        return wait;
      }
      inspected = true;
      expect(context.observation.controls.some((control) => control.text === '[REDACTED]')).toBe(true);
      expect(JSON.stringify(context)).not.toMatch(/prefix|suffix|private.provider/);
      return human;
    }), secretValues: [privateValue] });
    expect(inspected).toBe(true);
    expect(result.code).toBe('HUMAN_REQUIRED');
  });
});

it('navigates only to the current path or a link still present in a fresh observation', async () => {
  for (const mode of ['unobserved', 'current', 'link', 'removed_link'] as const) {
    await withApp(async ({ run, adapters, count, transcript }) => {
      const result = await run(fakeModel(async (context, turn) => {
        if (context.actions.some((action) => action.tool === 'navigate')) return human;
        let path: string | undefined;
        if (turn === 1 && mode === 'unobserved') path = '/notice';
        if (turn === 1 && mode === 'current') path = context.observation.path;
        const back = context.observation.controls.find((control) => control.href === '/members/search');
        if (back) {
          path = back.href!;
          if (mode === 'removed_link') {
            await adapters[0]!.page.getByRole('link', { name: 'Back to member search', exact: true })
              .evaluate((link) => { link.remove(); });
          }
        }
        return path ? { tool: 'navigate', input: { path, reason: 'locate_record' } } : chooseRead(context);
      }));
      expect(result.code).toBe('HUMAN_REQUIRED');
      const record = (await transcript(result)).records.find((record) => record.tool === 'navigate');
      if (mode === 'unobserved' || mode === 'removed_link') {
        expect(record).toMatchObject({ status: 'rejected', code: 'UNOBSERVED_NAVIGATION' });
        expect(record).not.toHaveProperty('path');
        expect(count('GET', '/members/search')).toBe(1);
      } else {
        expect(record).toMatchObject({ status: 'succeeded', path: '/members/search' });
        expect(count('GET', '/members/search')).toBe(2);
      }
      expect(count('GET', '/notice')).toBe(0);
      expect(count('POST', '/notice')).toBe(0);
    });
  }
});

it('rejects completion if the UI changes after either identity was verified', async () => {
  for (const afterIdentity of [1, 2]) {
    await withApp(async ({ run, adapters, count, transcript }) => {
      const result = await run(fakeModel((context) => {
        if (context.actions.some((action) => action.code === 'STATE_CHANGED')) return human;
        const decision = chooseRead(context);
        if (decision.tool === 'complete') {
          const adapter = adapters[0]!;
          const act = adapter.act.bind(adapter);
          let identities = 0;
          adapter.act = async (...args) => {
            const value = await act(...args);
            if (args[1] === 'extract' && value === context.inputs.memberId && ++identities === afterIdentity) {
              await adapter.page.frameLocator('iframe').locator('body').evaluate((body) => {
                body.querySelector('strong')!.textContent = '67890';
                body.querySelector('td.amount')!.textContent = '$9,876.54';
              });
              adapter.act = act;
            }
            return value;
          };
        }
        return decision;
      }));
      expect(result).toMatchObject({ kind: 'BLOCKED', code: 'HUMAN_REQUIRED' });
      expect(result.outputs).toBeUndefined();
      expect((await transcript(result)).records.find((record) => record.tool === 'complete'))
        .toMatchObject({ status: 'rejected', code: 'STATE_CHANGED' });
      expect(count('POST', '/members/search')).toBe(1);
      expect(count('POST', '/members/12345/sub-accounts')).toBe(0);
    });
  }
});

it('checks terminal health after logging and preserves receipts when post-dispatch logging fails', async () => {
  for (const fault of ['policy', 'evidence'] as const) {
    await withApp(async ({ run, adapters, count, transcript }) => {
      const original = Object.getOwnPropertyDescriptor(EvidenceSink.prototype, 'event')!.value as EvidenceSink['event'];
      const log = vi.spyOn(EvidenceSink.prototype, 'event').mockImplementation(async function (this: EvidenceSink, input) {
        await original.call(this, input);
        const event = input as { type: string; action?: string };
        if (event.type === 'decision_finished' && event.action === (fault === 'policy' ? 'complete' : 'click')) {
          if (fault === 'policy') await adapters[0]!.navigate('/members/12345/sub-accounts').catch(() => {});
          else throw new Error('Synthetic post-dispatch evidence failure');
        }
      });
      try {
        const result = await run(fakeModel((context) => chooseRead(context)));
        expect(result).toMatchObject({ kind: fault === 'policy' ? 'BLOCKED' : 'FAILURE',
          code: fault === 'policy' ? 'POLICY_BLOCKED' : 'EVIDENCE_ERROR' });
        expect(result.outputs).toBeUndefined();
        const record = (await transcript(result)).records.at(-1);
        expect(record?.status).toBe('succeeded');
        if (fault === 'evidence') {
          expect(record).toMatchObject({ tool: 'click', targetKey: 'search_member', path: '/members/search', framePath: '/members/search' });
          expect(record?.target).toBeDefined();
          expect(count('GET', '/members/12345')).toBe(0);
        }
        expect(count('POST', '/members/search')).toBe(1);
        expect(count('POST', '/members/12345/sub-accounts')).toBe(0);
      } finally { log.mockRestore(); }
    });
  }
});

it('fails closed on resource-close rejection without masking an existing terminal error', async () => {
  for (const outcome of ['success', 'blocked', 'failure'] as const) {
    await withApp(async ({ run, adapters, transcript }) => {
      let restore = () => {};
      try {
        const result = await run(fakeModel((context, turn) => {
          if (turn === 1) {
            const adapter = adapters[0]!;
            const close = adapter.close.bind(adapter);
            restore = () => { adapter.close = close; };
            adapter.close = async () => { await close(); throw new Error('Synthetic close failure'); };
          }
          if (outcome === 'failure') throw new ModelCallError();
          return outcome === 'blocked' ? human : chooseRead(context);
        }));
        expect(result).toMatchObject({ kind: outcome === 'blocked' ? 'BLOCKED' : 'FAILURE',
          code: outcome === 'success' ? 'RESOURCE_CLOSE_FAILED' : outcome === 'blocked' ? 'HUMAN_REQUIRED' : 'MODEL_ERROR' });
        expect(result.outputs).toBeUndefined();
        expect((await transcript(result)).status).toBe(result.kind);
      } finally { restore(); }
    });
  }
});

it('rejects the bounded close timeout rather than returning success for an unresolved close', async () => {
  await withApp(async ({ run, adapters, transcript }) => {
    let closed = () => {};
    const browserClosed = new Promise<void>((resolve) => { closed = resolve; });
    let restore = () => {};
    const original = Object.getOwnPropertyDescriptor(EvidenceSink.prototype, 'event')!.value as EvidenceSink['event'];
    const log = vi.spyOn(EvidenceSink.prototype, 'event').mockImplementation(async function (this: EvidenceSink, input) {
      await original.call(this, input);
      const event = input as { type: string; action?: string };
      if (event.type === 'decision_finished' && event.action === 'complete') {
        // Leave native clearTimeout available to clear the already-running real deadlines.
        vi.useFakeTimers({ toFake: ['setTimeout'] });
      }
    });
    try {
      const pending = run(fakeModel((context, turn) => {
        if (turn === 1) {
          const adapter = adapters[0]!;
          const close = adapter.close.bind(adapter);
          restore = () => { adapter.close = close; };
          adapter.close = async () => {
            await close();
            closed();
            await new Promise<void>(() => {});
          };
        }
        return chooseRead(context);
      }));
      await browserClosed;
      expect(adapters[0]!.page.isClosed()).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(result).toMatchObject({ kind: 'FAILURE', code: 'RESOURCE_CLOSE_FAILED' });
      expect((await transcript(result)).status).toBe('FAILURE');
    } finally {
      restore();
      log.mockRestore();
      vi.useRealTimers();
    }
  });
});
