import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeAction, authorizeRequest, loadPolicy, parsePolicy } from './policy.js';
import type { Policy } from './policy.js';

const origin = 'http://localhost:4000';
let policy: Policy;
beforeAll(async () => {
  policy = await loadPolicy(fileURLToPath(new URL('../../policy.yaml', import.meta.url)));
});
const request = (path: string, method = 'GET') => ({ url: `${origin}${path}`, method });
const action = (path: string, action: string, targetKey?: string) => ({
  appId: 'harbor_core', appVersion: '1.0', url: `${origin}${path}`, action,
  ...(targetKey === undefined ? {} : { targetKey }),
});

describe('policy schema', () => {
  it('requires explicit deny-by-default and blocking irreversible actions', () => {
    expect(policy.defaultEffect).toBe('deny');
    expect(policy.irreversibleActions).toBe('block');
    for (const change of [
      { defaultEffect: 'allow' }, { defaultEffect: undefined },
      { irreversibleActions: 'allow' }, { irreversibleActions: undefined },
      { schemaVersion: 2 }, { schemaVersion: undefined },
    ]) expect(() => parsePolicy({ ...policy, ...change })).toThrow('Invalid policy.');
    const empty = parsePolicy({ ...policy, requests: [], actions: [], allowedOrigins: [] });
    expect(authorizeRequest(empty, request('/'))).toEqual({ allowed: false, code: 'origin_denied' });
    const noRules = parsePolicy({ ...policy, requests: [], actions: [] });
    expect(authorizeRequest(noRules, request('/'))).toEqual({ allowed: false, code: 'request_denied' });
    expect(authorizeAction(noRules, action('/', 'navigate')).allowed).toBe(false);
  });

  it.each([null, [], 'secret-placeholder', 1, {}, { defaultEffect: 'allow' }])(
    'rejects invalid configuration without returning its contents', (input) => {
      expect(() => parsePolicy(input)).toThrow(/^Invalid policy\.$/);
    },
  );

  it('rejects unknown keys at every level', () => {
    for (const change of [
      { credentials: 'secret-placeholder' },
      { requests: [{ method: 'GET', path: '/', extra: true }] },
      { requests: [{ method: 'GET', path: '/login', query: { reason: ['expired'], token: ['secret-placeholder'] } }] },
      { actions: [{ action: 'wait', path: '/', risk: 'read_only', selector: 'body' }] },
    ]) expect(() => parsePolicy({ ...policy, ...change })).toThrow(/^Invalid policy\.$/);
  });

  it('rejects missing identity, unsupported methods, and invalid query rules', () => {
    for (const change of [
      { appId: undefined }, { appVersion: undefined }, { appVersion: 1.0 },
      { requests: [{ method: 'PUT', path: '/login' }] },
      { requests: [{ method: 'GET', path: '/login', query: {} }] },
      { requests: [{ method: 'GET', path: '/login', query: { reason: ['other'] } }] },
      { requests: [{ method: 'GET', path: '/login', query: { reason: ['expired', 'expired'] } }] },
    ]) expect(() => parsePolicy({ ...policy, ...change })).toThrow(/^Invalid policy\.$/);
  });

  it.each([
    'https://localhost:4000', 'http://localhost:4000/', 'http://localhost:4000/path',
    'http://localhost:4000?secret=placeholder', 'http://user:placeholder@localhost:4000',
    'http://LOCALHOST:4000', 'not an origin',
  ])('requires canonical exact HTTP origins: %s', (allowedOrigin) => {
    expect(() => parsePolicy({ ...policy, allowedOrigins: [allowedOrigin] })).toThrow('Invalid policy.');
  });

  it.each(['*', '/members/*', '/members/:id', '/members/:memberId/:memberId', '/login/', '/a/../login', '/%6cogin', '/login?reason=expired', '/a\\login'])(
    'rejects unsupported route syntax %s', (path) => {
      expect(() => parsePolicy({ ...policy, requests: [{ method: 'GET', path }] })).toThrow('Invalid policy.');
      expect(() => parsePolicy({ ...policy, actions: [{ action: 'wait', path, risk: 'read_only' }] })).toThrow('Invalid policy.');
    },
  );

  it.each([
    { action: 'navigate', targetKey: 'member_id', risk: 'read_only' },
    { action: 'wait', targetKey: undefined, risk: 'read_only' },
    { action: 'click', risk: 'read_only' },
    { action: 'fill', risk: 'read_only' },
    { action: 'select', risk: 'read_only' },
    { action: 'extract', risk: 'read_only' },
    { action: 'click', targetKey: '#confirm', risk: 'read_only' },
    { action: 'click', targetKey: 'confirm', risk: 'irreversible' },
    { action: 'execute', targetKey: 'confirm', risk: 'read_only' },
  ])('validates action rules strictly', (rule) => {
    expect(() => parsePolicy({ ...policy, actions: [{ path: '/', ...rule }] })).toThrow('Invalid policy.');
  });

  it('rejects duplicate origins and conflicting action risks', () => {
    expect(() => parsePolicy({ ...policy, allowedOrigins: [origin, origin] })).toThrow('Invalid policy.');
    expect(() => parsePolicy({ ...policy, actions: [
      { action: 'wait', path: '/', risk: 'read_only' },
      { action: 'wait', path: '/', risk: 'reversible' },
    ] })).toThrow('Invalid policy.');
  });

  it('rejects overlapping parameterized/literal rules with conflicting risks in either order', () => {
    const rules = [
      { action: 'click', targetKey: 'review', path: '/members/:memberId', risk: 'read_only' },
      { action: 'click', targetKey: 'review', path: '/members/12345', risk: 'reversible' },
    ];
    expect(() => parsePolicy({ ...policy, actions: rules })).toThrow('Invalid policy.');
    expect(() => parsePolicy({ ...policy, actions: [...rules].reverse() })).toThrow('Invalid policy.');
    const sameRisk = parsePolicy({ ...policy, actions: rules.map((rule) => ({ ...rule, risk: 'read_only' })) });
    expect(authorizeAction(sameRisk, action('/members/12345', 'click', 'review'))).toEqual({ allowed: true, risk: 'read_only' });
  });

  it('does not trust shape-typed objects and prevents post-validation mutation', () => {
    const forged = { ...policy };
    expect(authorizeRequest(forged, request('/'))).toEqual({ allowed: false, code: 'invalid_policy' });
    expect(authorizeAction(forged, action('/', 'navigate'))).toEqual({ allowed: false, code: 'invalid_policy' });
    expect(() => policy.allowedOrigins.push('http://example.com')).toThrow();
    expect(() => { policy.actions[0]!.risk = 'reversible'; }).toThrow();
    const source = structuredClone(policy);
    const compiled = parsePolicy(source);
    source.requests.push({ method: 'POST', path: '/transfer' });
    expect(authorizeRequest(compiled, request('/transfer', 'POST')).allowed).toBe(false);
  });
});

