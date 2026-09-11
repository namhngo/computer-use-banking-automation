import { Server } from 'node:http';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { createMockApp, mockFaultSchema } from './app.js';
import { readMockCredentials } from './config.js';

try {
  const { values } = parseArgs({
    options: { fault: { type: 'string', default: 'none' }, port: { type: 'string', default: '4000' } },
  });
  const fault = mockFaultSchema.parse(values.fault);
  const port = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).parse(values.port);
  const { app } = createMockApp({ fault, credentials: readMockCredentials() });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
    console.log(`Harbor sandbox: http://127.0.0.1:${String(port)} (fault=${fault})`);
    console.log('Synthetic data only. Ctrl+C stops and resets the sandbox.');
  });
  server.on('error', () => {
    console.error('Unable to start the local sandbox. Check that the port is available.');
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      if (server instanceof Server) server.closeAllConnections();
    });
  }
} catch {
  console.error('Unable to configure the sandbox. Use --port 1..65535 and --fault with one of:');
  console.error(mockFaultSchema.options.join(', '));
  console.error('MOCK_USERNAME and MOCK_PASSWORD must be configured; see .env.example.');
  process.exitCode = 1;
}
