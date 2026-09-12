import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createMockApp, mockFaultSchema } from '../../mock-app/app.js';
import { readMockCredentials } from '../../mock-app/config.js';
import { readConfig } from '../config.js';
import { discoveryResultSchema, type DiscoveryResult } from '../discovery/contracts.js';
import { runDiscovery } from '../discovery/engine.js';
import { readDiscoveryModel } from '../discovery/model.js';
import { loadPolicy, parsePolicy } from '../policy/policy.js';

let result: DiscoveryResult;
let setupCode = 'CLI_INVALID';
let discoveryStarted = false;
try {
  const { values, tokens } = parseArgs({
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      goal: { type: 'string' },
      sandbox: { type: 'boolean', default: false },
      target: { type: 'string' },
      fault: { type: 'string', default: 'none' },
      policy: { type: 'string', default: 'policy.yaml' },
      'evidence-root': { type: 'string', default: 'artifacts/runs' },
      'max-steps': { type: 'string', default: '25' },
      'max-duration-ms': { type: 'string', default: '180000' },
      'model-timeout-ms': { type: 'string', default: '30000' },
      'max-tokens': { type: 'string', default: '40000' },
    },
  });
  const supplied = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (supplied.has(token.name)) throw new Error();
    supplied.add(token.name);
  }
  if (!values.goal?.trim() || values.goal.length > 2000
    || (values.sandbox && supplied.has('target'))
    || (!values.sandbox && supplied.has('fault'))
    || !values.policy.trim() || values.policy.length > 4096
    || !values['evidence-root'].trim() || values['evidence-root'].length > 4096) throw new Error();
  const fault = mockFaultSchema.parse(values.fault);
  function bounded(value: string, max: number): number {
    if (!/^[0-9]+$/.test(value)) throw new Error();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error();
    return number;
  }
  const limits = {
    maxSteps: bounded(values['max-steps'], 50),
    maxDurationMs: bounded(values['max-duration-ms'], 300_000),
    modelTimeoutMs: bounded(values['model-timeout-ms'], 60_000),
    maxTokens: bounded(values['max-tokens'], 200_000),
  };

  setupCode = 'CONFIG_ERROR';
  const config = readConfig({ ...process.env,
    ...(values.target === undefined ? {} : { TARGET_URL: values.target }),
  });
  const target = values.target ?? process.env.TARGET_URL ?? config.targetUrl;
  // Authentication starts at /login; entry paths and URL normalization must not silently discard input.
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(target)) throw new Error();
  let origin = new URL(config.targetUrl).origin;
  const credentials = readMockCredentials();
  let policy = await loadPolicy(values.policy);
  setupCode = process.env.OPENAI_API_KEY?.trim() ? 'CONFIG_ERROR' : 'MODEL_NOT_CONFIGURED';
  const model = readDiscoveryModel();
  setupCode = 'CONFIG_ERROR';

  let server: ReturnType<typeof serve> | undefined;
  try {
    if (values.sandbox) {
      const { app } = createMockApp({ credentials, fault });
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      if (!server.listening) await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error();
      origin = `http://127.0.0.1:${String(address.port)}`;
      policy = parsePolicy({ ...policy, allowedOrigins: [origin] });
    }
    discoveryStarted = true;
    result = await runDiscovery({
      goal: values.goal, model, origin, policy, credentials, limits,
      evidenceRoot: values['evidence-root'], headless: config.headless,
    });
  } finally {
    if (server?.listening) {
      const ownedServer = server;
      const closing = new Promise<void>((resolve, reject) => {
        ownedServer.close((error) => error ? reject(error) : resolve());
      });
      if (ownedServer instanceof Server) ownedServer.closeAllConnections();
      await closing;
    }
  }
} catch {
  result = discoveryResultSchema.parse({
    kind: 'FAILURE', runId: `run_${randomUUID().replaceAll('-', '')}`, code: setupCode,
    source: 'live', turns: 0, usage: { inputTokens: 0, outputTokens: 0 }, usageComplete: !discoveryStarted, evidence: [],
  });
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.kind === 'SUCCESS' || result.kind === 'BUSINESS_OUTCOME' ? 0 : 1;