describe('request decisions', () => {
  it('does not implicitly treat loopback hostnames as the same origin', () => {
    const localhostOnly = parsePolicy({ ...policy, allowedOrigins: [origin] });
    const url = 'http://127.0.0.1:4000/login';
    expect(authorizeRequest(localhostOnly, { url, method: 'GET' })).toEqual({ allowed: false, code: 'origin_denied' });
    expect(authorizeAction(localhostOnly, { ...action('/login', 'navigate'), url })).toEqual({ allowed: false, code: 'origin_denied' });
  });

  it.each([
    ['GET', '/'], ['GET', '/login'], ['GET', '/login?reason=expired'],
    ['GET', '/members/search'], ['GET', '/members/12345'], ['GET', '/members/00000/accounts'],
    ['GET', '/notice'], ['POST', '/login'], ['POST', '/members/search'], ['POST', '/notice'], ['POST', '/logout'],
  ])('allows explicit %s %s on both enumerated origins', (method, path) => {
    for (const allowedOrigin of [origin, 'http://127.0.0.1:4000']) {
      expect(authorizeRequest(policy, { url: `${allowedOrigin}${path}`, method })).toEqual({ allowed: true });
    }
  });

  it.each([
    ['POST', '/'], ['POST', '/members/12345'], ['POST', '/members/12345/accounts'], ['GET', '/logout'],
    ['POST', '/login?reason=expired'], ['GET', '/login?reason=other'],
    ['GET', '/login?reason=expired&reason=expired'], ['GET', '/login?reason=expired&token=placeholder'],
    ['GET', '/members/search?reason=expired'], ['GET', '/login?token=placeholder'],
    ['GET', '/members/1234'], ['GET', '/members/123456'], ['GET', '/members/abcde'],
    ['GET', '/members/12345/accounts/'], ['GET', '/members/12345/accounts-extra'],
    ['GET', '/LOGIN'], ['GET', '/members//12345'],
  ])('denies unmatched %s %s', (method, path) => {
    expect(authorizeRequest(policy, request(path, method))).toEqual({ allowed: false, code: 'request_denied' });
  });

  it.each([null, {}, { url: origin }, request('/', 'get'), request('/', 'DELETE'),
    { ...request('/'), risk: 'read_only' }, { ...request('/'), url: new URL(origin) }])(
    'runtime-validates request input', (input) => {
      expect(authorizeRequest(policy, input)).toEqual({ allowed: false, code: 'invalid_input' });
    },
  );
});

