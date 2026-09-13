import { once } from 'node:events';
import { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { identifierSchema, resumeActionSchema } from './interventions.js';
import type { InterventionBroker } from './interventions.js';

/**
 * Loopback-only operator signaling. Three routes, one bearer token per run, JSON in and out.
 * This is deliberately not an operator UI or a remote co-browsing service: the operator is a
 * trusted local person at the same machine as the headed browser.
 */

const maxBodyBytes = 4096;
const claimSchema = z.strictObject({ operatorId: identifierSchema });
const resumeSchema = z.strictObject({ operatorId: identifierSchema, action: resumeActionSchema, note: z.string().max(500).optional() });

export function createHitlApp(broker: InterventionBroker): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (!broker.authorize(c.req.header('authorization'))) return c.json({ code: 'UNAUTHORIZED' }, 401);
    await next();
  });
  app.get('/interventions', (c) => c.json({ interventions: broker.list() }));
  app.post('/interventions/:id/claim', async (c) => {
    const body = await readJson(c.req.raw, claimSchema);
    if (!body) return c.json({ code: 'INVALID_BODY' }, 400);
    const result = await broker.claim(c.req.param('id'), body.operatorId);
    return result.ok ? c.json({ intervention: result.view }) : c.json({ code: result.code }, result.status);
  });
  app.post('/interventions/:id/resume', async (c) => {
    const body = await readJson(c.req.raw, resumeSchema);
    if (!body) return c.json({ code: 'INVALID_BODY' }, 400);
    // The note is for the operator's own console history; it is not persisted in evidence.
    const result = await broker.resume(c.req.param('id'), body.operatorId, body.action);
    return result.ok ? c.json({ state: result.state }) : c.json({ code: result.code }, result.status);
  });
  app.notFound((c) => c.json({ code: 'NOT_FOUND' }, 404));
  app.onError((_error, c) => c.json({ code: 'INTERNAL_ERROR' }, 500));
  return app;
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
  if (!/^application\/json(?:;|$)/.test(request.headers.get('content-type') ?? '')) return undefined;
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isInteger(length) || length > maxBodyBytes) return undefined;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > maxBodyBytes) return undefined;
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export async function startHitlServer(options: { broker: InterventionBroker; port?: number }): Promise<{ origin: string; close(): Promise<void> }> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HITL port.');
  const server = serve({ fetch: createHitlApp(options.broker).fetch, hostname: '127.0.0.1', port });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HITL server failed to start.');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      const closing = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (server instanceof Server) server.closeAllConnections();
      await closing;
    },
  };
}
