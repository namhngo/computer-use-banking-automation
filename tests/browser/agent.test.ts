import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createMockApp, type MockFault } from '../../mock-app/app.js';
import { runAgent, type AgentOptions } from '../../src/agent/agent.js';
import { agentResultSchema, type RouteDecision, type RouterModel } from '../../src/agent/contracts.js';
import { FileCapabilityRegistry } from '../../src/artifact/registry.js';
import { parseArtifact } from '../../src/artifact/schema.js';
import type { VerificationTarget } from '../../src/compiler/verify.js';
import type { DiscoveryDecision } from '../../src/discovery/contracts.js';
import type { DiscoveryModel } from '../../src/discovery/model.js';
import { loadPolicy, parsePolicy } from '../../src/policy/policy.js';

const credentials = { username: 'agent-synthetic-operator', password: 'agent-synthetic-password' };
const basePolicy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
const verifiedArtifact = parseArtifact(JSON.parse(readFileSync(
  new URL('../../evidence/compile-phase5/get_member_savings_balance.v2.verified.json', import.meta.url), 'utf8')) as unknown);
const app = { appId: 'harbor_core', appVersion: '1.0' } as const;
const key = (version: number) => ({ ...app, name: 'get_member_savings_balance', version });
const goal = (memberId: string) => `look up member ${memberId} and read their current savings balance`;

type Control = { ref: string; tag: string; label: string; text: string; scope: 'main' | 'frame'; row?: string; column?: string | number };
type Context = { inputs: { memberId: string }; observation: { controls: Control[] }; actions: Array<{ tool: string; status: string }>; extracted: Array<{ field: string; scope: string }> };

/** Test-only scripted discovery model using visible semantics, never production selectors. */
function scriptedDiscovery(memberId: string, calls: { intent: number; decide: number }): DiscoveryModel {
  const reply = <T>(value: T) => ({ value, usage: { inputTokens: 10, outputTokens: 2 }, modelId: 'actual-test-model', responseId: `test-${++calls.decide}` });
  const click = (ref: string): DiscoveryDecision => ({ tool: 'click', input: { ref, reason: 'locate_record' } });
  return {
    source: 'test', provider: 'synthetic', modelId: 'configured-test-model', secretValues: [],
    intent: () => { calls.intent++; return Promise.resolve(reply({ status: 'ready' as const, memberId })); },
    decide: (input) => {
      const context = input as Context;
      const controls = context.observation.controls;
      const alert = controls.find((control) => control.text === 'No member found');
      if (alert) return Promise.resolve(reply({ tool: 'complete', input: { reason: 'confirm_completion', ref: alert.ref, outcome: 'member_not_found' } }));
      const member = controls.find((control) => control.tag === 'a' && control.text === 'View member');
      if (member) return Promise.resolve(reply(click(member.ref)));
      const field = controls.find((control) => control.tag === 'input' && control.label === 'Member ID');
      if (field) {
        if (!context.actions.some((action) => action.tool === 'fill' && action.status === 'succeeded')) {
          return Promise.resolve(reply({ tool: 'fill', input: { ref: field.ref, input: 'memberId', reason: 'enter_input' } }));
        }
        return Promise.resolve(reply(click(controls.find((control) => control.tag === 'button' && control.text === 'Search')!.ref)));
      }
      const reads = [
        { field: 'memberId', scope: 'main', control: controls.find((control) => control.scope === 'main' && control.row === 'Member ID') },
        { field: 'memberId', scope: 'frame', control: controls.find((control) => control.scope === 'frame' && control.tag === 'strong' && control.text === memberId) },
        { field: 'savingsBalanceCents', scope: 'frame', control: controls.find((control) => control.row === 'Savings' && control.column === 'Current balance') },
        { field: 'currency', scope: 'frame', control: controls.find((control) => control.row === 'Savings' && control.column === 'Currency') },
      ] as const;
      for (const next of reads) {
        if (!context.extracted.some((read) => read.field === next.field && read.scope === next.scope)) {
          return Promise.resolve(reply(next.control ? { tool: 'extract', input: { ref: next.control.ref, field: next.field, reason: 'read_value' } }
            : { tool: 'wait', input: { reason: 'wait_for_ui', ms: 50 } }));
        }
      }
      return Promise.resolve(reply({ tool: 'complete', input: { reason: 'confirm_completion', outcome: 'success', ref: null } }));
    },
  };
}

