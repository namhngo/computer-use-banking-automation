import { createServer, request } from 'node:http';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { authorizeRequest } from '../policy/policy.js';
import type { Policy } from '../policy/policy.js';

type Violation = 'POLICY_BLOCKED' | 'NETWORK_ERROR';
type PostGrant = { url: string; body: Buffer; revoked: boolean };
const maxFormBodyBytes = 32 * 1024;

function forwardingHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const stripped = new Set([
    'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-automation-session',
    ...(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()),
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !stripped.has(name)));
}

/**
 * HTTP-only enforcement for a trusted local prototype, not an HTTPS tunnel or banking API.
 * Launch Chromium with BOTH returned proxy fields and block service workers in its contexts.
 * Grant each POST's exact URL and UTF-8 form body just before dispatch; revoke in finally.
 * Non-network navigation (including script/data URLs) still needs adapter restrictions.
 */
export async function startPolicyProxy({ policy, origin, onViolation, timeoutMs, sessionToken }: {
  policy: Policy;
  origin: string;
  onViolation: (code: Violation) => void;
  timeoutMs: number;
  sessionToken?: string;
}): Promise<{ server: string; bypass: string; grantPost(url: string, body: string): () => void; close(): Promise<void> }> {
  try {
    const target = new URL(origin);
    const decision = authorizeRequest(policy, { url: `${origin}/`, method: 'GET' });
    if (target.protocol !== 'http:' || target.origin !== origin
      || !policy.allowedOrigins.includes(origin)
      || (!decision.allowed && decision.code === 'invalid_policy')
      || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
      || (sessionToken !== undefined && !/^[a-f0-9]{32}$/.test(sessionToken))) {
      throw new Error();
    }
  } catch {
    throw new Error('Policy proxy startup failed.');
  }

  const sockets = new Set<Socket>();
  const upstreams = new Set<ClientRequest>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let grant: PostGrant | undefined;
  const grantPost = (url: string, body: string): (() => void) => {
    if (closing || grant || typeof body !== 'string' || Buffer.byteLength(body) > maxFormBodyBytes
      || !authorizeRequest(policy, { url, method: 'POST' }).allowed || new URL(url).origin !== origin) {
      throw new Error('Invalid POST grant.');
    }
    const issued: PostGrant = { url, body: Buffer.from(body), revoked: false };
    grant = issued;
    return () => {
      issued.revoked = true;
      if (grant === issued) grant = undefined;
    };
  };
  const report = (code: Violation) => {
    if (closing) return;
    // A consumer callback must not crash the proxy or expose a transport error.
    try { onViolation(code); } catch { /* Only generic codes leave this module. */ }
  };
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => { /* Request handlers report sanitized failures. */ });
  };

  const forward = (incoming: IncomingMessage, response: ServerResponse) => {
    // Chromium's own update/sign-in traffic is outside our Page context. Still deny it,
    // but do not let an unmarked background request consume an action grant or abort a run.
    if (sessionToken !== undefined && incoming.headers['x-automation-session'] !== sessionToken) {
      incoming.on('error', () => {});
      response.on('error', () => response.destroy());
      response.writeHead(403, { connection: 'close', 'content-type': 'text/plain', 'x-automation-denied': '1' });
      response.end('POLICY_BLOCKED');
      return;
    }
    const rawUrl = incoming.url;
    // Consume on arrival, even for a mismatched destination or an incomplete upload.
    const postGrant = incoming.method === 'POST' ? grant : undefined;
    if (incoming.method === 'POST') grant = undefined;
    // Authorize the unnormalized request target, never a URL reconstructed from Host.
    if (closing || !authorizeRequest(policy, { url: rawUrl, method: incoming.method }).allowed
      || typeof rawUrl !== 'string' || new URL(rawUrl).origin !== origin
      || (incoming.method === 'POST' && (!postGrant || postGrant.revoked || postGrant.url !== rawUrl))) {
      report('POLICY_BLOCKED');
      incoming.on('error', () => { /* A denied upload can be aborted by the client. */ });
      response.on('error', () => response.destroy());
      response.writeHead(403, { connection: 'close', 'content-type': 'text/plain' });
      response.end('POLICY_BLOCKED');
      return;
    }

    const target = new URL(rawUrl);
    let upstream: ClientRequest | undefined;
    let upstreamResponse: IncomingMessage | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    // The absolute deadline covers body validation AND the upstream exchange.
    incoming.socket.setTimeout(0);
    const timer = setTimeout(() => fail('NETWORK_ERROR'), timeoutMs);
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      incoming.pause();
      if (upstream) {
        incoming.unpipe(upstream);
        upstreams.delete(upstream);
        upstream.destroy();
      }
      upstreamResponse?.destroy();
    };
    const fail = (code: Violation) => {
      if (settled) return;
      report(code);
      cleanup();
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(code === 'POLICY_BLOCKED' ? 403 : 502, {
          connection: 'close', 'content-type': 'text/plain',
        });
        response.end(code);
      }
    };
    response.once('finish', cleanup);
    response.once('close', cleanup);
    response.once('error', () => fail('NETWORK_ERROR'));
    incoming.once('error', () => fail('NETWORK_ERROR'));
    incoming.once('aborted', () => fail('NETWORK_ERROR'));

    const send = (body?: Buffer) => {
      if (settled) return;
      if (closing || postGrant?.revoked) { fail('POLICY_BLOCKED'); return; }
      try {
        const headers = forwardingHeaders(incoming.headers);
        headers.host = target.host;
        delete headers.expect;
        if (body) headers['content-length'] = String(body.length);
        upstream = request(target, { method: incoming.method, headers, agent: false }, (reply) => {
          upstreamResponse = reply;
          reply.once('error', () => fail('NETWORK_ERROR'));
          reply.once('aborted', () => fail('NETWORK_ERROR'));
          if (settled) { reply.destroy(); return; }
          // Preserve Location and redirect status; a redirected POST needs its own grant.
          response.writeHead(reply.statusCode ?? 502, forwardingHeaders(reply.headers));
          reply.pipe(response);
        });
        upstreams.add(upstream);
        upstream.once('socket', trackSocket);
        upstream.once('error', () => fail('NETWORK_ERROR'));
        upstream.once('upgrade', (_reply, socket) => {
          socket.destroy();
          fail('POLICY_BLOCKED');
        });
        if (body) upstream.end(body);
        else incoming.pipe(upstream);
      } catch {
        fail('NETWORK_ERROR');
      }
    };

    if (postGrant) {
      if (Number(incoming.headers['content-length']) > maxFormBodyBytes) { fail('POLICY_BLOCKED'); return; }
      let length = 0;
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        length += chunk.length;
        if (length > maxFormBodyBytes) { fail('POLICY_BLOCKED'); return; }
        chunks.push(chunk);
      });
      incoming.once('end', () => {
        if (settled) return;
        const body = Buffer.concat(chunks, length);
        chunks.length = 0;
        // Do not normalize form encoding: even equivalent spellings need a fresh grant.
        if (!body.equals(postGrant.body)) { fail('POLICY_BLOCKED'); return; }
        send(body);
      });
    }
    if (incoming.headers.expect?.toLowerCase() === '100-continue') response.writeContinue();
    if (!postGrant) send();
  };

  const listener = createServer({ headersTimeout: timeoutMs, requestTimeout: timeoutMs }, forward);
  listener.on('connection', (socket) => {
    trackSocket(socket);
    socket.setTimeout(timeoutMs, () => socket.destroy());
  });
  listener.on('checkContinue', forward);
  listener.on('checkExpectation', forward);
  // These events bypass the normal HTTP request handler. Never open a target socket.
  const denyTunnel = (incoming: IncomingMessage, socket: Socket) => {
    if (sessionToken === undefined || incoming.headers['x-automation-session'] === sessionToken) report('POLICY_BLOCKED');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 14\r\n\r\nPOLICY_BLOCKED');
  };
  listener.on('connect', denyTunnel);
  listener.on('upgrade', denyTunnel);
  listener.on('clientError', (_error, socket) => {
    if (!socket.destroyed && sessionToken === undefined) report('POLICY_BLOCKED');
    socket.destroy();
  });

  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve) => {
      closing = true;
      if (grant) grant.revoked = true;
      grant = undefined;
      listener.close(() => resolve());
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        listener.removeListener('error', reject);
        resolve();
      });
    });
    listener.on('error', () => report('NETWORK_ERROR'));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error();
    return { server: `http://127.0.0.1:${String(address.port)}`, bypass: '<-loopback>', grantPost, close };
  } catch {
    await close();
    throw new Error('Policy proxy startup failed.');
  }
}
