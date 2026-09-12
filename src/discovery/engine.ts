import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { EvidenceSink, type SafeSnapshot } from '../evidence/evidence.js';
import { authorizeRequest, type Policy } from '../policy/policy.js';
import { SurfaceError } from '../surface/errors.js';
import { PlaywrightAdapter } from '../surface/playwright-adapter.js';
import {
  DiscoveryError, discoveryResultSchema, intentSchema, ModelCallError, parseDecision, usageSchema,
  type DiscoveryRecord, type DiscoveryResult, type DiscoveryTranscript, type ModelCallReceipt, type ModelReply,
} from './contracts.js';
import {
  readGoalField, verifyBalanceCompletion, verifyBusinessOutcome, type DiscoverySurface, type ReadEvidence,
} from './harbor-goal.js';
import { PROMPT_VERSION, type DiscoveryModel } from './model.js';
import { createSecretGuard } from './privacy.js';
import { writeTranscript } from './transcript.js';

type Options = {
  goal: string; model: DiscoveryModel; origin: string; policy: Policy;
  credentials: { username: string; password: string }; headless?: boolean; evidenceRoot?: string;
  limits?: { maxSteps?: number; maxDurationMs?: number; modelTimeoutMs?: number; maxTokens?: number };
  createSurface?: (options: Parameters<typeof PlaywrightAdapter.create>[0]) => Promise<DiscoverySurface>;
};

const optionsSchema = z.object({
  goal: z.string().min(1).max(2000).refine((goal) => goal.trim().length > 0),
  origin: z.string().max(500).refine((origin) => URL.parse(origin)?.origin === origin),
  credentials: z.object({ username: z.string().min(1).max(4096), password: z.string().min(1).max(4096) }),
  headless: z.boolean().optional(), evidenceRoot: z.string().min(1).max(4096).optional(),
  limits: z.object({
    maxSteps: z.number().int().min(1).max(50).default(25),
    maxDurationMs: z.number().int().min(1).max(300_000).default(180_000),
    modelTimeoutMs: z.number().int().min(1).max(60_000).default(30_000),
    maxTokens: z.number().int().min(1).max(200_000).default(40_000),
  }).prefault({}),
});
const retryable = new Set(['STALE_REF', 'AMBIGUOUS_TARGET', 'CAPTURE_FAILED', 'UNREPLAYABLE_TARGET',
  'TARGET_NOT_FOUND', 'FRAME_NOT_FOUND', 'INVALID_TARGET', 'FIELD_MISMATCH', 'WRONG_MEMBER',
  'INCOMPLETE_EVIDENCE', 'EXTRACTION_FAILED', 'UNSUPPORTED_CURRENCY', 'INVALID_DECISION',
  'STATE_CHANGED', 'UNOBSERVED_NAVIGATION']);
const blocked = new Set(['POLICY_BLOCKED', 'UNEXPECTED_DIALOG', 'SESSION_REQUIRED', 'HUMAN_REQUIRED',
  'TOKEN_LIMIT', 'STEP_LIMIT', 'DEAD_END']);
const surfaceCodes = new Set([...retryable, ...blocked, 'RUN_TIMEOUT', 'ACTION_FAILED', 'NAVIGATION_FAILED',
  'BROWSER_ERROR', 'SURFACE_CLOSED', 'OBSERVATION_LIMIT', 'AUTH_FAILED', 'APP_MISMATCH', 'CONDITION_FAILED',
  'INVALID_VALUE', 'INVALID_ACTION']);
const engineCodes = new Set([...surfaceCodes, 'INVALID_OPTIONS', 'MODEL_ERROR', 'MODEL_TIMEOUT',
  'SURFACE_TIMEOUT', 'EVIDENCE_ERROR', 'UNSAFE_GOAL', 'CONTEXT_LIMIT', 'RESOURCE_CLOSE_FAILED']);

