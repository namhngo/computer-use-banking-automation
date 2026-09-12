import { describe, expect, it } from 'vitest';
import { makeArtifact } from '../../tests/fixtures/capability.js';
import { bindText, parseExtraction, prepareInvocation, validateValues } from './bindings.js';
import type { ExtractionParser, FieldDefinition } from './schema.js';

describe('prepareInvocation', () => {
  const context = { appId: 'harbor_core', appVersion: '1.0', mode: 'verification' };
  it('permits an authored draft only for explicit sandbox verification', () => {
    const artifact = makeArtifact();
    expect(prepareInvocation(artifact, { memberId: '00123' }, context)).toEqual({ artifact, inputs: { memberId: '00123' } });
    expect(() => prepareInvocation(artifact, { memberId: '00123' }, { ...context, mode: 'replay' })).toThrow('Capability is not eligible');
    artifact.identity.status = 'verified';
    artifact.verification = { runId: 'synthetic_verification', verifiedAt: '2026-09-11T01:00:00Z' };
    expect(prepareInvocation(artifact, { memberId: '00123' }, { ...context, mode: 'replay' }).inputs).toEqual({ memberId: '00123' });
  });
  it.each([
    { appId: 'other_app' }, { appVersion: '2.0' }, { mode: 'production' }, { trusted: true },
  ])('rejects invalid execution context %j', (change) => {
    expect(() => prepareInvocation(makeArtifact(), { memberId: '00123' }, { ...context, ...change })).toThrow('Invocation target');
  });
  it('rejects writes even in verification mode and validates all invocation inputs', () => {
    const artifact = makeArtifact();
    artifact.risk = artifact.steps[2]!.risk = 'irreversible';
    expect(() => prepareInvocation(artifact, { memberId: '00123' }, context)).toThrow('Capability is not eligible');
    expect(() => prepareInvocation(makeArtifact(), { memberId: 123 }, context)).toThrow('Values do not match');
  });
});

describe('validateValues', () => {
  it('preserves leading zeroes without mutating input', () => {
    const values = Object.freeze({ memberId: '00123' });
    expect(validateValues(makeArtifact().inputs, values)).toEqual({ memberId: '00123' });
    expect(values.memberId).toBe('00123');
  });

  it.each([
    {}, { memberID: '00123' }, { memberId: '00123', extra: true },
    { memberId: 123 }, { memberId: 12345 }, { memberId: true },
    { memberId: null }, { memberId: undefined }, { memberId: '1234' },
    { memberId: '001234' }, { memberId: '12a45' }, { memberId: ' 0123' },
    null, ['00123'],
  ])('requires exact input keys and declared types for %j', (values) => {
    expect(() => validateValues(makeArtifact().inputs, values)).toThrow(
      new Error('Values do not match the declared contract.'),
    );
  });

  const definitions: Record<string, FieldDefinition> = {
    count: { type: 'number', integer: true, minimum: -2, maximum: 2, description: 'Count', sensitive: false },
    ratio: { type: 'number', integer: false, minimum: 0, maximum: 1, description: 'Ratio', sensitive: false },
    label: { type: 'string', format: 'text', minLength: 1, maxLength: 3, description: 'Label', sensitive: false },
    active: { type: 'boolean', description: 'Active', sensitive: false },
  };
  const values = { count: 0, ratio: 0.5, label: 'USD', active: false };

  it('accepts inclusive numeric/string bounds, fractional nonintegers and both booleans', () => {
    for (const boundary of [
      { count: -2, ratio: 0, label: 'a', active: false },
      { count: 2, ratio: 1, label: 'USD', active: true },
      values,
    ]) expect(validateValues(definitions, boundary)).toEqual(boundary);
  });

  it.each([
    { count: -3 }, { count: 3 }, { count: 1.5 }, { count: '1' },
    { ratio: NaN }, { ratio: Infinity }, { ratio: -Infinity },
    { ratio: -0.01 }, { ratio: 1.01 }, { ratio: '0.5' },
    { label: '' }, { label: 'USDX' }, { label: 123 },
    { active: 'false' }, { active: 0 }, { active: null },
  ])('rejects out-of-contract output values %j', (invalid) => {
    expect(() => validateValues(definitions, { ...values, ...invalid })).toThrow(
      'Values do not match the declared contract.',
    );
  });

  it('enforces safe integer bounds independently of declared ranges', () => {
    const outputs = makeArtifact().outputs;
    for (const cents of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
      expect(validateValues(outputs, { savingsBalanceCents: cents, currency: 'USD' })).toEqual({ savingsBalanceCents: cents, currency: 'USD' });
    }
    for (const cents of [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, 0.1]) {
      expect(() => validateValues(outputs, { savingsBalanceCents: cents, currency: 'USD' })).toThrow('Values do not match the declared contract.');
    }
  });

  it('does not disclose sensitive values in errors', () => {
    expect(() => validateValues(makeArtifact().inputs, { memberId: 'synthetic-secret' })).toThrow(
      new Error('Values do not match the declared contract.'),
    );
  });
});

