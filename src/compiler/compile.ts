import { z } from 'zod';
import { capabilityArtifactSchema, identifierSchema } from '../artifact/schema.js';
import type { CapabilityArtifact, Condition, ExtractionParser, FieldDefinition, Step, Target } from '../artifact/schema.js';
import { transcriptSchema } from '../discovery/contracts.js';
import type { DiscoveryRecord, DiscoveryTranscript } from '../discovery/contracts.js';

/**
 * Compiles a sanitized discovery transcript into a draft capability artifact.
 *
 * Conservative by construction: only confirmed dispatch receipts become steps, nothing is
 * reordered or pruned except later re-reads of the same output, every postcondition is a
 * fact the model itself acted on next, and identity reads become the checkpoint. Anything
 * the transcript does not prove is refused with COMPILE_* rather than guessed.
 */

export class CompileError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CompileError';
  }
}

type GoalContract = {
  description: string;
  inputs: Record<string, FieldDefinition>;
  outputs: Record<string, { field: FieldDefinition; parser: ExtractionParser }>;
  /** Extract fields that verify identity rather than produce outputs; each must equal the named input. */
  identity: Record<string, string>;
  outcomes: Record<string, string>;
};

/** Typed contract per supported goal family. The compiler knows shapes, never UI order or selectors. */
const goalContracts: Record<DiscoveryTranscript['goalType'], GoalContract> = {
  member_savings_balance: {
    description: 'Find a member by ID and return the savings balance in integer US cents with its currency. Discovered from a live UI session; steps and locators were captured at dispatch time.',
    inputs: {
      memberId: { type: 'string', format: 'digits', minLength: 5, maxLength: 5, sensitive: true,
        description: 'Member identifier supplied per invocation; preserve leading zeroes.' },
    },
    outputs: {
      savingsBalanceCents: { parser: 'usd_cents', field: { type: 'number', integer: true, sensitive: true,
        description: 'Savings balance in integer cents, parsed from the displayed USD amount.' } },
      currency: { parser: 'text', field: { type: 'string', format: 'text', minLength: 3, maxLength: 3, sensitive: false,
        description: 'Currency code displayed for the savings account.' } },
    },
    identity: { memberId: 'memberId' },
    outcomes: { member_not_found: 'MEMBER_NOT_FOUND', invalid_member_id: 'INVALID_MEMBER_ID' },
  },
};

const optionsSchema = z.strictObject({
  name: identifierSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  app: z.strictObject({ appId: identifierSchema, appVersion: z.string().regex(/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/) }),
  recordedAt: z.iso.datetime(),
  /** Additional transcripts whose terminal business outcome becomes an observed handler. */
  outcomeTranscripts: z.array(z.unknown()).max(10).default([]),
  /** Known invocation values and secrets that must not appear as literals anywhere in the output. */
  sensitiveValues: z.array(z.string().max(4096)).max(64).default([]),
});
export type CompileOptions = z.input<typeof optionsSchema>;

const parameterPath = /^\/members\/:memberId(?:\/|$)/;

function succeeded(records: readonly DiscoveryRecord[]): DiscoveryRecord[] {
  // The dispatcher records failed proposals without receipts; they had no effect and are not steps.
  return records.filter((record) => record.status === 'succeeded');
}

function literalPath(path: string | undefined): string | undefined {
  return path === undefined || parameterPath.test(path) ? undefined : path;
}

type LeafCondition = Extract<Condition, { target: Target } | { path: string }>;

function visible(target: Target): LeafCondition {
  return { kind: 'visible', target: structuredClone(target) };
}

/** A click or navigate is confirmed by the control the model acted on next, plus its literal path if known. */
function derivePostcondition(next: DiscoveryRecord | undefined): Condition {
  if (!next?.target) throw new CompileError('COMPILE_AMBIGUOUS_EFFECT');
  const path = literalPath(next.path);
  return path === undefined ? visible(next.target)
    : { kind: 'all', conditions: [{ kind: 'path_equals', path }, visible(next.target)] };
}

function stepId(prefix: string, turn: number): string {
  return `${prefix}_t${String(turn)}`;
}

