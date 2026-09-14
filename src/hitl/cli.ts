import { InterventionBroker } from './interventions.js';
import { startHitlServer } from './server.js';

/**
 * Operator console for a CLI run: one broker, one local HTTP endpoint, one bearer token printed
 * once to stderr. Shared by `pnpm replay --hitl` and `pnpm agent --hitl` so a handoff looks the
 * same whether it came from a replay step or from the discovery loop.
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

/** Validates `--hitl-port` / `--hitl-wait-ms` the same way for every CLI. */
export function parseHitlFlags(values: { hitl: boolean; 'hitl-port': string; 'hitl-wait-ms': string }, supplied: Set<string>): { port: number; waitMs: number } | undefined {
  if (!/^[0-9]{1,5}$/.test(values['hitl-port']) || !/^[0-9]{4,7}$/.test(values['hitl-wait-ms'])
    || (!values.hitl && (supplied.has('hitl-port') || supplied.has('hitl-wait-ms')))) throw new Error();
  const port = Number(values['hitl-port']);
  const waitMs = Number(values['hitl-wait-ms']);
  if (port > 65535 || waitMs < 1000 || waitMs > 3_600_000) throw new Error();
  return values.hitl ? { port, waitMs } : undefined;
}
