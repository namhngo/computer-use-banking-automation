import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCapabilityRegistry } from '../artifact/registry.js';
import { parseArtifact, type CapabilityArtifact } from '../artifact/schema.js';
import { ModelCallError } from '../discovery/contracts.js';
import type { DiscoveryModel } from '../discovery/model.js';
import { loadPolicy } from '../policy/policy.js';
import { buildCatalog, runAgent, type AgentOptions } from './agent.js';
import { agentResultSchema, parseRouteDecision, type RouteDecision, type RouterModel } from './contracts.js';
import { createRouterModel, ROUTER_INSTRUCTIONS } from './model.js';

const verified = parseArtifact(JSON.parse(readFileSync(
  new URL('../../evidence/compile-phase5/get_member_savings_balance.v2.verified.json', import.meta.url), 'utf8')) as unknown);
const draft = parseArtifact(JSON.parse(readFileSync(
  new URL('../../evidence/compile-phase5/get_member_savings_balance.v1.draft.json', import.meta.url), 'utf8')) as unknown);
const policy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
const credentials = { username: 'agent-synthetic-operator', password: 'agent-synthetic-password' };
const secret = 'synthetic-router-provider-key';

function fakeRouter(decide: (context: { goal: string; catalog: unknown[] }, signal: AbortSignal) => RouteDecision | Promise<RouteDecision>): RouterModel {
  return {
    source: 'test', provider: 'synthetic', modelId: 'configured-router', secretValues: [secret],
    route: async (context, signal) => {
      const serialized = JSON.stringify(context);
      for (const forbidden of [secret, credentials.username, credentials.password, '"steps"', '"selector"', '"strategies"', '"target"']) {
        expect(serialized).not.toContain(forbidden);
      }
      return { value: await decide(context, signal), usage: { inputTokens: 20, outputTokens: 4 }, modelId: 'actual-router', responseId: 'resp_1' };
    },
  };
}
const neverDiscover: DiscoveryModel = {
  source: 'test', provider: 'synthetic', modelId: 'never', secretValues: [],
  intent: () => Promise.reject(new Error('discovery must not run')),
  decide: () => Promise.reject(new Error('discovery must not run')),
};

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agent-unit-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function options(router: RouterModel, overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    goal: 'look up member 12345 and read their current savings balance', router, discoveryModel: neverDiscover,
    registry: new FileCapabilityRegistry(join(root, 'capabilities')), origin: 'http://127.0.0.1:1', policy, credentials,
    evidenceRoot: join(root, 'runs'), headless: true, ...overrides,
  };
}

describe('catalog', () => {
  it('lists only verified revisions of the configured app, newest per name, without executable detail', () => {
    const other: CapabilityArtifact = { ...verified, app: { ...verified.app, appVersion: '9.9' } };
    const older: CapabilityArtifact = { ...verified, identity: { ...verified.identity, version: 1 } };
    const catalog = buildCatalog([draft, other, older, verified]);
    expect(catalog).toEqual([{
      name: 'get_member_savings_balance', version: 2, description: verified.identity.description, risk: 'read_only',
      inputs: { memberId: { description: verified.inputs.memberId!.description, type: 'string', format: 'digits', minLength: 5, maxLength: 5 } },
      outputs: {
        savingsBalanceCents: { description: verified.outputs.savingsBalanceCents!.description, type: 'number' },
        currency: { description: verified.outputs.currency!.description, type: 'string' },
      },
    }]);
    expect(JSON.stringify(catalog)).not.toMatch(/"steps"|"selector"|"strategies"|"checkpoint"|"kind"/);
    expect(buildCatalog([draft])).toEqual([]);
  });
});

