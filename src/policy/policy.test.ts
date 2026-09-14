import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { authorizeAction, authorizeHumanAction, authorizeRequest, canonicalPagePath, loadPolicy, matchesPath, parsePolicy, policyApp } from './policy.js';
import type { Effect, Policy } from './policy.js';

const origin = 'http://localhost:4000';
let policy: Policy;
beforeAll(async () => {
  policy = await loadPolicy(fileURLToPath(new URL('../../policy.yaml', import.meta.url)));
});
const request = (path: string, method = 'GET') => ({ url: `${origin}${path}`, method });
const action = (path: string, action: string, effect?: Effect) => ({
  appId: 'harbor_core', appVersion: '1.0', url: `${origin}${path}`, action,
  ...(effect === undefined ? {} : { effect }),
});
const read: Effect = { kind: 'read' };
const link = (path: string): Effect => ({ kind: 'navigate', destination: `${origin}${path}` });
const form = (kind: 'input' | 'submit', path: string, fields: string[], method = 'post', originOverride = origin): Effect =>
  ({ kind, form: { action: `${originOverride}${path}`, method, fields } });

describe('policy schema', () => {
  it('requires explicit deny-by-default and blocking irreversible actions', () => {
    expect(policy.defaultEffect).toBe('deny');
    expect(policy.irreversibleActions).toBe('block');
    expect(policyApp(policy)).toEqual({ appId: 'harbor_core', appVersion: '1.0' });
    for (const change of [
      { defaultEffect: 'allow' }, { defaultEffect: undefined },
      { irreversibleActions: 'allow' }, { irreversibleActions: undefined },
      { schemaVersion: 1 }, { schemaVersion: undefined },
      { allowedOrigins: [] }, { pages: [] }, { session: undefined },
    ]) expect(() => parsePolicy({ ...policy, ...change })).toThrow('Invalid policy.');
    const noForms = parsePolicy({ ...policy, forms: [] });
    expect(authorizeRequest(noForms, request('/login', 'POST'))).toEqual({ allowed: false, code: 'request_denied' });
    expect(authorizeAction(noForms, action('/login', 'fill', form('input', '/login', ['password', 'username']))).allowed).toBe(false);
    expect(authorizeAction(noForms, action('/login', 'extract', read))).toEqual({ allowed: true, risk: 'read_only' });
  });

  it.each([null, [], 'secret-placeholder', 1, {}, { defaultEffect: 'allow' }])(
    'rejects invalid configuration without returning its contents', (input) => {
      expect(() => parsePolicy(input)).toThrow(/^Invalid policy\.$/);
    },
  );

  it('rejects unknown keys at every level', () => {
    for (const change of [
      { credentials: 'secret-placeholder' },
      { pages: [{ path: '/', extra: true }] },
      { pages: [{ path: '/login', query: { reason: ['expired'] } }, { path: '/', selector: 'body' }] },
      { forms: [{ path: '/login', fields: ['username'], risk: 'reversible', targetKey: 'sign_in' }] },
      { session: { ...policy.session, cookie: 'secret-placeholder' } },
    ]) expect(() => parsePolicy({ ...policy, ...change })).toThrow(/^Invalid policy\.$/);
  });

  it('rejects missing identity, bad query rules, and a session whose login page is not allowed', () => {
    for (const change of [
      { appId: undefined }, { appVersion: undefined }, { appVersion: 1.0 },
      { pages: [{ path: '/login', query: { reason: [] } }] },
      { pages: [{ path: '/login', query: { 'bad key': ['x'] } }] },
      { pages: [{ path: '/', query: {} }, { path: '/', query: {} }] },
      { session: { ...policy.session, loginPath: '/signin' } },
      { session: { ...policy.session, fields: { username: 'Operator ID' } } },
      { session: { ...policy.session, submit: ' Sign in' } },
    ]) expect(() => parsePolicy({ ...policy, ...change })).toThrow(/^Invalid policy\.$/);
  });

  it.each([
    'https://localhost:4000', 'http://localhost:4000/', 'http://localhost:4000/path',
    'http://localhost:4000?secret=placeholder', 'http://user:placeholder@localhost:4000',
    'http://LOCALHOST:4000', 'not an origin',
  ])('requires canonical exact HTTP origins: %s', (allowedOrigin) => {
    expect(() => parsePolicy({ ...policy, allowedOrigins: [allowedOrigin] })).toThrow('Invalid policy.');
  });

  it.each(['*', '/members/*', '/members/:memberId', '/login/', '/a/../login', '/%6cogin', '/login?reason=expired', '/a\\login', 'members'])(
    'rejects unsupported route syntax %s', (path) => {
      expect(() => parsePolicy({ ...policy, pages: [...policy.pages, { path }] })).toThrow('Invalid policy.');
      expect(() => parsePolicy({ ...policy, forms: [{ path, fields: [], risk: 'read_only' }] })).toThrow('Invalid policy.');
    },
  );

  it.each([
    { path: '/x', fields: ['a', 'a'], risk: 'read_only' },
    { path: '/x', fields: ['1a'], risk: 'read_only' },
    { path: '/x', fields: [], risk: 'irreversible' },
    { path: '/x', fields: [] },
    { path: '/x', risk: 'read_only' },
  ])('validates form rules strictly %j', (rule) => {
    expect(() => parsePolicy({ ...policy, forms: [rule] })).toThrow('Invalid policy.');
    expect(() => parsePolicy({ ...policy, humanForms: [rule] })).toThrow('Invalid policy.');
  });

  it('rejects duplicate origins, pages and form rules', () => {
    expect(() => parsePolicy({ ...policy, allowedOrigins: [origin, origin] })).toThrow('Invalid policy.');
    expect(() => parsePolicy({ ...policy, pages: [...policy.pages, { path: '/' }] })).toThrow('Invalid policy.');
    expect(() => parsePolicy({ ...policy, forms: [
      { path: '/notice', fields: [], risk: 'read_only' },
      { path: '/notice', fields: [], risk: 'reversible' },
    ] })).toThrow('Invalid policy.');
    // The same field set in a different order is the same rule.
    expect(() => parsePolicy({ ...policy, forms: [
      { path: '/login', fields: ['username', 'password'], risk: 'reversible' },
      { path: '/login', fields: ['password', 'username'], risk: 'reversible' },
    ] })).toThrow('Invalid policy.');
  });

  it('does not trust shape-typed objects and prevents post-validation mutation', () => {
    const forged = { ...policy };
    expect(authorizeRequest(forged, request('/'))).toEqual({ allowed: false, code: 'invalid_policy' });
    expect(authorizeAction(forged, action('/', 'navigate'))).toEqual({ allowed: false, code: 'invalid_policy' });
    expect(authorizeHumanAction(forged, { ...action('/notice', 'click'), action: undefined, effect: form('submit', '/notice', []) })).toEqual({ allowed: false, code: 'invalid_policy' });
    expect(() => policy.allowedOrigins.push('http://example.com')).toThrow();
    expect(() => { policy.forms[0]!.risk = 'reversible'; }).toThrow();
    const source = structuredClone(policy);
    const compiled = parsePolicy(source);
    source.forms.push({ path: '/transfer', fields: [], risk: 'reversible' });
    expect(authorizeRequest(compiled, request('/transfer', 'POST')).allowed).toBe(false);
  });
});

