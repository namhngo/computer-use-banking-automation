import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createMockApp } from '../../mock-app/app.js';
import { FileCapabilityRegistry } from '../../src/artifact/registry.js';
import { compileTranscript } from '../../src/compiler/compile.js';
import { verifyDraft, type VerificationTarget } from '../../src/compiler/verify.js';
import { loadPolicy, parsePolicy } from '../../src/policy/policy.js';
import { runReplay } from '../../src/replay/engine.js';

const credentials = { username: 'compile-synthetic-operator', password: 'compile-synthetic-password' };
const basePolicy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
const evidence = (name: string) => JSON.parse(readFileSync(new URL(`../../evidence/discovery-phase4/${name}/discovery.json`, import.meta.url), 'utf8')) as unknown;
const app = { appId: 'harbor_core', appVersion: '1.0' } as const;
const key = (version: number) => ({ ...app, name: 'get_member_savings_balance', version });
const draft = compileTranscript(evidence('success'), { name: 'get_member_savings_balance', version: 1, app,
  recordedAt: '2026-09-12T21:00:00.000Z', outcomeTranscripts: [evidence('not-found')], sensitiveValues: Object.values(credentials) });

let root: string;
let spawned = 0;
const targets: VerificationTarget[] = [];
async function createTarget(): Promise<VerificationTarget> {
  spawned++;
  const sandbox = createMockApp({ credentials, fault: 'none' });
  const server = serve({ fetch: sandbox.app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected ephemeral test server');
  const origin = `http://127.0.0.1:${address.port}`;
  const target = { origin, policy: parsePolicy({ ...basePolicy, allowedOrigins: [origin] }), close: async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if ('closeAllConnections' in server) server.closeAllConnections();
    await closed;
  } };
  targets.push(target);
  return target;
}
const verify = (candidate: unknown, inputs = [{ memberId: '12345' }, { memberId: '67890' }]) => verifyDraft({
  draft: candidate, registry: new FileCapabilityRegistry(join(root, 'capabilities')), createTarget, inputs, credentials,
  evidenceRoot: join(root, 'runs'), headless: true, verifiedAt: '2026-09-12T21:05:00.000Z',
});

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'compile-verify-')); spawned = 0; });
afterEach(async () => {
  for (const target of targets.splice(0)) await target.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

it('verifies the artifact compiled from the live transcript with two members in fresh sandboxes, then replays it model-free', async () => {
  const report = await verify(draft);
  expect(report).toMatchObject({ kind: 'VERIFIED', draft: key(1), verified: key(2) });
  expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['SUCCESS', 'SUCCESS']);
  expect(spawned).toBe(2);
  const registry = new FileCapabilityRegistry(join(root, 'capabilities'));
  expect(await registry.load(key(1))).toMatchObject({ identity: { status: 'draft' } });
  const verified = await registry.load(key(2));
  expect(verified).toMatchObject({ identity: { status: 'verified', version: 2 }, verification: { runId: report.attempts[1]!.runId },
    provenance: { source: 'discovered', model: 'gpt-4.1' } });
  // Each verification run has its own private evidence; outputs and member values never land in it.
  for (const attempt of report.attempts) {
    const events = await readFile(join(root, 'runs', attempt.runId, 'events.jsonl'), 'utf8');
    for (const value of ['12345', '67890', '123456', '987654', '1,234', '9,876', ...Object.values(credentials)]) expect(events).not.toContain(value);
  }

  // Production path: the verified revision replays for a third invocation and the observed outcome fires.
  for (const [memberId, expected] of [
    ['67890', { kind: 'SUCCESS', atStep: 'extract_t6', outputs: { savingsBalanceCents: 987654, currency: 'USD' } }],
    ['99999', { kind: 'BUSINESS_OUTCOME', code: 'MEMBER_NOT_FOUND', atStep: 'click_t2' }],
  ] as const) {
    const target = await createTarget();
    const result = await runReplay({ artifact: verified, inputs: { memberId }, mode: 'replay', origin: target.origin, policy: target.policy,
      credentials, evidenceRoot: join(root, 'runs'), headless: true });
    expect(result).toMatchObject(expected);
  }
  // The draft itself stays ineligible for production replay.
  const target = await createTarget();
  expect(await runReplay({ artifact: draft, inputs: { memberId: '12345' }, mode: 'replay', origin: target.origin, policy: target.policy,
    credentials, evidenceRoot: join(root, 'runs'), headless: true })).toMatchObject({ kind: 'FAILURE', code: 'INVOCATION_INVALID' });
}, 60_000);

it('refuses a draft with the discovery member hardcoded before any browser is started', async () => {
  const hardcoded = structuredClone(draft);
  if (hardcoded.checkpoint.kind !== 'all') throw new Error('Expected a compound checkpoint');
  for (const condition of hardcoded.checkpoint.conditions) {
    if (condition.kind === 'text_equals') condition.expected = { source: 'literal', value: '12345' };
  }
  await expect(verify(hardcoded)).rejects.toThrow('known sensitive value');
  expect(spawned).toBe(0);
  await expect(readdir(join(root, 'capabilities'))).rejects.toThrow();
}, 60_000);

it('rejects a draft that only works for the discovery member through the second verification input', async () => {
  // A literal the registry cannot know about: the discovered member's synthetic name passes for
  // 12345 and must be exposed by replaying with a different member.
  const hardcoded = structuredClone(draft);
  if (hardcoded.checkpoint.kind !== 'all') throw new Error('Expected a compound checkpoint');
  hardcoded.checkpoint.conditions.push({ kind: 'text_equals', expected: { source: 'literal', value: 'Avery Sample' },
    target: { strategies: [{ kind: 'table_cell', row: { source: 'literal', value: 'Name' }, column: 2 }] } });
  const report = await verify(hardcoded);
  expect(report).toMatchObject({ kind: 'REJECTED', draft: key(1) });
  expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['SUCCESS', 'FAILURE']);
  expect(report.attempts[1]).toMatchObject({ code: 'CHECKPOINT_FAILED' });
  expect(await readdir(join(root, 'capabilities'))).toEqual(['harbor_core--1.0--get_member_savings_balance--1.json']);
}, 60_000);

it('rejects a draft whose observed postcondition no longer holds, before any extraction', async () => {
  const stale = structuredClone(draft);
  const search = stale.steps.find((step) => step.id === 'click_t2');
  if (!search || search.action !== 'click') throw new Error('Expected the search click');
  search.postcondition = { kind: 'visible', target: { strategies: [{ kind: 'role', role: 'heading', name: { source: 'literal', value: 'Never rendered' } }] } };
  const report = await verify(stale);
  expect(report).toMatchObject({ kind: 'REJECTED', attempts: [{ kind: 'FAILURE' }] });
  expect(spawned).toBe(1);
}, 60_000);
