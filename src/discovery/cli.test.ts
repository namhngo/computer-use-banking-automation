import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { discoveryResultSchema } from './contracts.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const credentials = { MOCK_USERNAME: 'cli-synthetic-operator', MOCK_PASSWORD: 'cli-synthetic-password' };
const goal = 'Read the savings balance and currency for member 54321.';
const invocation = ['--goal', goal];

async function run(args: string[], code: string, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harbor-discovery-cli-'));
  try {
    const { stdout, stderr, status } = await new Promise<{ stdout: string; stderr: string; status: number }>((resolve, reject) => {
      execFile(process.execPath, [
        '--import', 'tsx', 'src/cli/discover.ts', '--evidence-root', join(root, 'runs'), ...args,
      ], {
        cwd: workspace,
        // Do not load .env; even an inherited or caller-supplied key must never enable a provider call.
        env: { ...process.env, ...credentials, TARGET_URL: 'http://localhost:4000/', HEADLESS: 'true',
          DISCOVERY_MODEL: 'gpt-4.1', ...env, OPENAI_API_KEY: '' },
        timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.code !== 1)) {
          reject(new Error('Discovery CLI did not exit normally.'));
          return;
        }
        resolve({ stdout, stderr, status: error ? 1 : 0 });
      });
    });
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    for (const secret of [goal, root, ...Object.values(credentials)]) expect(stdout).not.toContain(secret);
    const result = discoveryResultSchema.parse(JSON.parse(stdout) as unknown);
    expect(result).toEqual({
      kind: 'FAILURE', runId: result.runId, code,
      source: 'live', turns: 0, usage: { inputTokens: 0, outputTokens: 0 }, usageComplete: true, evidence: [],
    });
    expect(status).toBe(1);
    expect(await readdir(root)).toEqual([]);
    return stdout;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.each([
  [], ['--sandbox'], ['--sandbox', '--fault', 'permission_denied'],
  ['--target', 'http://127.0.0.1:43210'], ['--target', 'http://[::1]:43210/'],
  ['--max-steps', '1', '--max-duration-ms', '1', '--model-timeout-ms', '1', '--max-tokens', '1'],
  ['--max-steps', '50', '--max-duration-ms', '300000', '--model-timeout-ms', '60000', '--max-tokens', '200000'],
])('requires a configured live model without falling back for %j', async (...options) => {
  await run([...invocation, ...options], 'MODEL_NOT_CONFIGURED');
}, 10_000);

it.each([
  [], ['--goal'], ['--goal', ''], ['--goal', ' \t\n '], ['--goal', 'x'.repeat(2001)],
  [...invocation, 'positional'], [...invocation, '--', 'positional'],
  [...invocation, '--sandbox=true'], [...invocation, '--sandbox', 'false'],
  [...invocation, '--policy', ''], [...invocation, '--evidence-root='],
  [...invocation, '--target'], [...invocation, '--unknown'],
  [...invocation, '--fake-model'], [...invocation, '--script', 'secret-script'],
  [...invocation, '--offline'], [...invocation, '--model', 'fake'],
  [...invocation, '--fault', 'none'], [...invocation, '--fault', 'permission_denied'],
  [...invocation, '--sandbox', '--fault', 'invalid-fault'],
  [...invocation, '--sandbox', '--target', 'http://localhost:4000/'],
  [...invocation, '--target=http://localhost:4000/', '--sandbox'],
])('rejects malformed or incompatible arguments %j', async (...args) => {
  await run(args, 'CLI_INVALID');
}, 10_000);

it.each([
  ['--goal', goal], ['--sandbox', '--sandbox'],
  ['--target', 'http://localhost:4000', '--target=http://localhost:4000'],
  ['--sandbox', '--fault', 'none', '--fault=none'],
  ['--policy', 'policy.yaml', '--policy=policy.yaml'],
  ['--evidence-root', 'secret-duplicate-root'],
  ['--max-steps', '1', '--max-steps=2'],
  ['--max-duration-ms', '1', '--max-duration-ms=2'],
  ['--model-timeout-ms', '1', '--model-timeout-ms=2'],
  ['--max-tokens', '1', '--max-tokens=2'],
])('rejects duplicate flags %j', async (...options) => {
  await run([...invocation, ...options], 'CLI_INVALID');
}, 10_000);

it.each([
  ['--max-steps', '0'], ['--max-steps', '51'], ['--max-steps', '-1'],
  ['--max-steps', '1.5'], ['--max-steps', 'NaN'], ['--max-steps', 'Infinity'],
  ['--max-steps', '1e1'], ['--max-steps', '0x10'], ['--max-steps', '+1'],
  ['--max-steps', ' 1'], ['--max-steps', ''], ['--max-steps', '9007199254740993'],
  ['--max-duration-ms', '0'], ['--max-duration-ms', '300001'],
  ['--model-timeout-ms', '0'], ['--model-timeout-ms', '60001'],
  ['--max-tokens', '0'], ['--max-tokens', '200001'],
])('rejects invalid bounded numbers %j', async (...options) => {
  await run([...invocation, ...options], 'CLI_INVALID');
}, 10_000);

it.each([
  '', 'https://localhost:4000/', 'http://example.com/', 'file:///secret-path',
  'http://localhost:4000/login', 'http://localhost:4000/artifacts/run.json',
  'http://localhost:4000/?secret=query', 'http://localhost:4000/#secret-fragment',
  'http://secret-user:secret-password@localhost:4000/', 'http://localhost:99999/',
  'http://localhost:4000/ignored/..', ' http://localhost:4000/',
])('rejects invalid targets without echoing them (%s)', async (target) => {
  const stdout = await run([...invocation, '--target', target], 'CONFIG_ERROR');
  if (target) expect(stdout).not.toContain(target);
}, 10_000);

it('uses the explicit target instead of the environment target', async () => {
  await run([...invocation, '--target', 'http://localhost:4000/'], 'MODEL_NOT_CONFIGURED', {
    TARGET_URL: 'https://secret-invalid-target.invalid/',
  });
}, 10_000);

it.each([
  { TARGET_URL: 'https://secret-target.invalid/' },
  { TARGET_URL: 'http://localhost:4000/secret-entry' },
  { HEADLESS: 'secret-invalid-headless' },
  { MOCK_USERNAME: '' }, { MOCK_PASSWORD: 'short' },
])('sanitizes invalid configuration without a provider key (%j)', async (env) => {
  const stdout = await run(invocation, 'CONFIG_ERROR', env);
  for (const value of Object.values(env)) if (value) expect(stdout).not.toContain(value);
}, 10_000);

it('does not echo a rejected policy path', async () => {
  const secret = 'secret-missing-policy.yaml';
  const stdout = await run([...invocation, '--policy', secret], 'CONFIG_ERROR');
  expect(stdout).not.toContain(secret);
}, 10_000);

it('does not echo secret goals, unknown option names, or values', async () => {
  const secret = 'unknown-option-synthetic-secret';
  const stdout = await run(['--goal', credentials.MOCK_PASSWORD, `--${secret}=${credentials.MOCK_USERNAME}`], 'CLI_INVALID');
  expect(stdout).not.toContain(secret);
}, 10_000);
