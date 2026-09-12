import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArtifact } from '../artifact/schema.js';
import { transcriptSchema, type DiscoveryTranscript } from '../discovery/contracts.js';
import { compileTranscript, type CompileOptions } from './compile.js';

const success = transcriptSchema.parse(JSON.parse(readFileSync(new URL('../../evidence/discovery-phase4/success/discovery.json', import.meta.url), 'utf8')));
const notFound = transcriptSchema.parse(JSON.parse(readFileSync(new URL('../../evidence/discovery-phase4/not-found/discovery.json', import.meta.url), 'utf8')));
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
      'entry:navigate', 'fill_t1:fill', 'click_t2:click', 'click_t3:click', 'extract_t5:extract', 'extract_t6:extract',
    ]);
    const rejected = success.records.filter((record) => record.status !== 'succeeded');
    expect(rejected.length).toBeGreaterThan(0);
    for (const record of rejected) expect(artifact.steps.some((step) => step.id.endsWith(`_t${String(record.turn)}`))).toBe(false);
    expect(artifact.steps.find((step) => step.action === 'fill')).toMatchObject({ value: { source: 'input', name: 'memberId' } });
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
      target: { scope: { frames: [{ kind: 'css' }] }, strategies: [{ kind: 'text', text: { source: 'input', name: 'memberId' } }] } } });
  });

  it('declares typed outputs with parsers and an identity checkpoint in both documents', () => {
    expect(Object.keys(artifact.outputs).sort()).toEqual(['currency', 'savingsBalanceCents']);
    expect(artifact.steps.filter((step) => step.action === 'extract').map((step) => step.action === 'extract' && [step.output, step.parser]))
      .toEqual([['savingsBalanceCents', 'usd_cents'], ['currency', 'text']]);
    expect(artifact.checkpoint).toMatchObject({ kind: 'all' });
    const conditions = artifact.checkpoint.kind === 'all' ? artifact.checkpoint.conditions : [];
    expect(conditions).toHaveLength(2);
    expect(conditions.every((condition) => condition.kind === 'text_equals' && condition.expected.source === 'input')).toBe(true);
    expect(conditions.filter((condition) => 'target' in condition && condition.target.scope?.frames.length)).toHaveLength(1);
  });

  it('adds business outcomes only from separate transcripts, with observed provenance', () => {
    expect(compile(success).outcomes).toEqual([]);
    expect(artifact.outcomes).toEqual([{ code: 'MEMBER_NOT_FOUND', provenance: { source: 'observed', runId: notFound.runId },
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

  it('rejects flows without identity evidence, outputs, or a bound input', () => {
    failsWith('COMPILE_NO_IDENTITY_CHECK', mutate((copy) => { copy.records = copy.records.filter((record) => record.field !== 'memberId'); }));
    failsWith('COMPILE_MISSING_OUTPUT', mutate((copy) => { copy.records = copy.records.filter((record) => record.field !== 'currency'); }));
    failsWith('COMPILE_UNBOUND_FILL', mutate((copy) => {
      const fill = copy.records.find((record) => record.tool === 'fill')!;
      fill.value = { source: 'literal', value: 'anything' };
    }));
    failsWith('COMPILE_NO_DISPATCHES', mutate((copy) => { copy.records = copy.records.map((record) => ({ ...record, status: 'rejected', target: undefined, targetKey: undefined, path: undefined, framePath: undefined, value: undefined, field: undefined })); }));
  });

  it('does not invent a postcondition for a click with no observed consequence', () => {
    failsWith('COMPILE_AMBIGUOUS_EFFECT', mutate((copy) => {
      const last = copy.records.findLastIndex((record) => record.status === 'succeeded' && record.tool !== 'complete');
      copy.records = [...copy.records.slice(0, last + 1), { turn: 49, tool: 'click', reason: 'inspect_state', status: 'succeeded',
        target: { strategies: [{ kind: 'text', text: { source: 'literal', value: 'Anything' } }] }, path: '/members/:memberId', framePath: '/members/:memberId' }];
    }));
  });

  it('rejects parameterized entry paths, unknown fields, and known sensitive literals', () => {
    failsWith('COMPILE_AMBIGUOUS_ENTRY', mutate((copy) => { copy.records[0]!.path = '/members/:memberId'; }));
    failsWith('COMPILE_AMBIGUOUS_ENTRY', mutate((copy) => {
      copy.records.splice(1, 0, { turn: 40, tool: 'navigate', reason: 'locate_record', status: 'succeeded', path: '/members/:memberId' });
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
    failsWith('COMPILE_INVALID_TRANSCRIPT', success, { outcomeTranscripts: ['not a transcript'] });
  });

  it('keeps only the last confirmed read of a re-extracted output', () => {
    const artifact = compile(mutate((copy) => {
      const currency = copy.records.find((record) => record.field === 'currency')!;
      copy.records.splice(copy.records.indexOf(currency), 0, { ...currency, turn: 4 });
      copy.records.forEach((record, index) => { record.turn = index + 1; });
    }));
    expect(artifact.steps.filter((step) => step.action === 'extract' && step.output === 'currency')).toHaveLength(1);
  });
});
