import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createMockApp } from '../mock-app/app.js';
import { readMockCredentials } from '../mock-app/config.js';
import { runDiscovery } from '../src/discovery/engine.js';
import { readDiscoveryModel } from '../src/discovery/model.js';
import { InterventionBroker } from '../src/hitl/interventions.js';
import { startHitlServer } from '../src/hitl/server.js';
import { loadPolicy, parsePolicy } from '../src/policy/policy.js';
import { PlaywrightAdapter } from '../src/surface/playwright-adapter.js';

/**
 * Reproducible handoff during DISCOVERY with the live model: the sandbox raises an unfamiliar
 * "Operator review required" dialog right after sign-in, the discovery loop pauses before the
 * model's first turn, an operator claims the intervention over the HTTP console, acknowledges
 * the notice in the very same browser, and resumes; the model then finishes the read.
 *
 * The operator's click is performed programmatically on the handed-over page so the run can be
 * reproduced without a person at the keyboard. In `pnpm agent --hitl` the same click is a real one.
 *
 *   pnpm exec tsx scripts/hitl-discovery-demo.ts <evidence-root>
 */
const evidenceRoot = process.argv[2] ?? 'artifacts/runs';
await mkdir(evidenceRoot, { recursive: true });
const credentials = readMockCredentials();
const { app } = createMockApp({ credentials, fault: 'unexpected_confirm' });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
const origin = `http://127.0.0.1:${String(address.port)}`;
const policy = parsePolicy({ ...(await loadPolicy('policy.yaml')), allowedOrigins: [origin] });

const token = InterventionBroker.generateToken();
const operatorLog: string[] = [];
let adapter: PlaywrightAdapter | undefined;
let consoleOrigin = '';
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${consoleOrigin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json: unknown = await response.json();
  operatorLog.push(`${method} ${path} -> ${String(response.status)} ${JSON.stringify(json)}`);
  return json;
};
const broker = new InterventionBroker(token, {
  onOpen: (view) => {
    operatorLog.push(`intervention ${view.id} opened at ${view.stepId} (${view.reason}) on ${view.path}`);
    void (async () => {
      await api('POST', `/interventions/${view.id}/claim`, { operatorId: 'alice' });
      // The operator reads the notice and acknowledges it in the same browser the model was using.
      const page = adapter!.page;
      await page.getByRole('dialog', { name: 'Operator review required', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Acknowledge notice', exact: true }).click();
      await page.waitForURL(`${origin}/members/search`);
      await api('POST', `/interventions/${view.id}/resume`, { operatorId: 'alice', action: 'retry_step' });
    })().catch((error: unknown) => { operatorLog.push(`operator error: ${String(error)}`); });
  },
});
const operatorConsole = await startHitlServer({ broker, port: 0 });
consoleOrigin = operatorConsole.origin;

try {
  const result = await runDiscovery({
    goal: 'What is the current savings balance for member 12345?', model: readDiscoveryModel(), origin, policy, credentials,
    headless: process.env.HEADLESS !== 'false', evidenceRoot, hitl: { broker, maxWaitMs: 60_000 },
    createSurface: async (options) => { adapter = await PlaywrightAdapter.create(options); return adapter; },
  });
  await writeFile(join(evidenceRoot, `${result.runId}.result.json`), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(evidenceRoot, `${result.runId}.operator.log`), `${operatorLog.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.kind === 'SUCCESS' ? 0 : 1;
} finally {
  await operatorConsole.close();
  server.close();
}