describe('action decisions', () => {
  it.each([
    ['/login', 'fill', 'login_operator', 'reversible'],
    ['/login?reason=expired', 'fill', 'login_password', 'reversible'],
    ['/login', 'click', 'sign_in', 'reversible'],
    ['/members/search', 'click', 'sign_out', 'reversible'],
    ['/members/search', 'fill', 'member_id', 'read_only'],
    ['/members/search', 'click', 'search_member', 'read_only'],
    ['/members/search', 'click', 'view_member', 'read_only'],
    ['/members/12345', 'extract', 'member_identity', 'read_only'],
    ['/members/12345/accounts', 'extract', 'savings_balance', 'read_only'],
    ['/members/12345/accounts', 'extract', 'currency', 'read_only'],
  ])('uses trusted target identity and policy risk for %s %s %s', (path, verb, targetKey, risk) => {
    expect(authorizeAction(policy, action(path, verb, targetKey))).toEqual({ allowed: true, risk });
  });

  it.each(['navigate', 'wait'])('allows %s without a target only on allowed pages', (verb) => {
    expect(authorizeAction(policy, action('/login?reason=expired', verb))).toEqual({ allowed: true, risk: 'read_only' });
    expect(authorizeAction(policy, action('/login?reason=expired&reason=expired', verb)).allowed).toBe(false);
    expect(authorizeAction(policy, action('/login?token=placeholder', verb)).allowed).toBe(false);
    expect(authorizeAction(policy, action('/login', verb, 'sign_in'))).toEqual({ allowed: false, code: 'invalid_input' });
  });

  it('supports explicit configurable select rules, without enabling selects by default', () => {
    const input = action('/members/search', 'select', 'member_filter');
    expect(authorizeAction(policy, input).allowed).toBe(false);
    const configured = parsePolicy({ ...policy, actions: [
      ...policy.actions, { action: 'select', path: '/members/search', targetKey: 'member_filter', risk: 'read_only' },
    ] });
    expect(authorizeAction(configured, input)).toEqual({ allowed: true, risk: 'read_only' });
  });

  it('distinguishes known and unknown dialogs despite the same allowed POST', () => {
    // These identities are resolved by the trusted adapter/app profile, NOT a model.
    expect(authorizeRequest(policy, request('/notice', 'POST'))).toEqual({ allowed: true });
    expect(authorizeAction(policy, action('/notice', 'click', 'system_notice_ok'))).toEqual({ allowed: true, risk: 'reversible' });
    expect(authorizeAction(policy, action('/notice', 'click', 'operator_notice_acknowledge'))).toEqual({ allowed: false, code: 'action_denied' });
    const noActions = parsePolicy({ ...policy, actions: [] });
    expect(authorizeRequest(noActions, request('/notice', 'POST'))).toEqual({ allowed: true });
    expect(authorizeAction(noActions, action('/notice', 'click', 'system_notice_ok'))).toEqual({ allowed: false, code: 'action_denied' });
  });

  it('does not authorize selectors, unknown targets, or self-claimed read_only risk', () => {
    for (const input of [
      action('/members/12345', 'click', 'open_sub_account'),
      { ...action('/members/12345', 'click', 'open_sub_account'), risk: 'read_only' },
      { ...action('/notice', 'click', 'operator_notice_acknowledge'), risk: 'read_only' },
      { ...action('/login', 'click', 'sign_in'), risk: 'read_only' },
      { ...action('/notice', 'click', 'system_notice_ok'), selector: 'button' },
      action('/notice', 'click', 'button'), action('/notice', 'click', '#notice-title'),
      action('/members/search', 'fill', 'login_password'), action('/login', 'extract', 'login_password'),
    ]) expect(authorizeAction(policy, input).allowed).toBe(false);
  });

  it.each(['execute', 'evaluate', 'download', 'upload', 'delete', 'transfer', 'CLICK', '', null])(
    'fails closed for unknown action types', (verb) => {
      expect(authorizeAction(policy, { ...action('/', 'wait'), action: verb })).toEqual({ allowed: false, code: 'invalid_input' });
    },
  );

  it.each(['click', 'fill', 'select', 'extract'])('requires a trusted target for %s', (verb) => {
    expect(authorizeAction(policy, action('/login', verb))).toEqual({ allowed: false, code: 'invalid_input' });
  });

  it('runtime-validates action inputs and rejects app identity mismatches', () => {
    for (const input of [null, {}, { ...action('/', 'wait'), url: 1 }]) {
      expect(authorizeAction(policy, input)).toEqual({ allowed: false, code: 'invalid_input' });
    }
    for (const change of [{ appId: 'other_app' }, { appVersion: '1.1' }]) {
      expect(authorizeAction(policy, { ...action('/', 'wait'), ...change })).toEqual({ allowed: false, code: 'app_mismatch' });
    }
    const input = { get url() { throw new Error('secret-placeholder'); } };
    expect(authorizeAction(policy, input)).toEqual({ allowed: false, code: 'invalid_input' });
    expect(authorizeRequest(policy, input)).toEqual({ allowed: false, code: 'invalid_input' });
  });
});

