import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArtifact } from '../artifact/schema.js';
import { transcriptSchema, type DiscoveryTranscript } from '../discovery/contracts.js';
import { compileTranscript, type CompileOptions } from './compile.js';

const success = transcriptSchema.parse(JSON.parse(readFileSync(new URL('../../evidence/agent/cold-savings/discovery/discovery.json', import.meta.url), 'utf8')));
const notFound = transcriptSchema.parse(JSON.parse(readFileSync(new URL('../../evidence/agent/cold-not-found/discovery/discovery.json', import.meta.url), 'utf8')));
const options: CompileOptions = {
  name: 'get_member_savings_balance', version: 1, app: { appId: 'harbor_core', appVersion: '1.0' },
  recordedAt: '2026-09-12T21:00:00.000Z', sensitiveValues: ['12345', 'synthetic-operator', 'synthetic-password'],
};
const compile = (transcript: unknown, overrides: Partial<CompileOptions> = {}) => compileTranscript(transcript, { ...options, ...overrides });
const failsWith = (code: string, transcript: unknown, overrides: Partial<CompileOptions> = {}) =>
  expect(() => compile(transcript, overrides)).toThrow(expect.objectContaining({ name: 'CompileError', code }) as Error);
const mutate = (edit: (copy: DiscoveryTranscript) => void): DiscoveryTranscript => {
  const copy = structuredClone(success);
  edit(copy);
  return copy;
};

describe('compileTranscript on the published live transcript', () => {
  const artifact = compile(success, { outcomeTranscripts: [notFound] });

  it('emits a valid draft with discovered provenance and no verification claim', () => {
    expect(parseArtifact(artifact)).toEqual(artifact);
    expect(artifact.identity).toMatchObject({ name: 'get_member_savings_balance', version: 1, status: 'draft' });
    expect(artifact.provenance).toEqual({ source: 'discovered', recordedAt: options.recordedAt, runId: success.runId, model: 'gpt-4.1' });
    expect(artifact.verification).toBeUndefined();
    expect(artifact.risk).toBe('read_only');
    expect(artifact.app).toEqual({ appId: 'harbor_core', appVersion: '1.0', surface: 'web', entryPath: '/members/search', requiresSession: true });
  });

  it('turns only confirmed dispatches into ordered steps and drops rejected proposals and identity reads', () => {
    expect(artifact.steps.map((step) => `${step.id}:${step.action}`)).toEqual([
      'entry:navigate', 'fill_t1:fill', 'click_t2:click', 'click_t3:click', 'extract_t5:extract',
    ]);
    // The identity read (turn 4) becomes the checkpoint, not a step; a rejected proposal never becomes one.
    expect(artifact.steps.some((step) => step.id.endsWith('_t4'))).toBe(false);
    const withRejected = compile(mutate((copy) => { copy.records.splice(3, 0, { turn: 4, tool: 'click', reason: 'inspect_state', status: 'rejected', code: 'STALE_REF' });
      copy.records.forEach((record, index) => { record.turn = index + 1; }); }));
    expect(withRejected.steps.some((step) => step.id.endsWith('_t4'))).toBe(false);
    expect(artifact.steps.find((step) => step.action === 'fill')).toMatchObject({ value: { source: 'input', name: 'member_id' } });
  });

  it('derives every postcondition from the control the model acted on next', () => {
    const [entry, , search, view] = artifact.steps;
    expect(entry).toMatchObject({ action: 'navigate', postcondition: { kind: 'all', conditions: [
      { kind: 'path_equals', path: '/members/search' }, { kind: 'visible', target: { strategies: [{ kind: 'label' }] } }] } });
    expect(search).toMatchObject({ action: 'click', postcondition: { kind: 'all', conditions: [
      { kind: 'path_equals', path: '/members/search' },
      { kind: 'visible', target: { strategies: [{ kind: 'role', role: 'link', name: { value: 'View member' } }, { kind: 'text' }] } }] } });
    // The member route is parameterized, so only the observed control is asserted, scoped to its frame.
    expect(view).toMatchObject({ action: 'click', postcondition: { kind: 'visible',
      target: { scope: { frames: [{ kind: 'css' }] }, strategies: [{ kind: 'text', text: { source: 'input', name: 'member_id' } }] } } });
  });

  it('declares typed outputs with parsers and an identity checkpoint in the document that shows them', () => {
    expect(Object.keys(artifact.outputs)).toEqual(['savings_balance']);
    expect(artifact.steps.filter((step) => step.action === 'extract').map((step) => step.action === 'extract' && [step.output, step.parser]))
      .toEqual([['savings_balance', 'usd_cents']]);
    expect(artifact.checkpoint).toMatchObject({ kind: 'text_equals', expected: { source: 'input', name: 'member_id' },
      target: { scope: { frames: [{ kind: 'css' }] } } });
  });

  it('adds business outcomes only from separate transcripts, with observed provenance', () => {
    expect(compile(success).outcomes).toEqual([]);
    expect(artifact.outcomes).toEqual([{ code: 'NO_MEMBER_FOUND', provenance: { source: 'observed', runId: notFound.runId },
      when: { kind: 'visible', target: { strategies: [{ kind: 'text', text: { source: 'literal', value: 'No member found' } }] } } }]);
    expect(artifact.failures).toEqual([]);
    expect(artifact.recoveries).toEqual([]);
  });

  it('never embeds the member value, credentials, or goal text', () => {
    const serialized = JSON.stringify(artifact);
    for (const value of ['12345', '99999', 'synthetic', 'look up member', '$1,234.56']) expect(serialized).not.toContain(value);
  });
});