describe('route decisions', () => {
  it('accepts only the four declared tools with schema-valid inputs', () => {
    expect(parseRouteDecision('execute', { capability: 'get_member_savings_balance', version: 2, inputs: { memberId: '12345' } }))
      .toEqual({ tool: 'execute', input: { capability: 'get_member_savings_balance', version: 2, inputs: { memberId: '12345' } } });
    expect(() => parseRouteDecision('navigate', { path: '/' })).toThrow('Invalid route decision.');
    expect(() => parseRouteDecision('discover', { reason: 'no_compatible_capability', inputs: { memberId: '1234' } })).toThrow('Invalid route decision.');
    expect(() => parseRouteDecision('clarify', { reason: 'missing_member_id', question: 'x'.repeat(301) })).toThrow('Invalid route decision.');
    expect(() => parseRouteDecision('execute', { capability: 'get_member_savings_balance', version: 2, inputs: { memberId: '12345' }, extra: 1 })).toThrow();
    expect(() => parseRouteDecision('unsupported', { reason: 'because' })).toThrow('Invalid route decision.');
  });

  it('routes through the guarded single-turn SDK call and rejects prose or multiple calls', async () => {
    let mode: 'tool' | 'text' | 'double' = 'tool';
    const sdk = new MockLanguageModelV4({
      modelId: 'test-router-sdk',
      doGenerate: (request) => {
        expect(request.toolChoice).toEqual({ type: 'required' });
        expect((request.tools ?? []).map((tool) => tool.name).sort()).toEqual(['clarify', 'discover', 'execute', 'unsupported']);
        const system = request.prompt.find((entry) => entry.role === 'system');
        expect(system && 'content' in system ? system.content : '').toBe(ROUTER_INSTRUCTIONS);
        const call = { type: 'tool-call' as const, toolCallId: 'call_1', toolName: 'clarify',
          input: JSON.stringify({ reason: 'missing_member_id', question: 'Which member ID should I look up?' }) };
        const content = mode === 'tool' ? [call] : mode === 'text' ? [{ type: 'text' as const, text: 'Sure!' }] : [call, { ...call, toolCallId: 'call_2' }];
        return Promise.resolve({
          content, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, warnings: [],
          usage: { inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 6, text: 6, reasoning: undefined }, raw: {} },
          response: { id: 'resp_router_1', modelId: 'test-router-sdk', timestamp: new Date(0) },
        });
      },
    });
    const router = createRouterModel({ model: sdk, modelId: 'test-router-sdk', provider: 'test-sdk', source: 'test', secretValues: [secret] });
    const reply = await router.route({ goal: 'read a savings balance', catalog: [] }, AbortSignal.timeout(5000));
    expect(reply).toMatchObject({ value: { tool: 'clarify', input: { reason: 'missing_member_id' } }, usage: { inputTokens: 30, outputTokens: 6 }, modelId: 'test-router-sdk' });
    for (mode of ['text', 'double'] as const) {
      await expect(router.route({ goal: 'read a savings balance', catalog: [] }, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(ModelCallError);
    }
  });
});

describe('runAgent without a browser', () => {
  it('returns clarification and unsupported decisions verbatim with the routing receipt', async () => {
    const clarified = await runAgent(options(fakeRouter(() => ({ tool: 'clarify', input: { reason: 'missing_member_id', question: 'Which member?' } }))));
    expect(clarified).toMatchObject({ kind: 'CLARIFICATION_REQUIRED', reason: 'missing_member_id', question: 'Which member?', source: 'test',
      routing: { decision: 'clarify', modelId: 'actual-router', responseId: 'resp_1', usage: { inputTokens: 20, outputTokens: 4 }, catalog: [] } });
    expect(clarified.agentRunId).toMatch(/^agent_[a-f0-9]{32}$/);
    const refused = await runAgent(options(fakeRouter(() => ({ tool: 'unsupported', input: { reason: 'changes_financial_data' } })),
      { goal: 'transfer 500 from member 12345 savings to checking' }));
    expect(refused).toMatchObject({ kind: 'UNSUPPORTED_GOAL', reason: 'changes_financial_data', routing: { decision: 'unsupported' } });
    expect(agentResultSchema.safeParse(refused).success).toBe(true);
  });

  it('supplies the verified catalog to the router and fails closed on an unknown capability name or revision', async () => {
    const registry = new FileCapabilityRegistry(join(root, 'capabilities'));
    await registry.save(draft);
    await registry.save(verified);
    let seen: unknown[] = [];
    const result = await runAgent(options(fakeRouter((context) => {
      seen = context.catalog;
      return { tool: 'execute', input: { capability: 'get_member_savings_balance', version: 1, inputs: { memberId: '12345' } } };
    }), { registry }));
    expect(seen).toMatchObject([{ name: 'get_member_savings_balance', version: 2 }]);
    expect(result).toMatchObject({ kind: 'FAILURE', code: 'CAPABILITY_NOT_FOUND', routing: { decision: 'execute', catalog: [{ name: 'get_member_savings_balance', version: 2 }] } });
    expect(await runAgent(options(fakeRouter(() => ({ tool: 'execute', input: { capability: 'transfer_funds', version: 1, inputs: {} } })), { registry })))
      .toMatchObject({ kind: 'FAILURE', code: 'CAPABILITY_NOT_FOUND' });
  });

  it('never discovers when a verified capability exists, and never discovers without a discovery model', async () => {
    const registry = new FileCapabilityRegistry(join(root, 'capabilities'));
    await registry.save(verified);
    const discover: RouteDecision = { tool: 'discover', input: { reason: 'no_compatible_capability', inputs: { memberId: '12345' } } };
    expect(await runAgent(options(fakeRouter(() => discover), { registry }))).toMatchObject({ kind: 'FAILURE', code: 'DISCOVERY_NOT_NEEDED' });
    const withoutModel: Partial<AgentOptions> = options(fakeRouter(() => discover), { registry: new FileCapabilityRegistry(join(root, 'empty')) });
    delete withoutModel.discoveryModel;
    expect(await runAgent(withoutModel as AgentOptions)).toMatchObject({ kind: 'FAILURE', code: 'MODEL_NOT_CONFIGURED', routing: { catalog: [] } });
  });

  it('reports router failures and timeouts as codes without executing anything', async () => {
    const failing = fakeRouter(() => { throw new ModelCallError({ usage: { inputTokens: 7, outputTokens: 0 } }); });
    expect(await runAgent(options(failing))).toMatchObject({ kind: 'FAILURE', code: 'ROUTER_ERROR', routing: { decision: null, usage: { inputTokens: 7, outputTokens: 0 } } });
    const slow = fakeRouter((_context, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ModelCallError()), { once: true });
    }));
    expect(await runAgent(options(slow, { routeTimeoutMs: 1000 }))).toMatchObject({ kind: 'FAILURE', code: 'ROUTER_TIMEOUT' });
    expect(await runAgent(options(failing, { goal: '   ' }))).toMatchObject({ kind: 'FAILURE', code: 'INVALID_OPTIONS' });
    expect(await runAgent(options(failing, { registry: new FileCapabilityRegistry(join(root, 'missing', 'nested')) })))
      .toMatchObject({ kind: 'FAILURE', code: 'ROUTER_ERROR', routing: { catalog: [] } });
  });
});