export async function runDiscovery(options: Options): Promise<DiscoveryResult> {
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const calls: DiscoveryTranscript['calls'] = [];
  const records: DiscoveryRecord[] = [];
  const receipts = new Map<string, ReadEvidence>();
  const sensitive = new Set<string>();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let surface: DiscoverySurface | undefined;
  let closing: Promise<void> | undefined;
  let sink: EvidenceSink | undefined;
  let evidenceFailed = false;
  let transcriptFile: string | undefined;
  let memberId: string | undefined;
  let submittedMember: string | undefined;
  let turns = 0;
  let kind: DiscoveryResult['kind'] = 'FAILURE';
  let code = 'INVALID_OPTIONS';
  let outputs: DiscoveryResult['outputs'];
  let source: DiscoveryModel['source'] = options?.model?.source === 'test' ? 'test' : 'live';
  let metadata: { provider: string; modelId: string } | undefined;
  let secrets: string[] = [];

  function check() {
    if (evidenceFailed) throw new DiscoveryError('EVIDENCE_ERROR');
    if (controller.signal.aborted) throw controller.signal.reason as DiscoveryError;
  }
  async function close() {
    if (!surface) return;
    closing ??= (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve().then(() => surface!.close()), new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new DiscoveryError('RESOURCE_CLOSE_FAILED')), 5000);
        })]);
      } catch { throw new DiscoveryError('RESOURCE_CLOSE_FAILED'); }
      finally { clearTimeout(timeout); }
    })();
    await closing;
  }
  function abort(reason: string) {
    if (!controller.signal.aborted) controller.abort(new DiscoveryError(reason));
    void close().catch(() => {});
  }
  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, timeoutCode: string): Promise<T> {
    check();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason as DiscoveryError);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => abort(timeoutCode), ms);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { check(); return work(controller.signal); }), stopped]);
      check();
      return value;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  const ui = <T>(work: () => Promise<T>) => bounded(work, 5000, 'SURFACE_TIMEOUT');
  async function event(value: Parameters<EvidenceSink['event']>[0]) {
    check();
    try { await bounded(() => sink!.event(value), 5000, 'EVIDENCE_ERROR'); }
    catch {
      if (controller.signal.aborted) throw controller.signal.reason as DiscoveryError;
      evidenceFailed = true; throw new DiscoveryError('EVIDENCE_ERROR');
    }
    check();
  }
  function errorCode(error: unknown): string {
    if (evidenceFailed) return 'EVIDENCE_ERROR';
    if (controller.signal.aborted) return (controller.signal.reason as DiscoveryError).code;
    if (error instanceof DiscoveryError && engineCodes.has(error.code)) return error.code;
    if (error instanceof SurfaceError && surfaceCodes.has(error.code)) return error.code;
    return 'SURFACE_ERROR';
  }

  try {
    const validated = optionsSchema.safeParse(options);
    if (!validated.success) throw new DiscoveryError('INVALID_OPTIONS');
    const { goal, origin, credentials, headless, evidenceRoot, limits } = validated.data;
    const model = options.model;
    if (!model || !['live', 'test'].includes(model.source) || typeof model.intent !== 'function'
      || typeof model.decide !== 'function' || !Array.isArray(model.secretValues)
      || !z.array(z.string().max(4096)).max(90).safeParse(model.secretValues).success
      || (options.createSurface !== undefined && typeof options.createSurface !== 'function')
      || !authorizeRequest(options.policy, { url: `${origin}/login`, method: 'GET' }).allowed) {
      throw new DiscoveryError('INVALID_OPTIONS');
    }
    source = model.source;
    secrets = [...new Set([...z.array(z.string()).parse(model.secretValues), credentials.username, credentials.password].filter(Boolean))];
    if (secrets.reduce((total, secret) => total + secret.length, 0) > 14_000) throw new DiscoveryError('INVALID_OPTIONS');
    const guard = createSecretGuard(secrets);
    function modelMetadata(value: unknown, max: number): string {
      if (typeof value !== 'string' || !value.length || value.length > max
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) || guard.contains(value)) {
        throw new DiscoveryError('MODEL_ERROR');
      }
      return value;
    }
    metadata = { provider: modelMetadata(model.provider, 100), modelId: modelMetadata(model.modelId, 100) };
    // These candidates constrain intent and guard evidence; they never select UI actions.
    const candidates = [...goal.matchAll(/(?<![\p{L}\p{N}_])[0-9]{5}(?![\p{L}\p{N}_])/gu)].map((match) => match[0]);
    candidates.forEach((candidate) => sensitive.add(candidate));
    const deadline = Date.now() + limits.maxDurationMs;
    timer = setTimeout(() => abort('RUN_TIMEOUT'), limits.maxDurationMs);
    try {
      sink = await EvidenceSink.create({ runId, ...(evidenceRoot ? { root: evidenceRoot } : {}),
        sensitiveValues: [...secrets, ...(candidates.length === 1 ? candidates : [])] });
    }
    catch { throw new DiscoveryError('EVIDENCE_ERROR'); }
    await event({ type: 'discovery_started', phase: 'intent' });
    if (guard.contains(goal)) throw new DiscoveryError('UNSAFE_GOAL');

    function budget() {
      check();
      if (usage.inputTokens + usage.outputTokens >= limits.maxTokens) throw new DiscoveryError('TOKEN_LIMIT');
    }
    async function call<T>(phase: 'intent' | 'action', work: (signal: AbortSignal) => Promise<ModelReply<T>>) {
      budget();
      await event({ type: 'model_call', phase });
      const attempt: DiscoveryTranscript['calls'][number] = {
        turn: turns, phase, modelId: metadata!.modelId, status: 'failed', usage: null,
      };
      calls.push(attempt);
      function account(receipt: ModelCallReceipt, returned: boolean) {
        const counted = usageSchema.safeParse(receipt?.usage);
        if (!counted.success || !Number.isSafeInteger(counted.data.inputTokens) || !Number.isSafeInteger(counted.data.outputTokens)
          || !Number.isSafeInteger(usage.inputTokens + counted.data.inputTokens)
          || !Number.isSafeInteger(usage.outputTokens + counted.data.outputTokens)) throw new DiscoveryError('MODEL_ERROR');
        usage.inputTokens += counted.data.inputTokens;
        usage.outputTokens += counted.data.outputTokens;
        attempt.usage = counted.data;
        if (returned || receipt.modelId !== undefined) attempt.modelId = modelMetadata(receipt.modelId, 100);
        if (receipt.responseId !== undefined) attempt.responseId = modelMetadata(receipt.responseId, 200);
        if (returned) attempt.status = 'returned';
      }
      let reply: ModelReply<T>;
      try { reply = await bounded(work, limits.modelTimeoutMs, 'MODEL_TIMEOUT'); }
      catch (error) {
        if (error instanceof ModelCallError && error.receipt) account(error.receipt, false);
        check();
        if (error instanceof Error && error.name === 'AbortError') {
          abort('MODEL_TIMEOUT'); check();
        }
        budget();
        throw new DiscoveryError('MODEL_ERROR');
      }
      account(reply, true);
      budget();
      return reply.value;
    }
    const intent = intentSchema.safeParse(await call('intent', (signal) => model.intent(goal, signal)));
    if (!intent.success) throw new DiscoveryError('MODEL_ERROR');
    if (intent.data.status === 'unsupported') { kind = 'UNSUPPORTED_GOAL'; code = 'UNSUPPORTED_GOAL'; }
    else if (intent.data.status !== 'ready' || candidates.length !== 1 || intent.data.memberId !== candidates[0]) {
      kind = 'CLARIFICATION_REQUIRED'; code = 'CLARIFICATION_REQUIRED';
    } else {
      memberId = intent.data.memberId!;
      budget();
      await event({ type: 'surface_starting', phase: 'authentication' });
      await ui(async () => {
        const created = await (options.createSurface ?? PlaywrightAdapter.create)({ origin, policy: options.policy,
          ...(headless === undefined ? {} : { headless }), timeoutMs: Math.min(5000, limits.maxDurationMs), deadline,
          onEvent: (value) => event(value) });
        surface = created;
        if (controller.signal.aborted || evidenceFailed) { await close(); check(); }
      });
      // Helpers can perform several reads. Recheck cancellation between each adapter call,
      // including when an injected operation resolves after its enclosing timeout.
      const active = new Proxy(surface!, {
        get(target, property: keyof DiscoverySurface) {
          if (property === 'health') return () => { check(); target.health(); };
          if (property === 'close') return target.close.bind(target);
          return async (...args: unknown[]) => {
            check();
            const value: unknown = await Reflect.apply(target[property], target, args);
            check();
            return value;
          };
        },
      });
      await ui(() => active.authenticate(credentials));
      let consecutiveErrors = 0;
      let previousFingerprint = '';
      let repeated = 0;
      for (turns = 1; turns <= limits.maxSteps; turns++) {
        budget();
        let observation: Awaited<ReturnType<DiscoverySurface['observe']>>;
        try {
          if (await ui(() => active.unknownDialog())) throw new DiscoveryError('UNEXPECTED_DIALOG');
          observation = await ui(() => active.observe());
        } catch (error) {
          const failure = errorCode(error);
          if (retryable.has(failure) && ++consecutiveErrors < 3) continue;
          throw error;
        }
        if (observation.path === '/login') throw new DiscoveryError('SESSION_REQUIRED');
        const controls = observation.controls.map(({ target, ref, tag, label, text, framePath, enabled, inputType, href, truncated, options }) => {
          const cell = target.strategies.find((strategy) => strategy.kind === 'table_cell');
          const semantic = (value: { source: string; value?: string } | number) =>
            typeof value === 'number' ? value : value.source === 'literal' ? value.value : undefined;
          return { ref, tag, label, text, framePath, enabled, inputType, href, truncated,
            options: options.map(({ label, value, disabled }) => ({ label, value, disabled })),
            scope: target.scope?.frames.length ? 'frame' : 'main',
            ...(cell ? { row: semantic(cell.row), column: semantic(cell.column) } : {}) };
        });
        const context = {
          goal, inputs: { memberId }, observation: { path: observation.path, truncated: observation.truncated, controls },
          actions: records.slice(-5).map(({ turn, tool, reason, status, code, field }) =>
            ({ turn, tool, reason, status, ...(code ? { code } : {}), ...(field ? { field } : {}) })),
          extracted: [...receipts.values()].map(({ field, scope }) => ({ field, scope })),
        };
        const serialized = JSON.stringify(context, (_key, value: unknown) => typeof value === 'string' ? guard.redact(value) : value);
        if (serialized.length > 60_000) throw new DiscoveryError('CONTEXT_LIMIT');
        const choice = await call('action', (signal) => model.decide(JSON.parse(serialized) as unknown, signal));
        let decision;
        try { decision = parseDecision(choice?.tool, choice?.input); }
        catch {
          budget();
          if (++consecutiveErrors < 3) continue;
          throw new DiscoveryError('INVALID_DECISION');
        }
        const record: DiscoveryRecord = { turn: turns, tool: decision.tool, reason: decision.input.reason, status: 'rejected' };
        records.push(record);
        try {
          budget();
          active.health();
          if (await ui(() => active.unknownDialog())) throw new DiscoveryError('UNEXPECTED_DIALOG');
          // A success claim is judged on recorded extracts; any ref it carries is not evidence.
          const ref = 'ref' in decision.input && !(decision.tool === 'complete' && decision.input.outcome === 'success')
            ? decision.input.ref : null;
          const selected = ref === null ? undefined : observation.controls.find((control) => control.ref === ref);
          if (ref !== null && !selected) throw new DiscoveryError('STALE_REF');
          const fingerprint = createHash('sha256').update(JSON.stringify({
            path: observation.path, controls: controls.map((control) => ({ ...control, ref: undefined })),
            tool: decision.tool, input: { ...decision.input, reason: undefined,
              ...('ref' in decision.input ? { ref: selected?.target ?? null } : {}) },
          })).digest('hex');
          repeated = fingerprint === previousFingerprint ? repeated + 1 : 1;
          previousFingerprint = fingerprint;
          if (repeated >= 3) throw new DiscoveryError('DEAD_END');
          await event({ type: 'decision_selected', phase: 'action', action: decision.tool });
          const receipt = await ui(async (): Promise<Partial<DiscoveryRecord>> => {
            switch (decision.tool) {
              case 'fill':
              case 'click': {
                const captured = await active.capture(decision.input.ref);
                check();
                if (decision.tool === 'fill' && captured.targetKey !== 'member_id') throw new DiscoveryError('FIELD_MISMATCH');
                if (decision.tool === 'click' && captured.targetKey === 'search_member'
                  && captured.formValues.memberId !== memberId) throw new DiscoveryError('WRONG_MEMBER');
                if (!captured.targetKey) throw new DiscoveryError('POLICY_BLOCKED');
                receipts.clear();
                submittedMember = undefined;
                await active.act(decision.input.ref, decision.tool, decision.tool === 'fill' ? memberId : undefined);
                if (decision.tool === 'click' && captured.targetKey === 'search_member') submittedMember = memberId;
                return { ref: decision.input.ref, target: captured.target, targetKey: captured.targetKey,
                  path: observation.path, framePath: captured.framePath,
                  ...(decision.tool === 'fill' ? { value: { source: 'input', name: 'memberId' } as const } : {}) };
              }
              case 'extract': {
                const read = await readGoalField(active, decision.input.ref, decision.input.field, memberId!);
                sensitive.add(read.raw); sensitive.add(String(read.value));
                receipts.set(`${read.evidence.field}:${read.evidence.scope}`, read.evidence);
                return { ref: decision.input.ref, target: read.evidence.target, targetKey: read.evidence.targetKey,
                  path: observation.path, framePath: read.evidence.framePath, field: read.evidence.field };
              }
              case 'navigate': {
                const current = await active.observe();
                if (current.path === '/login') throw new DiscoveryError('SESSION_REQUIRED');
                if (decision.input.path !== current.path && !current.controls.some((control) => control.href === decision.input.path)) {
                  throw new DiscoveryError('UNOBSERVED_NAVIGATION');
                }
                receipts.clear();
                submittedMember = undefined;
                await active.navigate(decision.input.path);
                return { path: decision.input.path };
              }
              case 'wait':
                await delay(decision.input.ms, undefined, { signal: controller.signal });
                return { ms: decision.input.ms };
              case 'complete':
                if (decision.input.outcome === 'success') {
                  outputs = await verifyBalanceCompletion(active, [...receipts.values()], memberId!);
                  active.health();
                  sensitive.add(String(outputs.savingsBalanceCents));
                  code = 'COMPLETED';
                  return {};
                } else {
                  const captured = await active.capture(decision.input.ref!);
                  code = await verifyBusinessOutcome(active, decision.input.ref!, decision.input.outcome, submittedMember, memberId!);
                  active.health();
                  return { ref: decision.input.ref!, target: captured.target,
                    ...(captured.targetKey ? { targetKey: captured.targetKey } : {}),
                    path: observation.path, framePath: captured.framePath };
                }
              case 'request_human': throw new DiscoveryError('HUMAN_REQUIRED');
            }
          });
          Object.assign(record, receipt, { status: 'succeeded' });
          if (decision.tool === 'complete') kind = decision.input.outcome === 'success' ? 'SUCCESS' : 'BUSINESS_OUTCOME';
          consecutiveErrors = 0;
        } catch (error) {
          const failure = errorCode(error);
          // A failed dispatch is not a receipt, even if its proposal was structurally valid.
          records[records.length - 1] = { turn: turns, tool: decision.tool, reason: decision.input.reason,
            status: blocked.has(failure) ? 'blocked' : 'rejected', code: failure };
          if (retryable.has(failure) && ++consecutiveErrors < 3) continue;
          throw error;
        }
        // Logging failure cannot erase a confirmed dispatch receipt.
        await event({ type: 'decision_finished', phase: 'action', action: decision.tool });
        if (kind === 'SUCCESS' || kind === 'BUSINESS_OUTCOME') {
          active.health();
          break;
        }
      }
      if (turns > limits.maxSteps) { turns = limits.maxSteps; throw new DiscoveryError('STEP_LIMIT'); }
    }
  } catch (error) {
    code = errorCode(error);
    if (code === 'RUN_TIMEOUT' || code === 'MODEL_TIMEOUT' || code === 'SURFACE_TIMEOUT') abort(code);
    kind = blocked.has(code) ? 'BLOCKED' : 'FAILURE';
    outputs = undefined;
  } finally {
    if (controller.signal.aborted) await close().catch(() => {});
    if (sink) {
      try {
        if (surface && kind !== 'SUCCESS') {
          let snapshot: SafeSnapshot = { frames: [{ index: 0, allowed: false, path: '[unavailable]', nodes: [], truncated: true }] };
          if (!controller.signal.aborted && !evidenceFailed) {
            try { snapshot = await ui(() => surface!.snapshot()); }
            catch { await close().catch(() => {}); }
          }
          await sink.snapshot(snapshot);
        }
      } catch { evidenceFailed = true; kind = 'FAILURE'; code = 'EVIDENCE_ERROR'; outputs = undefined; }
    }
    await close().catch(() => {
      if (kind !== 'FAILURE' && kind !== 'BLOCKED') {
        kind = 'FAILURE'; code = 'RESOURCE_CLOSE_FAILED'; outputs = undefined;
      }
    });
    if (controller.signal.aborted && kind !== 'FAILURE' && kind !== 'BLOCKED') {
      kind = 'FAILURE'; code = errorCode(controller.signal.reason); outputs = undefined;
    }
    clearTimeout(timer);
    if (sink && metadata) {
      try {
        transcriptFile = await writeTranscript(sink.directory, {
          schemaVersion: 1, kind: 'discovery_transcript', source, ...metadata, runId, promptVersion: PROMPT_VERSION,
          goalType: 'member_savings_balance', inputNames: ['memberId'], status: kind, calls, records,
        } satisfies DiscoveryTranscript, { inputs: memberId ? { memberId } : {}, secrets, sensitiveValues: [...sensitive] });
      } catch (error) {
        kind = 'FAILURE'; outputs = undefined;
        code = error instanceof Error && error.message === 'TRANSCRIPT_UNSAFE' ? 'TRANSCRIPT_UNSAFE' : 'TRANSCRIPT_WRITE_FAILED';
      }
      try { await sink.event({ type: 'discovery_finished', outcome: kind, code }); }
      catch { kind = 'FAILURE'; code = 'EVIDENCE_ERROR'; outputs = undefined; }
    }
    try { await sink?.close(); }
    catch { kind = 'FAILURE'; code = 'EVIDENCE_ERROR'; outputs = undefined; }
  }
  return discoveryResultSchema.parse({ kind, runId, code, source, turns, usage, usageComplete: calls.every((call) => call.usage !== null),
    evidence: [...(sink?.files ?? []), ...(transcriptFile ? [transcriptFile] : [])],
    ...(kind === 'SUCCESS' ? { outputs } : {}) });
}
