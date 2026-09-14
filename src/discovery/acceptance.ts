import { parseExtraction } from '../artifact/bindings.js';
import type { Target } from '../artifact/schema.js';
import type { PlaywrightAdapter } from '../surface/playwright-adapter.js';
import { DiscoveryError, type GoalSpec } from './contracts.js';

/**
 * Goal-agnostic acceptance. The model chooses what to read; this module decides whether what it
 * read proves the claim, using only the GoalSpec it declared:
 *
 *   - an input read must equal the declared input value (an identity check);
 *   - an output read must parse with its declared parser;
 *   - a success claim needs every output, and for each output's document every input read back
 *     in that same document, all re-verified under one unchanged document state;
 *   - a business outcome needs a live message element on a page reached by submitting every input.
 *
 * Nothing here knows a route, a label, a field name or an application.
 */

export type DiscoverySurface = Pick<PlaywrightAdapter,
  'authenticate' | 'observe' | 'capture' | 'resolve' | 'act' | 'navigate' | 'unknownDialog' | 'checkCondition'
  | 'documentState' | 'snapshot' | 'health' | 'close' | 'startHumanControl' | 'stopHumanControl' | 'page' | 'canonicalPath'>;

export type ReadEvidence = {
  name: string; kind: 'input' | 'output'; target: Target; framePath: string; effect: 'read';
};
export type ReadValue = string | number | boolean;

export function inputValues(spec: GoalSpec): Record<string, string> {
  return Object.fromEntries(Object.entries(spec.inputs).map(([name, input]) => [name, input.value]));
}

/** Reads one declared name from a model-selected live ref and checks it against the contract. */
export async function readDeclared(surface: DiscoverySurface, spec: GoalSpec, ref: string, name: string, expectedState?: string) {
  const kind = name in spec.inputs ? 'input' : name in spec.outputs ? 'output' : undefined;
  if (!kind) throw new DiscoveryError('INVALID_DECISION');
  const captured = await surface.capture(ref);
  if (captured.effect.kind !== 'read' && captured.effect.kind !== 'navigate') throw new DiscoveryError('FIELD_MISMATCH');
  if (expectedState !== undefined && await surface.documentState() !== expectedState) throw new DiscoveryError('STATE_CHANGED');
  const raw = await surface.act(ref, 'extract');
  if (expectedState !== undefined && await surface.documentState() !== expectedState) throw new DiscoveryError('STATE_CHANGED');
  if (raw === undefined) throw new DiscoveryError('EXTRACTION_FAILED');
  let value: ReadValue;
  try { value = parseExtraction(raw, kind === 'input' ? 'text' : spec.outputs[name]!.parser); }
  catch { throw new DiscoveryError('EXTRACTION_FAILED'); }
  if (kind === 'input' && value !== spec.inputs[name]!.value) throw new DiscoveryError('WRONG_IDENTITY');
  const evidence: ReadEvidence = { name, kind, target: captured.target, framePath: captured.framePath, effect: 'read' };
  return { evidence, value, raw };
}

/**
 * Re-verifies every read a success claim depends on, under one document state, and returns the
 * outputs as read during verification (not as remembered from earlier turns).
 */
export async function verifySuccess(surface: DiscoverySurface, spec: GoalSpec, reads: readonly ReadEvidence[]) {
  const inputs = Object.keys(spec.inputs);
  const outputs = Object.keys(spec.outputs);
  const byKey = new Map(reads.map((read) => [`${read.name}@${read.framePath}`, read]));
  // Every identity read the model made is re-verified, plus the latest read of each output.
  const required: ReadEvidence[] = reads.filter((read) => read.kind === 'input');
  for (const output of outputs) {
    const read = reads.filter((candidate) => candidate.name === output).at(-1);
    if (!read) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
    required.push(read);
    for (const input of inputs) {
      if (!byKey.has(`${input}@${read.framePath}`)) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
    }
  }
  const state = await surface.documentState();
  const values: Record<string, ReadValue> = {};
  const bindings = inputValues(spec);
  for (const original of required) {
    const current = await surface.resolve(original.target, bindings);
    const checked = await readDeclared(surface, spec, current.ref, original.name, state);
    if (checked.evidence.framePath !== original.framePath) throw new DiscoveryError('WRONG_IDENTITY');
    if (original.kind === 'output') values[original.name] = checked.value;
  }
  if (await surface.documentState() !== state) throw new DiscoveryError('STATE_CHANGED');
  surface.health();
  if (outputs.some((output) => !(output in values))) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  return values;
}

/**
 * Confirms a claimed business outcome on a live message: a status/alert element in the main
 * document, on a page reached by submitting every declared input, whose text is still present.
 */
export async function verifyBusinessOutcome(surface: DiscoverySurface, spec: GoalSpec, ref: string, submitted: ReadonlySet<string>) {
  const inputs = Object.keys(spec.inputs);
  if (inputs.some((name) => !submitted.has(name))) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  const captured = await surface.capture(ref);
  if (captured.target.scope?.frames.length || !['alert', 'status', 'alertdialog'].includes(captured.role ?? '')) throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  const text = captured.target.strategies.find((strategy) => strategy.kind === 'text');
  if (!text || text.kind !== 'text' || text.text.source !== 'literal') throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  if (!await surface.checkCondition({ kind: 'text_equals', target: captured.target, expected: text.text }, inputValues(spec))) {
    throw new DiscoveryError('INCOMPLETE_EVIDENCE');
  }
  return captured;
}
