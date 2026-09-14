import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { FileCapabilityRegistry } from '../artifact/registry.js';
import type { CapabilityArtifact, CapabilityKey } from '../artifact/schema.js';
import { compileTranscript, CompileError } from '../compiler/compile.js';
import { verifyDraft } from '../compiler/verify.js';
import type { VerificationTarget } from '../compiler/verify.js';
import { inputValues } from '../discovery/acceptance.js';
import { ModelCallError } from '../discovery/contracts.js';
import type { DiscoveryResult } from '../discovery/contracts.js';
import { runDiscovery } from '../discovery/engine.js';
import type { DiscoveryModel } from '../discovery/model.js';
import { readTranscriptFile } from '../discovery/transcript.js';
import type { InterventionBroker } from '../hitl/interventions.js';
import { policyApp } from '../policy/policy.js';
import type { Policy } from '../policy/policy.js';
import { runReplay } from '../replay/engine.js';
import { agentResultSchema, catalogEntrySchema } from './contracts.js';
import type { AgentResult, CatalogEntry, RouterModel } from './contracts.js';

/**
 * The capability router. It maps a goal to one of four decisions and then composes pieces that
 * already exist: model-free replay of a verified capability, or discovery followed by
 * compilation and fresh-sandbox verification. It never sees the UI and never chooses steps.
 *
 * Deliberate non-behaviours: a replay failure is returned, not re-discovered; a policy denial is
 * not routed around; a completed discovery is not executed again after verification; nothing is
 * ever guessed on the user's behalf.
 */

export type AgentOptions = {
  goal: string;
  router: RouterModel;
  /** Required only for the cold path. Without it, a discover decision fails closed. */
  discoveryModel?: DiscoveryModel;
  registry: FileCapabilityRegistry;
  origin: string;
  policy: Policy;
  credentials: { username: string; password: string };
  evidenceRoot?: string;
  headless?: boolean;
  discoveryLimits?: { maxSteps?: number; maxDurationMs?: number; modelTimeoutMs?: number; maxTokens?: number };
  /**
   * Fresh sandboxes for verification plus extra distinct inputs. Absent → drafts stay drafts.
   * Extra inputs may be keyed by the names the discovery contract ends up using, or given as
   * bare values that are matched to the contract's inputs in declaration order.
   */
  verification?: { createTarget: () => Promise<VerificationTarget>; inputs: Record<string, string>[] };
  /** Same-session human handoff, offered to both discovery and replay. */
  hitl?: { broker: InterventionBroker; maxWaitMs: number };
  routeTimeoutMs?: number;
  now?: () => Date;
};

const optionsSchema = z.object({
  goal: z.string().min(1).max(2000).refine((goal) => goal.trim().length > 0),
  origin: z.string().max(500).refine((origin) => URL.parse(origin)?.origin === origin),
  credentials: z.object({ username: z.string().min(1).max(4096), password: z.string().min(1).max(4096) }),
  evidenceRoot: z.string().min(1).max(4096).optional(),
  headless: z.boolean().optional(),
  routeTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});

