import { z } from 'zod';
import { extractionParserSchema, identifierSchema, targetSchema, textValueSchema } from '../artifact/schema.js';

/**
 * Discovery contracts. Nothing here names a goal, a field, an outcome or a route: the model
 * declares a GoalSpec from the user's request and every later schema is derived from it.
 */

export { identifierSchema };
const codeSchema = z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/);
export const reasonSchema = z.enum(['inspect_state', 'enter_input', 'locate_record', 'read_value', 'wait_for_ui', 'confirm_completion', 'ask_human']);
export const refSchema = z.string().max(64).regex(/^e[0-9]+_[0-9]+$/);
const description = z.string().min(1).max(300).refine((value) => value === value.trim());

/**
 * What the model understood the goal to be, as a structured contract. Values are copied verbatim
 * from the goal text (the engine checks that), so the model cannot invent an identifier.
 *
 * Every input is an identity: the outputs must be read from a document that also displays each
 * input value. That is the generic form of "this balance belongs to the member you asked about".
 */
export const goalSpecSchema = z.strictObject({
  name: identifierSchema,
  description,
  inputs: z.record(identifierSchema, z.strictObject({
    value: z.string().min(1).max(200).refine((value) => value === value.trim()),
    description,
  })).refine((inputs) => Object.keys(inputs).length <= 4),
  outputs: z.record(identifierSchema, z.strictObject({
    parser: extractionParserSchema,
    description,
    sensitive: z.boolean(),
  })).refine((outputs) => Object.keys(outputs).length >= 1 && Object.keys(outputs).length <= 8),
}).refine((spec) => Object.keys(spec.inputs).every((name) => !(name in spec.outputs)));
export type GoalSpec = z.infer<typeof goalSpecSchema>;

export const intentSchema = z.strictObject({
  status: z.enum(['ready', 'clarify', 'unsupported']),
  goal: goalSpecSchema.nullable(),
}).refine((intent) => (intent.status === 'ready') === (intent.goal !== null));
export type DiscoveryIntent = z.infer<typeof intentSchema>;

/** Tool schemas are built per run so the model can only name inputs and outputs it declared. */
export function toolInputSchemas(spec: GoalSpec) {
  const inputNames = Object.keys(spec.inputs);
  const names = [...inputNames, ...Object.keys(spec.outputs)] as [string, ...string[]];
  const inputName = inputNames.length > 0 ? z.enum(inputNames as [string, ...string[]]) : z.never();
  return {
    fill: z.strictObject({ ref: refSchema, input: inputName, reason: reasonSchema }),
    click: z.strictObject({ ref: refSchema, reason: reasonSchema }),
    /** Naming an input reads it back as an identity check; naming an output records a result. */
    extract: z.strictObject({ ref: refSchema, name: z.enum(names), reason: reasonSchema }),
    navigate: z.strictObject({ path: z.string().max(200).regex(/^\/(?:[A-Za-z_-]+(?:\/[A-Za-z_-]+)*)?$/), reason: reasonSchema }),
    wait: z.strictObject({ ms: z.number().int().min(50).max(1000), reason: reasonSchema }),
    // Success is proven by recorded extracts, so its ref is ignored; a business outcome needs the
    // ref of the live message and an UPPER_SNAKE code naming it (e.g. MEMBER_NOT_FOUND).
    complete: z.strictObject({
      outcome: z.enum(['success', 'business_outcome']), code: codeSchema.nullable(), ref: refSchema.nullable(), reason: reasonSchema,
    }).refine((claim) => claim.outcome === 'success' ? claim.code === null : (claim.ref !== null && claim.code !== null)),
    request_human: z.strictObject({ reason: reasonSchema, code: z.enum(['stuck', 'unexpected_ui', 'credentials_required', 'permission_required']) }),
  };
}
export type ToolSchemas = ReturnType<typeof toolInputSchemas>;
export type ToolName = keyof ToolSchemas;
export type DiscoveryDecision = { [K in ToolName]: { tool: K; input: z.infer<ToolSchemas[K]> } }[ToolName];

