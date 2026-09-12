import { z } from 'zod';
import { identifierSchema, scalarSchema } from './schema.js';
import type { CapabilityArtifact } from './schema.js';
import { validateValues } from './bindings.js';

const codeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const base = {
  runId: identifierSchema,
  atStep: identifierSchema.nullable(),
  evidence: z.array(z.string().max(200).regex(/^[a-zA-Z0-9_-]+\.(?:jsonl|json|png)$/)).max(20),
  recoveries: z.array(z.strictObject({
    code: codeSchema, atStep: identifierSchema, attempt: z.number().int().min(1).max(5),
    outcome: z.enum(['recovered', 'exhausted']),
  })).max(5),
};

export const replayResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('SUCCESS'), outputs: z.record(identifierSchema, scalarSchema) }),
  z.strictObject({ ...base, kind: z.literal('BUSINESS_OUTCOME'), code: codeSchema }),
  z.strictObject({
    ...base, kind: z.literal('FAILURE'), code: codeSchema,
    message: z.string().min(1).max(1000), expected: z.string().max(1000).optional(), observed: z.string().max(1000).optional(),
  }),
  z.strictObject({ ...base, kind: z.literal('NEEDS_HUMAN'), interventionId: identifierSchema, reason: codeSchema }),
]);
export type ReplayResult = z.infer<typeof replayResultSchema>;

export function parseReplayResult(value: unknown, artifact?: CapabilityArtifact): ReplayResult {
  const result = replayResultSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid replay result.');
  const parsed = result.data;
  if (parsed.atStep === null && (parsed.kind !== 'FAILURE' || parsed.recoveries.length > 0)) {
    throw new Error('Only a pre-step failure can omit the current step.');
  }
  if (!artifact) {
    if (parsed.kind !== 'FAILURE' || parsed.atStep !== null || parsed.recoveries.length > 0) {
      throw new Error('A capability is required to validate this result.');
    }
    return parsed;
  }
  const ids = new Set(artifact.steps.map((step) => step.id));
  if ((parsed.atStep !== null && !ids.has(parsed.atStep)) || parsed.recoveries.length > artifact.limits.maxRecoveryAttempts) {
    throw new Error('Replay result references an unknown step or recovery.');
  }
  const attempts = new Map<string, number>();
  const exhausted = new Set<string>();
  for (const recovery of parsed.recoveries) {
    const expectedAttempt = (attempts.get(recovery.code) ?? 0) + 1;
    const handler = artifact.recoveries.find((candidate) => candidate.code === recovery.code);
    if (!ids.has(recovery.atStep) || !handler || exhausted.has(recovery.code)
      || expectedAttempt > handler.maxAttempts || recovery.attempt !== expectedAttempt) {
      throw new Error('Replay result references an unknown step or recovery.');
    }
    attempts.set(recovery.code, expectedAttempt);
    if (recovery.outcome === 'exhausted') exhausted.add(recovery.code);
  }
  if (parsed.kind === 'SUCCESS') {
    if (parsed.atStep !== artifact.steps.at(-1)?.id || exhausted.size > 0) {
      throw new Error('Success requires a completed flow without exhausted recoveries.');
    }
    validateValues(artifact.outputs, parsed.outputs);
  }
  if (parsed.kind === 'BUSINESS_OUTCOME' && !artifact.outcomes.some((outcome) => outcome.code === parsed.code)) {
    throw new Error('Undeclared business outcome.');
  }
  return parsed;
}
