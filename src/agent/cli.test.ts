import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { agentResultSchema } from './contracts.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const credentials = { MOCK_USERNAME: 'cli-synthetic-operator', MOCK_PASSWORD: 'cli-synthetic-password' };
const goal = 'look up member 54321 and read their current savings balance';
const invocation = ['--goal', goal];

async function run(args: string[], code: string, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harbor-agent-cli-'));
  try {
    const { stdout, stderr, status } = await new Promise<{ stdout: string; stderr: string; status: number }>((resolve, reject) => {
      execFile(process.execPath, [
        '--import', 'tsx', 'src/cli/agent.ts', '--evidence-root', join(root, 'runs'), '--registry', join(root, 'capabilities'), ...args,
      ], {
        cwd: workspace,
        // Do not load .env; an inherited key must never enable a provider call from a test.
        env: { ...process.env, ...credentials, TARGET_URL: 'http://localhost:4000/', HEADLESS: 'true',
          DISCOVERY_MODEL: 'gpt-4.1', ...env, OPENAI_API_KEY: '' },
        timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.code !== 1)) {
          reject(new Error('Agent CLI did not exit normally.'));
          return;
        }
        resolve({ stdout, stderr, status: error ? 1 : 0 });
      });
    });
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    for (const secret of [goal, root, ...Object.values(credentials)]) expect(stdout).not.toContain(secret);
    const result = agentResultSchema.parse(JSON.parse(stdout) as unknown);
    expect(result).toEqual({
      kind: 'FAILURE', agentRunId: result.agentRunId, code, source: 'live',
      routing: { decision: null, usage: { inputTokens: 0, outputTokens: 0 }, catalog: [] },
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
  ['--sandbox', '--verify-inputs', '{"memberId":"67890"}'],
  ['--target', 'http://127.0.0.1:43210'],
  ['--max-steps', '50', '--max-duration-ms', '300000', '--model-timeout-ms', '60000', '--max-tokens', '200000'],
])('requires a configured live model without falling back for %j', async (...options) => {
  await run([...invocation, ...options], 'MODEL_NOT_CONFIGURED');
}, 10_000);

it.each([
  [], ['--goal'], ['--goal', ''], ['--goal', ' \t\n '], ['--goal', 'x'.repeat(2001)],
  [...invocation, 'positional'], [...invocation, '--', 'positional'],
  [...invocation, '--sandbox=true'], [...invocation, '--policy', ''], [...invocation, '--registry', ''],
  [...invocation, '--evidence-root='], [...invocation, '--target'], [...invocation, '--unknown'],
  [...invocation, '--fault', 'none'], [...invocation, '--sandbox', '--fault', 'invalid-fault'],
  [...invocation, '--sandbox', '--target', 'http://localhost:4000/'],
  [...invocation, '--verify-inputs', '{"memberId":"67890"}'],
  [...invocation, '--sandbox', '--verify-inputs', 'not-json'],
  [...invocation, '--sandbox', '--verify-inputs', '["67890"]'],
  [...invocation, '--sandbox', '--verify-inputs', '{"memberId":67890}'],
  [...invocation, '--sandbox', ...Array.from({ length: 5 }, (_unused, index) => ['--verify-inputs', `{"memberId":"1234${String(index)}"}`]).flat()],
  [...invocation, '--sandbox', '--sandbox'], [...invocation, '--policy', 'policy.yaml', '--policy=policy.yaml'],
  [...invocation, '--max-steps', '0'], [...invocation, '--max-steps', '51'], [...invocation, '--max-duration-ms', '300001'],
  [...invocation, '--model-timeout-ms', '60001'], [...invocation, '--max-tokens', '1.5'],
])('rejects malformed or incompatible arguments %j', async (...args) => {
  await run(args, 'CLI_INVALID');
}, 10_000);

it.each([
  '', 'https://localhost:4000/', 'http://example.com/', 'http://localhost:4000/login', 'http://secret-user:secret-password@localhost:4000/',
])('rejects invalid targets without echoing them (%s)', async (target) => {
  const stdout = await run([...invocation, '--target', target], 'CONFIG_ERROR');
  if (target) expect(stdout).not.toContain(target);
}, 10_000);

it('does not echo a rejected policy path or unknown option values', async () => {
  const secret = 'secret-missing-policy.yaml';
  expect(await run([...invocation, '--policy', secret], 'CONFIG_ERROR')).not.toContain(secret);
  const unknown = 'unknown-option-synthetic-secret';
  expect(await run(['--goal', credentials.MOCK_PASSWORD, `--${unknown}=${credentials.MOCK_USERNAME}`], 'CLI_INVALID')).not.toContain(unknown);
}, 20_000);
