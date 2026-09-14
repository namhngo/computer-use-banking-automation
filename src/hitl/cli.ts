import { InterventionBroker } from './interventions.js';
import { startHitlServer } from './server.js';

/**
 * Human handoff is part of every interactive run, not a separate mode. `pnpm agent`,
 * `pnpm discover` and `pnpm replay` open an operator console and show the browser window by
 * default, so that a stuck discovery or an unrecoverable replay pauses for a person instead
 * of failing. A run is unattended only when the caller says so (`--unattended`) or has asked
 * for a browser nobody can see (`HEADLESS=true`); then the same conditions end the run with
 * `NEEDS_HUMAN` / `BLOCKED` evidence rather than a pause nobody will answer.
 */

export const attendanceOptions = {
  unattended: { type: 'boolean', default: false },
  'hitl-port': { type: 'string', default: '4100' },
  'hitl-wait-ms': { type: 'string', default: '300000' },
} as const;

export type Attendance =
  | { attended: true; headless: false; port: number; waitMs: number }
  | { attended: false; headless: true };

/** Decides attended vs. unattended for a CLI run and validates the console flags. */
export function resolveAttendance(
  values: { unattended: boolean; 'hitl-port': string; 'hitl-wait-ms': string },
  supplied: Set<string>,
  env: NodeJS.ProcessEnv = process.env,
): Attendance {
  if (!/^[0-9]{1,5}$/.test(values['hitl-port']) || !/^[0-9]{4,7}$/.test(values['hitl-wait-ms'])) throw new Error();
  const port = Number(values['hitl-port']);
  const waitMs = Number(values['hitl-wait-ms']);
  if (port > 65535 || waitMs < 1000 || waitMs > 3_600_000) throw new Error();
  const unattended = values.unattended || env.HEADLESS === 'true';
  if (unattended && (supplied.has('hitl-port') || supplied.has('hitl-wait-ms'))) throw new Error();
  // Unattended runs stay silent on stderr: a condition that needs a person ends with evidence.
  if (unattended) return { attended: false, headless: true };
  return { attended: true, headless: false, port, waitMs };
}

/**
 * Operator console for a CLI run: one broker, one local HTTP endpoint, one bearer token printed
 * once to stderr. Shared by every entrypoint so a handoff looks the same whether it came from
 * a replay step or from the discovery loop.
 */
export async function openOperatorConsole(options: { port: number; waitMs: number }): Promise<{
  hitl: { broker: InterventionBroker; maxWaitMs: number };
  close(): Promise<void>;
}> {
  let origin = '';
  const token = InterventionBroker.generateToken();
  const broker = new InterventionBroker(token, {
    onOpen: (view) => {
      process.stderr.write(`[hitl] intervention ${view.id} opened at ${view.stepId} (${view.reason}) on ${view.path}\n`
        + `[hitl] the browser window is yours once you claim; resume when the page is ready\n`
        + `[hitl] claim:  curl -sS -X POST ${origin}/interventions/${view.id}/claim -H "Authorization: Bearer $HITL_TOKEN" -H "Content-Type: application/json" -d '{"operatorId":"<you>"}'\n`
        + `[hitl] resume: curl -sS -X POST ${origin}/interventions/${view.id}/resume -H "Authorization: Bearer $HITL_TOKEN" -H "Content-Type: application/json" -d '{"operatorId":"<you>","action":"retry_step"}'\n`);
    },
  });
  const server = await startHitlServer({ broker, port: options.port });
  origin = server.origin;
  // The token appears once, on the operator's console only. It is never written to evidence.
  process.stderr.write(`[hitl] operator endpoint ${server.origin}\n[hitl] export HITL_TOKEN=${token}\n`);
  return { hitl: { broker, maxWaitMs: options.waitMs }, close: () => server.close().catch(() => {}) };
}

/** Opens the console for an attended run; returns nothing for an unattended one. */
export async function attend(attendance: Attendance): Promise<Awaited<ReturnType<typeof openOperatorConsole>> | undefined> {
  return attendance.attended ? openOperatorConsole(attendance) : undefined;
}
