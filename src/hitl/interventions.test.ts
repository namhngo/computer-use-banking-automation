import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterventionBroker } from './interventions.js';
import type { InterventionHooks, Validation } from './interventions.js';

const token = 'a'.repeat(48);
const input = { runId: 'run_' + '1'.repeat(32), stepId: 'open_search', reason: 'UNEXPECTED_DIALOG', path: '/notice' } as const;

function hooks(validation: Validation = { accepted: true }) {
  const calls: string[] = [];
  const record: InterventionHooks = {
    validate: vi.fn((action: string) => { calls.push(`validate:${action}`); return Promise.resolve(validation); }),
    onClaim: vi.fn((operatorId: string) => { calls.push(`claim:${operatorId}`); return Promise.resolve(); }),
    onRelease: vi.fn(() => { calls.push('release'); return Promise.resolve(); }),
  };
  return { record, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('token handling', () => {
  it('requires a long hex token and checks bearers in constant time', () => {
    expect(() => new InterventionBroker('short')).toThrow('Invalid operator token');
    expect(() => new InterventionBroker('G'.repeat(48))).toThrow('Invalid operator token');
    const broker = new InterventionBroker(token);
    expect(broker.authorize(`Bearer ${token}`)).toBe(true);
    expect(broker.authorize(`Bearer ${'b'.repeat(48)}`)).toBe(false);
    expect(broker.authorize(`Bearer ${token}0`)).toBe(false);
    expect(broker.authorize(`bearer ${token}`)).toBe(false);
    expect(broker.authorize(token)).toBe(false);
    expect(broker.authorize(undefined)).toBe(false);
    expect(InterventionBroker.generateToken()).toMatch(/^[a-f0-9]{48}$/);
    expect(InterventionBroker.generateToken()).not.toBe(InterventionBroker.generateToken());
  });
});

describe('state machine', () => {
  it('opens waiting, moves to human control on claim, validates resume, and releases the browser', async () => {
    const broker = new InterventionBroker(token);
    const { record, calls } = hooks();
    const intervention = broker.open(input, record);
    expect(intervention.id).toMatch(/^iv_[a-f0-9]{32}$/);
    expect(broker.list()).toEqual([expect.objectContaining({ id: intervention.id, state: 'waiting', controlOwner: 'none', ...input })]);
    const waiting = intervention.wait(60_000);

    expect(await broker.claim(intervention.id, 'alice')).toMatchObject({ ok: true, view: { state: 'human_control', controlOwner: 'human', operatorId: 'alice' } });
    expect(await broker.claim(intervention.id, 'bob')).toEqual({ ok: false, status: 409, code: 'ALREADY_CLAIMED' });
    expect(await broker.resume(intervention.id, 'bob', 'retry_step')).toEqual({ ok: false, status: 409, code: 'NOT_OWNER' });
    expect(await broker.resume(intervention.id, 'alice', 'destroy_step')).toEqual({ ok: false, status: 409, code: 'INVALID_ACTION' });
    expect(await broker.resume(intervention.id, 'alice', 'skip_step')).toEqual({ ok: true, state: 'resumed' });
    await expect(waiting).resolves.toEqual({ kind: 'resumed', action: 'skip_step', operatorId: 'alice' });
    expect(calls).toEqual(['claim:alice', 'validate:skip_step', 'release']);
    const saved = intervention.record();
    expect(saved).toMatchObject({ state: 'resumed', operatorId: 'alice' });
    expect(saved.transitions.map((transition) => transition.state)).toEqual(['waiting', 'human_control', 'validating', 'resumed']);
    expect(await broker.resume(intervention.id, 'alice', 'abort')).toEqual({ ok: false, status: 409, code: 'INTERVENTION_CLOSED' });
    expect(await broker.claim(intervention.id, 'alice')).toEqual({ ok: false, status: 409, code: 'INTERVENTION_CLOSED' });
  });

  it('keeps the human in control when validation rejects and records the reason', async () => {
    const broker = new InterventionBroker(token);
    const { record, calls } = hooks({ accepted: false, code: 'DIALOG_STILL_PRESENT' });
    const intervention = broker.open(input, record);
    void intervention.wait(60_000);
    await broker.claim(intervention.id, 'alice');
    expect(await broker.resume(intervention.id, 'alice', 'retry_step')).toEqual({ ok: false, status: 409, code: 'DIALOG_STILL_PRESENT' });
    expect(broker.list()[0]).toMatchObject({ state: 'human_control', controlOwner: 'human' });
    expect(intervention.record().transitions.at(-1)).toMatchObject({ state: 'human_control', code: 'DIALOG_STILL_PRESENT' });
    expect(calls).not.toContain('release');
  });

  it('sanitizes validator failures and malformed codes', async () => {
    const broker = new InterventionBroker(token);
    const throwing = hooks().record;
    throwing.validate = vi.fn(() => Promise.reject(new Error('private detail')));
    const first = broker.open(input, throwing);
    void first.wait(60_000);
    await broker.claim(first.id, 'alice');
    expect(await broker.resume(first.id, 'alice', 'skip_step')).toEqual({ ok: false, status: 409, code: 'VALIDATION_FAILED' });
    await broker.resume(first.id, 'alice', 'abort');

    const odd = hooks({ accepted: false, code: 'not a code' }).record;
    const second = broker.open(input, odd);
    void second.wait(60_000);
    await broker.claim(second.id, 'alice');
    expect(await broker.resume(second.id, 'alice', 'skip_step')).toEqual({ ok: false, status: 409, code: 'RESUME_REJECTED' });
  });

  it('serialises resume requests: a second request during validation is refused', async () => {
    const broker = new InterventionBroker(token);
    let finish: (value: Validation) => void = () => {};
    const record = hooks().record;
    record.validate = vi.fn(() => new Promise<Validation>((resolve) => { finish = resolve; }));
    const intervention = broker.open(input, record);
    const waiting = intervention.wait(60_000);
    await broker.claim(intervention.id, 'alice');
    const inFlight = broker.resume(intervention.id, 'alice', 'retry_step');
    await Promise.resolve();
    expect(await broker.resume(intervention.id, 'alice', 'abort')).toEqual({ ok: false, status: 409, code: 'VALIDATION_IN_PROGRESS' });
    finish({ accepted: true });
    expect(await inFlight).toEqual({ ok: true, state: 'resumed' });
    await expect(waiting).resolves.toMatchObject({ kind: 'resumed', action: 'retry_step' });
  });

  it('aborts and expires cleanly, releasing the browser only if a human held it', async () => {
    const broker = new InterventionBroker(token);
    const aborted = hooks();
    const first = broker.open(input, aborted.record);
    const firstWait = first.wait(60_000);
    await broker.claim(first.id, 'alice');
    expect(await broker.resume(first.id, 'alice', 'abort')).toEqual({ ok: true, state: 'aborted' });
    await expect(firstWait).resolves.toEqual({ kind: 'aborted', operatorId: 'alice' });
    expect(aborted.calls).toEqual(['claim:alice', 'release']);

    const expired = hooks();
    const second = broker.open(input, expired.record);
    const secondWait = second.wait(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(secondWait).resolves.toEqual({ kind: 'expired' });
    expect(expired.calls).toEqual([]);
    expect(second.record()).toMatchObject({ state: 'expired', humanActions: [] });
    expect(await broker.claim(second.id, 'alice')).toEqual({ ok: false, status: 409, code: 'INTERVENTION_CLOSED' });

    const closed = hooks();
    const third = broker.open(input, closed.record);
    const thirdWait = third.wait(60_000);
    await broker.claim(third.id, 'erin');
    await broker.close(third.id);
    await expect(thirdWait).resolves.toEqual({ kind: 'expired' });
    expect(closed.calls).toEqual(['claim:erin', 'release']);
  });

  it('rejects malformed opens, double opens, bad operators, unknown ids, and bad wait budgets', async () => {
    const broker = new InterventionBroker(token);
    expect(() => broker.open({ ...input, path: '/anything' }, hooks().record)).toThrow('Invalid intervention');
    expect(() => broker.open({ ...input, stepId: 'not valid' }, hooks().record)).toThrow('Invalid intervention');
    const intervention = broker.open(input, hooks().record);
    expect(() => broker.open(input, hooks().record)).toThrow('already open');
    expect(() => intervention.wait(0)).toThrow('Invalid wait budget');
    expect(await broker.claim(intervention.id, 'not an id')).toEqual({ ok: false, status: 409, code: 'INVALID_OPERATOR' });
    expect(await broker.claim(intervention.id, { toString: () => 'alice' })).toEqual({ ok: false, status: 409, code: 'INVALID_OPERATOR' });
    expect(await broker.claim('iv_missing', 'alice')).toEqual({ ok: false, status: 404, code: 'INTERVENTION_NOT_FOUND' });
    expect(await broker.resume(undefined, 'alice', 'abort')).toEqual({ ok: false, status: 404, code: 'INTERVENTION_NOT_FOUND' });
    expect(await broker.resume(intervention.id, 'alice', 'abort')).toEqual({ ok: false, status: 409, code: 'NOT_UNDER_HUMAN_CONTROL' });
  });

  it('records sanitized human actions only while a human owns control', async () => {
    const broker = new InterventionBroker(token);
    const intervention = broker.open(input, hooks().record);
    void intervention.wait(60_000);
    broker.recordHumanAction(intervention.id, { action: 'click', outcome: 'recorded', path: '/notice' });
    expect(intervention.record().humanActions).toEqual([]);
    await broker.claim(intervention.id, 'alice');
    broker.recordHumanAction(intervention.id, { action: 'submit', targetKey: 'operator_notice_acknowledge', outcome: 'allowed', path: '/notice' });
    broker.recordHumanAction(intervention.id, { action: 'submit', outcome: 'blocked', path: 'http://evil.example/steal?x=1' });
    broker.recordHumanAction(intervention.id, { action: 'typed value: 12345', outcome: 'recorded', path: '/notice' });
    expect(intervention.record().humanActions).toEqual([
      expect.objectContaining({ action: 'submit', targetKey: 'operator_notice_acknowledge', outcome: 'allowed', path: '/notice' }),
    ]);
    expect(broker.list()[0]).not.toHaveProperty('humanActions');
    expect(JSON.stringify(broker.list())).not.toContain(token);
  });

  it('restores waiting when the claim hook fails so another operator can try', async () => {
    const broker = new InterventionBroker(token);
    const record = hooks().record;
    record.onClaim = vi.fn().mockRejectedValueOnce(new Error('browser gone')).mockResolvedValue(undefined);
    const intervention = broker.open(input, record);
    void intervention.wait(60_000);
    expect(await broker.claim(intervention.id, 'alice')).toEqual({ ok: false, status: 500, code: 'CLAIM_FAILED' });
    expect(broker.list()[0]).toMatchObject({ state: 'waiting', controlOwner: 'none' });
    expect(broker.list()[0]).not.toHaveProperty('operatorId');
    expect(await broker.claim(intervention.id, 'bob')).toMatchObject({ ok: true, view: { operatorId: 'bob' } });
  });
});