describe('bindText', () => {
  it('binds exact scalar values without losing leading zeroes', () => {
    expect(bindText({ source: 'input', name: 'memberId' }, { memberId: '00123' })).toBe('00123');
    expect(bindText({ source: 'input', name: 'count' }, { count: 0 })).toBe('0');
    expect(bindText({ source: 'input', name: 'active' }, { active: false })).toBe('false');
    expect(bindText({ source: 'literal', value: '' }, {})).toBe('');
  });

  it('treats malicious-looking strings as data, not interpolation or executable code', () => {
    const payload = '${(() => { throw new Error("executed"); })()}; <script>alert(1)</script>';
    const definitions: Record<string, FieldDefinition> = {
      text: { type: 'string', format: 'text', minLength: 0, maxLength: 1000, description: 'Text', sensitive: false },
    };
    const inputs = validateValues(definitions, { text: payload });
    expect(bindText({ source: 'input', name: 'text' }, inputs)).toBe(payload);
    expect(bindText({ source: 'literal', value: payload }, {})).toBe(payload);
  });

  it.each(['missing', 'toString', 'hasOwnProperty', '__proto__', 'constructor', 'prototype'])(
    'rejects unknown or prototype reference %s', (name) => {
      expect(() => bindText({ source: 'input', name }, {})).toThrow(/^(Missing input for value reference|Invalid value reference)\.$/);
    },
  );

  it('does not bind inherited inputs', () => {
    const inputs: Record<string, string | number | boolean> = {};
    Object.setPrototypeOf(inputs, { memberId: '00123' });
    expect(() => bindText({ source: 'input', name: 'memberId' }, inputs)).toThrow('Missing input for value reference.');
  });

  it('rejects unknown reference properties and nonfinite scalar inputs', () => {
    const reference = { source: 'input' as const, name: 'memberId', fallback: 'synthetic-secret' };
    expect(() => bindText(reference, { memberId: '00123' })).toThrow(new Error('Invalid value reference.'));
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => bindText({ source: 'input', name: 'amount' }, { amount: value })).toThrow(new Error('Invalid input for value reference.'));
    }
  });
});

describe('parseExtraction', () => {
  it.each<[ExtractionParser, string, string | number | boolean]>([
    ['text', '  USD\n', 'USD'], ['text', '   ', ''],
    ['integer', ' 00123\n', 123], ['integer', '-42', -42], ['integer', '0', 0],
    ['boolean', ' true\n', true], ['boolean', 'false', false],
    ['usd_cents', '$0.00', 0], ['usd_cents', '$0.29', 29],
    ['usd_cents', '$1,234.56', 123456], ['usd_cents', '-$1,234.56', -123456],
    ['usd_cents', ' $1234567.89\n', 123456789], ['usd_cents', '$1,234,567.89', 123456789],
    ['integer', '9007199254740991', Number.MAX_SAFE_INTEGER],
    ['integer', '-9007199254740991', Number.MIN_SAFE_INTEGER],
    ['usd_cents', '$90,071,992,547,409.91', Number.MAX_SAFE_INTEGER],
    ['usd_cents', '-$90,071,992,547,409.91', Number.MIN_SAFE_INTEGER],
  ])('parses %s %j exactly', (parser, raw, expected) => {
    expect(parseExtraction(raw, parser)).toBe(expected);
  });

  it.each([
    '$1,23.45', '$12,34.56', '$1234,567.89', '$1,,234.56', '$,123.45', '$123,.45',
    '$1.2', '$1.234', '$1.', '$1', '$.99', '1.00', 'USD 1.00',
    '+$1.00', '$-1.00', '($1.00)', '--$1.00', '$ 1.00', '$1 234.56',
    '$1e3.00', '$1.00 trailing', 'NaN', 'Infinity', '',
  ])('rejects malformed money %j without rounding or partial parsing', (raw) => {
    expect(() => parseExtraction(raw, 'usd_cents')).toThrow(new Error('Invalid extracted value.'));
  });

  it.each(['1.0', '1.5', '+1', '1,000', '1e3', '0x10', '1 2', '12abc', '', 'NaN', 'Infinity'])(
    'rejects noninteger syntax %j', (raw) => {
      expect(() => parseExtraction(raw, 'integer')).toThrow(new Error('Invalid extracted value.'));
    },
  );

  it.each(['TRUE', 'False', '1', '0', 'yes', '', 'true false'])(
    'rejects nonboolean syntax %j', (raw) => {
      expect(() => parseExtraction(raw, 'boolean')).toThrow(new Error('Invalid extracted value.'));
    },
  );

  it.each<[ExtractionParser, string]>([
    ['integer', '9007199254740992'], ['integer', '-9007199254740992'],
    ['integer', '9'.repeat(100)], ['usd_cents', '$90,071,992,547,409.92'],
    ['usd_cents', '-$90,071,992,547,409.92'],
  ])('rejects %s outside bigint safe bounds: %s', (parser, raw) => {
    expect(() => parseExtraction(raw, parser)).toThrow(new Error('Extracted value exceeds safe integer range.'));
  });

  it('never evaluates extracted expressions and keeps errors sanitized', () => {
    const payload = '(() => { throw new Error("synthetic-secret"); })()';
    expect(parseExtraction(payload, 'text')).toBe(payload);
    for (const parser of ['integer', 'usd_cents', 'boolean'] as const) {
      expect(() => parseExtraction(payload, parser)).toThrow(new Error('Invalid extracted value.'));
      expect(() => parseExtraction('1 + 2', parser)).toThrow(new Error('Invalid extracted value.'));
    }
  });

  it('bounds raw extraction length before trimming', () => {
    expect(parseExtraction('x'.repeat(10_000), 'text')).toBe('x'.repeat(10_000));
    for (const parser of ['text', 'integer', 'usd_cents', 'boolean'] as const) {
      expect(() => parseExtraction(' '.repeat(10_001), parser)).toThrow(new Error('Invalid extracted value.'));
    }
  });
});