describe('path matching and canonical evidence paths', () => {
  it('treats :id as exactly one opaque identifier segment', () => {
    expect(matchesPath('/members/:id', '/members/12345')).toBe(true);
    expect(matchesPath('/members/:id', '/members/abc-1_2')).toBe(true);
    expect(matchesPath('/members/:id', '/members/')).toBe(false);
    expect(matchesPath('/members/:id', '/members/12345/accounts')).toBe(false);
    expect(matchesPath('/members/:id/accounts', '/members/12345/accounts')).toBe(true);
    expect(matchesPath('/members/:id', '/members/a.b')).toBe(false);
  });

  it('spells identifiers as :id, keeps literal routes, and never names an unknown route', () => {
    expect(canonicalPagePath(policy, `${origin}/members/12345/accounts`)).toBe('/members/:id/accounts');
    expect(canonicalPagePath(policy, `${origin}/members/search`)).toBe('/members/search');
    expect(canonicalPagePath(policy, `${origin}/`)).toBe('/');
    expect(canonicalPagePath(policy, `${origin}/login?reason=expired`)).toBe('/login');
    // Any segment a page pattern marks as :id is spelled :id, whatever its value looks like.
    expect(canonicalPagePath(policy, `${origin}/members/AB123`)).toBe('/members/:id');
    expect(canonicalPagePath(policy, `${origin}/members/AB123`, ['AB123'])).toBe('/members/:id');
    expect(canonicalPagePath(policy, `${origin}/transfer`)).toBe('[unavailable]');
    expect(canonicalPagePath(policy, 'not a url')).toBe('[unavailable]');
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
    ['GET', '/members/abcde'],
    ['GET', '/notice'], ['POST', '/login'], ['POST', '/members/search'], ['POST', '/notice'], ['POST', '/logout'],
  ])('allows explicit %s %s on both enumerated origins', (method, path) => {
    for (const allowedOrigin of [origin, 'http://127.0.0.1:4000']) {
      expect(authorizeRequest(policy, { url: `${allowedOrigin}${path}`, method })).toEqual({ allowed: true });
    }
  });

  it.each([
    ['POST', '/'], ['POST', '/members/12345'], ['POST', '/members/12345/accounts'], ['GET', '/logout'],
    ['POST', '/members/12345/sub-accounts'],
    ['POST', '/login?reason=expired'], ['GET', '/login?reason=other'],
    ['GET', '/login?reason=expired&reason=expired'], ['GET', '/login?reason=expired&token=placeholder'],
    ['GET', '/members/search?reason=expired'], ['GET', '/login?token=placeholder'],
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

describe('action decisions by structural effect', () => {
  it.each([
    ['/login', 'fill', form('input', '/login', ['password', 'username']), 'reversible'],
    ['/login?reason=expired', 'fill', form('input', '/login', ['username', 'password']), 'reversible'],
    ['/login', 'click', form('submit', '/login', ['password', 'username']), 'reversible'],
    ['/members/search', 'click', form('submit', '/logout', []), 'reversible'],
    ['/members/search', 'fill', form('input', '/members/search', ['memberId']), 'read_only'],
    ['/members/search', 'click', form('submit', '/members/search', ['memberId']), 'read_only'],
    ['/members/search', 'click', link('/members/12345'), 'read_only'],
    ['/members/12345', 'click', link('/members/search'), 'read_only'],
    ['/members/12345', 'extract', read, 'read_only'],
    ['/members/12345/accounts', 'extract', read, 'read_only'],
    ['/notice', 'click', form('submit', '/notice', []), 'reversible'],
  ])('decides %s %s from the measured effect', (path, verb, effect, risk) => {
    expect(authorizeAction(policy, action(path, verb, effect))).toEqual({ allowed: true, risk });
  });

  it('reads any visible text on an allowed page, and nothing on a page that is not', () => {
    expect(authorizeAction(policy, action('/members/12345/accounts', 'extract', read))).toEqual({ allowed: true, risk: 'read_only' });
    expect(authorizeAction(policy, action('/members/12345', 'extract', read))).toEqual({ allowed: true, risk: 'read_only' });
    expect(authorizeAction(policy, action('/transfer', 'extract', read))).toEqual({ allowed: false, code: 'request_denied' });
    // Reading is text only: a click on a plain node has no authorised effect.
    expect(authorizeAction(policy, action('/members/12345', 'click', read))).toEqual({ allowed: false, code: 'action_denied' });
  });

  it('denies forms the policy does not list, however they are reached', () => {
    // The sandbox's "Open sub-account" form: same page is allowed, the POST is not.
    expect(authorizeAction(policy, action('/members/12345', 'click', form('submit', '/members/12345/sub-accounts', ['accountType']))))
      .toEqual({ allowed: false, code: 'action_denied' });
    expect(authorizeAction(policy, action('/members/12345', 'fill', form('input', '/members/12345/sub-accounts', ['accountType']))))
      .toEqual({ allowed: false, code: 'action_denied' });
    // Extra or missing fields change the submission and therefore the decision.
    expect(authorizeAction(policy, action('/members/search', 'click', form('submit', '/members/search', ['memberId', 'confirm']))).allowed).toBe(false);
    expect(authorizeAction(policy, action('/members/search', 'click', form('submit', '/members/search', []))).allowed).toBe(false);
    // Only POST forms are submissions; a GET form is not a listed page load either.
    expect(authorizeAction(policy, action('/members/search', 'click', form('submit', '/members/search', ['memberId'], 'get'))).allowed).toBe(false);
    // A form posting elsewhere is denied even when its path matches.
    expect(authorizeAction(policy, action('/login', 'click', form('submit', '/login', ['password', 'username'], 'post', 'http://evil.test'))).allowed).toBe(false);
  });

  it('follows links only to allowed pages on the allowed origin', () => {
    expect(authorizeAction(policy, action('/members/search', 'click', link('/members/12345'))).allowed).toBe(true);
    expect(authorizeAction(policy, action('/members/search', 'click', link('/members/12345/sub-accounts'))).allowed).toBe(false);
    expect(authorizeAction(policy, action('/members/search', 'click', link('/logout'))).allowed).toBe(false);
    expect(authorizeAction(policy, action('/members/search', 'click', { kind: 'navigate', destination: 'http://evil.test/members/12345' })).allowed).toBe(false);
    expect(authorizeAction(policy, action('/members/search', 'click', { kind: 'navigate', destination: `${origin}/members/12345#x` })).allowed).toBe(false);
  });

  it.each(['navigate', 'wait'])('allows %s without an effect only on allowed pages', (verb) => {
    expect(authorizeAction(policy, action('/login?reason=expired', verb))).toEqual({ allowed: true, risk: 'read_only' });
    expect(authorizeAction(policy, action('/login?reason=expired&reason=expired', verb)).allowed).toBe(false);
    expect(authorizeAction(policy, action('/login?token=placeholder', verb)).allowed).toBe(false);
    expect(authorizeAction(policy, action('/login', verb, read))).toEqual({ allowed: false, code: 'action_denied' });
  });

  it('never accepts an unknown effect, a mismatched verb, or self-claimed risk', () => {
    for (const input of [
      action('/members/12345', 'click', { kind: 'unknown' }),
      action('/members/12345', 'click'),
      action('/members/12345', 'fill'),
      action('/members/12345', 'extract'),
      action('/login', 'fill', form('submit', '/login', ['password', 'username'])),
      action('/login', 'click', form('input', '/login', ['password', 'username'])),
      action('/login', 'extract', form('submit', '/login', ['password', 'username'])),
      action('/login', 'extract', link('/members/search')),
      action('/login', 'select', form('submit', '/login', ['password', 'username'])),
      { ...action('/members/12345', 'click', form('submit', '/members/12345/sub-accounts', [])), risk: 'read_only' },
      { ...action('/notice', 'click', form('submit', '/notice', [])), selector: 'button' },
      { ...action('/notice', 'click', form('submit', '/notice', [])), targetKey: 'system_notice_ok' },
    ]) expect(authorizeAction(policy, input).allowed).toBe(false);
  });

  it('allows a listed form field for select the same way as fill, and nothing more', () => {
    const configured = parsePolicy({ ...policy, forms: [...policy.forms, { path: '/members/search', fields: ['memberFilter'], risk: 'read_only' }] });
    expect(authorizeAction(configured, action('/members/search', 'select', form('input', '/members/search', ['memberFilter'])))).toEqual({ allowed: true, risk: 'read_only' });
    expect(authorizeAction(policy, action('/members/search', 'select', form('input', '/members/search', ['memberFilter']))).allowed).toBe(false);
  });

  it.each(['execute', 'evaluate', 'download', 'upload', 'delete', 'transfer', 'CLICK', '', null])(
    'fails closed for unknown action types', (verb) => {
      expect(authorizeAction(policy, { ...action('/', 'wait'), action: verb })).toEqual({ allowed: false, code: 'invalid_input' });
    },
  );

  it('runtime-validates action inputs and rejects app identity mismatches', () => {
    for (const input of [null, {}, { ...action('/', 'wait'), url: 1 }, { ...action('/', 'extract'), effect: { kind: 'read', extra: true } },
      { ...action('/', 'extract'), effect: 'read' }]) {
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

describe('human action decisions', () => {
  const human = (path: string, effect: Effect) => ({ appId: 'harbor_core', appVersion: '1.0', url: `${origin}${path}`, effect });
  const withHumanForm = () => parsePolicy({ ...policy, forms: policy.forms.filter((rule) => rule.path !== '/notice'),
    humanForms: [{ path: '/notice', fields: [], risk: 'reversible' }] });

  it('permits automation forms plus humanForms, and never widens automation', () => {
    const configured = withHumanForm();
    expect(authorizeHumanAction(configured, human('/notice', form('submit', '/notice', [])))).toEqual({ allowed: true, risk: 'reversible' });
    expect(authorizeAction(configured, action('/notice', 'click', form('submit', '/notice', [])))).toEqual({ allowed: false, code: 'action_denied' });
    expect(authorizeHumanAction(configured, human('/members/search', form('submit', '/members/search', ['memberId'])))).toEqual({ allowed: true, risk: 'read_only' });
    expect(authorizeHumanAction(configured, human('/members/12345', form('submit', '/members/12345/sub-accounts', ['accountType'])))).toEqual({ allowed: false, code: 'action_denied' });
    expect(authorizeHumanAction(configured, human('/members/12345', human('/x', read).effect))).toEqual({ allowed: false, code: 'action_denied' });
    expect(authorizeHumanAction(configured, human('/members/search', link('/members/12345')))).toEqual({ allowed: false, code: 'action_denied' });
  });

  it('applies the same origin, request, app, and input boundaries', () => {
    const submit = form('submit', '/notice', []);
    expect(authorizeHumanAction(policy, human('/unknown', submit))).toEqual({ allowed: false, code: 'request_denied' });
    expect(authorizeHumanAction(policy, { ...human('/notice', submit), url: 'http://evil.example/notice' })).toEqual({ allowed: false, code: 'origin_denied' });
    expect(authorizeHumanAction(policy, { ...human('/notice', submit), appVersion: '2.0' })).toEqual({ allowed: false, code: 'app_mismatch' });
    expect(authorizeHumanAction(policy, { ...human('/notice', submit), action: 'click' })).toEqual({ allowed: false, code: 'invalid_input' });
    expect(authorizeHumanAction(policy, { ...human('/notice', submit), risk: 'read_only' })).toEqual({ allowed: false, code: 'invalid_input' });
    expect(authorizeHumanAction(policy, { ...human('/notice', submit), effect: undefined })).toEqual({ allowed: false, code: 'invalid_input' });
    expect(authorizeHumanAction({ ...policy }, human('/notice', submit))).toEqual({ allowed: false, code: 'invalid_policy' });
  });

  it('is optional and deny-by-default', () => {
    const withoutHumans: Record<string, unknown> = { ...policy, forms: policy.forms.filter((rule) => rule.path !== '/notice') };
    delete withoutHumans.humanForms;
    const none = parsePolicy(withoutHumans);
    expect(authorizeHumanAction(none, human('/notice', form('submit', '/notice', [])))).toEqual({ allowed: false, code: 'action_denied' });
    expect(() => parsePolicy({ ...policy, humanForms: 'operator' })).toThrow('Invalid policy.');
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
      expect(authorizeAction(policy, action(path, verb, verb === 'click' ? form('submit', path, []) : verb === 'extract' ? read : undefined)).allowed).toBe(false);
    }
    // Nor as the destination of a link or the action of a form seen on an allowed page.
    expect(authorizeAction(policy, action('/members/12345', 'click', { kind: 'navigate', destination: `${origin}${path}` })).allowed).toBe(false);
    expect(authorizeAction(policy, action('/members/12345', 'click', { kind: 'submit', form: { action: `${origin}${path}`, method: 'post', fields: [] } })).allowed).toBe(false);
  });

  it('never echoes raw input or secrets in decisions', () => {
    const url = 'http://operator:secret-placeholder@localhost:4000/login?password=secret-placeholder';
    expect(authorizeRequest(policy, { url, method: 'GET' })).toEqual({ allowed: false, code: 'invalid_url' });
    expect(authorizeAction(policy, { ...action('/login', 'fill', form('input', '/login', ['password', 'username'])), url })).toEqual({ allowed: false, code: 'invalid_url' });
  });
});

describe('YAML loading', () => {
  it('loads YAML from disk and sanitizes file, syntax, schema, tag, duplicate, and alias errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harbor-policy-'));
    const path = join(directory, 'policy.yaml');
    const valid = `schemaVersion: 2
defaultEffect: deny
appId: harbor_core
appVersion: '1.0'
allowedOrigins: [http://localhost:4000]
session: {loginPath: /login, fields: {username: Operator ID, password: Password}, submit: Sign in}
pages: [{path: /}, {path: /login}]
forms: [{path: /login, fields: [username, password], risk: reversible}]
irreversibleActions: block
`;
    try {
      await writeFile(path, valid);
      expect(authorizeAction(await loadPolicy(path), action('/', 'navigate'))).toEqual({ allowed: true, risk: 'read_only' });
      for (const invalid of [
        '', '[secret-placeholder', `${valid}defaultEffect: allow\n`, `${valid}unknown: secret-placeholder\n`,
        valid.replace('path: /login}', 'path: /login, path: /notice}'),
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