describe('compileTranscript refuses what the transcript does not prove', () => {
  it('rejects malformed transcripts, options, and non-successful runs', () => {
    failsWith('COMPILE_INVALID_TRANSCRIPT', { ...success, records: 'invalid' });
    failsWith('COMPILE_INVALID_OPTIONS', success, { name: 'Invalid Name' });
    failsWith('COMPILE_INVALID_OPTIONS', success, { app: { appId: 'harbor_core', appVersion: 'latest' } });
    failsWith('COMPILE_NOT_SUCCESSFUL', notFound);
    failsWith('COMPILE_NOT_SUCCESSFUL', mutate((copy) => { copy.status = 'BLOCKED'; }));
  });

  it('derives the capability contract from the declared goal, not from a registry', () => {
    const artifact = compile(success);
    expect(Object.keys(artifact.inputs)).toEqual(['member_id']);
    expect(artifact.inputs.member_id).toMatchObject({ type: 'string', format: 'digits', minLength: 5, maxLength: 5, sensitive: true });
    expect(artifact.outputs.savings_balance).toMatchObject({ type: 'number', integer: true, sensitive: true });
    expect(artifact.identity.description).toContain(success.goal!.description);
    failsWith('COMPILE_NOT_SUCCESSFUL', { ...success, goal: null, records: [], status: 'CLARIFICATION_REQUIRED' });
    failsWith('COMPILE_HUMAN_ASSISTED', mutate((copy) => { copy.records[1]!.code = 'HUMAN_RESUMED'; }));
  });

  it('rejects flows without identity evidence, outputs, or a bound input', () => {
    failsWith('COMPILE_NO_IDENTITY_CHECK', mutate((copy) => { copy.records = copy.records.filter((record) => record.name !== 'member_id'); }));
    failsWith('COMPILE_MISSING_OUTPUT', mutate((copy) => { copy.records = copy.records.filter((record) => record.name !== 'savings_balance'); }));
    failsWith('COMPILE_UNBOUND_FILL', mutate((copy) => {
      const fill = copy.records.find((record) => record.tool === 'fill')!;
      fill.value = { source: 'literal', value: 'anything' };
    }));
    failsWith('COMPILE_NO_DISPATCHES', mutate((copy) => { copy.records = copy.records.map((record) => ({ ...record, status: 'rejected', target: undefined, effect: undefined, path: undefined, framePath: undefined, value: undefined, name: undefined })); }));
  });

  it('does not invent a postcondition for a click with no observed consequence', () => {
    failsWith('COMPILE_AMBIGUOUS_EFFECT', mutate((copy) => {
      const last = copy.records.findLastIndex((record) => record.status === 'succeeded' && record.tool !== 'complete');
      copy.records = [...copy.records.slice(0, last + 1), { turn: 49, tool: 'click', reason: 'inspect_state', status: 'succeeded',
        target: { strategies: [{ kind: 'text', text: { source: 'literal', value: 'Anything' } }] }, path: '/members/:id', framePath: '/members/:id' }];
    }));
  });

  it('rejects parameterized entry paths, unknown fields, and known sensitive literals', () => {
    failsWith('COMPILE_AMBIGUOUS_ENTRY', mutate((copy) => { copy.records[0]!.path = '/members/:id'; }));
    failsWith('COMPILE_AMBIGUOUS_ENTRY', mutate((copy) => {
      copy.records.splice(1, 0, { turn: 40, tool: 'navigate', reason: 'locate_record', status: 'succeeded', path: '/members/:id' });
    }));
    failsWith('COMPILE_SENSITIVE_LITERAL', mutate((copy) => {
      const search = copy.records.find((record) => record.tool === 'click')!;
      search.target = { strategies: [{ kind: 'text', text: { source: 'literal', value: 'synthetic-operator' } }] };
    }));
  });

  it('rejects outcome transcripts that are not confirmed business outcomes of the same goal', () => {
    failsWith('COMPILE_INVALID_OUTCOME', success, { outcomeTranscripts: [success] });
    failsWith('COMPILE_INVALID_OUTCOME', success, { outcomeTranscripts: [{ ...notFound, records: notFound.records.map((record) => ({ ...record, outcome: undefined })) }] });
    failsWith('COMPILE_INVALID_OUTCOME', success, { outcomeTranscripts: [notFound, notFound] });
    // A different contract (other outputs, other name) is not an outcome of this capability, however it ended.
    failsWith('COMPILE_INVALID_OUTCOME', success, { outcomeTranscripts: [{ ...notFound, goal: { ...notFound.goal!, name: 'get_member_checking_balance' } }] });
    failsWith('COMPILE_INVALID_TRANSCRIPT', success, { outcomeTranscripts: ['not a transcript'] });
  });

  it('keeps only the last confirmed read of a re-extracted output', () => {
    const artifact = compile(mutate((copy) => {
      const balance = copy.records.find((record) => record.name === 'savings_balance')!;
      copy.records.splice(copy.records.indexOf(balance), 0, { ...balance, turn: 4 });
      copy.records.forEach((record, index) => { record.turn = index + 1; });
    }));
    expect(artifact.steps.filter((step) => step.action === 'extract' && step.output === 'savings_balance')).toHaveLength(1);
  });
});
