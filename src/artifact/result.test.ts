import { describe, expect, it } from 'vitest';
import { makeArtifact } from '../../tests/fixtures/capability.js';
import { parseReplayResult } from './result.js';

const base = { runId: 'synthetic_run', atStep: 'extract_currency', evidence: ['synthetic_run.jsonl', 'checkpoint.png'], recoveries: [] };
const success = { ...base, kind: 'SUCCESS', outputs: { savingsBalanceCents: 123456, currency: 'USD' } } as const;
const recovery = { code: 'SESSION_EXPIRED', atStep: 'open_search', attempt: 1, outcome: 'recovered' } as const;

describe('parseReplayResult', () => {
  it('rejects success before the final step or after exhausted recovery', () => {
    const artifact = makeArtifact();
    expect(() => parseReplayResult({ ...success, atStep: 'open_search' }, artifact)).toThrow('Success requires a completed flow');
    expect(() => parseReplayResult({ ...success, recoveries: [{ ...recovery, outcome: 'exhausted' }] }, artifact)).toThrow('Success requires a completed flow');
  });
  it('does not resume automatic attempts after an exhausted recovery', () => {
    const artifact = makeArtifact();
    artifact.recoveries[0]!.maxAttempts = 2;
    expect(() => parseReplayResult({
      ...base, kind: 'FAILURE', code: 'RECOVERY_EXHAUSTED', message: 'Stopped.',
      recoveries: [{ ...recovery, outcome: 'exhausted' }, { ...recovery, attempt: 2 }],
    }, artifact)).toThrow('Replay result references');
  });

  it('accepts SUCCESS with exact typed outputs and declared recovery history', () => {
    const result = { ...success, recoveries: [recovery] };
    expect(parseReplayResult(result, makeArtifact())).toEqual(result);
  });

  it.each([
    {}, { savingsBalanceCents: 123456 },
    { savingsBalanceCents: 123456, currency: 'USD', extra: true },
    { savingsBalanceCents: '123456', currency: 'USD' },
    { savingsBalanceCents: 1.5, currency: 'USD' },
    { savingsBalanceCents: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' },
    { savingsBalanceCents: Infinity, currency: 'USD' },
    { savingsBalanceCents: NaN, currency: 'USD' },
    { savingsBalanceCents: 123456, currency: 'US' },
    { savingsBalanceCents: 123456, currency: 'USDX' },
    { savingsBalanceCents: 123456, currency: true },
    { savingsBalanceCents: 123456, currency: { value: 'USD' } },
  ])('rejects SUCCESS with bad outputs %j', (outputs) => {
    expect(() => parseReplayResult({ ...success, outputs }, makeArtifact())).toThrow();
  });

  it('validates output ranges against the supplied artifact', () => {
    const artifact = makeArtifact();
    Object.assign(artifact.outputs.savingsBalanceCents!, { minimum: 0, maximum: 100 });
    expect(() => parseReplayResult(success, artifact)).toThrow('Values do not match the declared contract.');
    const valid = { ...success, outputs: { savingsBalanceCents: 100, currency: 'USD' } };
    expect(parseReplayResult(valid, artifact)).toEqual(valid);
  });

  it('accepts only declared business outcomes, not failure or recovery codes', () => {
    const artifact = makeArtifact();
    const result = { ...base, kind: 'BUSINESS_OUTCOME', atStep: 'search', code: 'MEMBER_NOT_FOUND' };
    expect(parseReplayResult(result, artifact)).toEqual(result);
    for (const code of ['UNKNOWN_OUTCOME', 'PERMISSION_DENIED', 'SESSION_EXPIRED']) {
      expect(() => parseReplayResult({ ...result, code }, artifact)).toThrow('Undeclared business outcome.');
    }
  });

  it('accepts a pre-step hard failure without an artifact', () => {
    const result = { ...base, kind: 'FAILURE', atStep: null, code: 'INVALID_ARTIFACT', message: 'Artifact rejected.' };
    expect(parseReplayResult(result)).toEqual(result);
    expect(parseReplayResult(result, makeArtifact())).toEqual(result);
  });

  it('accepts an in-step hard failure and NEEDS_HUMAN with an identified step', () => {
    for (const result of [
      { ...base, kind: 'FAILURE', atStep: 'open_search', code: 'TIMEOUT', message: 'Step timed out.', expected: 'Search page', observed: 'Login page' },
      { ...base, kind: 'NEEDS_HUMAN', atStep: 'open_search', interventionId: 'synthetic_intervention', reason: 'MFA_REQUIRED' },
    ]) expect(parseReplayResult(result, makeArtifact())).toEqual(result);
  });

  it.each([
    success,
    { ...base, kind: 'BUSINESS_OUTCOME', code: 'MEMBER_NOT_FOUND' },
    { ...base, kind: 'NEEDS_HUMAN', interventionId: 'synthetic_intervention', reason: 'MFA_REQUIRED' },
  ])('rejects null atStep for $kind even with a valid artifact', (result) => {
    expect(() => parseReplayResult({ ...result, atStep: null }, makeArtifact())).toThrow();
  });

  it('rejects a purported pre-step failure containing recovery history', () => {
    const result = { ...base, kind: 'FAILURE', atStep: null, code: 'INVALID_ARTIFACT', message: 'Artifact rejected.', recoveries: [recovery] };
    expect(() => parseReplayResult(result)).toThrow();
    expect(() => parseReplayResult(result, makeArtifact())).toThrow();
  });

  it.each([
    success,
    { ...base, kind: 'BUSINESS_OUTCOME', code: 'MEMBER_NOT_FOUND' },
    { ...base, kind: 'FAILURE', code: 'TIMEOUT', message: 'Step timed out.' },
    { ...base, kind: 'NEEDS_HUMAN', interventionId: 'synthetic_intervention', reason: 'MFA_REQUIRED' },
  ])('requires an artifact and a known atStep for $kind', (result) => {
    expect(() => parseReplayResult(result)).toThrow('A capability is required to validate this result.');
    expect(() => parseReplayResult({ ...result, atStep: 'unknown_step' }, makeArtifact())).toThrow();
  });

  it.each([
    { ...recovery, code: 'UNKNOWN_RECOVERY' },
    { ...recovery, code: 'MEMBER_NOT_FOUND' },
    { ...recovery, atStep: 'unknown_step' },
    { ...recovery, attempt: 2 },
    { ...recovery, attempt: 0 },
    { ...recovery, attempt: 1.5 },
    { ...recovery, attempt: 6 },
    { ...recovery, outcome: 'ignored' },
  ])('rejects invalid recovery history %j', (invalid) => {
    expect(() => parseReplayResult({ ...success, recoveries: [invalid] }, makeArtifact())).toThrow();
  });

  it('does not let repeated attempt numbers bypass a handler maxAttempts', () => {
    const artifact = makeArtifact();
    expect(artifact.recoveries[0]!.maxAttempts).toBe(1);
    expect(artifact.limits.maxRecoveryAttempts).toBeGreaterThanOrEqual(2);
    const result = { ...success, recoveries: [recovery, { ...recovery, atStep: 'search' }] };
    expect(() => parseReplayResult(result, artifact)).toThrow();
  });

  it('counts per-handler attempts even when other recoveries are interleaved', () => {
    const artifact = makeArtifact();
    artifact.recoveries[0]!.maxAttempts = 2;
    artifact.limits.maxRecoveryAttempts = 4;
    const result = {
      ...success,
      recoveries: [recovery, { ...recovery, code: 'SYSTEM_NOTICE' }, { ...recovery, attempt: 2 }, { ...recovery, attempt: 2, outcome: 'exhausted' }],
    };
    expect(() => parseReplayResult(result, artifact)).toThrow();
  });

  it('enforces the total budget independently of per-handler budgets', () => {
    const artifact = makeArtifact();
    artifact.limits.maxRecoveryAttempts = 2;
    artifact.recoveries[0]!.maxAttempts = 2;
    const recoveries = [recovery, { ...recovery, attempt: 2 }];
    expect(parseReplayResult({ ...success, recoveries }, artifact)).toEqual({ ...success, recoveries });
    expect(() => parseReplayResult({ ...success, recoveries: [...recoveries, { ...recovery, code: 'SYSTEM_NOTICE' }] }, artifact)).toThrow();
  });

  it.each([
    { ...success, debug: 'synthetic-secret' },
    { ...success, recoveries: [{ ...recovery, debug: 'synthetic-secret' }] },
    { ...base, kind: 'BUSINESS_OUTCOME', code: 'MEMBER_NOT_FOUND', outputs: {} },
    { ...base, kind: 'FAILURE', code: 'TIMEOUT', message: 'Timed out.', outputs: {} },
    { ...base, kind: 'NEEDS_HUMAN', interventionId: 'synthetic_intervention', reason: 'MFA_REQUIRED', outputs: {} },
  ])('rejects unknown fields, including nested recovery fields: %j', (result) => {
    expect(() => parseReplayResult(result, makeArtifact())).toThrow(new Error('Invalid replay result.'));
  });

  it.each([
    { ...success, kind: 'PARTIAL_SUCCESS' },
    { ...success, evidence: ['../synthetic-secret.png'] },
    { ...success, evidence: ['https://example.com/synthetic-secret.png'] },
    { ...success, evidence: Array.from({ length: 21 }, () => 'trace.jsonl') },
    { ...base, kind: 'NEEDS_HUMAN', reason: 'MFA_REQUIRED' },
    { ...base, kind: 'FAILURE', code: 'TIMEOUT', message: '' },
    { ...base, kind: 'FAILURE', code: 'TIMEOUT', message: 'x'.repeat(1001) },
  ])('rejects malformed result metadata without echoing it: %j', (result) => {
    expect(() => parseReplayResult(result, makeArtifact())).toThrow(new Error('Invalid replay result.'));
  });
});
