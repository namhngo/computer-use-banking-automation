import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parseReplayResult } from '../../src/artifact/result.js';
import { parseArtifact } from '../../src/artifact/schema.js';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const artifactPath = 'examples/get-member-savings-balance.json';
const artifact = parseArtifact(JSON.parse(await readFile(join(workspace, artifactPath), 'utf8')) as unknown);
const credentials = { MOCK_USERNAME: 'cli-synthetic-operator', MOCK_PASSWORD: 'cli-synthetic-password' };
const invocation = ['--artifact', artifactPath, '--inputs', '{"memberId":"12345"}'];
const verification = ['--sandbox', '--mode', 'verification'];

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harbor-replay-cli-'));
  const evidenceRoot = join(root, 'runs');
  try {
    const { stdout, stderr, status } = await new Promise<{ stdout: string; stderr: string; status: number }>((resolve, reject) => {
      execFile(process.execPath, [
        '--import', 'tsx', 'src/cli/replay.ts',
        '--evidence-root', evidenceRoot, '--registry', join(root, 'capabilities'), ...args,
      ], {
        cwd: workspace,
        env: { ...process.env, ...credentials, TARGET_URL: 'http://localhost:4000/', HEADLESS: 'true', ...env },
        timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && (error.killed || error.code !== 1)) {
          reject(new Error('Replay CLI did not exit normally.'));
          return;
        }
        resolve({ stdout, stderr, status: error ? 1 : 0 });
      });
    });
    expect(stderr).toBe('');
    for (const secret of Object.values(credentials)) expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(root);
    const result = parseReplayResult(JSON.parse(stdout) as unknown, artifact);
    expect(status).toBe(result.kind === 'SUCCESS' || result.kind === 'BUSINESS_OUTCOME' ? 0 : 1);
    const evidence = await Promise.all(result.evidence.map((file) => readFile(join(evidenceRoot, result.runId, file), 'utf8')));
    if (result.evidence.length) {
      expect(await readdir(evidenceRoot)).toEqual([result.runId]);
      expect((await readdir(join(evidenceRoot, result.runId))).sort()).toEqual([...result.evidence].sort());
    }
    expect(await readdir(root)).not.toContain('capabilities');
    for (const secret of [...Object.values(credentials), '12345', '123456', '$1,234.56', 'USD', 'Avery Sample']) {
      expect(evidence.join('\n')).not.toContain(secret);
    }
    return { result, stdout, status };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('executes the authored draft once in a fresh owned sandbox without publishing verification', async () => {
  const before = await readFile(join(workspace, artifactPath), 'utf8');
  expect(artifact.identity.status).toBe('draft');
  const { result, status } = await run([...invocation, ...verification]);
  expect(result).toMatchObject({ kind: 'SUCCESS', recoveries: [],
    outputs: { savingsBalanceCents: 123456, currency: 'USD' } });
  expect(status).toBe(0);
  expect(result.evidence).toContain('events.jsonl');
  expect(await readFile(join(workspace, artifactPath), 'utf8')).toBe(before);
}, 30_000);

it('returns member-not-found as a business outcome with exit zero', async () => {
  const { result, status } = await run([
    '--artifact', artifactPath, '--inputs', '{"memberId":"99999"}', ...verification,
  ]);
  expect(result).toMatchObject({ kind: 'BUSINESS_OUTCOME', code: 'MEMBER_NOT_FOUND', atStep: 'search' });
  expect(status).toBe(0);
}, 30_000);

it('applies the named permission fault only to its fresh sandbox', async () => {
  const { result, status } = await run([...invocation, ...verification, '--fault', 'permission_denied']);
  expect(status).toBe(1);
  expect(result).toMatchObject({ kind: 'FAILURE', code: 'PERMISSION_DENIED' });
  expect(result).not.toHaveProperty('outputs');
}, 30_000);

it.each([
  ['{"memberId":"bad"}', 'INPUT_INVALID'], ['{"memberId":12345}', 'INPUT_INVALID'],
  ['memberId: 12345', 'CLI_INVALID'], ['null', 'INPUT_INVALID'],
])(
  'rejects invalid input without coercion (%s)', async (inputs, code) => {
    const { result } = await run(['--artifact', artifactPath, '--inputs', inputs, ...verification]);
    expect(result).toMatchObject({ kind: 'FAILURE', code, atStep: null });
  }, 30_000,
);

it('rejects the draft in default replay mode even with an owned sandbox', async () => {
  const { result } = await run([...invocation, '--sandbox']);
  expect(result).toMatchObject({ kind: 'FAILURE', code: 'INVOCATION_INVALID', atStep: null });
}, 30_000);

it.each([
  ['--mode', 'verification'],
  ['--fault', 'permission_denied'],
  ['--sandbox', '--fault', 'permission_denied,app_error'],
  ['--mode', 'unsafe'],
  ['--version', '1'],
  ['get_member_savings_balance'],
  ['--sandbox', '--sandbox'],
  ['--hitl-port', '4100'],
  ['--hitl-wait-ms', '60000'],
  ['--sandbox', '--hitl', '--hitl-port', '70000'],
  ['--sandbox', '--hitl', '--hitl-wait-ms', '500'],
  ['--sandbox', '--hitl', '--hitl-wait-ms', '4000000'],
])('fails closed on incompatible or invalid options %j', async (...options) => {
  const { result } = await run([...invocation, ...options]);
  expect(result).toMatchObject({ kind: 'FAILURE', code: 'CLI_INVALID', atStep: null, evidence: [] });
}, 30_000);

it('refuses a human handoff nobody could see: --hitl requires a headed browser', async () => {
  const { result, stdout } = await run([...invocation, ...verification, '--hitl'], { HEADLESS: 'true' });
  expect(result).toMatchObject({ kind: 'FAILURE', code: 'CONFIG_ERROR', atStep: null, evidence: [] });
  expect(stdout).not.toContain('HITL_TOKEN');
}, 30_000);

it('does not echo secrets supplied in unknown options', async () => {
  const secret = 'unknown-option-synthetic-secret';
  const { result, stdout } = await run([...invocation, ...verification, `--${secret}=${credentials.MOCK_PASSWORD}`]);
  expect(result).toMatchObject({ kind: 'FAILURE', code: 'CLI_INVALID', atStep: null, evidence: [] });
  expect(stdout).not.toContain(secret);
}, 30_000);

it('sanitizes configuration errors without echoing rejected environment values', async () => {
  const secret = 'synthetic-target-secret';
  const { result, stdout } = await run([...invocation, ...verification], { TARGET_URL: `https://${secret}.invalid/` });
  expect(result).toMatchObject({ kind: 'FAILURE', code: 'CONFIG_ERROR', atStep: null, evidence: [] });
  expect(stdout).not.toContain(secret);
}, 30_000);
