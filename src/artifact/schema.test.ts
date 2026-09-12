import { describe, expect, it } from 'vitest';
import { makeArtifact } from '../../tests/fixtures/capability.js';
import { capabilityArtifactSchema, parseArtifact } from './schema.js';
import type { CapabilityArtifact, Condition, Target } from './schema.js';

const target: Target = { strategies: [{ kind: 'css', selector: 'strong' }] };
const missingInput = { source: 'input', name: 'missingInput' } as const;
const unknownCondition: Condition = { kind: 'text_equals', target, expected: missingInput };
type Mutation = [string, (artifact: CapabilityArtifact) => void];

describe('capability artifact schema', () => {
  it('rejects malformed long paths without catastrophic regex backtracking', () => {
    const artifact = makeArtifact();
    artifact.app.entryPath = `/${'a'.repeat(30)}?`;
    const start = performance.now();
    expect(() => parseArtifact(artifact)).toThrow('Invalid capability artifact.');
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('accepts the authored read-only draft without verification', () => {
    const artifact = makeArtifact();
    expect(parseArtifact(artifact)).toEqual(artifact);
    expect(artifact.identity.status).toBe('draft');
    expect(artifact.risk).toBe('read_only');
    expect(artifact.provenance.source).toBe('authored');
    expect(artifact).not.toHaveProperty('verification');
  });

  it('accepts structurally valid discovered verification metadata, not proof of an actual run', () => {
    const artifact = makeArtifact();
    artifact.identity.status = 'verified';
    artifact.provenance = {
      source: 'discovered', recordedAt: '2026-09-11T00:00:00Z',
      runId: 'synthetic_discovery', model: 'synthetic_model',
    };
    artifact.verification = { runId: 'synthetic_verification', verifiedAt: '2026-09-11T01:00:00Z' };
    artifact.outcomes[0]!.provenance = { source: 'observed', runId: 'synthetic_discovery' };
    expect(parseArtifact(artifact)).toEqual(artifact);
  });

  it.each<Mutation>([
    ['top-level field', (a) => { Object.assign(a, { script: 'synthetic-secret' }); }],
    ['identity field', (a) => { Object.assign(a.identity, { trusted: true }); }],
    ['app field', (a) => { Object.assign(a.app, { origin: 'https://example.com' }); }],
    ['field definition property', (a) => { Object.assign(a.inputs.memberId!, { default: '00123' }); }],
    ['step property', (a) => { Object.assign(a.steps[0]!, { script: 'alert(1)' }); }],
    ['nested selector property', (a) => {
      Object.assign(a.steps[1]!, { target: { strategies: [{ kind: 'css', selector: 'input', evaluate: 'alert(1)' }] } });
    }],
    ['nested scope property', (a) => {
      Object.assign(a.steps[1]!, { target: { ...target, scope: { frames: [], shadowRoot: true } } });
    }],
    ['condition property', (a) => { Object.assign(a.checkpoint, { optional: true }); }],
    ['handler property', (a) => { Object.assign(a.outcomes[0]!, { retry: true }); }],
    ['recovery property', (a) => { Object.assign(a.recoveries[0]!.recovery, { script: 'alert(1)' }); }],
    ['limits property', (a) => { Object.assign(a.limits, { unlimited: true }); }],
    ['provenance property', (a) => { Object.assign(a.provenance, { trusted: true }); }],
    ['unsupported schema version', (a) => { Object.assign(a, { schemaVersion: 2 }); }],
    ['unsupported surface', (a) => { Object.assign(a.app, { surface: 'desktop' }); }],
    ['unsupported action', (a) => { Object.assign(a.steps[1]!, { action: 'evaluate' }); }],
    ['unsupported parser', (a) => { Object.assign(a.steps[4]!, { parser: 'javascript' }); }],
  ])('rejects %s instead of silently stripping it', (_name, mutate) => {
    const artifact = makeArtifact();
    mutate(artifact);
    expect(capabilityArtifactSchema.safeParse(artifact).success).toBe(false);
    expect(() => parseArtifact(artifact)).toThrow(new Error('Invalid capability artifact.'));
  });

  it.each<Mutation>([
    ['duplicate step IDs', (a) => { a.steps[1]!.id = a.steps[0]!.id; }],
    ['duplicate outcome codes', (a) => { a.outcomes[1]!.code = a.outcomes[0]!.code; }],
    ['outcome/failure code collision', (a) => { a.failures[0]!.code = a.outcomes[0]!.code; }],
    ['failure/recovery code collision', (a) => { a.recoveries[0]!.code = a.failures[0]!.code; }],
    ['duplicate recovery codes', (a) => { a.recoveries[1]!.code = a.recoveries[0]!.code; }],
    ['no outputs', (a) => { a.outputs = {}; }],
    ['undeclared extraction output', (a) => { Object.assign(a.steps[4]!, { output: 'missingOutput' }); }],
    ['declared but unextracted output', (a) => { a.outputs.extra = a.outputs.currency!; }],
    ['duplicate extraction output', (a) => { a.steps.push({ ...a.steps[4]!, id: 'duplicate_extract' }); }],
    ['text parser with numeric output', (a) => { Object.assign(a.steps[4]!, { parser: 'text' }); }],
    ['integer parser with string output', (a) => { Object.assign(a.steps[5]!, { parser: 'integer' }); }],
    ['money parser with string output', (a) => { Object.assign(a.steps[5]!, { parser: 'usd_cents' }); }],
    ['boolean parser with numeric output', (a) => { Object.assign(a.steps[4]!, { parser: 'boolean' }); }],
    ['money output allowing fractions', (a) => { Object.assign(a.outputs.savingsBalanceCents!, { integer: false }); }],
    ['understated aggregate risk', (a) => { a.steps[2]!.risk = 'irreversible'; }],
    ['overstated aggregate risk', (a) => { a.risk = 'reversible'; }],
    ['verified without evidence', (a) => { a.identity.status = 'verified'; }],
    ['draft claiming verification', (a) => {
      a.verification = { runId: 'synthetic_run', verifiedAt: '2026-09-11T00:00:00Z' };
    }],
    ['verified mutating flow', (a) => {
      a.identity.status = 'verified';
      a.verification = { runId: 'synthetic_run', verifiedAt: '2026-09-11T00:00:00Z' };
      a.risk = a.steps[2]!.risk = 'reversible';
    }],
  ])('rejects %s', (_name, mutate) => {
    const artifact = makeArtifact();
    mutate(artifact);
    expect(() => parseArtifact(artifact)).toThrow('Invalid capability artifact.');
  });

  it('accepts matching aggregate risk on a draft and all supported parser/output pairs', () => {
    const artifact = makeArtifact();
    artifact.risk = artifact.steps[2]!.risk = 'irreversible';
    artifact.steps[3]!.risk = 'reversible';
    artifact.outputs.count = { type: 'number', integer: true, description: 'Count', sensitive: false };
    artifact.outputs.active = { type: 'boolean', description: 'Active', sensitive: false };
    artifact.steps.push(
      { id: 'extract_count', action: 'extract', risk: 'read_only', target, output: 'count', parser: 'integer' },
      { id: 'extract_active', action: 'extract', risk: 'read_only', target, output: 'active', parser: 'boolean' },
    );
    expect(parseArtifact(artifact)).toEqual(artifact);
  });

  it.each<Mutation>([
    ['fill value', (a) => { Object.assign(a.steps[1]!, { value: missingInput }); }],
    ['scoped frame selector', (a) => {
      Object.assign(a.steps[4]!, { target: { ...target, scope: { frames: [{ kind: 'text', text: missingInput }] } } });
    }],
    ['scoped container selector', (a) => {
      Object.assign(a.steps[4]!, { target: { ...target, scope: { frames: [], container: { kind: 'label', text: missingInput } } } });
    }],
    ['table row', (a) => {
      Object.assign(a.steps[4]!, { target: { strategies: [{ kind: 'table_cell', row: missingInput, column: 2 }] } });
    }],
    ['table column', (a) => {
      Object.assign(a.steps[4]!, { target: { strategies: [{ kind: 'table_cell', row: { source: 'literal', value: 'Savings' }, column: missingInput }] } });
    }],
    ['waitFor condition', (a) => { a.steps[1]!.waitFor = unknownCondition; }],
    ['nested postcondition', (a) => { a.steps[0]!.postcondition = { kind: 'any', conditions: [unknownCondition] }; }],
    ['wait action condition', (a) => { a.steps.push({ id: 'wait_extra', action: 'wait', risk: 'read_only', condition: unknownCondition }); }],
    ['checkpoint', (a) => { a.checkpoint = { kind: 'all', conditions: [unknownCondition] }; }],
    ['outcome condition', (a) => { a.outcomes[0]!.when = unknownCondition; }],
    ['failure condition', (a) => { a.failures[0]!.when = unknownCondition; }],
    ['recovery condition', (a) => { a.recoveries[0]!.when = unknownCondition; }],
    ['dismissal target', (a) => {
      a.recoveries[1]!.recovery = { kind: 'dismiss', target: { strategies: [{ kind: 'text', text: missingInput }] }, postcondition: a.checkpoint };
    }],
    ['dismissal postcondition', (a) => {
      a.recoveries[1]!.recovery = { kind: 'dismiss', target, postcondition: unknownCondition };
    }],
    ['inherited input name', (a) => { Object.assign(a.steps[1]!, { value: { source: 'input', name: 'toString' } }); }],
  ])('rejects unknown input references in %s', (_name, mutate) => {
    const artifact = makeArtifact();
    mutate(artifact);
    const result = capabilityArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ message: 'Unknown input reference' }));
  });

  it.each<Mutation>([
    ['session not required', (a) => { a.app.requiresSession = false; }],
    ['unknown resume step', (a) => { a.recoveries[0]!.recovery = { kind: 'reauthenticate', resumeAt: 'missingStep' }; }],
    ['later safe navigation', (a) => {
      a.steps.push({ ...a.steps[0]!, id: 'later_entry' });
      a.recoveries[0]!.recovery = { kind: 'reauthenticate', resumeAt: 'later_entry' };
    }],
    ['non-navigation first step', (a) => {
      a.steps[0] = { id: 'open_search', action: 'wait', risk: 'read_only', condition: a.checkpoint };
    }],
    ['different entry path', (a) => { a.app.entryPath = '/members/other'; }],
    ['mutating entry navigation', (a) => { a.risk = a.steps[0]!.risk = 'reversible'; }],
  ])('rejects reauthentication with %s', (_name, mutate) => {
    const artifact = makeArtifact();
    mutate(artifact);
    expect(() => parseArtifact(artifact)).toThrow('Invalid capability artifact.');
  });

  it.each<Mutation>([
    ['zero steps', (a) => { a.steps = []; }],
    ['over 40 steps', (a) => {
      a.steps.push(...Array.from({ length: 35 }, (_, i) => ({ id: `wait_${i}`, action: 'wait' as const, risk: 'read_only' as const, condition: a.checkpoint })));
    }],
    ['over 32 inputs', (a) => { a.inputs = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i === 0 ? 'memberId' : `field_${i}`, a.inputs.memberId!])); }],
    ['over 32 outputs', (a) => {
      for (let i = 0; i < 31; i++) {
        a.outputs[`field_${i}`] = a.outputs.currency!;
        a.steps.push({ id: `extract_${i}`, action: 'extract', risk: 'read_only', target, output: `field_${i}`, parser: 'text' });
      }
    }],
    ['over 10 outcomes', (a) => { a.outcomes = Array.from({ length: 11 }, (_, i) => ({ ...a.outcomes[0]!, code: `OUTCOME_${i}` })); }],
    ['over 10 failures', (a) => { a.failures = Array.from({ length: 11 }, (_, i) => ({ ...a.failures[0]!, code: `FAILURE_${i}` })); }],
    ['over 5 recoveries', (a) => { a.recoveries = Array.from({ length: 6 }, (_, i) => ({ ...a.recoveries[1]!, code: `RECOVERY_${i}` })); }],
    ['step timeout below minimum', (a) => { a.limits.stepTimeoutMs = 99; }],
    ['step timeout above maximum', (a) => { a.limits.stepTimeoutMs = 30_001; }],
    ['fractional timeout', (a) => { a.limits.stepTimeoutMs = 100.5; }],
    ['run timeout below minimum', (a) => { a.limits.runTimeoutMs = 99; }],
    ['run timeout above maximum', (a) => { a.limits.runTimeoutMs = 300_001; }],
    ['run shorter than step timeout', (a) => { a.limits.runTimeoutMs = a.limits.stepTimeoutMs - 1; }],
    ['negative recovery budget', (a) => { a.limits.maxRecoveryAttempts = -1; }],
    ['recovery budget above five', (a) => { a.limits.maxRecoveryAttempts = 6; }],
    ['zero handler attempts', (a) => { a.recoveries[0]!.maxAttempts = 0; }],
    ['handler attempts above three', (a) => { a.limits.maxRecoveryAttempts = 5; a.recoveries[0]!.maxAttempts = 4; }],
    ['handler exceeds run budget', (a) => { a.limits.maxRecoveryAttempts = 1; a.recoveries[0]!.maxAttempts = 2; }],
    ['inverted string bounds', (a) => { Object.assign(a.inputs.memberId!, { minLength: 6, maxLength: 5 }); }],
    ['negative string minimum', (a) => { Object.assign(a.inputs.memberId!, { minLength: -1 }); }],
    ['string maximum above 10000', (a) => { Object.assign(a.outputs.currency!, { maxLength: 10_001 }); }],
    ['inverted numeric bounds', (a) => { Object.assign(a.outputs.savingsBalanceCents!, { minimum: 1, maximum: 0 }); }],
    ['nonfinite numeric bound', (a) => { Object.assign(a.outputs.savingsBalanceCents!, { maximum: Infinity }); }],
    ['empty strategies', (a) => { Object.assign(a.steps[1]!, { target: { strategies: [] } }); }],
    ['over five strategies', (a) => { Object.assign(a.steps[1]!, { target: { strategies: Array.from({ length: 6 }, () => target.strategies[0]!) } }); }],
    ['over four frames', (a) => { Object.assign(a.steps[1]!, { target: { ...target, scope: { frames: Array.from({ length: 5 }, () => ({ kind: 'css', selector: 'iframe' })) } } }); }],
    ['empty condition group', (a) => { a.checkpoint = { kind: 'all', conditions: [] }; }],
    ['over ten leaf conditions', (a) => { a.checkpoint = { kind: 'any', conditions: Array.from({ length: 11 }, () => ({ kind: 'path_equals', path: '/' })) }; }],
  ])('enforces limits: %s', (_name, mutate) => {
    const artifact = makeArtifact();
    mutate(artifact);
    expect(() => parseArtifact(artifact)).toThrow('Invalid capability artifact.');
  });

  it('accepts inclusive timeout, attempt, step and field boundaries', () => {
    const artifact = makeArtifact();
    artifact.limits = { stepTimeoutMs: 30_000, runTimeoutMs: 300_000, maxRecoveryAttempts: 5 };
    artifact.recoveries[0]!.maxAttempts = 3;
    Object.assign(artifact.inputs.memberId!, { minLength: 0, maxLength: 10_000 });
    Object.assign(artifact.outputs.savingsBalanceCents!, { minimum: 0, maximum: 0 });
    artifact.steps.push(...Array.from({ length: 34 }, (_, i) => ({ id: `wait_${i}`, action: 'wait' as const, risk: 'read_only' as const, condition: artifact.checkpoint })));
    expect(parseArtifact(artifact)).toEqual(artifact);
    artifact.recoveries = [];
    artifact.limits = { stepTimeoutMs: 100, runTimeoutMs: 100, maxRecoveryAttempts: 0 };
    expect(parseArtifact(artifact)).toEqual(artifact);
  });
});
