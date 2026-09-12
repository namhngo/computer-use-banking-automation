import { z } from 'zod';
import { targetSchema, textValueSchema } from '../artifact/schema.js';

export const reasonSchema = z.enum(['inspect_state', 'enter_input', 'locate_record', 'read_value', 'wait_for_ui', 'confirm_completion', 'ask_human']);
export const refSchema = z.string().max(64).regex(/^e[0-9]+_[0-9]+$/);
export const fieldSchema = z.enum(['memberId', 'savingsBalanceCents', 'currency']);
export const intentSchema = z.strictObject({
  status: z.enum(['ready', 'clarify', 'unsupported']),
  memberId: z.string().regex(/^[0-9]{5}$/).nullable(),
}).refine((intent) => intent.status === 'ready' ? intent.memberId !== null : intent.memberId === null);
export type DiscoveryIntent = z.infer<typeof intentSchema>;

export const toolInputSchemas = {
  fill: z.strictObject({ ref: refSchema, input: z.literal('memberId'), reason: reasonSchema }),
  click: z.strictObject({ ref: refSchema, reason: reasonSchema }),
  extract: z.strictObject({ ref: refSchema, field: fieldSchema, reason: reasonSchema }),
  navigate: z.strictObject({ path: z.string().max(200).regex(/^\/(?:[A-Za-z_-]+(?:\/[A-Za-z_-]+)*)?$/), reason: reasonSchema }),
  wait: z.strictObject({ ms: z.number().int().min(50).max(1000), reason: reasonSchema }),
  // Success is proven by recorded extracts, so its ref is optional and ignored; a business outcome
  // needs the ref of the live message. Cross-field rules are invisible in JSON Schema, so keep them minimal.
  complete: z.strictObject({
    outcome: z.enum(['success', 'member_not_found', 'invalid_member_id']), ref: refSchema.nullable(), reason: reasonSchema,
  }).refine((claim) => claim.outcome === 'success' || claim.ref !== null),
  request_human: z.strictObject({ reason: reasonSchema, code: z.enum(['stuck', 'unexpected_ui', 'credentials_required', 'permission_required']) }),
};
export type ToolName = keyof typeof toolInputSchemas;
export type DiscoveryDecision = { [K in ToolName]: { tool: K; input: z.infer<(typeof toolInputSchemas)[K]> } }[ToolName];

export function parseDecision(tool: string, input: unknown): DiscoveryDecision {
  if (!Object.hasOwn(toolInputSchemas, tool)) throw new Error('Invalid model decision.');
  const name = tool as ToolName;
  const result = toolInputSchemas[name].safeParse(input);
  if (!result.success) throw new Error('Invalid model decision.');
  return { tool: name, input: result.data } as DiscoveryDecision;
}

export const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
});
export type ModelUsage = z.infer<typeof usageSchema>;
export type ModelReply<T> = { value: T; usage: ModelUsage; modelId: string; responseId?: string };
export type ModelCallReceipt = { usage: ModelUsage; modelId?: string; responseId?: string };
export class ModelCallError extends Error {
  constructor(readonly receipt?: ModelCallReceipt) {
    super('Discovery model call failed.');
    this.name = 'ModelCallError';
  }
}

export const recordSchema = z.strictObject({
  turn: z.number().int().positive().max(50),
  tool: z.enum(['fill', 'click', 'extract', 'navigate', 'wait', 'complete', 'request_human']),
  reason: reasonSchema,
  status: z.enum(['succeeded', 'rejected', 'blocked']),
  code: z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  ref: refSchema.optional(),
  target: targetSchema.optional(),
  targetKey: z.string().max(64).regex(/^[a-z][a-z0-9_]*$/).optional(),
  framePath: z.string().max(250).optional(),
  path: z.string().max(250).optional(),
  value: textValueSchema.optional(),
  field: fieldSchema.optional(),
  ms: z.number().int().min(50).max(1000).optional(),
  outcome: z.enum(['member_not_found', 'invalid_member_id']).optional(),
});
export type DiscoveryRecord = z.infer<typeof recordSchema>;

export const transcriptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('discovery_transcript'),
  source: z.enum(['live', 'test']), provider: z.string().max(100), modelId: z.string().max(100),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/), promptVersion: z.literal(1),
  goalType: z.literal('member_savings_balance'), inputNames: z.tuple([z.literal('memberId')]),
  status: z.enum(['SUCCESS', 'BUSINESS_OUTCOME', 'CLARIFICATION_REQUIRED', 'UNSUPPORTED_GOAL', 'BLOCKED', 'FAILURE']),
  calls: z.array(z.strictObject({
    turn: z.number().int().min(0).max(50), phase: z.enum(['intent', 'action']),
    modelId: z.string().max(100), responseId: z.string().max(200).optional(), usage: usageSchema.nullable(),
    status: z.enum(['returned', 'failed']),
  })).max(51),
  records: z.array(recordSchema).max(50),
});
export type DiscoveryTranscript = z.infer<typeof transcriptSchema>;

export const discoveryResultSchema = z.strictObject({
  kind: z.enum(['SUCCESS', 'BUSINESS_OUTCOME', 'CLARIFICATION_REQUIRED', 'UNSUPPORTED_GOAL', 'BLOCKED', 'FAILURE']),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/),
  code: z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  source: z.enum(['live', 'test']), turns: z.number().int().min(0).max(50),
  usage: usageSchema,
  usageComplete: z.boolean(),
  evidence: z.array(z.string().regex(/^[a-zA-Z0-9_-]+\.(?:json|jsonl)$/)).max(20),
  outputs: z.strictObject({ savingsBalanceCents: z.number().int().safe(), currency: z.literal('USD') }).optional(),
}).refine((result) => result.kind === 'SUCCESS' ? result.outputs !== undefined : result.outputs === undefined);
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;

export class DiscoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DiscoveryError';
  }
}
