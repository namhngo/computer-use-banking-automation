import { once } from 'node:events';
import { Server } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createMockApp } from '../../mock-app/app.js';
import { readMockCredentials } from '../../mock-app/config.js';
import { FileCapabilityRegistry } from '../artifact/registry.js';
import type { CapabilityKey } from '../artifact/schema.js';
import { compileTranscript, CompileError } from '../compiler/compile.js';
import { verifyDraft, type VerificationAttempt } from '../compiler/verify.js';
import { readConfig } from '../config.js';
import { readTranscriptFile } from '../discovery/transcript.js';
import { loadPolicy, parsePolicy } from '../policy/policy.js';
import { harborApp } from '../surface/harbor-profile.js';

type CompileCliResult =
  | { kind: 'COMPILED'; draft: CapabilityKey }
  | { kind: 'VERIFIED'; draft: CapabilityKey; verified: CapabilityKey; attempts: VerificationAttempt[] }
  | { kind: 'REJECTED'; draft: CapabilityKey; code: string; attempts: VerificationAttempt[] }
  | { kind: 'FAILURE'; code: string };

const runIdPattern = /^run_[a-f0-9]{32}$/;
const readBoundedJson = readTranscriptFile;

let result: CompileCliResult;
let setupCode = 'CLI_INVALID';
try {
  const { values, tokens } = parseArgs({
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      run: { type: 'string' },
      'outcome-run': { type: 'string', multiple: true, default: [] },
      name: { type: 'string', default: 'get_member_savings_balance' },
      version: { type: 'string', default: '1' },
      registry: { type: 'string', default: 'artifacts/capabilities' },
      'evidence-root': { type: 'string', default: 'artifacts/runs' },
      policy: { type: 'string', default: 'policy.yaml' },
      verify: { type: 'boolean', default: false },
      sandbox: { type: 'boolean', default: false },
      'verify-inputs': { type: 'string', multiple: true, default: [] },
    },
  });
  const repeatable = new Set(['outcome-run', 'verify-inputs']);
  const supplied = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (supplied.has(token.name) && !repeatable.has(token.name)) throw new Error();
    supplied.add(token.name);
  }
  if (!values.run || !runIdPattern.test(values.run) || values['outcome-run'].some((run) => !runIdPattern.test(run))
    || !/^[0-9]{1,15}$/.test(values.version) || !values.registry.trim() || !values['evidence-root'].trim() || !values.policy.trim()
    || (values.verify !== values.sandbox) || (!values.verify && values['verify-inputs'].length > 0)
    || (values.verify && values['verify-inputs'].length < 2)) throw new Error();
  const version = Number(values.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error();
  const verifyInputs = values['verify-inputs'].map((text) => JSON.parse(text) as unknown);
  if (verifyInputs.some((input) => input === null || typeof input !== 'object' || Array.isArray(input))) throw new Error();

  setupCode = 'TRANSCRIPT_UNREADABLE';
  const transcript = await readBoundedJson(join(values['evidence-root'], values.run, 'discovery.json'));
  const outcomeTranscripts: unknown[] = [];
  for (const run of values['outcome-run']) outcomeTranscripts.push(await readBoundedJson(join(values['evidence-root'], run, 'discovery.json')));

  setupCode = 'CONFIG_ERROR';
  const config = readConfig();
  const credentials = readMockCredentials();
  const sensitiveValues = [credentials.username, credentials.password,
    ...verifyInputs.flatMap((input) => Object.values(input as Record<string, unknown>).map(String))];
  const registry = new FileCapabilityRegistry(values.registry);

  setupCode = 'COMPILE_FAILED';
  const draft = compileTranscript(transcript, {
    name: values.name, version, app: harborApp, recordedAt: new Date().toISOString(), outcomeTranscripts, sensitiveValues,
  });

  if (!values.verify) {
    setupCode = 'REGISTRY_ERROR';
    result = { kind: 'COMPILED', draft: await registry.save(draft, sensitiveValues) };
  } else {
    setupCode = 'VERIFY_FAILED';
    const basePolicy = await loadPolicy(values.policy);
    const report = await verifyDraft({
      draft, registry, inputs: verifyInputs as Record<string, string>[], credentials, verifiedAt: new Date().toISOString(),
      evidenceRoot: values['evidence-root'], headless: config.headless,
      createTarget: async () => {
        // Each verification run gets a brand-new sandbox: no session, no fault state, no prior page.
        const { app } = createMockApp({ credentials, fault: 'none' });
        const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
        if (!server.listening) await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error();
        const origin = `http://127.0.0.1:${String(address.port)}`;
        return {
          origin, policy: parsePolicy({ ...basePolicy, allowedOrigins: [origin] }),
          close: async () => {
            const closing = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            if (server instanceof Server) server.closeAllConnections();
            await closing;
          },
        };
      },
    });
    result = report;
  }
} catch (error) {
  result = { kind: 'FAILURE', code: error instanceof CompileError ? error.code : setupCode };
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.kind === 'COMPILED' || result.kind === 'VERIFIED' ? 0 : 1;
