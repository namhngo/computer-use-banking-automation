import { describe, expect, it } from 'vitest';
import { createSecretGuard } from './privacy.js';

describe('known-secret guard', () => {
  const secret = 'private value+with&symbols';
  const guard = createSecretGuard([secret]);

  it('detects raw, form, JSON, base64, and hex representations', () => {
    for (const value of [secret, new URLSearchParams({ v: secret }).toString(),
      encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret)),
      JSON.stringify(secret), Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('hex').toUpperCase()]) {
      expect(guard.contains(`prefix ${value} suffix`)).toBe(true);
      expect(guard.redact(`prefix ${value} suffix`)).toBe('[REDACTED]');
    }
  });
  it('does not execute strings or throw on malformed encodings', () => {
    const value = '(() => fail()) %ZZ \\U0000';
    expect(guard.contains(value)).toBe(false);
    expect(guard.redact(value)).toBe(value);
  });
  it('supports bounded ambiguous goal IDs without dropping any known value', () => {
    const values = Array.from({ length: 333 }, (_, index) => String(10000 + index));
    const ids = createSecretGuard(values);
    expect(ids.contains('10332')).toBe(true);
    expect(() => createSecretGuard(Array.from({ length: 501 }, () => 'x'))).toThrow('Invalid sensitive values.');
    expect(() => createSecretGuard(['x'.repeat(4097)])).toThrow('Invalid sensitive values.');
  });
  it('ignores empty entries without redacting everything', () => {
    expect(createSecretGuard(['']).redact('Safe metadata')).toBe('Safe metadata');
  });
});
