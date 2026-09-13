import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createMockApp, mockFaultSchema } from '../../mock-app/app.js';
import { readMockCredentials } from '../../mock-app/config.js';
import { runAgent } from '../agent/agent.js';
import { agentResultSchema, type AgentResult } from '../agent/contracts.js';
import { createRouterModel } from '../agent/model.js';
import { FileCapabilityRegistry } from '../artifact/registry.js';
import { readConfig } from '../config.js';
import { createDiscoveryModel, readLiveModelConfiguration } from '../discovery/model.js';
import { loadPolicy, parsePolicy } from '../policy/policy.js';

/**
 * `pnpm agent --goal "..."`: the goal-driven entrypoint. One model call routes the goal; a
 * verified capability replays without a model; otherwise discovery runs, its transcript is
 * compiled, and the draft is verified in fresh sandboxes (sandbox mode only). Direct
 * `pnpm discover` / `pnpm replay` remain available and unchanged.
 */

let result: AgentResult;
let setupCode = 'CLI_INVALID';
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
      registry: { type: 'string', default: 'artifacts/capabilities' },
      'evidence-root': { type: 'string', default: 'artifacts/runs' },
      'verify-inputs': { type: 'string', multiple: true, default: [] },
      'max-steps': { type: 'string', default: '25' },
      'max-duration-ms': { type: 'string', default: '180000' },
      'model-timeout-ms': { type: 'string', default: '30000' },
      'max-tokens': { type: 'string', default: '40000' },
    },
  });
  const supplied = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (supplied.has(token.name) && token.name !== 'verify-inputs') throw new Error();
    supplied.add(token.name);
  }
  if (!values.goal?.trim() || values.goal.length > 2000
    || (values.sandbox && supplied.has('target'))
    || (!values.sandbox && (supplied.has('fault') || values['verify-inputs'].length > 0))
    || !values.policy.trim() || values.policy.length > 4096
    || !values.registry.trim() || values.registry.length > 4096
    || !values['evidence-root'].trim() || values['evidence-root'].length > 4096
    || values['verify-inputs'].length > 4) throw new Error();
  const fault = mockFaultSchema.parse(values.fault);
  const verifyInputs = values['verify-inputs'].map((text) => JSON.parse(text) as unknown);
  if (verifyInputs.some((input) => input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.values(input).some((value) => typeof value !== 'string'))) throw new Error();
  function bounded(value: string, max: number): number {
    if (!/^[0-9]+$/.test(value)) throw new Error();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error();
    return number;
  }
  const discoveryLimits = {
    maxSteps: bounded(values['max-steps'], 50),
    maxDurationMs: bounded(values['max-duration-ms'], 300_000),
    modelTimeoutMs: bounded(values['model-timeout-ms'], 60_000),
    maxTokens: bounded(values['max-tokens'], 200_000),
  };

  setupCode = 'CONFIG_ERROR';
  const config = readConfig({ ...process.env, ...(values.target === undefined ? {} : { TARGET_URL: values.target }) });
  const target = values.target ?? process.env.TARGET_URL ?? config.targetUrl;
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(target)) throw new Error();
  let origin = new URL(config.targetUrl).origin;
  const credentials = readMockCredentials();
  const basePolicy = await loadPolicy(values.policy);
  let policy = basePolicy;
  const registry = new FileCapabilityRegistry(values.registry);
  setupCode = process.env.OPENAI_API_KEY?.trim() ? 'CONFIG_ERROR' : 'MODEL_NOT_CONFIGURED';
  const configuration = readLiveModelConfiguration();
  const router = createRouterModel(configuration);
  const discoveryModel = createDiscoveryModel(configuration);
  setupCode = 'CONFIG_ERROR';

  let server: ReturnType<typeof serve> | undefined;
  const closeServer = async (owned: ReturnType<typeof serve>) => {
    const closing = new Promise<void>((resolve, reject) => owned.close((error) => error ? reject(error) : resolve()));
    if (owned instanceof Server) owned.closeAllConnections();
    await closing;
  };
  try {
    if (values.sandbox) {
      const { app } = createMockApp({ credentials, fault });
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      if (!server.listening) await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error();
      origin = `http://127.0.0.1:${String(address.port)}`;
      policy = parsePolicy({ ...basePolicy, allowedOrigins: [origin] });
    }
    result = await runAgent({
      goal: values.goal, router, discoveryModel, registry, origin, policy, credentials, discoveryLimits,
      evidenceRoot: values['evidence-root'], headless: config.headless,
      // Verification needs sandboxes this process owns; against an external target a draft stays a draft.
      ...(values.sandbox ? { verification: {
        inputs: verifyInputs as Record<string, string>[],
        createTarget: async () => {
          const { app } = createMockApp({ credentials, fault: 'none' });
          const fresh = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
          if (!fresh.listening) await once(fresh, 'listening');
          const address = fresh.address();
          if (!address || typeof address === 'string') throw new Error();
          const freshOrigin = `http://127.0.0.1:${String(address.port)}`;
          return { origin: freshOrigin, policy: parsePolicy({ ...basePolicy, allowedOrigins: [freshOrigin] }), close: () => closeServer(fresh) };
        },
      } } : {}),
    });
  } finally {
    if (server?.listening) await closeServer(server);
  }
} catch {
  result = agentResultSchema.parse({
    kind: 'FAILURE', agentRunId: `agent_${randomUUID().replaceAll('-', '')}`, code: setupCode, source: 'live',
    routing: { decision: null, usage: { inputTokens: 0, outputTokens: 0 }, catalog: [] },
  });
}

process.stdout.write(`${JSON.stringify(result)}\n`);
const succeeded = result.kind === 'EXECUTED' ? ['SUCCESS', 'BUSINESS_OUTCOME'].includes(result.result.kind)
  : result.kind === 'DISCOVERED' ? ['SUCCESS', 'BUSINESS_OUTCOME'].includes(result.discovery.kind) : false;
process.exitCode = succeeded ? 0 : 1;