describe('URL boundary', () => {
  it.each([
    'http://example.com/login', 'http://localhost.evil.test:4000/login',
    'http://localhost:4001/login', 'http://127.0.0.2:4000/login', 'http://[::1]:4000/login',
  ])('denies non-enumerated origin %s', (url) => {
    expect(authorizeRequest(policy, { url, method: 'GET' })).toEqual({ allowed: false, code: 'origin_denied' });
    expect(authorizeAction(policy, { ...action('/login', 'navigate'), url })).toEqual({ allowed: false, code: 'origin_denied' });
  });

  it.each([
    '', '/login', 'not a URL', '//localhost:4000/login', 'https://localhost:4000/login',
    'file:///login', 'http://[invalid/login', 'http://localhost:4000/login#',
    'http://user:secret-placeholder@localhost:4000/login', 'http://@localhost:4000/login',
    'http://localhost:4000@evil.test/login', 'http://127.1:4000/login',
    'http://2130706433:4000/login', 'http://LOCALHOST:4000/login',
    `${origin}/members/12345/../../login`, `${origin}/./login`,
    `${origin}/members/12345/%2e%2e/%2e%2e/login`, `${origin}/%2flogin`,
    `${origin}/members%2F12345/accounts`, `${origin}/members%5c12345/accounts`,
    `${origin}/%252e%252e/login`, `${origin}/%6cogin`, `${origin}/login%`,
    `${origin}/members\\12345\\accounts`, 'http:\\localhost:4000/login',
    ` ${origin}/login`, `${origin}/lo\ngin`, `${origin}/login\t`,
    `${origin}/login?`, `${origin}/login?reason`, `${origin}/login?reason=`,
    `${origin}/login?reason=%65xpired`, `${origin}/login?reason=expired&`,
    `${origin}/login?reason=expired;token=placeholder`,
  ])('rejects malformed or ambiguous URL spelling %j', (url) => {
    expect(authorizeRequest(policy, { url, method: 'GET' })).toEqual({ allowed: false, code: 'invalid_url' });
    expect(authorizeAction(policy, { ...action('/login', 'navigate'), url })).toEqual({ allowed: false, code: 'invalid_url' });
  });

  it.each([
    '/members/12345/sub-accounts', '/members/12345/sub-accounts/../accounts',
    '/members/12345/sub-accounts/%2e%2e/accounts', '/members/12345/sub-accounts%2f..%2faccounts',
    '/members/12345/sub-accounts?reason=expired', '/transfer', '/admin/reset',
  ])('never grants risky routes %s', (path) => {
    for (const method of ['GET', 'POST']) expect(authorizeRequest(policy, request(path, method)).allowed).toBe(false);
    for (const verb of ['navigate', 'wait', 'click', 'extract']) {
      expect(authorizeAction(policy, action(path, verb, ['click', 'extract'].includes(verb) ? 'savings_balance' : undefined)).allowed).toBe(false);
    }
  });

  it('never echoes raw input or secrets in decisions', () => {
    const url = 'http://operator:secret-placeholder@localhost:4000/login?password=secret-placeholder';
    expect(authorizeRequest(policy, { url, method: 'GET' })).toEqual({ allowed: false, code: 'invalid_url' });
    expect(authorizeAction(policy, { ...action('/login', 'fill', 'login_password'), url })).toEqual({ allowed: false, code: 'invalid_url' });
  });
});

