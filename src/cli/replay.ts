import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createMockApp, mockFaultSchema } from '../../mock-app/app.js';
import { readMockCredentials } from '../../mock-app/config.js';
import { FileCapabilityRegistry } from '../artifact/registry.js';
import { parseReplayResult } from '../artifact/result.js';
import type { ReplayResult } from '../artifact/result.js';
import { capabilityKeySchema } from '../artifact/schema.js';
import { readConfig } from '../config.js';
import { loadPolicy, parsePolicy } from '../policy/policy.js';
import { runReplay } from '../replay/engine.js';
import { harborApp } from '../surface/harbor-profile.js';

let result: ReplayResult;
let setupCode = 'CLI_INVALID';
try {
  const { values, positionals, tokens } = parseArgs({
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      artifact: { type: 'string' },
      inputs: { type: 'string' },
      sandbox: { type: 'boolean', default: false },
      mode: { type: 'string', default: 'replay' },
      fault: { type: 'string', default: 'none' },
      policy: { type: 'string', default: 'policy.yaml' },
      'evidence-root': { type: 'string', default: 'artifacts/runs' },
      registry: { type: 'string', default: 'artifacts/capabilities' },
      version: { type: 'string' },
    },
  });
  const supplied = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (supplied.has(token.name)) throw new Error();
    supplied.add(token.name);
  }
  const mode = values.mode;
  const fault = mockFaultSchema.parse(values.fault);
  if ((mode !== 'replay' && mode !== 'verification') || values.inputs === undefined
    || (!values.sandbox && (mode === 'verification' || fault !== 'none'))
    || !values.policy || !values['evidence-root'] || !values.registry) throw new Error();

  let key: ReturnType<typeof capabilityKeySchema.parse> | undefined;
  if (values.artifact !== undefined) {
    if (!values.artifact || positionals.length !== 0 || values.version !== undefined) throw new Error();
  } else {
    if (positionals.length !== 1 || !values.version || !/^[0-9]+$/.test(values.version)) throw new Error();
    key = capabilityKeySchema.parse({ ...harborApp, name: positionals[0], version: Number(values.version) });
  }

  const inputs = JSON.parse(values.inputs) as unknown;
  let artifact: unknown;
  if (values.artifact !== undefined) {
    const maxBytes = 1024 * 1024;
    const file = await open(values.artifact, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error();
      // Bound the actual read as well as fstat, including files that grow concurrently.
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > maxBytes) throw new Error();
      artifact = JSON.parse(buffer.toString('utf8', 0, size)) as unknown;
    } finally {
      await file.close();
    }
  } else {
    artifact = await new FileCapabilityRegistry(values.registry).load(key);
  }

  setupCode = 'CONFIG_ERROR';
  const config = readConfig();
  const credentials = readMockCredentials();
  let origin = new URL(config.targetUrl).origin;
  let policy = await loadPolicy(values.policy);
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
    result = await runReplay({
      artifact, inputs, mode, origin, policy, credentials,
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
  result = parseReplayResult({
    kind: 'FAILURE', runId: `run_${randomUUID().replaceAll('-', '')}`, atStep: null,
    code: setupCode, message: setupCode === 'CLI_INVALID' ? 'Invalid replay invocation.' : 'Unable to configure replay.',
    recoveries: [], evidence: [],
  });
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.kind === 'SUCCESS' || result.kind === 'BUSINESS_OUTCOME' ? 0 : 1;
