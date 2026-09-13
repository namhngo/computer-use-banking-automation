import { describe, expect, it, vi } from 'vitest';
import { InterventionBroker } from './interventions.js';
import { createHitlApp, startHitlServer } from './server.js';

const token = 'c'.repeat(48);
const input = { runId: 'run_' + '2'.repeat(32), stepId: 'open_search', reason: 'UNEXPECTED_DIALOG', path: '/notice' } as const;
const hooks = () => ({ validate: vi.fn().mockResolvedValue({ accepted: true }), onClaim: vi.fn().mockResolvedValue(undefined), onRelease: vi.fn().mockResolvedValue(undefined) });

function client(app: ReturnType<typeof createHitlApp>) {
  return async (method: string, path: string, options: { body?: string; headers?: Record<string, string>; bearer?: string | null } = {}) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.bearer !== null) headers.authorization = `Bearer ${options.bearer ?? token}`;
    if (options.body !== undefined && !('content-type' in headers)) headers['content-type'] = 'application/json';
    const response = await app.request(`http://hitl.local${path}`, { method, headers, ...(options.body === undefined ? {} : { body: options.body }) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
}

describe('operator API', () => {
  it('requires the per-run bearer token on every route', async () => {
    const broker = new InterventionBroker(token);
    const request = client(createHitlApp(broker));
    expect(await request('GET', '/interventions', { bearer: null })).toEqual({ status: 401, json: { code: 'UNAUTHORIZED' } });
    expect(await request('GET', '/interventions', { bearer: 'd'.repeat(48) })).toEqual({ status: 401, json: { code: 'UNAUTHORIZED' } });
    expect(await request('POST', '/interventions/iv_x/claim', { bearer: null, body: '{"operatorId":"a"}' })).toEqual({ status: 401, json: { code: 'UNAUTHORIZED' } });
    expect(await request('GET', '/nowhere', { bearer: null })).toEqual({ status: 401, json: { code: 'UNAUTHORIZED' } });
    expect(await request('GET', '/nowhere')).toEqual({ status: 404, json: { code: 'NOT_FOUND' } });
    expect(await request('GET', '/interventions')).toEqual({ status: 200, json: { interventions: [] } });
  });

  it('drives claim and resume through the broker and reports its codes', async () => {
    const broker = new InterventionBroker(token);
    const request = client(createHitlApp(broker));
    const intervention = broker.open(input, hooks());
    const waiting = intervention.wait(60_000);
    expect(await request('GET', '/interventions')).toMatchObject({ status: 200, json: { interventions: [{ id: intervention.id, state: 'waiting' }] } });
    expect(await request('POST', `/interventions/${intervention.id}/claim`, { body: JSON.stringify({ operatorId: 'alice' }) }))
      .toMatchObject({ status: 200, json: { intervention: { state: 'human_control', operatorId: 'alice' } } });
    expect(await request('POST', `/interventions/${intervention.id}/claim`, { body: JSON.stringify({ operatorId: 'bob' }) }))
      .toEqual({ status: 409, json: { code: 'ALREADY_CLAIMED' } });
    expect(await request('POST', `/interventions/iv_${'0'.repeat(32)}/resume`, { body: JSON.stringify({ operatorId: 'alice', action: 'abort' }) }))
      .toEqual({ status: 404, json: { code: 'INTERVENTION_NOT_FOUND' } });
    expect(await request('POST', `/interventions/${intervention.id}/resume`, { body: JSON.stringify({ operatorId: 'alice', action: 'retry_step', note: 'done' }) }))
      .toEqual({ status: 200, json: { state: 'resumed' } });
    await expect(waiting).resolves.toMatchObject({ kind: 'resumed', action: 'retry_step' });
    expect(JSON.stringify(intervention.record())).not.toContain('done');
  });

  it('rejects malformed, oversized, or non-JSON bodies without touching the broker', async () => {
    const broker = new InterventionBroker(token);
    const claim = vi.spyOn(broker, 'claim');
    const request = client(createHitlApp(broker));
    const intervention = broker.open(input, hooks());
    void intervention.wait(60_000);
    const path = `/interventions/${intervention.id}/claim`;
    for (const body of ['', 'not json', '[]', '{}', '{"operatorId":"has space"}', '{"operatorId":"alice","extra":1}', JSON.stringify({ operatorId: 'a'.repeat(65) })]) {
      expect(await request('POST', path, { body })).toEqual({ status: 400, json: { code: 'INVALID_BODY' } });
    }
    expect(await request('POST', path, { body: '{"operatorId":"alice"}', headers: { 'content-type': 'text/plain' } })).toEqual({ status: 400, json: { code: 'INVALID_BODY' } });
    expect(await request('POST', path, { body: JSON.stringify({ operatorId: 'alice', note: 'x'.repeat(5000) }) })).toEqual({ status: 400, json: { code: 'INVALID_BODY' } });
    expect(await request('POST', `/interventions/${intervention.id}/resume`, { body: JSON.stringify({ operatorId: 'alice', action: 'delete_everything' }) }))
      .toEqual({ status: 400, json: { code: 'INVALID_BODY' } });
    expect(claim).not.toHaveBeenCalled();
    expect(broker.list()[0]).toMatchObject({ state: 'waiting' });
  });

  it('listens on loopback only, on an ephemeral port by default', async () => {
    const broker = new InterventionBroker(token);
    const server = await startHitlServer({ broker });
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${server.origin}/interventions`, { headers: { authorization: `Bearer ${token}` } });
      expect(await response.json()).toEqual({ interventions: [] });
    } finally {
      await server.close();
    }
    await expect(startHitlServer({ broker, port: 70_000 })).rejects.toThrow('Invalid HITL port');
  });
});
