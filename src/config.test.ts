import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

describe('readConfig', () => {
  it('works without model credentials or an env file', () => {
    expect(readConfig({})).toEqual({
      targetUrl: 'http://localhost:4000/',
      headless: true,
    });
  });

  it.each([
    'http://localhost:4000/members',
    'http://127.0.0.1:4000/',
    'http://[::1]:4000/',
  ])('accepts local target %s', (targetUrl) => {
    expect(readConfig({ TARGET_URL: targetUrl }).targetUrl).toBe(targetUrl);
  });

  it('parses false explicitly instead of coercing it to true', () => {
    expect(readConfig({ HEADLESS: 'false' }).headless).toBe(false);
  });

  it.each(['', '1', 'yes', 'FALSE'])('rejects invalid HEADLESS %j', (value) => {
    expect(() => readConfig({ HEADLESS: value })).toThrow('Invalid configuration: HEADLESS.');
  });

  it.each([
    '',
    'not a URL',
    'file:///etc/passwd',
    'https://example.com/',
    'http://localhost.example.com/',
    'http://localhost:4000/?token=synthetic-secret',
    'http://localhost:4000/#synthetic-secret',
    'http://operator:synthetic-secret@localhost:4000/',
  ])('rejects unsupported or sensitive target %j', (targetUrl) => {
    expect(() => readConfig({ TARGET_URL: targetUrl })).toThrow(
      'Invalid configuration: TARGET_URL. See .env.example.',
    );
  });

  it('does not expose rejected values in validation errors', () => {
    const validate = () => readConfig({
      TARGET_URL: 'http://operator:synthetic-secret@localhost:4000/',
      HEADLESS: 'another-synthetic-secret',
    });
    expect(validate).toThrow('Invalid configuration: TARGET_URL, HEADLESS. See .env.example.');
    expect(validate).not.toThrow(/synthetic-secret/);
  });

  it('does not return unrelated environment secrets or mutate the input', () => {
    const env = Object.freeze({ ANTHROPIC_API_KEY: 'synthetic-placeholder' });
    expect(readConfig(env)).toEqual({ targetUrl: 'http://localhost:4000/', headless: true });
    expect(env.ANTHROPIC_API_KEY).toBe('synthetic-placeholder');
  });
});