describe('YAML loading', () => {
  it('loads YAML from disk and sanitizes file, syntax, schema, tag, duplicate, and alias errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-policy-'));
    const path = join(directory, 'policy.yaml');
    const valid = `schemaVersion: 1
defaultEffect: deny
appId: harbor_core
appVersion: '1.0'
allowedOrigins: [http://localhost:4000]
requests: [{method: GET, path: /}]
actions: [{action: navigate, path: /, risk: read_only}]
irreversibleActions: block
`;
    try {
      await writeFile(path, valid);
      expect(authorizeAction(await loadPolicy(path), action('/', 'navigate'))).toEqual({ allowed: true, risk: 'read_only' });
      for (const invalid of [
        '', '[secret-placeholder', `${valid}defaultEffect: allow\n`, `${valid}unknown: secret-placeholder\n`,
        valid.replace('method: GET', 'method: GET, method: POST'),
        valid.replace('defaultEffect: deny', 'defaultEffect: !secret-placeholder deny'),
        valid.replace('defaultEffect: deny', 'defaultEffect: !!str deny'),
        valid.replace('defaultEffect: deny', 'defaultEffect: &effect deny').replace('irreversibleActions: block', 'irreversibleActions: *effect'),
        `${valid}extra: &a [*a]\n`, `${valid}---\nsecret-placeholder\n`,
        valid.replace("appVersion: '1.0'", 'appVersion: 1.0'),
      ]) {
        await writeFile(path, invalid);
        await expect(loadPolicy(path)).rejects.toThrow(/^Invalid policy\.$/);
      }
      await expect(loadPolicy(join(directory, 'secret-placeholder'))).rejects.toThrow(/^Invalid policy\.$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
