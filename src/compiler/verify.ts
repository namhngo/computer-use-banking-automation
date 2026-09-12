import { z } from 'zod';
import { validateValues } from '../artifact/bindings.js';
import type { FileCapabilityRegistry } from '../artifact/registry.js';
import { capabilityKeySchema, parseArtifact } from '../artifact/schema.js';
import type { CapabilityArtifact, CapabilityKey } from '../artifact/schema.js';
import type { ReplayResult } from '../artifact/result.js';
import type { Policy } from '../policy/policy.js';
import { runReplay } from '../replay/engine.js';

/**
 * Verifies a draft in fresh sandboxes and, on success, publishes a new verified revision.
 *
 * The draft revision is never mutated or overwritten. Every verification run starts from a
 * newly created target and browser at the declared entry path, never from the discovery
 * session. Only read-only capabilities are eligible; a write is never replayed to prove itself.
 */

export type VerificationTarget = { origin: string; policy: Policy; close(): Promise<void> };
export type VerificationAttempt = { runId: string; kind: ReplayResult['kind']; code?: string; evidence: string[] };
export type VerificationReport =
  | { kind: 'VERIFIED'; draft: CapabilityKey; verified: CapabilityKey; attempts: VerificationAttempt[] }
  | { kind: 'REJECTED'; draft: CapabilityKey; code: string; attempts: VerificationAttempt[] };

const optionsSchema = z.strictObject({
  /** At least two distinct invocations so a hardcoded value from discovery cannot pass. */
  inputs: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).min(2).max(5),
  credentials: z.strictObject({ username: z.string().min(1).max(4096), password: z.string().min(1).max(4096) }),
  evidenceRoot: z.string().min(1).max(4096).optional(),
  headless: z.boolean().optional(),
  verifiedAt: z.iso.datetime(),
});

export async function verifyDraft(options: {
  draft: unknown;
  registry: FileCapabilityRegistry;
  createTarget: () => Promise<VerificationTarget>;
} & z.input<typeof optionsSchema>): Promise<VerificationReport> {
  const { draft: draftInput, registry, createTarget, ...rest } = options;
  const parsedOptions = optionsSchema.safeParse(rest);
  if (!parsedOptions.success || typeof createTarget !== 'function') throw new Error('Invalid verification options.');
  const { inputs, credentials, evidenceRoot, headless, verifiedAt } = parsedOptions.data;
  const draft = parseArtifact(draftInput);
  if (draft.identity.status !== 'draft' || draft.verification) throw new Error('Only an unverified draft can be verified.');
  if (draft.risk !== 'read_only' || draft.steps.some((step) => step.risk !== 'read_only')) throw new Error('Writes are never automatically verified.');
  const distinct = new Set(inputs.map((values) => JSON.stringify(validateValues(draft.inputs, values))));
  if (distinct.size !== inputs.length) throw new Error('Verification inputs must be distinct.');

  // Persist the immutable draft first so a failed verification still leaves a reviewable record.
  const draftKey = await registry.save(draft, inputs.flatMap((values) => Object.values(values).map(String)));

  const attempts: VerificationAttempt[] = [];
  let lastRunId: string | undefined;
  for (const values of inputs) {
    const target = await createTarget();
    let result: ReplayResult;
    try {
      result = await runReplay({ artifact: draft, inputs: values, mode: 'verification', origin: target.origin, policy: target.policy,
        credentials, ...(evidenceRoot === undefined ? {} : { evidenceRoot }), ...(headless === undefined ? {} : { headless }) });
    } finally {
      await target.close();
    }
    attempts.push({ runId: result.runId, kind: result.kind, evidence: result.evidence,
      ...('code' in result ? { code: result.code } : {}) });
    if (result.kind !== 'SUCCESS') {
      return { kind: 'REJECTED', draft: draftKey, code: 'code' in result ? result.code : result.kind, attempts };
    }
    // runReplay already validated outputs against the declared contract; re-check here so a
    // future engine change cannot silently weaken what "verified" means.
    validateValues(draft.outputs, result.outputs);
    lastRunId = result.runId;
  }

  const verified: CapabilityArtifact = parseArtifact({
    ...structuredClone(draft),
    identity: { ...draft.identity, version: draft.identity.version + 1, status: 'verified' },
    verification: { runId: lastRunId!, verifiedAt },
  });
  const verifiedKey = capabilityKeySchema.parse(await registry.save(verified, inputs.flatMap((values) => Object.values(values).map(String))));
  return { kind: 'VERIFIED', draft: draftKey, verified: verifiedKey, attempts };
}
