import { parseExtraction } from '../artifact/bindings.js';
import type { Target } from '../artifact/schema.js';
import type { PlaywrightAdapter } from '../surface/playwright-adapter.js';
import { DiscoveryError } from './contracts.js';

export type DiscoverySurface = Pick<PlaywrightAdapter,
  'authenticate' | 'observe' | 'capture' | 'resolve' | 'act' | 'navigate' | 'unknownDialog' | 'checkCondition' | 'documentState' | 'snapshot' | 'health' | 'close'>;
export type ReadEvidence = {
  field: 'memberId' | 'savingsBalanceCents' | 'currency';
  scope: 'main' | 'frame'; target: Target; framePath: string; targetKey: string;
};

/** Acceptance criteria, not navigation instructions. Every target comes from a model-selected live ref. */
export async function readGoalField(surface: DiscoverySurface, ref: string, field: ReadEvidence['field'], memberId: string, expectedState?: string) {
  const captured = await surface.capture(ref);
  const scope = captured.target.scope?.frames.length ? 'frame' : 'main';
  const key = field === 'memberId' ? 'member_identity' : field === 'currency' ? 'currency' : 'savings_balance';
  if (captured.targetKey !== key) throw new DiscoveryError('FIELD_MISMATCH');
  if ((field !== 'memberId' && scope !== 'frame')
    || captured.framePath !== `/members/${memberId}${scope === 'frame' ? '/accounts' : ''}`) {
    throw new DiscoveryError('WRONG_MEMBER');
  }
  if (expectedState !== undefined && await surface.documentState() !== expectedState) throw new DiscoveryError('STATE_CHANGED');
  const raw = await surface.act(ref, 'extract');
  if (expectedState !== undefined && await surface.documentState() !== expectedState) throw new DiscoveryError('STATE_CHANGED');
  if (raw === undefined) throw new DiscoveryError('EXTRACTION_FAILED');
  let value: string | number | boolean;
  try { value = parseExtraction(raw, field === 'savingsBalanceCents' ? 'usd_cents' : 'text'); }
  catch { throw new DiscoveryError('EXTRACTION_FAILED'); }
  if (field === 'memberId' && value !== memberId) throw new DiscoveryError('WRONG_MEMBER');
  if (field === 'currency' && value !== 'USD') throw new DiscoveryError('UNSUPPORTED_CURRENCY');
  const evidence: ReadEvidence = { field, scope, target: captured.target, framePath: captured.framePath, targetKey: key };
  return { evidence, value, raw };
}

export async function verifyBalanceCompletion(surface: DiscoverySurface, reads: readonly ReadEvidence[], memberId: string) {
  const required = ['memberId:main', 'memberId:frame', 'savingsBalanceCents:frame', 'currency:frame'];
  const fields = new Map(reads.map((read) => [`${read.field}:${read.scope}`, read]));
  if (required.some((key) => !fields.has(key))) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  const state = await surface.documentState();
  let cents: number | undefined;
  for (const key of required) {
    const original = fields.get(key)!;
    const current = await surface.resolve(original.target, { memberId });
    const checked = await readGoalField(surface, current.ref, original.field, memberId, state);
    if (checked.evidence.scope !== original.scope || checked.evidence.framePath !== original.framePath) throw new DiscoveryError('WRONG_MEMBER');
    if (original.field === 'savingsBalanceCents') {
      if (typeof checked.value !== 'number') throw new DiscoveryError('EXTRACTION_FAILED');
      cents = checked.value;
    }
  }
  if (await surface.documentState() !== state) throw new DiscoveryError('STATE_CHANGED');
  surface.health();
  if (cents === undefined) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  return { savingsBalanceCents: cents, currency: 'USD' as const };
}

export async function verifyBusinessOutcome(surface: DiscoverySurface, ref: string, outcome: 'member_not_found' | 'invalid_member_id', submittedMember: string | undefined, memberId: string) {
  const captured = await surface.capture(ref);
  if (submittedMember !== memberId || captured.framePath !== '/members/search' || captured.target.scope?.frames.length
    || captured.role !== 'alert') throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  const text = outcome === 'member_not_found' ? 'No member found' : 'Member ID must be 5 digits';
  if (!await surface.checkCondition({ kind: 'text_equals', target: captured.target,
    expected: { source: 'literal', value: text } }, { memberId })) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  return outcome === 'member_not_found' ? 'MEMBER_NOT_FOUND' : 'INVALID_MEMBER_ID';
}
