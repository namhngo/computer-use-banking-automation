import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('fails closed on missing credentials without printing configuration values', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url)),
  ], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, MOCK_USERNAME: 'private-test-operator', MOCK_PASSWORD: '' },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('MOCK_USERNAME and MOCK_PASSWORD must be configured');
  expect(result.stdout + result.stderr).not.toContain('private-test-operator');
  expect(result.stdout).not.toContain('Harbor sandbox:');
});

it.each(['SIGINT', 'SIGTERM'] as const)('exits promptly on %s with an incomplete POST', async (signal) => {
  const reservation = createServer();
  let port: number;
  try {
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local TCP port');
    port = address.port;
  } finally {
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
  }

  const child = spawn(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url)), '--port', String(port),
  ], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, MOCK_USERNAME: 'test-operator', MOCK_PASSWORD: 'test-only-password' },
  });
  const controller = new AbortController();
  const startupTimeout = setTimeout(() => controller.abort(new Error('CLI startup timed out')), 5000);
  let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
  let pending: ClientRequest | undefined;
  let requestClosed: Promise<void> | undefined;
  const onChildError = (error: Error) => controller.abort(error);
  // Force-closing the server is expected to reset this unfinished request.
  const onRequestError = () => {};
  child.on('error', onChildError);

  try {
    let output = '';
    while (!output.includes(`Harbor sandbox: http://127.0.0.1:${String(port)}`)) {
      const chunks: unknown[] = await once(child.stdout, 'data', { signal: controller.signal });
      output += String(chunks[0]);
    }
    expect(output).not.toContain('test-operator');
    expect(output).not.toContain('test-only-password');
    pending = request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/login', agent: false,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': '1000',
        Expect: '100-continue',
      },
    });
    pending.on('error', onRequestError);
    requestClosed = new Promise<void>((resolve) => pending?.once('close', resolve));
    const accepted = once(pending, 'continue', { signal: controller.signal });
    pending.write('username=operator');
    // A 100 Continue response proves the server accepted the active request, without a sleep.
    await accepted;
    clearTimeout(startupTimeout);
    shutdownTimeout = setTimeout(() => controller.abort(new Error('CLI shutdown timed out')), 1500);
    const closed = once(child, 'close', { signal: controller.signal });
    child.kill(signal);
    expect(await closed).toEqual([0, null]);
  } finally {
    clearTimeout(startupTimeout);
    clearTimeout(shutdownTimeout);
    controller.abort();
    const killed = child.pid !== undefined && child.exitCode === null && child.signalCode === null
      ? once(child, 'close') : undefined;
    if (killed) child.kill('SIGKILL');
    pending?.destroy();
    await requestClosed;
    pending?.removeListener('error', onRequestError);
    await killed;
    child.stdout.destroy();
    child.removeListener('error', onChildError);
  }
}, 10_000);
