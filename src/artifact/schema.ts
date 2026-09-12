import { z } from 'zod';

export const identifierSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/)
  .refine((name) => !['constructor', 'prototype'].includes(name));
const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const appVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/);
const pathSchema = z.string().max(300).regex(/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/);
const descriptionSchema = z.string().min(1).max(1000);
export const riskSchema = z.enum(['read_only', 'reversible', 'irreversible']);
export const scalarSchema = z.union([z.string().max(10_000), z.number().finite(), z.boolean()]);

export const capabilityKeySchema = z.strictObject({
  appId: identifierSchema,
  appVersion: appVersionSchema,
  name: identifierSchema,
  version: versionSchema,
});
export type CapabilityKey = z.infer<typeof capabilityKeySchema>;

export const textValueSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('literal'), value: z.string().max(1000) }),
  z.strictObject({ source: z.literal('input'), name: identifierSchema }),
]);
export type TextValue = z.infer<typeof textValueSchema>;

const fieldBase = { description: descriptionSchema, sensitive: z.boolean() };
export const fieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...fieldBase, type: z.literal('string'),
    format: z.enum(['text', 'digits']),
    minLength: z.number().int().min(0).max(10_000),
    maxLength: z.number().int().min(1).max(10_000),
  }),
  z.strictObject({
    ...fieldBase, type: z.literal('number'), integer: z.boolean(),
    minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  }),
  z.strictObject({ ...fieldBase, type: z.literal('boolean') }),
]);
export type FieldDefinition = z.infer<typeof fieldSchema>;

const selectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('role'),
    role: z.enum(['button', 'textbox', 'link', 'heading', 'row', 'cell', 'table', 'dialog', 'status', 'alert', 'combobox']),
    name: textValueSchema,
  }),
  z.strictObject({ kind: z.literal('label'), text: textValueSchema }),
  z.strictObject({ kind: z.literal('text'), text: textValueSchema }),
  z.strictObject({ kind: z.literal('css'), selector: z.string().min(1).max(500) }),
]);
export const targetSchema = z.strictObject({
  scope: z.strictObject({
    frames: z.array(selectorSchema).max(4),
    container: selectorSchema.optional(),
  }).optional(),
  strategies: z.array(z.union([
    selectorSchema,
    z.strictObject({
      kind: z.literal('table_cell'), row: textValueSchema,
      column: z.union([textValueSchema, z.number().int().min(1).max(30)]),
    }),
  ])).min(1).max(5),
});
export type Target = z.infer<typeof targetSchema>;

const leafConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('visible'), target: targetSchema }),
  z.strictObject({ kind: z.literal('text_equals'), target: targetSchema, expected: textValueSchema }),
  z.strictObject({ kind: z.literal('path_equals'), path: pathSchema }),
]);
export const conditionSchema = z.union([
  leafConditionSchema,
  z.strictObject({ kind: z.enum(['all', 'any']), conditions: z.array(leafConditionSchema).min(1).max(10) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

const stepBase = {
  id: identifierSchema,
  risk: riskSchema,
  waitFor: conditionSchema.optional(),
  postcondition: conditionSchema.optional(),
};
export const extractionParserSchema = z.enum(['text', 'integer', 'usd_cents', 'boolean']);
export type ExtractionParser = z.infer<typeof extractionParserSchema>;
export const stepSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...stepBase, action: z.literal('navigate'), path: pathSchema, postcondition: conditionSchema }),
  z.strictObject({ ...stepBase, action: z.literal('click'), target: targetSchema, postcondition: conditionSchema }),
  z.strictObject({ ...stepBase, action: z.literal('fill'), target: targetSchema, value: textValueSchema }),
  z.strictObject({ ...stepBase, action: z.literal('select'), target: targetSchema, value: textValueSchema, postcondition: conditionSchema }),
  z.strictObject({ ...stepBase, action: z.literal('extract'), target: targetSchema, output: identifierSchema, parser: extractionParserSchema }),
  z.strictObject({ ...stepBase, action: z.literal('wait'), condition: conditionSchema }),
]);
export type Step = z.infer<typeof stepSchema>;

const handlerSourceSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('authored') }),
  z.strictObject({ source: z.literal('observed'), runId: identifierSchema }),
]);
const outcomeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const handlerBase = { code: outcomeCodeSchema, when: conditionSchema, provenance: handlerSourceSchema };
const recoverySchema = z.strictObject({
  ...handlerBase,
  maxAttempts: z.number().int().min(1).max(3),
  recovery: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('reauthenticate'), resumeAt: identifierSchema }),
    z.strictObject({ kind: z.literal('dismiss'), target: targetSchema, postcondition: conditionSchema }),
  ]),
});

