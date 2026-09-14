import { readFile } from 'node:fs/promises';
import { isAlias, parseDocument, visit } from 'yaml';
import { z } from 'zod';

/**
 * Trusted, app-owned policy. Risk is decided by what an action structurally DOES in the
 * document, never by a hand-labelled control identity and never by anything the model says:
 *
 *   - loading a page (GET)             -> must match `pages`
 *   - reading visible text             -> read-only on any allowed page
 *   - following a same-origin link     -> a page load; must match `pages`
 *   - typing into a form field         -> allowed only inside a form that matches `forms`
 *   - submitting a form (POST)         -> must match `forms` by action path AND exact field set
 *   - anything else (script buttons, downloads, popups, other origins) -> denied
 *
 * The app profile is therefore data in policy.yaml: which pages exist, which forms may be
 * submitted with which fields, how a session is opened, and which interstitial dialogs are
 * benign. No goal-specific knowledge lives here or anywhere else in the automation.
 */

const identifier = z.string().max(64).regex(/^[a-z][a-z0-9_]*$/);
const label = z.string().min(1).max(200).refine((value) => value === value.trim());
const fieldName = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
/** `:id` stands for one opaque record identifier segment. */
const pathSchema = z.string().max(300).refine((path) => path === '/'
  || /^\/(?:[A-Za-z0-9_-]+|:id)(?:\/(?:[A-Za-z0-9_-]+|:id))*$/.test(path));
const riskSchema = z.enum(['read_only', 'reversible']);
const actionSchema = z.enum(['navigate', 'click', 'fill', 'select', 'extract', 'wait']);
const querySchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).min(1).max(20));

const formRuleSchema = z.strictObject({
  path: pathSchema,
  /** Exact set of field names the real form submits. Extra or missing fields deny the submission. */
  fields: z.array(fieldName).max(50).refine((fields) => new Set(fields).size === fields.length),
  risk: riskSchema,
});

