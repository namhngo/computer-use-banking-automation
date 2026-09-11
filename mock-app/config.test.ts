import { describe, expect, it } from 'vitest';
import { readMockCredentials } from './config.js';

describe('readMockCredentials', () => {
  it('reads only explicit local credentials without mutating the environment', () => {
    const env = Object.freeze({
      MOCK_USERNAME: 'test-operator',
      MOCK_PASSWORD: 'test-only-password',
      ANTHROPIC_API_KEY: 'unrelated-test-secret',
    });
    expect(readMockCredentials(env)).toEqual({ username: 'test-operator', password: 'test-only-password' });
    expect(env.MOCK_PASSWORD).toBe('test-only-password');
  });

  it.each([
    {},
    { MOCK_USERNAME: 'test-operator' },
    { MOCK_PASSWORD: 'test-only-password' },
    { MOCK_USERNAME: ' ', MOCK_PASSWORD: 'test-only-password' },
    { MOCK_USERNAME: 'test-operator', MOCK_PASSWORD: 'short' },
    { MOCK_USERNAME: 'test-operator', MOCK_PASSWORD: '        ' },
  ])('rejects missing or invalid credentials without exposing values (case %#)', (env) => {
    expect(() => readMockCredentials(env)).toThrow(
      'Set MOCK_USERNAME and MOCK_PASSWORD in .env; see .env.example.',
    );
    expect(() => readMockCredentials(env)).not.toThrow(/test-operator|test-only-password|short/);
  });
});