const artifactShape = z.strictObject({
  schemaVersion: z.literal(1),
  identity: z.strictObject({
    name: identifierSchema, version: versionSchema, description: descriptionSchema,
    status: z.enum(['draft', 'verified']),
  }),
  app: z.strictObject({
    appId: identifierSchema, appVersion: appVersionSchema, surface: z.literal('web'),
    entryPath: pathSchema, requiresSession: z.boolean(),
  }),
  risk: riskSchema,
  inputs: z.record(identifierSchema, fieldSchema),
  outputs: z.record(identifierSchema, fieldSchema),
  steps: z.array(stepSchema).min(1).max(40),
  outcomes: z.array(z.strictObject(handlerBase)).max(10),
  failures: z.array(z.strictObject(handlerBase)).max(10),
  recoveries: z.array(recoverySchema).max(5),
  limits: z.strictObject({
    stepTimeoutMs: z.number().int().min(100).max(30_000),
    runTimeoutMs: z.number().int().min(100).max(300_000),
    maxRecoveryAttempts: z.number().int().min(0).max(5),
  }),
  checkpoint: conditionSchema,
  provenance: z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('authored'), recordedAt: z.iso.datetime() }),
    z.strictObject({ source: z.literal('discovered'), recordedAt: z.iso.datetime(), runId: identifierSchema, model: z.string().min(1).max(100) }),
  ]),
  verification: z.strictObject({ runId: identifierSchema, verifiedAt: z.iso.datetime() }).optional(),
});

export const capabilityArtifactSchema = artifactShape.superRefine((artifact, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const definitions of [artifact.inputs, artifact.outputs]) {
    if (Object.keys(definitions).length > 32) invalid('Too many fields');
    for (const field of Object.values(definitions)) {
      if (field.type === 'string' && field.minLength > field.maxLength) invalid('Invalid string bounds');
      if (field.type === 'number' && field.minimum !== undefined && field.maximum !== undefined
        && field.minimum > field.maximum) invalid('Invalid number bounds');
    }
  }
  if (Object.keys(artifact.outputs).length === 0) invalid('At least one output is required');
  const ids = artifact.steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) invalid('Duplicate step IDs');
  const codes = [...artifact.outcomes, ...artifact.failures, ...artifact.recoveries].map((handler) => handler.code);
  if (new Set(codes).size !== codes.length) invalid('Duplicate handler codes');
  const risks = ['read_only', 'reversible', 'irreversible'] as const;
  const highestRisk = Math.max(...artifact.steps.map((step) => risks.indexOf(step.risk)));
  if (artifact.risk !== risks[highestRisk]) invalid('Aggregate risk does not match steps');
  if (artifact.identity.status === 'verified' && (!artifact.verification || artifact.risk !== 'read_only')) {
    invalid('Verification requires evidence and a read-only flow');
  }
  if (artifact.identity.status === 'draft' && artifact.verification) invalid('Draft cannot claim verification');
  if (artifact.limits.runTimeoutMs < artifact.limits.stepTimeoutMs) invalid('Invalid timeout bounds');

  const extracted = new Set<string>();
  for (const step of artifact.steps) {
    if (step.action !== 'extract') continue;
    const output = artifact.outputs[step.output];
    if (!output || extracted.has(step.output)) invalid('Missing or duplicate output declaration');
    extracted.add(step.output);
    if (step.parser === 'text' && output?.type !== 'string') invalid('Text parser requires string output');
    if (['integer', 'usd_cents'].includes(step.parser) && output?.type !== 'number') invalid('Numeric parser requires number output');
    if (step.parser === 'boolean' && output?.type !== 'boolean') invalid('Boolean parser requires boolean output');
    if (step.parser === 'usd_cents' && (output?.type !== 'number' || !output.integer)) invalid('Money uses integer cents');
  }
  for (const name of Object.keys(artifact.outputs)) {
    if (!extracted.has(name)) invalid('Declared output is never extracted');
  }
  for (const handler of artifact.recoveries) {
    if (handler.maxAttempts > artifact.limits.maxRecoveryAttempts) invalid('Recovery exceeds run budget');
    if (handler.recovery.kind === 'reauthenticate') {
      const first = artifact.steps[0];
      if (!artifact.app.requiresSession || first?.id !== handler.recovery.resumeAt
        || first.action !== 'navigate' || first.path !== artifact.app.entryPath || first.risk !== 'read_only') {
        invalid('Reauthentication must restart at the safe entry navigation');
      }
    }
  }
  // All references, including scoped locators and exception checks, share the input contract.
  function checkReferences(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(checkReferences); return; }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.source === 'input' && (typeof record.name !== 'string' || !Object.hasOwn(artifact.inputs, record.name))) {
      invalid('Unknown input reference');
    }
    Object.values(record).forEach(checkReferences);
  }
  checkReferences(artifact);
});
export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;

export function parseArtifact(value: unknown): CapabilityArtifact {
  const result = capabilityArtifactSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid capability artifact.');
  return result.data;
}
