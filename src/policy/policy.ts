import { readFile } from 'node:fs/promises';
import { isAlias, parseDocument, visit } from 'yaml';
import { z } from 'zod';

const identifier = z.string().max(64).regex(/^[a-z][a-z0-9_]*$/);
const pathSchema = z.string().max(300).refine((path) => path === '/' || (
  /^\/(?:[A-Za-z0-9_-]+|:memberId)(?:\/(?:[A-Za-z0-9_-]+|:memberId))*$/.test(path)
  && path.split('/').filter((segment) => segment === ':memberId').length <= 1
));
const actionSchema = z.enum(['navigate', 'click', 'fill', 'select', 'extract', 'wait']);
const riskSchema = z.enum(['read_only', 'reversible']);
const targetShape = { action: actionSchema, targetKey: identifier.optional() };
const validTarget = (value: { action: string; targetKey?: string | undefined }) =>
  (value.action === 'navigate' || value.action === 'wait')
    ? !Object.hasOwn(value, 'targetKey') : value.targetKey !== undefined;
const actionInputSchema = z.strictObject({
  appId: identifier,
  appVersion: z.string().min(1),
  url: z.string(),
  ...targetShape,
});
const requestInputSchema = z.strictObject({ url: z.string(), method: z.enum(['GET', 'POST']) });
const policySchema = z.strictObject({
  schemaVersion: z.literal(1),
  defaultEffect: z.literal('deny'),
  appId: identifier,
  appVersion: z.string().min(1),
  allowedOrigins: z.array(z.string().refine((origin) => {
    const url = URL.parse(origin);
    return url !== null && url.protocol === 'http:' && origin === url.origin;
  })).max(20),
  requests: z.array(z.strictObject({
    method: z.enum(['GET', 'POST']),
    path: pathSchema,
    // Query keys are optional, but these are the only supported key/value pairs.
    query: z.strictObject({ reason: z.tuple([z.literal('expired')]) }).optional(),
  })).max(100),
  actions: z.array(z.strictObject({
    ...targetShape,
    path: pathSchema,
    risk: riskSchema,
  }).refine(validTarget)).max(100),
  /**
   * Form submissions an operator may make in a handed-over browser. Same trusted targetKeys,
   * same risk ceiling: human handoff widens who acts, never what the prototype permits.
   */
  humanActions: z.array(z.strictObject({
    action: z.literal('click'),
    targetKey: identifier,
    path: pathSchema,
    risk: riskSchema,
  })).max(100).optional(),
  irreversibleActions: z.literal('block'),
}).refine((policy) => {
  // Reject duplicate action rules rather than choosing their risk by array order.
  const unique = (rules: { action: string; path: string; targetKey?: string | undefined; risk: string }[]) => {
    const keys = rules.map((rule) => `${rule.action}|${rule.path}|${rule.targetKey ?? ''}`);
    return new Set(keys).size === keys.length && rules.every((rule, index) => rules.slice(index + 1).every((other) =>
      rule.action !== other.action || rule.targetKey !== other.targetKey || rule.risk === other.risk
      || !pathsOverlap(rule.path, other.path)));
  };
  return unique(policy.actions) && unique(policy.humanActions ?? [])
    && new Set(policy.allowedOrigins).size === policy.allowedOrigins.length;
});

function pathsOverlap(left: string, right: string): boolean {
  const a = left.split('/');
  const b = right.split('/');
  return a.length === b.length && a.every((segment, index) => segment === b[index]
    || (segment === ':memberId' && /^[0-9]{5}$/.test(b[index] ?? ''))
    || (b[index] === ':memberId' && /^[0-9]{5}$/.test(segment)));
}

export type Policy = z.infer<typeof policySchema>;
type Denial = { allowed: false; code: 'invalid_policy' | 'invalid_input' | 'invalid_url'
  | 'origin_denied' | 'app_mismatch' | 'request_denied' | 'action_denied' };
export type RequestDecision = { allowed: true } | Denial;
export type ActionDecision = { allowed: true; risk: z.infer<typeof riskSchema> } | Denial;
const policies = new WeakSet<object>();

function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

/** Compile trusted, app-owned configuration once. Never accept policy from a model. */
export function parsePolicy(input: unknown): Policy {
  try {
    const policy = policySchema.parse(input);
    freeze(policy);
    policies.add(policy);
    return policy;
  } catch {
    // Zod/YAML errors can contain credentials or other rejected input.
    throw new Error('Invalid policy.');
  }
}

export async function loadPolicy(path: string): Promise<Policy> {
  try {
    const document = parseDocument(await readFile(path, 'utf8'), {
      version: '1.2', strict: true, uniqueKeys: true, customTags: [], merge: false,
    });
    if (document.errors.length || document.warnings.length) throw new Error();
    visit(document, (_key, node) => {
      if (isAlias(node) || (node !== null && typeof node === 'object' && 'tag' in node && node.tag)) throw new Error();
    });
    return parsePolicy(document.toJS({ maxAliasCount: 0 }) as unknown);
  } catch {
    throw new Error('Invalid policy.');
  }
}