export function compileTranscript(transcriptInput: unknown, optionsInput: CompileOptions): CapabilityArtifact {
  const parsedOptions = optionsSchema.safeParse(optionsInput);
  if (!parsedOptions.success) throw new CompileError('COMPILE_INVALID_OPTIONS');
  const options = parsedOptions.data;
  const parsedTranscript = transcriptSchema.safeParse(transcriptInput);
  if (!parsedTranscript.success) throw new CompileError('COMPILE_INVALID_TRANSCRIPT');
  const transcript = parsedTranscript.data;
  if (transcript.status !== 'SUCCESS') throw new CompileError('COMPILE_NOT_SUCCESSFUL');
  const contract = goalContracts[transcript.goalType];

  const dispatches = succeeded(transcript.records);
  if (dispatches.length === 0) throw new CompileError('COMPILE_NO_DISPATCHES');
  const entryPath = literalPath(dispatches[0]!.path);
  if (entryPath === undefined) throw new CompileError('COMPILE_AMBIGUOUS_ENTRY');

  // Keep the last successful read per output: the discovery engine re-verified every field
  // at completion, so earlier reads of the same output are the only confirmed redundancy.
  const lastReadTurn = new Map<string, number>();
  for (const record of dispatches) {
    if (record.tool === 'extract' && record.field && !(record.field in contract.identity)) lastReadTurn.set(record.field, record.turn);
  }

  const steps: Step[] = [];
  const identityChecks: LeafCondition[] = [];
  const outputs: CapabilityArtifact['outputs'] = {};
  steps.push({ id: 'entry', action: 'navigate', risk: 'read_only', path: entryPath, postcondition: derivePostcondition(dispatches[0]) });

  for (const [index, record] of dispatches.entries()) {
    const next = dispatches.slice(index + 1).find((candidate) => candidate.target !== undefined);
    switch (record.tool) {
      case 'fill': {
        if (!record.target || record.value?.source !== 'input' || !(record.value.name in contract.inputs)) throw new CompileError('COMPILE_UNBOUND_FILL');
        steps.push({ id: stepId('fill', record.turn), action: 'fill', risk: 'read_only', target: structuredClone(record.target), value: record.value });
        break;
      }
      case 'click': {
        if (!record.target) throw new CompileError('COMPILE_MISSING_TARGET');
        steps.push({ id: stepId('click', record.turn), action: 'click', risk: 'read_only', target: structuredClone(record.target), postcondition: derivePostcondition(next) });
        break;
      }
      case 'navigate': {
        const path = literalPath(record.path);
        if (path === undefined) throw new CompileError('COMPILE_AMBIGUOUS_ENTRY');
        steps.push({ id: stepId('navigate', record.turn), action: 'navigate', risk: 'read_only', path, postcondition: derivePostcondition(next) });
        break;
      }
      case 'extract': {
        if (!record.target || !record.field) throw new CompileError('COMPILE_MISSING_TARGET');
        const inputName = contract.identity[record.field];
        if (inputName !== undefined) {
          const check: LeafCondition = { kind: 'text_equals', target: structuredClone(record.target), expected: { source: 'input', name: inputName } };
          if (!identityChecks.some((existing) => JSON.stringify(existing) === JSON.stringify(check))) identityChecks.push(check);
          break;
        }
        const output = contract.outputs[record.field];
        if (!output) throw new CompileError('COMPILE_UNKNOWN_FIELD');
        if (lastReadTurn.get(record.field) !== record.turn) break;
        outputs[record.field] = output.field;
        steps.push({ id: stepId('extract', record.turn), action: 'extract', risk: 'read_only', target: structuredClone(record.target), output: record.field, parser: output.parser });
        break;
      }
      case 'wait':
        // Replay has explicit per-step waits and timeouts; an unconditioned pause carries no reusable fact.
        break;
      case 'complete':
        break;
      case 'request_human':
        throw new CompileError('COMPILE_NOT_SUCCESSFUL');
    }
  }
  if (identityChecks.length === 0) throw new CompileError('COMPILE_NO_IDENTITY_CHECK');
  for (const name of Object.keys(contract.outputs)) if (!(name in outputs)) throw new CompileError('COMPILE_MISSING_OUTPUT');

  const outcomes: CapabilityArtifact['outcomes'] = [];
  for (const candidate of options.outcomeTranscripts) {
    const parsed = transcriptSchema.safeParse(candidate);
    if (!parsed.success) throw new CompileError('COMPILE_INVALID_TRANSCRIPT');
    const evidence = parsed.data;
    const terminal = evidence.records.at(-1);
    if (evidence.status !== 'BUSINESS_OUTCOME' || evidence.goalType !== transcript.goalType || terminal?.tool !== 'complete'
      || terminal.status !== 'succeeded' || !terminal.target || !terminal.outcome) throw new CompileError('COMPILE_INVALID_OUTCOME');
    const code = contract.outcomes[terminal.outcome];
    if (!code || outcomes.some((outcome) => outcome.code === code)) throw new CompileError('COMPILE_INVALID_OUTCOME');
    outcomes.push({ code, when: visible(terminal.target), provenance: { source: 'observed', runId: evidence.runId } });
  }

  const artifact = {
    schemaVersion: 1,
    identity: { name: options.name, version: options.version, description: contract.description, status: 'draft' },
    app: { ...options.app, surface: 'web', entryPath, requiresSession: true },
    risk: 'read_only',
    inputs: contract.inputs,
    outputs,
    steps,
    outcomes,
    failures: [],
    recoveries: [],
    limits: { stepTimeoutMs: 5000, runTimeoutMs: 60_000, maxRecoveryAttempts: 0 },
    checkpoint: identityChecks.length === 1 ? identityChecks[0] : { kind: 'all', conditions: identityChecks },
    provenance: { source: 'discovered', recordedAt: options.recordedAt, runId: transcript.runId,
      model: transcript.source === 'live' ? transcript.modelId : `test:${transcript.modelId}` },
  };
  const validated = capabilityArtifactSchema.safeParse(artifact);
  if (!validated.success) throw new CompileError('COMPILE_INVALID_ARTIFACT');
  const serialized = JSON.stringify(validated.data);
  for (const value of options.sensitiveValues) {
    if (value && serialized.includes(JSON.stringify(value).slice(1, -1))) throw new CompileError('COMPILE_SENSITIVE_LITERAL');
  }
  return validated.data;
}