/** The structural effect of acting on a node, measured on the live DOM by the trusted adapter. */
export const effectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('read') }),
  z.strictObject({ kind: z.literal('navigate'), destination: z.string() }),
  z.strictObject({ kind: z.literal('input'), form: z.strictObject({ action: z.string(), method: z.string(), fields: z.array(fieldName).max(50) }) }),
  z.strictObject({ kind: z.literal('submit'), form: z.strictObject({ action: z.string(), method: z.string(), fields: z.array(fieldName).max(50) }) }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type Effect = z.infer<typeof effectSchema>;

const actionInputSchema = z.strictObject({
  appId: identifier,
  appVersion: z.string().min(1),
  /** Destination for navigate; otherwise the URL of the document that owns the node. */
  url: z.string(),
  action: actionSchema,
  effect: effectSchema.optional(),
});
const requestInputSchema = z.strictObject({ url: z.string(), method: z.enum(['GET', 'POST']) });

const policySchema = z.strictObject({
  schemaVersion: z.literal(2),
  defaultEffect: z.literal('deny'),
  appId: identifier,
  appVersion: z.string().min(1),
  allowedOrigins: z.array(z.string().refine((origin) => {
    const url = URL.parse(origin);
    return url !== null && url.protocol === 'http:' && origin === url.origin;
  })).max(20).min(1),
  /** How a session is opened. Labels are matched exactly against the live login form. */
  session: z.strictObject({
    loginPath: pathSchema,
    fields: z.strictObject({ username: label, password: label }),
    submit: label,
    /** Optional visible fingerprint that must appear on the login page (e.g. an app/version footer). */
    banner: label.optional(),
  }),
  pages: z.array(z.strictObject({ path: pathSchema, query: querySchema.optional() })).max(100).min(1),
  forms: z.array(formRuleSchema).max(100),
  /** Forms an operator may additionally submit after a same-session handoff. Automation never gets these. */
  humanForms: z.array(formRuleSchema).max(100).optional(),
  /** Accessible names of interstitial dialogs automation may act through. Any other dialog is a handoff. */
  knownDialogs: z.array(label).max(20).optional(),
  irreversibleActions: z.literal('block'),
}).refine((policy) => {
  const uniqueForms = (rules: { path: string; fields: string[] }[]) => {
    const keys = rules.map((rule) => `${rule.path}|${[...rule.fields].sort().join(',')}`);
    return new Set(keys).size === keys.length;
  };
  const pageKeys = policy.pages.map((page) => page.path);
  return uniqueForms(policy.forms) && uniqueForms(policy.humanForms ?? [])
    && new Set(pageKeys).size === pageKeys.length
    && new Set(policy.allowedOrigins).size === policy.allowedOrigins.length
    && policy.pages.some((page) => page.path === policy.session.loginPath);
});

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

/** The app identity a policy governs; artifacts and replays are keyed by it. */
export function policyApp(policy: Policy): { appId: string; appVersion: string } {
  return { appId: policy.appId, appVersion: policy.appVersion };
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

const idSegment = /^[A-Za-z0-9_-]{1,64}$/;

export function matchesPath(pattern: string, path: string): boolean {
  const expected = pattern.split('/');
  const actual = path.split('/');
  return expected.length === actual.length && expected.every((segment, index) =>
    segment === ':id' ? idSegment.test(actual[index] ?? '') : segment === actual[index]);
}

/**
 * Canonical, identifier-free spelling of a path for evidence: every segment that equals a
 * sensitive value or looks like a record identifier (all digits) becomes `:id`. Paths that
 * no policy page matches are reported as `[unavailable]` so evidence never names an unknown route.
 */
export function canonicalPagePath(policy: Policy, url: string, sensitiveValues: readonly string[] = []): string {
  const parsed = URL.parse(url);
  if (!parsed) return '[unavailable]';
  const page = policy.pages.find((candidate) => matchesPath(candidate.path, parsed.pathname));
  if (!page) return '[unavailable]';
  // Spell every identifier segment as `:id`, plus any literal segment that equals a sensitive value.
  const pattern = page.path.split('/');
  return parsed.pathname === '/' ? '/' : parsed.pathname.split('/').map((segment, index) =>
    index === 0 ? segment : pattern[index] === ':id' || sensitiveValues.includes(segment) || /^[0-9]+$/.test(segment) ? ':id' : segment).join('/');
}

function matchesPage(policy: Policy, url: URL): boolean {
  const entries = [...url.searchParams];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false;
  return policy.pages.some((page) => matchesPath(page.path, url.pathname)
    && entries.every(([key, value]) => page.query?.[key]?.includes(value) ?? false));
}

function matchesForm(rules: readonly Policy['forms'][number][], url: URL, fields: readonly string[]) {
  if (url.search) return undefined;
  const actual = [...fields].sort().join(',');
  return rules.find((rule) => matchesPath(rule.path, url.pathname) && [...rule.fields].sort().join(',') === actual);
}

export function authorizeRequest(policy: Policy, input: unknown): RequestDecision {
  if (!policies.has(policy)) return { allowed: false, code: 'invalid_policy' };
  try {
    const result = requestInputSchema.safeParse(input);
    if (!result.success) return { allowed: false, code: 'invalid_input' };
    const url = parseUrl(result.data.url);
    if (!url) return { allowed: false, code: 'invalid_url' };
    if (!policy.allowedOrigins.includes(url.origin)) return { allowed: false, code: 'origin_denied' };
    const allowed = result.data.method === 'GET' ? matchesPage(policy, url)
      : !url.search && [...policy.forms, ...(policy.humanForms ?? [])].some((rule) => matchesPath(rule.path, url.pathname));
    return allowed ? { allowed: true } : { allowed: false, code: 'request_denied' };
  } catch {
    return { allowed: false, code: 'invalid_input' };
  }
}

function decideEffect(policy: Policy, rules: readonly Policy['forms'][number][], action: z.infer<typeof actionSchema>, effect: Effect | undefined): ActionDecision {
  const deny: ActionDecision = { allowed: false, code: 'action_denied' };
  if (action === 'navigate' || action === 'wait') return effect === undefined ? { allowed: true, risk: 'read_only' } : deny;
  if (!effect) return deny;
  switch (effect.kind) {
    case 'read':
      return action === 'extract' ? { allowed: true, risk: 'read_only' } : deny;
    case 'navigate': {
      if (action !== 'click') return deny;
      const destination = parseUrl(effect.destination);
      return destination && policy.allowedOrigins.includes(destination.origin) && matchesPage(policy, destination)
        ? { allowed: true, risk: 'read_only' } : deny;
    }
    case 'input':
    case 'submit': {
      if ((effect.kind === 'input') !== (action === 'fill' || action === 'select')) return deny;
      if (effect.kind === 'submit' && action !== 'click') return deny;
      if (effect.form.method.toLowerCase() !== 'post') return deny;
      const target = parseUrl(effect.form.action);
      if (!target || !policy.allowedOrigins.includes(target.origin)) return deny;
      const rule = matchesForm(rules, target, effect.form.fields);
      return rule ? { allowed: true, risk: rule.risk } : deny;
    }
    case 'unknown':
      return deny;
  }
}

/**
 * The effect MUST be measured by the trusted adapter on the actual node, never supplied by a
 * model. `url` is the destination for navigate, otherwise the owning document's URL; that
 * document must itself be an allowed page. Pure decision, no browser enforcement here.
 */
export function authorizeAction(policy: Policy, input: unknown): ActionDecision {
  if (!policies.has(policy)) return { allowed: false, code: 'invalid_policy' };
  try {
    const result = actionInputSchema.safeParse(input);
    if (!result.success) return { allowed: false, code: 'invalid_input' };
    const action = result.data;
    if (action.appId !== policy.appId || action.appVersion !== policy.appVersion) {
      return { allowed: false, code: 'app_mismatch' };
    }
    const url = parseUrl(action.url);
    if (!url) return { allowed: false, code: 'invalid_url' };
    if (!policy.allowedOrigins.includes(url.origin)) return { allowed: false, code: 'origin_denied' };
    if (!matchesPage(policy, url)) return { allowed: false, code: 'request_denied' };
    return decideEffect(policy, policy.forms, action.action, action.effect);
  } catch {
    return { allowed: false, code: 'invalid_input' };
  }
}

const humanActionInputSchema = z.strictObject({
  appId: identifier, appVersion: z.string().min(1), url: z.string(), effect: effectSchema,
});

/**
 * Decides whether an operator in a handed-over browser may submit a form through the same
 * proxy: automation's forms plus `humanForms`. Handoff widens who acts, never what the app
 * permits. Reads (GET navigation) fall under `pages` like any other request.
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
    if (!matchesPage(policy, url)) return { allowed: false, code: 'request_denied' };
    if (action.effect.kind !== 'submit') return { allowed: false, code: 'action_denied' };
    return decideEffect(policy, [...policy.forms, ...(policy.humanForms ?? [])], 'click', action.effect);
  } catch {
    return { allowed: false, code: 'invalid_input' };
  }
}