export function parseDecision(schemas: ToolSchemas, tool: string, input: unknown): DiscoveryDecision {
  if (!Object.hasOwn(schemas, tool)) throw new Error('Invalid model decision.');
  const name = tool as ToolName;
  const result = schemas[name].safeParse(input);
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
  code: codeSchema.optional(),
  ref: refSchema.optional(),
  target: targetSchema.optional(),
  /** Structural effect the adapter measured for the dispatched node. */
  effect: z.enum(['read', 'navigate', 'input', 'submit']).optional(),
  framePath: z.string().max(250).optional(),
  path: z.string().max(250).optional(),
  value: textValueSchema.optional(),
  /** Input name (identity read) or output name (result read) for extract. */
  name: identifierSchema.optional(),
  ms: z.number().int().min(50).max(1000).optional(),
  /** Business outcome code the model claimed and the engine confirmed on a live message. */
  outcome: codeSchema.optional(),
});
export type DiscoveryRecord = z.infer<typeof recordSchema>;

/** The GoalSpec as persisted: names, parsers and descriptions, never the input values. */
export const transcriptGoalSchema = z.strictObject({
  name: identifierSchema,
  description,
  inputs: z.record(identifierSchema, z.strictObject({
    description, format: z.enum(['text', 'digits']), length: z.number().int().min(1).max(200),
  })),
  outputs: z.record(identifierSchema, z.strictObject({ parser: extractionParserSchema, description, sensitive: z.boolean() })),
});
export type TranscriptGoal = z.infer<typeof transcriptGoalSchema>;

export function transcriptGoal(spec: GoalSpec): TranscriptGoal {
  return transcriptGoalSchema.parse({
    name: spec.name, description: spec.description,
    inputs: Object.fromEntries(Object.entries(spec.inputs).map(([name, input]) => [name, {
      description: input.description, format: /^[0-9]+$/.test(input.value) ? 'digits' : 'text', length: input.value.length,
    }])),
    outputs: spec.outputs,
  });
}

export const transcriptSchema = z.strictObject({
  schemaVersion: z.literal(2), kind: z.literal('discovery_transcript'),
  source: z.enum(['live', 'test']), provider: z.string().max(100), modelId: z.string().max(100),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/), promptVersion: z.literal(2),
  goal: transcriptGoalSchema.nullable(),
  status: z.enum(['SUCCESS', 'BUSINESS_OUTCOME', 'CLARIFICATION_REQUIRED', 'UNSUPPORTED_GOAL', 'BLOCKED', 'FAILURE']),
  calls: z.array(z.strictObject({
    turn: z.number().int().min(0).max(50), phase: z.enum(['intent', 'action']),
    modelId: z.string().max(100), responseId: z.string().max(200).optional(), usage: usageSchema.nullable(),
    status: z.enum(['returned', 'failed']),
  })).max(51),
  records: z.array(recordSchema).max(50),
}).refine((transcript) => transcript.goal !== null || transcript.records.length === 0);
export type DiscoveryTranscript = z.infer<typeof transcriptSchema>;

const outputValue = z.union([z.string().max(4096), z.number().finite(), z.boolean()]);
export const discoveryResultSchema = z.strictObject({
  kind: z.enum(['SUCCESS', 'BUSINESS_OUTCOME', 'CLARIFICATION_REQUIRED', 'UNSUPPORTED_GOAL', 'BLOCKED', 'FAILURE']),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/),
  code: codeSchema,
  source: z.enum(['live', 'test']), turns: z.number().int().min(0).max(50),
  usage: usageSchema,
  usageComplete: z.boolean(),
  evidence: z.array(z.string().regex(/^[a-zA-Z0-9_-]+\.(?:json|jsonl)$/)).max(20),
  /** The declared contract, with the input values the user supplied, once intent succeeded. */
  goal: goalSpecSchema.optional(),
  outputs: z.record(identifierSchema, outputValue).optional(),
}).refine((result) => result.kind === 'SUCCESS' ? result.outputs !== undefined && result.goal !== undefined : result.outputs === undefined);
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;

export class DiscoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DiscoveryError';
  }
}