function parseUrl(input: string): URL | null {
  // Inspect the raw spelling BEFORE WHATWG normalization removes traversal.
  // Reject all path escapes (including double encoding), not just encoded slashes.
  if (/[\s\\#]/.test(input) || [...input].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  const parts = /^http:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/.exec(input);
  if (!parts || parts[1]?.includes('@')) return null;
  const path = parts[2] ?? '/';
  if (path.includes('%') || path.split('/').some((part) => part === '.' || part === '..')) return null;
  const url = URL.parse(input);
  // No host aliases, credentials, or canonicalization of origin spellings.
  if (!url || `http://${parts[1]}` !== url.origin || url.pathname !== path) return null;
  // Reject malformed/ambiguous query encodings rather than silently repairing them.
  if (url.search && !/^\?[A-Za-z0-9_-]+=[A-Za-z0-9_-]+(?:&[A-Za-z0-9_-]+=[A-Za-z0-9_-]+)*$/.test(url.search)) return null;
  if (input.endsWith('?')) return null;
  return url;
}

function matchesPath(pattern: string, path: string): boolean {
  const expected = pattern.split('/');
  const actual = path.split('/');
  return expected.length === actual.length && expected.every((segment, index) =>
    segment === ':memberId' ? /^[0-9]{5}$/.test(actual[index] ?? '') : segment === actual[index]);
}

function matchesRequest(policy: Policy, url: URL, method: 'GET' | 'POST'): boolean {
  const entries = [...url.searchParams];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false;
  return policy.requests.some((rule) => rule.method === method && matchesPath(rule.path, url.pathname)
    && entries.every(([key, value]) => key === 'reason' && value === 'expired' && rule.query !== undefined));
}

export function authorizeRequest(policy: Policy, input: unknown): RequestDecision {
  if (!policies.has(policy)) return { allowed: false, code: 'invalid_policy' };
  try {
    const result = requestInputSchema.safeParse(input);
    if (!result.success) return { allowed: false, code: 'invalid_input' };
    const url = parseUrl(result.data.url);
    if (!url) return { allowed: false, code: 'invalid_url' };
    if (!policy.allowedOrigins.includes(url.origin)) return { allowed: false, code: 'origin_denied' };
    return matchesRequest(policy, url, result.data.method)
      ? { allowed: true } : { allowed: false, code: 'request_denied' };
  } catch {
    return { allowed: false, code: 'invalid_input' };
  }
}

/**
 * targetKey MUST come from a trusted adapter/app profile, never a model selector
 * or model-provided identity. Risk comes only from policy; input risk is rejected.
 * url is the destination for navigate, otherwise the target's document/frame URL.
 * Its GET rule supplies query constraints, but network permission is NOT action permission.
 * These are pure decisions, not browser interception or enforcement.
 */
export function authorizeAction(policy: Policy, input: unknown): ActionDecision {
  if (!policies.has(policy)) return { allowed: false, code: 'invalid_policy' };
  try {
    const result = actionInputSchema.safeParse(input);
    if (!result.success || !validTarget(result.data)) return { allowed: false, code: 'invalid_input' };
    const action = result.data;
    if (action.appId !== policy.appId || action.appVersion !== policy.appVersion) {
      return { allowed: false, code: 'app_mismatch' };
    }
    const url = parseUrl(action.url);
    if (!url) return { allowed: false, code: 'invalid_url' };
    if (!policy.allowedOrigins.includes(url.origin)) return { allowed: false, code: 'origin_denied' };
    if (!matchesRequest(policy, url, 'GET')) return { allowed: false, code: 'request_denied' };
    const rule = policy.actions.find((rule) => rule.action === action.action
      && rule.targetKey === action.targetKey && matchesPath(rule.path, url.pathname));
    return rule ? { allowed: true, risk: rule.risk } : { allowed: false, code: 'action_denied' };
  } catch {
    return { allowed: false, code: 'invalid_input' };
  }
}

const humanActionInputSchema = z.strictObject({
  appId: identifier, appVersion: z.string().min(1), url: z.string(), action: z.literal('click'), targetKey: identifier,
});

/**
 * Decides whether an operator in a handed-over browser may submit a form through the same
 * proxy. The targetKey is still classified by the trusted profile from the actual node; UI
 * text and operator intent cannot widen this. Reads (GET navigation) fall under `requests`.
 */
export function authorizeHumanAction(policy: Policy, input: unknown): ActionDecision {
  if (!policies.has(policy)) return { allowed: false, code: 'invalid_policy' };
  try {
    const result = humanActionInputSchema.safeParse(input);
    if (!result.success) return { allowed: false, code: 'invalid_input' };
    const action = result.data;
    if (action.appId !== policy.appId || action.appVersion !== policy.appVersion) {
      return { allowed: false, code: 'app_mismatch' };
    }
    const url = parseUrl(action.url);
    if (!url) return { allowed: false, code: 'invalid_url' };
    if (!policy.allowedOrigins.includes(url.origin)) return { allowed: false, code: 'origin_denied' };
    if (!matchesRequest(policy, url, 'GET')) return { allowed: false, code: 'request_denied' };
    const rule = (policy.humanActions ?? []).find((rule) => rule.targetKey === action.targetKey && matchesPath(rule.path, url.pathname));
    return rule ? { allowed: true, risk: rule.risk } : { allowed: false, code: 'action_denied' };
  } catch {
    return { allowed: false, code: 'invalid_input' };
  }
}