/** Verified capabilities for the configured app, newest revision per name, as the model sees them. */
export function buildCatalog(artifacts: readonly CapabilityArtifact[], app: { appId: string; appVersion: string }): CatalogEntry[] {
  const newest = new Map<string, CapabilityArtifact>();
  for (const artifact of artifacts) {
    if (artifact.identity.status !== 'verified' || !artifact.verification) continue;
    if (artifact.app.appId !== app.appId || artifact.app.appVersion !== app.appVersion) continue;
    const current = newest.get(artifact.identity.name);
    if (!current || current.identity.version < artifact.identity.version) newest.set(artifact.identity.name, artifact);
  }
  return [...newest.values()].sort((a, b) => a.identity.name.localeCompare(b.identity.name)).map((artifact) => catalogEntrySchema.parse({
    name: artifact.identity.name, version: artifact.identity.version, description: artifact.identity.description, risk: artifact.risk,
    inputs: Object.fromEntries(Object.entries(artifact.inputs).map(([name, field]) => [name, {
      description: field.description, type: field.type,
      ...(field.type === 'string' ? { format: field.format, minLength: field.minLength, maxLength: field.maxLength } : {}),
    }])),
    outputs: Object.fromEntries(Object.entries(artifact.outputs).map(([name, field]) => [name, { description: field.description, type: field.type }])),
  }));
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const agentRunId = `agent_${randomUUID().replaceAll('-', '')}`;
  const parsed = optionsSchema.safeParse(options);
  const source = options.router.source;
  const routing: AgentResult['routing'] = { decision: null, usage: { inputTokens: 0, outputTokens: 0 }, catalog: [] };
  type Outcome = AgentResult extends infer R ? R extends AgentResult ? Omit<R, 'agentRunId' | 'source' | 'routing'> : never : never;
  const finish = (result: Outcome): AgentResult =>
    agentResultSchema.parse({ agentRunId, source, routing, ...result });
  if (!parsed.success) return finish({ kind: 'FAILURE', code: 'INVALID_OPTIONS' });
  const { goal, origin, credentials, evidenceRoot, headless, routeTimeoutMs } = parsed.data;
  const now = options.now ?? (() => new Date());
  const passthrough = {
    ...(evidenceRoot === undefined ? {} : { evidenceRoot }),
    ...(headless === undefined ? {} : { headless }),
    ...(options.hitl === undefined ? {} : { hitl: options.hitl }),
  };
  const app = policyApp(options.policy);

  let catalog: CatalogEntry[];
  try {
    catalog = buildCatalog(await options.registry.list(app), app);
  } catch {
    return finish({ kind: 'FAILURE', code: 'REGISTRY_ERROR' });
  }
  routing.catalog = catalog.map(({ name, version }) => ({ name, version }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), routeTimeoutMs);
  let decision: Awaited<ReturnType<RouterModel['route']>>;
  try {
    decision = await options.router.route({ goal, catalog }, controller.signal);
  } catch (error) {
    if (error instanceof ModelCallError && error.receipt) routing.usage = error.receipt.usage;
    return finish({ kind: 'FAILURE', code: controller.signal.aborted ? 'ROUTER_TIMEOUT' : 'ROUTER_ERROR' });
  } finally {
    clearTimeout(timer);
  }
  routing.decision = decision.value.tool;
  routing.usage = decision.usage;
  routing.modelId = decision.modelId;
  if (decision.responseId !== undefined) routing.responseId = decision.responseId;

  const route = decision.value;
  if (route.tool === 'clarify') return finish({ kind: 'CLARIFICATION_REQUIRED', reason: route.input.reason, question: route.input.question });
  if (route.tool === 'unsupported') return finish({ kind: 'UNSUPPORTED_GOAL', reason: route.input.reason });

  if (route.tool === 'execute') {
    // The model names a catalog entry; the application decides whether it exists and validates the inputs.
    const entry = catalog.find((candidate) => candidate.name === route.input.capability && candidate.version === route.input.version);
    if (!entry) return finish({ kind: 'FAILURE', code: 'CAPABILITY_NOT_FOUND' });
    const capability: CapabilityKey = { ...app, name: entry.name, version: entry.version };
    let artifact: CapabilityArtifact;
    try {
      artifact = await options.registry.load(capability);
    } catch {
      return finish({ kind: 'FAILURE', code: 'REGISTRY_ERROR' });
    }
    // Replay validates inputs against the artifact; failures come back as results, never as rediscovery.
    const result = await runReplay({ artifact, inputs: route.input.inputs, mode: 'replay', origin, policy: options.policy, credentials, ...passthrough });
    return finish({ kind: 'EXECUTED', capability, result });
  }

  // discover: the catalog is what has been learned so far, not the limit of the application, so an
  // existing capability for a different read never blocks learning a new one.
  if (!options.discoveryModel) return finish({ kind: 'FAILURE', code: 'MODEL_NOT_CONFIGURED' });
  const discovery: DiscoveryResult = await runDiscovery({
    goal, model: options.discoveryModel, origin, policy: options.policy, credentials, ...passthrough,
    ...(options.discoveryLimits === undefined ? {} : { limits: options.discoveryLimits }),
  });
  if (discovery.kind !== 'SUCCESS') return finish({ kind: 'DISCOVERED', discovery, compiled: null });

  // Compile what the model actually did, save the draft, and prove it in fresh sandboxes. The goal
  // itself is already complete: the discovery result carries the outputs and nothing runs again.
  const contract = discovery.goal!;
  const names = Object.keys(contract.inputs);
  const conform = (values: Record<string, string>): Record<string, string> | undefined => {
    const keys = Object.keys(values);
    if (keys.length !== names.length) return undefined;
    if (names.every((name) => name in values)) return Object.fromEntries(names.map((name) => [name, values[name]!]));
    return Object.fromEntries(names.map((name, index) => [name, Object.values(values)[index]!]));
  };
  const verificationInputs = [inputValues(contract), ...(options.verification?.inputs ?? []).map(conform)]
    .filter((values): values is Record<string, string> => values !== undefined)
    .filter((values, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(values)) === index);
  const sensitiveValues = [credentials.username, credentials.password, ...verificationInputs.flatMap((values) => Object.values(values)),
    ...Object.values(route.input.inputs)];
  try {
    const existing = await options.registry.list(app);
    const version = existing.filter((artifact) => artifact.identity.name === contract.name)
      .reduce((max, artifact) => Math.max(max, artifact.identity.version), 0) + 1;
    const transcript = await readTranscriptFile(join(evidenceRoot ?? 'artifacts/runs', discovery.runId, 'discovery.json'));
    const draft = compileTranscript(transcript, { name: contract.name, version, app, recordedAt: now().toISOString(), sensitiveValues });
    if (!options.verification) {
      const saved = await options.registry.save(draft, sensitiveValues);
      return finish({ kind: 'DISCOVERED', discovery, compiled: { draft: saved, verified: null, code: 'VERIFICATION_UNAVAILABLE', verificationRuns: [] } });
    }
    if (verificationInputs.length < 2) {
      const saved = await options.registry.save(draft, sensitiveValues);
      return finish({ kind: 'DISCOVERED', discovery, compiled: { draft: saved, verified: null, code: 'VERIFICATION_INPUTS_REQUIRED', verificationRuns: [] } });
    }
    const report = await verifyDraft({
      draft, registry: options.registry, createTarget: options.verification.createTarget, inputs: verificationInputs,
      credentials, verifiedAt: now().toISOString(), ...passthrough,
    });
    return finish({ kind: 'DISCOVERED', discovery, compiled: {
      draft: report.draft, verified: report.kind === 'VERIFIED' ? report.verified : null,
      ...(report.kind === 'REJECTED' ? { code: report.code } : {}),
      verificationRuns: report.attempts.map((attempt) => attempt.runId),
    } });
  } catch (error) {
    // A person helped this run along: the goal is answered, and there is deliberately no recipe to keep.
    if (error instanceof CompileError && error.code === 'COMPILE_HUMAN_ASSISTED') {
      return finish({ kind: 'DISCOVERED', discovery, compiled: { draft: null, verified: null, code: error.code, verificationRuns: [] } });
    }
    return finish({ kind: 'FAILURE', code: error instanceof CompileError ? error.code : 'PROMOTION_FAILED', discovery });
  }
}
