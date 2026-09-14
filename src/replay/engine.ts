import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { bindText, parseExtraction, prepareInvocation, validateValues } from '../artifact/bindings.js';
import { parseArtifact } from '../artifact/schema.js';
import type { CapabilityArtifact, Condition, Target } from '../artifact/schema.js';
import { parseReplayResult } from '../artifact/result.js';
import type { ReplayResult } from '../artifact/result.js';
import { EvidenceSink } from '../evidence/evidence.js';
import type { SafeSnapshot } from '../evidence/evidence.js';
import type { InterventionBroker, Validation } from '../hitl/interventions.js';
import { authorizeAction, policyApp } from '../policy/policy.js';
import type { Policy } from '../policy/policy.js';
import { PlaywrightAdapter } from '../surface/playwright-adapter.js';
import { SurfaceError } from '../surface/errors.js';

export async function runReplay(options: {
  artifact: unknown;
  inputs: unknown;
  mode: 'verification' | 'replay';
  origin: string;
  policy: Policy;
  credentials?: { username: string; password: string };
  evidenceRoot?: string;
  headless?: boolean;
  /**
   * Same-session human handoff. Without it an unknown dialog is a terminal failure. With it the
   * run pauses, an operator may claim the same browser, and automation resumes only after the
   * requested resume action is validated against the live page. maxWaitMs bounds the pause.
   */
  hitl?: { broker: InterventionBroker; maxWaitMs: number };
}): Promise<ReplayResult> {
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const hitl = options.hitl;
  if (hitl && (!Number.isInteger(hitl.maxWaitMs) || hitl.maxWaitMs < 1000 || hitl.maxWaitMs > 3_600_000)) {
    throw new Error('Invalid human handoff budget.');
  }
  let controlOwner: 'automation' | 'human' | 'none' = 'automation';
  const recoveries: ReplayResult['recoveries'] = [];
  const sensitiveValues: string[] = [];
  let sensitiveLength = 0;
  let artifact: CapabilityArtifact | undefined;
  let adapter: PlaywrightAdapter | undefined;
  let sink: EvidenceSink | undefined;
  let atStep: string | null = null;
  let fallbackCode = 'ARTIFACT_INVALID';
  let evidenceFailed = false;
  let failedRecovery: string | undefined;
  let result: ReplayResult | undefined;
  const stop = new Error('BUSINESS_OUTCOME');
  const restart = new Error('RESTART');
  const skip = new Error('SKIP_STEP');

  function base() {
    return { runId, atStep, recoveries, evidence: sink?.files ?? [] };
  }
  function failure(code: string): ReplayResult {
    const step = artifact?.steps.find((candidate) => candidate.id === atStep);
    return {
      ...base(), kind: 'FAILURE', code, message: code,
      expected: failedRecovery ? `Complete recovery ${failedRecovery} within its attempt budget and verify its postcondition.`
        : step ? `Complete ${step.action} with a unique permitted target and valid conditions.` : 'Valid invocation and authenticated entry state.',
      observed: code,
    };
  }
  function errorCode(error: unknown): string {
    if (evidenceFailed) return 'EVIDENCE_FAILED';
    return error instanceof SurfaceError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code : fallbackCode;
  }
  async function event(metadata: Parameters<EvidenceSink['event']>[0]) {
    try {
      if (evidenceFailed || !sink) throw new Error();
      await sink.event(metadata);
    } catch {
      evidenceFailed = true;
      throw new SurfaceError('EVIDENCE_FAILED');
    }
  }
  function remember(value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
    const text = String(value);
    if (!text || text.length > 4096 || sensitiveLength + text.length > 16384) return;
    sensitiveValues.push(text);
    sensitiveLength += text.length;
  }

  try {
    // Bound both traversal and literal redaction patterns, including rejected invocations.
    remember(options.credentials?.username);
    remember(options.credentials?.password);
    if (options.inputs !== null && typeof options.inputs === 'object') {
      let count = 0;
      for (const key in options.inputs) {
        if (!Object.hasOwn(options.inputs, key)) continue;
        if (count++ >= 32) break;
        remember((options.inputs as Record<string, unknown>)[key]);
      }
    }
    artifact = parseArtifact(options.artifact);
    fallbackCode = 'INPUT_INVALID';
    const values = validateValues(artifact.inputs, options.inputs);
    fallbackCode = 'INVOCATION_INVALID';
    const app = policyApp(options.policy);
    const prepared = prepareInvocation(artifact, values, { ...app, mode: options.mode });
    const capability = prepared.artifact;
    const inputs = prepared.inputs;
    fallbackCode = 'AUTH_SETUP_INVALID';
    const credentials = options.credentials;
    if ((capability.app.requiresSession && !credentials) || (credentials &&
      [credentials.username, credentials.password].some((value) =>
        typeof value !== 'string' || value.length === 0 || value.length > 4096))) {
      throw new SurfaceError('AUTH_SETUP_INVALID');
    }
    const entry = authorizeAction(options.policy, {
      ...app, url: `${options.origin}${capability.app.entryPath}`, action: 'navigate',
    });
    if (!entry.allowed || entry.risk !== 'read_only') throw new SurfaceError('POLICY_BLOCKED');

    fallbackCode = 'EVIDENCE_FAILED';
    sink = await EvidenceSink.create({
      runId, sensitiveValues, ...(options.evidenceRoot === undefined ? {} : { root: options.evidenceRoot }),
    });
    await event({ type: 'run_started', phase: options.mode });
    // The automation clock pauses while a human owns the browser; the surface keeps a hard cap.
    let deadline = Date.now() + capability.limits.runTimeoutMs;
    const hardDeadline = deadline + (hitl ? hitl.maxWaitMs : 0);
    let cutoff = Math.min(deadline, Date.now() + capability.limits.stepTimeoutMs);
    let timeoutCode = 'AUTH_FAILED';

    fallbackCode = 'BROWSER_ERROR';
    adapter = await PlaywrightAdapter.create({
      origin: options.origin, policy: options.policy,
      timeoutMs: capability.limits.stepTimeoutMs, deadline: hardDeadline, onEvent: event,
      ...(options.headless === undefined ? {} : { headless: options.headless }),
    });
    const browser = adapter;
    cutoff = Math.min(deadline, Date.now() + Math.max(5000, capability.limits.stepTimeoutMs));
    const outputs: Record<string, string | number | boolean> = {};
    let activeRecovery: string | undefined;

    function health() {
      if (evidenceFailed) throw new SurfaceError('EVIDENCE_FAILED');
      // Ownership is checked before every automation operation; a human-owned browser is never driven.
      if (controlOwner !== 'automation') throw new SurfaceError('CONTROL_NOT_OWNED');
      browser.health();
      if (Date.now() >= deadline) throw new SurfaceError('RUN_TIMEOUT');
      if (Date.now() >= cutoff) throw new SurfaceError(timeoutCode);
    }
    async function call<T>(operation: () => Promise<T>, dispatch = false): Promise<T> {
      health();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const value = await Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new SurfaceError(Date.now() >= deadline ? 'RUN_TIMEOUT' : timeoutCode));
            }, Math.max(1, cutoff - Date.now()));
          }),
        ]);
        health();
        return value;
      } catch (error) {
        // Sticky network/policy failures take precedence over incidental locator errors.
        let cause = error;
        try {
          browser.health();
        } catch (fatal) {
          cause = fatal;
        }
        if (evidenceFailed) cause = new SurfaceError('EVIDENCE_FAILED');
        if (timedOut && dispatch) {
          // Stop a timed-out dispatch before collecting evidence; retain its primary failure.
          try {
            await browser.close();
          } catch {
            throw cause;
          }
        }
        throw cause;
      } finally {
        clearTimeout(timer);
      }
    }
    async function condition(value: Condition) {
      return call(() => browser.checkCondition(value, inputs));
    }
    function terminal(error: unknown) {
      return error instanceof SurfaceError && [
        'POLICY_BLOCKED', 'NETWORK_ERROR', 'EVIDENCE_FAILED', 'RUN_TIMEOUT',
        'STEP_TIMEOUT', 'SURFACE_CLOSED', 'UNEXPECTED_DIALOG',
      ].includes(error.code);
    }
    async function dispatch<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await call(operation, true);
      } catch (error) {
        if (terminal(error)) throw error;
        health();
        let detected = false;
        try {
          // Inspect once under the existing deadlines; never redispatch an unhandled action.
          await inspect(() => { detected = true; });
        } catch (inspectionError) {
          if (detected || terminal(inspectionError)) throw inspectionError;
          health();
        }
        throw error;
      }
    }
    async function poll<T>(probe: () => Promise<T | undefined>, code: string): Promise<T> {
      const previousCode = timeoutCode;
      timeoutCode = code;
      try {
        for (;;) {
          await inspect();
          const value = await probe();
          if (value !== undefined) return value;
          await call(() => delay(50));
        }
      } finally {
        timeoutCode = previousCode;
      }
    }
    async function waitFor(value: Condition, code: string) {
      await poll(async () => await condition(value) ? true : undefined, code);
    }
    async function resolve(target: Target) {
      return poll<{ ref: string; strategyIndex: number }>(async () => {
        try {
          return await call(() => browser.resolve(target, inputs));
        } catch (error) {
          if (error instanceof SurfaceError && ['TARGET_NOT_FOUND', 'FRAME_NOT_FOUND'].includes(error.code)) {
            return undefined;
          }
          throw error;
        }
      }, 'TARGET_NOT_FOUND');
    }
    async function inspect(onDetected?: () => void): Promise<void> {
      health();
      for (const handler of capability.failures) {
        if (await condition(handler.when)) {
          onDetected?.();
          throw new SurfaceError(handler.code);
        }
      }
      for (const handler of capability.outcomes) {
        if (await condition(handler.when)) {
          onDetected?.();
          result = { ...base(), kind: 'BUSINESS_OUTCOME', code: handler.code };
          throw stop;
        }
      }
      let knownDialog = false;
      for (const handler of capability.recoveries) {
        if (!await condition(handler.when)) continue;
        knownDialog = true;
        if (activeRecovery === handler.code) continue;
        onDetected?.();
        const attempt = recoveries.filter((recovery) => recovery.code === handler.code).length + 1;
        if (activeRecovery || attempt > handler.maxAttempts || recoveries.length >= capability.limits.maxRecoveryAttempts) {
          failedRecovery = handler.code;
          throw new SurfaceError('RECOVERY_EXHAUSTED');
        }
        await event({ type: 'recovery_started', stepId: atStep!, code: handler.code, attempt });
        const record: ReplayResult['recoveries'][number] = {
          code: handler.code, atStep: atStep!, attempt, outcome: 'exhausted',
        };
        recoveries.push(record);
        activeRecovery = handler.code;
        try {
          const recovery = handler.recovery;
          if (recovery.kind === 'reauthenticate') {
            if (!credentials) throw new SurfaceError('AUTH_SETUP_INVALID');
            await event({ type: 'action_started', stepId: atStep!, action: 'authenticate' });
            await call(() => browser.authenticate(credentials), true);
            if (await condition(handler.when)) throw new SurfaceError('RECOVERY_EXHAUSTED');
          } else {
            const target = await resolve(recovery.target);
            await event({ type: 'action_started', stepId: atStep!, action: 'click', strategyIndex: target.strategyIndex });
            await call(() => browser.act(target.ref, 'click'), true);
            await waitFor(recovery.postcondition, 'RECOVERY_EXHAUSTED');
          }
          await event({ type: 'recovery_finished', code: record.code, stepId: record.atStep,
            attempt: record.attempt, outcome: 'recovered' });
          record.outcome = 'recovered';
        } catch (error) {
          failedRecovery = handler.code;
          if (!evidenceFailed) await event({ type: 'recovery_finished', code: record.code, stepId: record.atStep,
            attempt: record.attempt, outcome: 'exhausted' });
          if (error instanceof SurfaceError && [
            'TARGET_NOT_FOUND', 'FRAME_NOT_FOUND', 'CHECKPOINT_FAILED', 'STEP_TIMEOUT',
          ].includes(error.code)) throw new SurfaceError('RECOVERY_EXHAUSTED');
          throw error;
        } finally {
          activeRecovery = undefined;
        }
        // Even a dismissal can replace the page that supplied an in-flight extraction.
        for (const key of Object.keys(outputs)) delete outputs[key];
        throw restart;
      }
      if (!knownDialog && await call(() => browser.unknownDialog())) throw new SurfaceError('UNEXPECTED_DIALOG');
    }

    /** Judges an operator's resume request against the live page while they still own it. */
    async function validateResume(step: CapabilityArtifact['steps'][number], action: 'retry_step' | 'skip_step'): Promise<Validation> {
      try {
        browser.health();
        if (await browser.unknownDialog()) return { accepted: false, code: 'DIALOG_STILL_PRESENT' };
        if (action === 'retry_step') {
          // Retry restarts the flow at its read-only entry navigation, so it is only safe for a read-only step.
          return step.risk === 'read_only' ? { accepted: true } : { accepted: false, code: 'UNSAFE_RETRY' };
        }
        // Skipping needs proof the human completed the step; an extraction can never be proven by the page alone.
        const proof = step.action === 'wait' ? step.condition : step.action === 'extract' ? undefined : step.postcondition;
        if (!proof) return { accepted: false, code: 'SKIP_NOT_PROVABLE' };
        return await browser.checkCondition(proof, inputs) ? { accepted: true } : { accepted: false, code: 'POSTCONDITION_NOT_MET' };
      } catch (error) {
        return { accepted: false, code: error instanceof SurfaceError ? error.code : 'VALIDATION_FAILED' };
      }
    }
    async function record(write: () => Promise<unknown>) {
      try {
        if (evidenceFailed || !sink) throw new Error();
        await write();
      } catch {
        evidenceFailed = true;
        throw new SurfaceError('EVIDENCE_FAILED');
      }
    }
    /** Pauses automation, offers the same browser to an operator, and applies the validated resume. */
    async function handoff(step: CapabilityArtifact['steps'][number], reason: string): Promise<never> {
      if (!hitl) throw new SurfaceError(reason);
      const broker = hitl.broker;
      await event({ type: 'intervention_opened', stepId: step.id, code: reason });
      let snapshot: SafeSnapshot | undefined;
      try { snapshot = await browser.snapshot(); } catch { /* The operator has the live page; the snapshot is a courtesy. */ }
      if (snapshot) await record(() => sink!.snapshot(snapshot));
      const intervention = broker.open({ runId, stepId: step.id, reason, path: browser.canonicalPath(browser.page.url()) }, {
        onClaim: async () => {
          controlOwner = 'human';
          await event({ type: 'intervention_claimed', stepId: step.id, outcome: 'human_control' });
          await browser.startHumanControl(async (action) => {
            broker.recordHumanAction(intervention.id, action);
            await event({ type: 'human_action', stepId: step.id, action: action.action, outcome: action.outcome, effect: action.effect });
          });
        },
        onRelease: () => browser.stopHumanControl(),
        validate: (action) => validateResume(step, action),
      });
      controlOwner = 'none';
      const pausedAt = Date.now();
      let waiting = true;
      let resolution: Awaited<ReturnType<typeof intervention.wait>>;
      try {
        // A browser the operator closes, or a policy violation they trigger, ends the wait early.
        const watchdog = (async (): Promise<never> => {
          while (waiting) {
            await delay(250);
            if (!waiting) break;
            try { browser.health(); } catch (error) { await broker.close(intervention.id); throw error; }
          }
          return new Promise<never>(() => {});
        })();
        resolution = await Promise.race([intervention.wait(hitl.maxWaitMs), watchdog]);
      } finally {
        waiting = false;
        controlOwner = 'automation';
      }
      const paused = Date.now() - pausedAt;
      deadline += paused;
      cutoff += paused;
      await event({ type: 'intervention_closed', stepId: step.id, outcome: resolution.kind,
        ...(resolution.kind === 'resumed' ? { action: resolution.action } : {}) });
      await record(() => sink!.intervention(intervention.record()));
      browser.health();
      if (resolution.kind === 'expired') {
        result = { ...base(), kind: 'NEEDS_HUMAN', interventionId: intervention.id, reason };
        throw stop;
      }
      if (resolution.kind === 'aborted') throw new SurfaceError('ABORTED_BY_OPERATOR');
      if (resolution.action === 'skip_step') throw skip;
      for (const key of Object.keys(outputs)) delete outputs[key];
      throw restart;
    }
    function humanEligible(error: unknown): boolean {
      if (!hitl || !(error instanceof SurfaceError) || error.code !== 'UNEXPECTED_DIALOG') return false;
      try { browser.health(); return true; } catch { return false; }
    }

    async function executeStep(step: CapabilityArtifact['steps'][number]) {
      await inspect();
      await event({ type: 'step_started', stepId: step.id, action: step.action });
      if (step.waitFor) await waitFor(step.waitFor, 'TARGET_NOT_FOUND');
      if (step.action === 'wait') {
        await waitFor(step.condition, 'TARGET_NOT_FOUND');
      } else if (step.action === 'navigate') {
        await event({ type: 'action_started', stepId: step.id, action: step.action });
        await dispatch(() => browser.navigate(step.path));
      } else {
        const target = await resolve(step.target);
        await event({ type: 'action_started', stepId: step.id, action: step.action, strategyIndex: target.strategyIndex });
        const value = step.action === 'fill' || step.action === 'select' ? bindText(step.value, inputs) : undefined;
        const raw = await dispatch(() => browser.act(target.ref, step.action, value));
        await inspect();
        if (step.action === 'extract') {
          try {
            if (raw === undefined) throw new Error();
            outputs[step.output] = parseExtraction(raw, step.parser);
          } catch {
            throw new SurfaceError('OUTPUT_INVALID');
          }
        }
      }
      await inspect();
      if (step.postcondition) await waitFor(step.postcondition, 'CHECKPOINT_FAILED');
      await inspect();
    }
    async function finish() {
      cutoff = Math.min(deadline, Date.now() + capability.limits.stepTimeoutMs);
      await waitFor(capability.checkpoint, 'CHECKPOINT_FAILED');
      await inspect();
      try {
        result = { ...base(), kind: 'SUCCESS', outputs: validateValues(capability.outputs, outputs) };
      } catch {
        throw new SurfaceError('OUTPUT_INVALID');
      }
    }

    fallbackCode = 'AUTH_FAILED';
    if (capability.app.requiresSession) {
      await event({ type: 'action_started', phase: 'prerequisite', action: 'authenticate' });
      await call(() => browser.authenticate(credentials!), true);
    }
    fallbackCode = 'STEP_FAILED';
    let index = 0;
    while (index < capability.steps.length) {
      const step = capability.steps[index]!;
      atStep = step.id;
      cutoff = Math.min(deadline, Date.now() + capability.limits.stepTimeoutMs);
      timeoutCode = 'STEP_TIMEOUT';
      let outcome: 'done' | 'restart' | 'skip' = 'done';
      try {
        try {
          await executeStep(step);
        } catch (error) {
          if (!humanEligible(error)) throw error;
          await handoff(step, 'UNEXPECTED_DIALOG');
        }
      } catch (error) {
        if (error === restart) outcome = 'restart';
        else if (error === skip) outcome = 'skip';
        else throw error;
      }
      if (outcome === 'restart') { index = 0; continue; }
      await event({ type: 'step_finished', stepId: step.id, action: step.action, ...(outcome === 'skip' ? { outcome: 'human' } : {}) });
      index++;
      if (index === capability.steps.length) await finish();
    }
  } catch (error) {
    if (error !== stop) result = failure(errorCode(error));
  }

  // Preflight failures still get an isolated metadata log, without opening a browser.
  if (!sink && fallbackCode !== 'EVIDENCE_FAILED') {
    try {
      sink = await EvidenceSink.create({ runId, sensitiveValues,
        ...(options.evidenceRoot === undefined ? {} : { root: options.evidenceRoot }) });
    } catch {
      evidenceFailed = true;
      result = failure('EVIDENCE_FAILED');
    }
  }
  if (adapter && result?.kind !== 'FAILURE') {
    try {
      adapter.health();
    } catch (error) {
      result = failure(errorCode(error));
    }
  }
  async function snapshotFailure(unavailable = false) {
    if (result?.kind !== 'FAILURE' || !adapter || !sink || evidenceFailed) return;
    let snapshot: SafeSnapshot = { frames: [{ index: 0, allowed: false, path: '[unavailable]', nodes: [], truncated: true }] };
    if (!unavailable) {
      try {
        snapshot = await adapter.snapshot();
      } catch {
        // Keep the structural fallback when the failed surface cannot be inspected.
      }
    }
    try {
      await sink.snapshot(snapshot);
    } catch {
      evidenceFailed = true;
      result = failure('EVIDENCE_FAILED');
    }
  }
  await snapshotFailure();
  try {
    await adapter?.close();
  } catch {
    if (result?.kind !== 'FAILURE') {
      result = failure(evidenceFailed ? 'EVIDENCE_FAILED' : 'RESOURCE_CLOSE_FAILED');
      await snapshotFailure(true);
    }
  }
  if (sink) {
    try {
      if (!evidenceFailed) await event({ type: 'run_finished', outcome: result?.kind ?? 'FAILURE',
        ...(result && 'code' in result ? { code: result.code } : {}) });
    } catch {
      result = failure('EVIDENCE_FAILED');
    } finally {
      try {
        await sink.close();
      } catch {
        evidenceFailed = true;
        result = failure('EVIDENCE_FAILED');
      }
    }
  }
  result = { ...(result ?? failure('REPLAY_FAILED')), evidence: sink?.files ?? [] };
  return parseReplayResult(result, artifact);
}