function router(decide: (context: { goal: string; catalog: Array<{ name: string; version: number }> }) => RouteDecision): RouterModel {
  return {
    source: 'test', provider: 'synthetic', modelId: 'configured-router', secretValues: [],
    route: (context) => Promise.resolve({ value: decide(context), usage: { inputTokens: 20, outputTokens: 4 }, modelId: 'actual-router' }),
  };
}
const execute = (version: number, memberId: string): RouteDecision => ({ tool: 'execute', input: { capability: 'get_member_savings_balance', version, inputs: { memberId } } });
const discover = (memberId: string): RouteDecision => ({ tool: 'discover', input: { reason: 'no_compatible_capability', inputs: { memberId } } });

let root: string;
const servers: Array<() => Promise<void>> = [];
let spawnedSandboxes = 0;
async function listen(fault: MockFault, requests?: Map<string, number>): Promise<VerificationTarget> {
  const sandbox = createMockApp({ credentials, fault });
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
    const path = `${request.method} ${new URL(request.url).pathname}`;
    requests?.set(path, (requests.get(path) ?? 0) + 1);
    return sandbox.app.fetch(request);
  } });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected ephemeral test server');
  const origin = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if ('closeAllConnections' in server) server.closeAllConnections();
    await closed;
  };
  servers.push(close);
  return { origin, policy: parsePolicy({ ...basePolicy, allowedOrigins: [origin] }), close };
}
const createTarget = async () => { spawnedSandboxes++; return listen('none'); };

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agent-browser-')); spawnedSandboxes = 0; });
afterEach(async () => {
  for (const close of servers.splice(0)) await close().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

async function agent(target: VerificationTarget, overrides: Partial<AgentOptions>) {
  const result = await runAgent({
    goal: goal('12345'), router: router(() => discover('12345')), registry: new FileCapabilityRegistry(join(root, 'capabilities')),
    origin: target.origin, policy: target.policy, credentials, evidenceRoot: join(root, 'runs'), headless: true,
    verification: { createTarget, inputs: [{ memberId: '67890' }] }, ...overrides,
  });
  expect(agentResultSchema.safeParse(result).success).toBe(true);
  return result;
}

it('cold run: discovers, compiles, verifies in fresh sandboxes, returns the discovered result without executing again; then the warm run replays model-free', async () => {
  const requests = new Map<string, number>();
  const target = await listen('none', requests);
  const calls = { intent: 0, decide: 0 };
  const registry = new FileCapabilityRegistry(join(root, 'capabilities'));
  let seenCatalog: unknown;
  const cold = await agent(target, {
    router: router((context) => { seenCatalog = context.catalog; return discover('12345'); }),
    discoveryModel: scriptedDiscovery('12345', calls), registry,
  });
  expect(seenCatalog).toEqual([]);
  expect(cold).toMatchObject({
    kind: 'DISCOVERED', source: 'test', routing: { decision: 'discover', catalog: [] },
    discovery: { kind: 'SUCCESS', outputs: { savingsBalanceCents: 123456, currency: 'USD' } },
    compiled: { draft: key(1), verified: key(2) },
  });
  if (cold.kind !== 'DISCOVERED' || !cold.compiled) throw new Error('Expected a compiled result');
  expect(cold.compiled.code).toBeUndefined();
  expect(cold.compiled.verificationRuns).toHaveLength(2);
  // The target saw discovery exactly once; verification ran only in the two fresh sandboxes.
  expect(requests.get('POST /members/search')).toBe(1);
  expect(spawnedSandboxes).toBe(2);
  expect(calls.intent).toBe(1);
  expect(await registry.load(key(2))).toMatchObject({ identity: { status: 'verified' }, provenance: { source: 'discovered', runId: cold.discovery.runId } });
  const runs = await readdir(join(root, 'runs'));
  expect(runs).toHaveLength(3);
  expect(runs).toEqual(expect.arrayContaining([cold.discovery.runId, ...cold.compiled.verificationRuns]));
  for (const run of runs) {
    const events = await readFile(join(root, 'runs', run, 'events.jsonl'), 'utf8');
    for (const value of ['12345', '67890', '123456', '987654', '1,234', '9,876', ...Object.values(credentials)]) expect(events).not.toContain(value);
  }

  // Warm: the router now sees the verified catalog and executes; discovery is never consulted.
  const untouched = { intent: 0, decide: 0 };
  const warm = await agent(target, {
    goal: goal('67890'), router: router((context) => {
      seenCatalog = context.catalog;
      return execute(2, '67890');
    }), discoveryModel: scriptedDiscovery('67890', untouched), registry,
  });
  expect(seenCatalog).toMatchObject([{ name: 'get_member_savings_balance', version: 2 }]);
  expect(warm).toMatchObject({ kind: 'EXECUTED', capability: key(2), routing: { decision: 'execute' },
    result: { kind: 'SUCCESS', outputs: { savingsBalanceCents: 987654, currency: 'USD' } } });
  expect(untouched).toEqual({ intent: 0, decide: 0 });
  expect(requests.get('POST /members/search')).toBe(2);
  expect(spawnedSandboxes).toBe(2);
}, 90_000);

it('warm run against a seeded registry executes the verified revision only, and a policy denial is returned rather than rediscovered', async () => {
  const registry = new FileCapabilityRegistry(join(root, 'capabilities'));
  await registry.save(verifiedArtifact);
  const untouched = { intent: 0, decide: 0 };
  const ok = await agent(await listen('none'), { goal: goal('67890'), router: router(() => execute(2, '67890')),
    discoveryModel: scriptedDiscovery('67890', untouched), registry });
  expect(ok).toMatchObject({ kind: 'EXECUTED', result: { kind: 'SUCCESS', outputs: { savingsBalanceCents: 987654 } } });

  const denied = await agent(await listen('permission_denied'), { goal: goal('12345'), router: router(() => execute(2, '12345')),
    discoveryModel: scriptedDiscovery('12345', untouched), registry });
  expect(denied).toMatchObject({ kind: 'EXECUTED', capability: key(2), result: { kind: 'FAILURE' } });
  if (denied.kind !== 'EXECUTED' || denied.result.kind !== 'FAILURE') throw new Error('Expected a replay failure');
  expect(denied.result.code).toMatch(/^[A-Z_]+$/);

  // A model-chosen input that fails the artifact's input contract is rejected before any browser starts.
  const invalid = await agent(await listen('none'), { router: router(() => execute(2, '1234')), discoveryModel: scriptedDiscovery('1234', untouched), registry });
  expect(invalid).toMatchObject({ kind: 'EXECUTED', result: { kind: 'FAILURE', code: 'INPUT_INVALID' } });
  expect(untouched).toEqual({ intent: 0, decide: 0 });
  expect(spawnedSandboxes).toBe(0);
  expect(await readdir(join(root, 'capabilities'))).toHaveLength(1);
}, 60_000);

it('cold run without owned sandboxes or a second input saves an unverified draft that stays out of the catalog', async () => {
  const registry = new FileCapabilityRegistry(join(root, 'capabilities'));
  const target = await listen('none');
  const first = await runAgent({ goal: goal('12345'), router: router(() => discover('12345')), origin: target.origin, policy: target.policy,
    credentials, evidenceRoot: join(root, 'runs'), headless: true, discoveryModel: scriptedDiscovery('12345', { intent: 0, decide: 0 }), registry });
  expect(first).toMatchObject({ kind: 'DISCOVERED', discovery: { kind: 'SUCCESS' }, compiled: { draft: key(1), verified: null, code: 'VERIFICATION_UNAVAILABLE', verificationRuns: [] } });

  const second = await agent(target, { discoveryModel: scriptedDiscovery('12345', { intent: 0, decide: 0 }), registry, verification: { createTarget, inputs: [{ memberId: '12345' }] } });
  expect(second).toMatchObject({ kind: 'DISCOVERED', compiled: { draft: key(2), verified: null, code: 'VERIFICATION_INPUTS_REQUIRED' } });
  expect(spawnedSandboxes).toBe(0);
  expect((await readdir(join(root, 'capabilities'))).sort()).toEqual([
    'harbor_core--1.0--get_member_savings_balance--1.json', 'harbor_core--1.0--get_member_savings_balance--2.json']);
}, 90_000);

it('cold run ending in a business outcome completes the goal and compiles nothing', async () => {
  const registry = new FileCapabilityRegistry(join(root, 'capabilities'));
  const result = await agent(await listen('none'), { goal: goal('99999'), router: router(() => discover('99999')),
    discoveryModel: scriptedDiscovery('99999', { intent: 0, decide: 0 }), registry });
  expect(result).toMatchObject({ kind: 'DISCOVERED', discovery: { kind: 'BUSINESS_OUTCOME', code: 'MEMBER_NOT_FOUND' }, compiled: null });
  expect(spawnedSandboxes).toBe(0);
  await expect(readdir(join(root, 'capabilities'))).rejects.toThrow();
}, 60_000);
