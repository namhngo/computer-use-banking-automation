import { z } from 'zod';
import { replayResultSchema } from '../artifact/result.js';
import { capabilityKeySchema, identifierSchema } from '../artifact/schema.js';
import { discoveryResultSchema, usageSchema } from '../discovery/contracts.js';
import type { ModelReply } from '../discovery/contracts.js';

const identifier = identifierSchema;

/**
 * What the router model sees: the compatible catalog, nothing about the UI. Descriptions come
 * from artifacts (authored or compiled from trusted goal contracts), never from model output.
 */
export const catalogEntrySchema = z.strictObject({
  name: identifier,
  version: z.number().int().positive(),
  description: z.string().min(1).max(1000),
  risk: z.enum(['read_only', 'reversible']),
  inputs: z.record(identifier, z.strictObject({
    description: z.string().min(1).max(1000), type: z.enum(['string', 'number', 'boolean']),
    format: z.enum(['text', 'digits']).optional(), minLength: z.number().int().optional(), maxLength: z.number().int().optional(),
  })),
  outputs: z.record(identifier, z.strictObject({ description: z.string().min(1).max(1000), type: z.enum(['string', 'number', 'boolean']) })),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** One structured decision per goal. Only tool calls, no free text except a bounded question. */
export const routeToolSchemas = {
  execute: z.strictObject({
    capability: identifier, version: z.number().int().positive(),
    inputs: z.record(identifier, z.string().max(200)).refine((inputs) => Object.keys(inputs).length <= 8),
  }),
  discover: z.strictObject({
    reason: z.literal('no_compatible_capability'),
    /** Identifiers written explicitly in the goal, copied verbatim. Discovery re-derives its own contract. */
    inputs: z.record(identifier, z.string().min(1).max(200)).refine((inputs) => Object.keys(inputs).length <= 8),
  }),
  clarify: z.strictObject({
    reason: z.enum(['missing_input', 'ambiguous_input', 'ambiguous_goal']),
    question: z.string().min(1).max(300),
  }),
  unsupported: z.strictObject({
    reason: z.enum(['changes_data', 'not_a_read', 'unsafe_request']),
  }),
};
export type RouteTool = keyof typeof routeToolSchemas;
export type RouteDecision = { [K in RouteTool]: { tool: K; input: z.infer<(typeof routeToolSchemas)[K]> } }[RouteTool];

export function parseRouteDecision(tool: string, input: unknown): RouteDecision {
  if (!Object.hasOwn(routeToolSchemas, tool)) throw new Error('Invalid route decision.');
  const name = tool as RouteTool;
  const result = routeToolSchemas[name].safeParse(input);
  if (!result.success) throw new Error('Invalid route decision.');
  return { tool: name, input: result.data } as RouteDecision;
}

export type RouterModel = {
  source: 'live' | 'test';
  provider: string;
  modelId: string;
  secretValues: readonly string[];
  route(context: { goal: string; catalog: CatalogEntry[] }, signal: AbortSignal): Promise<ModelReply<RouteDecision>>;
};

const routingSchema = z.strictObject({
  decision: z.enum(['execute', 'discover', 'clarify', 'unsupported']).nullable(),
  modelId: z.string().max(100).optional(),
  responseId: z.string().max(200).optional(),
  usage: usageSchema,
  catalog: z.array(z.strictObject({ name: identifier, version: z.number().int().positive() })).max(50),
});
const compiledSchema = z.strictObject({
  draft: capabilityKeySchema,
  verified: capabilityKeySchema.nullable(),
  code: z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  verificationRuns: z.array(z.string().regex(/^run_[a-f0-9]{32}$/)).max(10),
});
const base = { agentRunId: z.string().regex(/^agent_[a-f0-9]{32}$/), source: z.enum(['live', 'test']), routing: routingSchema };

export const agentResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('EXECUTED'), capability: capabilityKeySchema, result: replayResultSchema }),
  z.strictObject({ ...base, kind: z.literal('DISCOVERED'), discovery: discoveryResultSchema, compiled: compiledSchema.nullable() }),
  z.strictObject({ ...base, kind: z.literal('CLARIFICATION_REQUIRED'), reason: routeToolSchemas.clarify.shape.reason, question: z.string().max(300) }),
  z.strictObject({ ...base, kind: z.literal('UNSUPPORTED_GOAL'), reason: routeToolSchemas.unsupported.shape.reason }),
  // A failure after a successful discovery keeps the discovery result: the goal was met even if promotion was not.
  z.strictObject({ ...base, kind: z.literal('FAILURE'), code: z.string().max(64).regex(/^[A-Z][A-Z0-9_]*$/), discovery: discoveryResultSchema.optional() }),
]);
export type AgentResult = z.infer<typeof agentResultSchema>;
