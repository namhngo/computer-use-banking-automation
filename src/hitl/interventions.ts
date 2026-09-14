import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { evidencePathSchema } from '../evidence/evidence.js';
import type { InterventionRecord } from '../evidence/evidence.js';

/**
 * Control-transfer state machine for one automation run:
 *
 *   waiting -> human_control -> validating -> resumed
 *                    ^              |
 *                    +-- rejected --+          (any open state) -> aborted | expired
 *
 * The engine blocks on `wait()`; an operator drives transitions through the loopback HTTP
 * server. Ownership is explicit: only the claiming operator may resume, resume is validated by
 * the engine against the live page before automation gets control back, and a rejected resume
 * leaves the human in control rather than guessing.
 */

export const identifierSchema = z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
export const resumeActionSchema = z.enum(['retry_step', 'skip_step', 'abort']);
export type ResumeAction = z.infer<typeof resumeActionSchema>;
export type InterventionState = InterventionRecord['state'];
export type Resolution =
  | { kind: 'resumed'; action: 'retry_step' | 'skip_step'; operatorId: string }
  | { kind: 'aborted'; operatorId: string }
  | { kind: 'expired' };
export type Validation = { accepted: true } | { accepted: false; code: string };
export type InterventionHooks = {
  /** Called with the operator's request while they still own control; checks the live page. */
  validate(action: 'retry_step' | 'skip_step'): Promise<Validation>;
  /** Called exactly once when a claim succeeds; enables recording and human-permitted submissions. */
  onClaim(operatorId: string): Promise<void>;
  /** Called exactly once when the human no longer owns the browser. */
  onRelease(): Promise<void>;
};
export type InterventionView = {
  id: string; runId: string; stepId: string; reason: string; path: string; state: InterventionState;
  createdAt: string; controlOwner: 'none' | 'human'; operatorId?: string;
};
export type BrokerFailure = { ok: false; status: 404 | 409 | 500; code: string };
type Entry = {
  view: InterventionView;
  record: InterventionRecord;
  hooks: InterventionHooks;
  resolve: (resolution: Resolution) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const openSchema = z.strictObject({
  runId: identifierSchema, stepId: identifierSchema, reason: identifierSchema, path: evidencePathSchema,
});
const humanActionSchema = z.strictObject({
  action: identifierSchema, effect: identifierSchema, outcome: identifierSchema, path: evidencePathSchema,
});
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const now = () => new Date().toISOString();

export class InterventionBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly token: Buffer;

  constructor(token: string, private readonly listeners: { onOpen?: (view: InterventionView) => void } = {}) {
    if (!/^[a-f0-9]{48,128}$/.test(token)) throw new Error('Invalid operator token.');
    this.token = Buffer.from(token, 'utf8');
  }

  static generateToken(): string {
    return randomBytes(24).toString('hex');
  }

  /** Constant-time bearer check. The token is per run and shown only on the operator's console. */
  authorize(header: string | undefined): boolean {
    if (typeof header !== 'string') return false;
    const match = /^Bearer ([a-f0-9]{48,128})$/.exec(header);
    if (!match) return false;
    const presented = Buffer.from(match[1]!, 'utf8');
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }

  open(input: unknown, hooks: InterventionHooks): { id: string; wait(timeoutMs: number): Promise<Resolution>; record(): InterventionRecord } {
    const parsed = openSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid intervention.');
    if ([...this.entries.values()].some((entry) => !entry.settled)) throw new Error('An intervention is already open.');
    const id = `iv_${randomUUID().replaceAll('-', '')}`;
    const createdAt = now();
    let resolve: (resolution: Resolution) => void = () => {};
    const resolution = new Promise<Resolution>((done) => { resolve = done; });
    const entry: Entry = {
      view: { id, ...parsed.data, state: 'waiting', createdAt, controlOwner: 'none' },
      record: { id, ...parsed.data, createdAt, closedAt: createdAt, state: 'waiting',
        transitions: [{ state: 'waiting', at: createdAt }], humanActions: [] },
      hooks, resolve, settled: false,
    };
    this.entries.set(id, entry);
    try { this.listeners.onOpen?.({ ...entry.view }); } catch { /* Console listeners must not affect the run. */ }
    return {
      id,
      wait: (timeoutMs: number) => {
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid wait budget.');
        entry.timer = setTimeout(() => { void this.expire(entry); }, timeoutMs);
        return resolution;
      },
      record: () => structuredClone(entry.record),
    };
  }

  list(): InterventionView[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.view }));
  }

  async claim(id: unknown, operatorId: unknown): Promise<{ ok: true; view: InterventionView } | BrokerFailure> {
    const entry = this.lookup(id);
    if (!entry) return { ok: false, status: 404, code: 'INTERVENTION_NOT_FOUND' };
    const operator = identifierSchema.safeParse(operatorId);
    if (!operator.success) return { ok: false, status: 409, code: 'INVALID_OPERATOR' };
    if (entry.settled) return { ok: false, status: 409, code: 'INTERVENTION_CLOSED' };
    if (entry.view.state !== 'waiting') return { ok: false, status: 409, code: 'ALREADY_CLAIMED' };
    // Take ownership before the asynchronous hook so a competing claim cannot interleave.
    this.transition(entry, 'human_control', { operatorId: operator.data });
    try {
      await entry.hooks.onClaim(operator.data);
    } catch {
      this.transition(entry, 'waiting');
      delete entry.view.operatorId;
      delete entry.record.operatorId;
      entry.view.controlOwner = 'none';
      return { ok: false, status: 500, code: 'CLAIM_FAILED' };
    }
    return { ok: true, view: { ...entry.view } };
  }

  async resume(id: unknown, operatorId: unknown, action: unknown): Promise<{ ok: true; state: InterventionState } | BrokerFailure> {
    const entry = this.lookup(id);
    if (!entry) return { ok: false, status: 404, code: 'INTERVENTION_NOT_FOUND' };
    const parsedAction = resumeActionSchema.safeParse(action);
    if (!parsedAction.success) return { ok: false, status: 409, code: 'INVALID_ACTION' };
    if (entry.settled) return { ok: false, status: 409, code: 'INTERVENTION_CLOSED' };
    if (entry.view.state === 'validating') return { ok: false, status: 409, code: 'VALIDATION_IN_PROGRESS' };
    if (entry.view.state !== 'human_control') return { ok: false, status: 409, code: 'NOT_UNDER_HUMAN_CONTROL' };
    const operator = entry.view.operatorId;
    if (operator === undefined || operator !== operatorId) return { ok: false, status: 409, code: 'NOT_OWNER' };
    if (parsedAction.data === 'abort') {
      await this.settle(entry, 'aborted', { kind: 'aborted', operatorId: operator });
      return { ok: true, state: 'aborted' };
    }
    this.transition(entry, 'validating');
    let validation: Validation;
    try {
      validation = await entry.hooks.validate(parsedAction.data);
    } catch {
      validation = { accepted: false, code: 'VALIDATION_FAILED' };
    }
    if (entry.settled) return { ok: false, status: 409, code: 'INTERVENTION_CLOSED' };
    if (!validation.accepted) {
      const code = codePattern.test(validation.code) ? validation.code : 'RESUME_REJECTED';
      this.transition(entry, 'human_control', { code });
      return { ok: false, status: 409, code };
    }
    await this.settle(entry, 'resumed', { kind: 'resumed', action: parsedAction.data, operatorId: operator });
    return { ok: true, state: 'resumed' };
  }

  /** Records a sanitized operator action in the same browser; values are never accepted here. */
  recordHumanAction(id: string, action: { action: string; effect: string; outcome: string; path: string }): void {
    const entry = this.entries.get(id);
    const parsed = humanActionSchema.safeParse(action);
    if (!entry || !parsed.success || entry.view.state !== 'human_control' || entry.record.humanActions.length >= 200) return;
    entry.record.humanActions.push({ ...parsed.data, at: now() });
  }

  /** Closes an open intervention from the engine side, e.g. when the run itself fails. */
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry && !entry.settled) await this.settle(entry, 'expired', { kind: 'expired' });
  }

  private lookup(id: unknown): Entry | undefined {
    return typeof id === 'string' ? this.entries.get(id) : undefined;
  }

  private transition(entry: Entry, state: InterventionState, extra: { operatorId?: string; code?: string } = {}) {
    const at = now();
    entry.view.state = state;
    entry.record.state = state;
    if (extra.operatorId !== undefined) {
      entry.view.operatorId = extra.operatorId;
      entry.record.operatorId = extra.operatorId;
    }
    entry.view.controlOwner = state === 'human_control' || state === 'validating' ? 'human' : 'none';
    if (entry.record.transitions.length < 40) {
      entry.record.transitions.push({ state, at, ...(extra.code === undefined ? {} : { code: extra.code }) });
    }
  }

  private async settle(entry: Entry, state: 'resumed' | 'aborted' | 'expired', resolution: Resolution) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    const hadHuman = entry.view.controlOwner === 'human';
    this.transition(entry, state);
    entry.record.closedAt = now();
    if (hadHuman) {
      try {
        await entry.hooks.onRelease();
      } catch {
        // Release failures surface through the adapter's own health, not through the operator API.
      }
    }
    entry.resolve(resolution);
  }

  private async expire(entry: Entry) {
    if (!entry.settled) await this.settle(entry, 'expired', { kind: 'expired' });
  }
}
