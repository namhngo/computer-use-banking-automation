import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileCapabilityRegistry } from '../artifact/registry.js';
import type { ReplayResult } from '../artifact/result.js';
import { loadPolicy } from '../policy/policy.js';
import * as engine from '../replay/engine.js';
import { compileTranscript } from './compile.js';
import { verifyDraft } from './verify.js';

vi.mock('../replay/engine.js', () => ({ runReplay: vi.fn() }));

const transcript = JSON.parse(readFileSync(new URL('../../evidence/agent/cold-savings/discovery/discovery.json', import.meta.url), 'utf8')) as unknown;
const draft = compileTranscript(transcript, { name: 'get_member_savings_balance', version: 1,
  app: { appId: 'harbor_core', appVersion: '1.0' }, recordedAt: '2026-09-12T21:00:00.000Z' });
const credentials = { username: 'verify-synthetic-operator', password: 'verify-synthetic-password' };
const policy = await loadPolicy(new URL('../../policy.yaml', import.meta.url).pathname);
const inputs = [{ member_id: '12345' }, { member_id: '67890' }];
let directory: string;
let closed = 0;
const createTarget = () => Promise.resolve({ origin: 'http://127.0.0.1:1', policy, close: () => { closed++; return Promise.resolve(); } });
const success = (runId: string, cents: number): ReplayResult => ({ kind: 'SUCCESS', runId, atStep: 'extract_t6', recoveries: [], evidence: ['events.jsonl'],
  outputs: { savings_balance: cents } });
const run = (overrides: Partial<Parameters<typeof verifyDraft>[0]> = {}) => verifyDraft({
  draft, registry: new FileCapabilityRegistry(directory), createTarget, inputs, credentials, verifiedAt: '2026-09-12T21:05:00.000Z', ...overrides,
});

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'verify-test-')); closed = 0; vi.mocked(engine.runReplay).mockReset(); });
afterEach(() => rm(directory, { recursive: true, force: true }));

it('publishes a new verified revision only after every distinct input replays successfully from a fresh target', async () => {
  vi.mocked(engine.runReplay).mockResolvedValueOnce(success('run_' + 'a'.repeat(32), 123456)).mockResolvedValueOnce(success('run_' + 'b'.repeat(32), 987654));
  const report = await run();
  expect(report).toEqual({ kind: 'VERIFIED',
    draft: { appId: 'harbor_core', appVersion: '1.0', name: 'get_member_savings_balance', version: 1 },
    verified: { appId: 'harbor_core', appVersion: '1.0', name: 'get_member_savings_balance', version: 2 },
    attempts: [{ runId: 'run_' + 'a'.repeat(32), kind: 'SUCCESS', evidence: ['events.jsonl'] }, { runId: 'run_' + 'b'.repeat(32), kind: 'SUCCESS', evidence: ['events.jsonl'] }] });
  expect(closed).toBe(2);
  const calls = vi.mocked(engine.runReplay).mock.calls.map(([options]) => options);
  expect(calls.map((options) => options.mode)).toEqual(['verification', 'verification']);
  expect(calls.map((options) => options.inputs)).toEqual(inputs);
  for (const options of calls) {
    expect(options.artifact).toEqual(draft);
    expect(options.origin).toBe('http://127.0.0.1:1');
    expect(options.credentials).toEqual(credentials);
  }
  const registry = new FileCapabilityRegistry(directory);
  const stored = await registry.load({ appId: 'harbor_core', appVersion: '1.0', name: 'get_member_savings_balance', version: 1 });
  expect(stored).toEqual(draft);
  const verified = await registry.load({ appId: 'harbor_core', appVersion: '1.0', name: 'get_member_savings_balance', version: 2 });
  expect(verified).toEqual({ ...draft, identity: { ...draft.identity, version: 2, status: 'verified' },
    verification: { runId: 'run_' + 'b'.repeat(32), verifiedAt: '2026-09-12T21:05:00.000Z' } });
});

it('keeps the immutable draft and publishes nothing verified when any replay is not a success', async () => {
  for (const [second, code] of [
    [{ kind: 'BUSINESS_OUTCOME', code: 'NO_MEMBER_FOUND' }, 'NO_MEMBER_FOUND'],
    [{ kind: 'FAILURE', code: 'CHECKPOINT_FAILED', message: 'x' }, 'CHECKPOINT_FAILED'],
    [{ kind: 'NEEDS_HUMAN', interventionId: 'iv', reason: 'STUCK' }, 'NEEDS_HUMAN'],
  ] as const) {
    directory = await mkdtemp(join(tmpdir(), 'verify-test-'));
    vi.mocked(engine.runReplay).mockReset();
    vi.mocked(engine.runReplay).mockResolvedValueOnce(success('run_' + 'a'.repeat(32), 123456))
      .mockResolvedValueOnce({ runId: 'run_' + 'c'.repeat(32), atStep: 'click_t2', recoveries: [], evidence: ['events.jsonl', 'snapshot_1.json'], ...second });
    const report = await run();
    expect(report).toMatchObject({ kind: 'REJECTED', code, draft: { version: 1 } });
    expect(report.attempts).toHaveLength(2);
    expect(await readdir(directory)).toEqual(['harbor_core--1.0--get_member_savings_balance--1.json']);
  }
});

it('stops at the first failing input without running the rest', async () => {
  vi.mocked(engine.runReplay).mockResolvedValueOnce({ kind: 'FAILURE', code: 'TARGET_NOT_FOUND', message: 'x', runId: 'run_' + 'd'.repeat(32), atStep: 'fill_t1', recoveries: [], evidence: [] });  const report = await run();
  expect(report).toMatchObject({ kind: 'REJECTED', code: 'TARGET_NOT_FOUND' });
  expect(engine.runReplay).toHaveBeenCalledTimes(1);
  expect(closed).toBe(1);
});

it('refuses non-drafts, writes, indistinct or too few inputs, and mismatched outputs before touching the registry', async () => {
  const verifiedDraft = { ...draft, identity: { ...draft.identity, status: 'verified' }, verification: { runId: 'run_' + 'e'.repeat(32), verifiedAt: '2026-09-12T21:05:00.000Z' } };
  await expect(run({ draft: verifiedDraft })).rejects.toThrow('Only an unverified draft');
  const write = { ...draft, risk: 'reversible', steps: draft.steps.map((step, index) => index === 2 ? { ...step, risk: 'reversible' } : step) };
  await expect(run({ draft: write })).rejects.toThrow('Writes are never automatically verified');
  await expect(run({ inputs: [{ member_id: '12345' }, { member_id: '12345' }] })).rejects.toThrow('distinct');
  await expect(run({ inputs: [{ member_id: '12345' }] })).rejects.toThrow('Invalid verification options');
  await expect(run({ inputs: [{ member_id: '1234' }, { member_id: '67890' }] })).rejects.toThrow('Values do not match');
  expect(engine.runReplay).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
  vi.mocked(engine.runReplay).mockResolvedValueOnce({ ...success('run_' + 'f'.repeat(32), 1), outputs: { savings_balance: 1.5 } } as ReplayResult);
  await expect(run()).rejects.toThrow('Values do not match');
  expect(await readdir(directory)).toEqual(['harbor_core--1.0--get_member_savings_balance--1.json']);
});

it('rejects a draft whose revision already exists instead of overwriting it', async () => {
  vi.mocked(engine.runReplay).mockResolvedValue(success('run_' + 'a'.repeat(32), 123456));
  await run();
  await expect(run()).rejects.toThrow('already exists');
});
