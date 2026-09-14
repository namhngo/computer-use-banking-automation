import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { FileCapabilityRegistry } from '../artifact/registry.js';
import { transcriptSchema } from '../discovery/contracts.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const credentials = { MOCK_USERNAME: 'compile-cli-operator', MOCK_PASSWORD: 'compile-cli-password' };
let root: string;
let successRun: string;
let notFoundRun: string;

async function stage(name: string): Promise<string> {
  const source = join(workspace, 'evidence', 'agent', name, 'discovery', 'discovery.json');
  const { runId } = transcriptSchema.parse(JSON.parse(await readFile(source, 'utf8')));
  await mkdir(join(root, 'runs', runId), { recursive: true });
  await copyFile(source, join(root, 'runs', runId, 'discovery.json'));
  return runId;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'compile-cli-'));
  successRun = await stage('cold-savings');
  notFoundRun = await stage('cold-not-found');
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function run(args: string[]) {
  const { stdout, stderr, status } = await new Promise<{ stdout: string; stderr: string; status: number }>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/compile.ts', '--evidence-root', join(root, 'runs'), '--registry', join(root, 'capabilities'), ...args], {
      cwd: workspace,
      env: { ...process.env, ...credentials, TARGET_URL: 'http://localhost:4000/', HEADLESS: 'true', OPENAI_API_KEY: '' },
      timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || error.code !== 1)) { reject(new Error('Compile CLI did not exit normally.')); return; }
      resolve({ stdout, stderr, status: error ? 1 : 0 });
    });
  });
  expect(stderr).toBe('');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  for (const secret of [root, ...Object.values(credentials)]) expect(stdout).not.toContain(secret);
  return { result: JSON.parse(stdout) as Record<string, unknown>, status };
}

it('compiles the published live transcript into an immutable draft revision without a browser or model', async () => {
  const { result, status } = await run(['--run', successRun, '--outcome-run', notFoundRun]);
  expect(status).toBe(0);
  expect(result).toEqual({ kind: 'COMPILED', draft: { appId: 'harbor_core', appVersion: '1.0', name: 'get_member_savings_balance', version: 1 } });
  const saved = await new FileCapabilityRegistry(join(root, 'capabilities')).load(result.draft);
  expect(saved).toMatchObject({ identity: { status: 'draft', version: 1 }, provenance: { source: 'discovered', runId: successRun },
    outcomes: [{ code: 'NO_MEMBER_FOUND', provenance: { source: 'observed', runId: notFoundRun } }] });
  expect(await run(['--run', successRun])).toMatchObject({ status: 1, result: { kind: 'FAILURE', code: 'REGISTRY_ERROR' } });
  expect(await run(['--run', successRun, '--version', '2'])).toMatchObject({ status: 0, result: { kind: 'COMPILED', draft: { version: 2 } } });
  expect((await readdir(join(root, 'capabilities'))).sort()).toEqual([
    'harbor_core--1.0--get_member_savings_balance--1.json', 'harbor_core--1.0--get_member_savings_balance--2.json']);
}, 30_000);

it('reports compile refusals by code and unreadable transcripts without echoing paths', async () => {
  expect(await run(['--run', notFoundRun])).toMatchObject({ status: 1, result: { kind: 'FAILURE', code: 'COMPILE_NOT_SUCCESSFUL' } });
  expect(await run(['--run', successRun, '--outcome-run', successRun])).toMatchObject({ status: 1, result: { kind: 'FAILURE', code: 'COMPILE_INVALID_OUTCOME' } });
  expect(await run(['--run', `run_${'0'.repeat(32)}`])).toMatchObject({ status: 1, result: { kind: 'FAILURE', code: 'TRANSCRIPT_UNREADABLE' } });
  await expect(readdir(join(root, 'capabilities'))).rejects.toThrow();
}, 30_000);

it.each([
  [], ['--run', 'not-a-run-id'], ['--run', '../evidence/agent/cold-savings'],
  ['--run', `run_${'0'.repeat(32)}`, '--run', `run_${'1'.repeat(32)}`],
  ['--run', `run_${'0'.repeat(32)}`, '--version', '0'], ['--run', `run_${'0'.repeat(32)}`, '--version', '1.5'],
  ['--run', `run_${'0'.repeat(32)}`, '--verify'], ['--run', `run_${'0'.repeat(32)}`, '--sandbox'],
  ['--run', `run_${'0'.repeat(32)}`, '--verify', '--sandbox', '--verify-inputs', '{"member_id":"12345"}'],
  ['--run', `run_${'0'.repeat(32)}`, '--verify-inputs', '{"member_id":"12345"}', '--verify-inputs', '{"member_id":"67890"}'],
  ['--run', `run_${'0'.repeat(32)}`, '--verify', '--sandbox', '--verify-inputs', '[]', '--verify-inputs', '{}'],
  ['--run', `run_${'0'.repeat(32)}`, '--unknown'], ['--run', `run_${'0'.repeat(32)}`, 'positional'],
])('rejects malformed invocations %j', async (...args) => {
  expect(await run(args)).toMatchObject({ status: 1, result: { kind: 'FAILURE', code: 'CLI_INVALID' } });
}, 30_000);
