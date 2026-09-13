# Capability Router (`pnpm agent --goal`)

The router is the goal-driven entrypoint from proposal §1.2. It is deliberately thin: one model
call maps *goal → decision*, and everything after that is a pipeline stage that already exists
and is independently tested (`src/replay`, `src/discovery`, `src/compiler`). The router never
sees the UI, never chooses locators or steps, and never runs without the application validating
its decision.

## Flow

```text
goal ──► catalog = verified revisions for the configured app (newest per name)
     ──► one structured model call: execute | discover | clarify | unsupported
           execute      → registry.load(name, version) → runReplay(mode: replay)   [no model]
           discover     → runDiscovery → compileTranscript → registry.save(draft)
                          → verifyDraft in fresh sandboxes → publish verified revision
                          → return the discovery outputs (nothing executes again)
           clarify      → CLARIFICATION_REQUIRED { reason, question }
           unsupported  → UNSUPPORTED_GOAL { reason }
```

Implementation: `src/agent/agent.ts` (`runAgent`, `buildCatalog`), `src/agent/contracts.ts`
(decision and result schemas), `src/agent/model.ts` (router prompt and model), `src/cli/agent.ts`.

## What the model sees and may say

Input is `{ goal, catalog }`. A catalog entry is name, version, description, risk, and the input
and output field definitions (type, format, bounds, description). Descriptions come from
artifacts, which are authored or compiled from trusted goal contracts, never from model text.
Steps, selectors, checkpoints, and handlers are not sent.

Output is exactly one tool call, parsed with strict schemas (`routeToolSchemas`):

| Tool | Input | Application check afterwards |
|---|---|---|
| `execute` | `capability`, `version`, `inputs` (string map, ≤ 8 keys) | Name and version must be in the catalog (`CAPABILITY_NOT_FOUND` otherwise). Inputs are validated by the replay engine against the artifact's field definitions (`INPUT_INVALID`). |
| `discover` | `reason: no_compatible_capability`, `inputs.memberId` (5 digits) | Refused with `DISCOVERY_NOT_NEEDED` if any verified capability exists. Requires a discovery model (`MODEL_NOT_CONFIGURED`). Discovery re-derives its own intent from the goal; the router's `memberId` is used only as the first verification input. |
| `clarify` | `reason` enum, `question` ≤ 300 chars | Returned verbatim. |
| `unsupported` | `reason` enum | Returned verbatim. |

The call goes through the same guarded path as discovery (`createGuardedCall`): temperature 0,
one step, tool choice required, secret guard on input and output, provider receipt captured at
the wire and validated before the SDK can synthesize usage or IDs. Prose, multiple tool calls, or
an unknown tool fail the call (`ROUTER_ERROR`); the route has its own timeout (`ROUTER_TIMEOUT`).

## Deliberate non-behaviours

- **No rediscovery on failure.** A replay `FAILURE` (including policy denials and checkpoint
  failures) is returned inside `EXECUTED`. The router never tries discovery as a way around a
  denied or failed execution, and a failed run is not retried.
- **No execution after verification.** On the cold path the goal is already met by discovery;
  the result carries `discovery.outputs`. Verification replays the draft in fresh sandboxes the
  process owns, never against the target, and no additional run follows.
- **No guessed inputs.** Missing or ambiguous identifiers become `clarify`. Type validation is
  not intent validation; the model is told to copy inputs exactly as written.
- **No discovery when a capability exists.** With one goal family the application enforces
  this; a future multi-capability catalog would need a finer rule.
- **Drafts stay drafts.** Verification requires owned sandboxes (`--sandbox`) and at least two
  distinct inputs (goal member plus `--verify-inputs`). Otherwise the draft is saved with
  `VERIFICATION_UNAVAILABLE` / `VERIFICATION_INPUTS_REQUIRED` and stays out of the catalog, so
  the next run discovers again rather than executing something unproven.

## Result shape

`agentResultSchema` (`src/agent/contracts.ts`) is a discriminated union on `kind`:
`EXECUTED { capability, result }`, `DISCOVERED { discovery, compiled | null }`,
`CLARIFICATION_REQUIRED { reason, question }`, `UNSUPPORTED_GOAL { reason }`,
`FAILURE { code, discovery? }`. Every result includes `agentRunId`, `source`, and
`routing { decision, modelId?, responseId?, usage, catalog }`. Exit code 0 only when the
delegated stage ended in `SUCCESS` or `BUSINESS_OUTCOME`.

## CLI

```bash
pnpm agent --goal "..." [--sandbox [--fault <fault>] [--verify-inputs '{"memberId":"67890"}']...]
                        [--target http://localhost:4000/] [--policy policy.yaml]
                        [--registry artifacts/capabilities] [--evidence-root artifacts/runs]
                        [--max-steps N] [--max-duration-ms N] [--model-timeout-ms N] [--max-tokens N]
```

`OPENAI_API_KEY` is required for the router itself (`MODEL_NOT_CONFIGURED` otherwise); the
replay it delegates to is still model-free. `--fault` and `--verify-inputs` only apply with
`--sandbox`. Setup failures print a `FAILURE` result with a code and never echo the goal, paths,
or configuration values.

## Known limitations

- The cold path compiles only the success transcript. Observed business outcomes (e.g. the
  not-found message) are added by `pnpm compile --outcome-run`; until then a not-found member
  replays to `CHECKPOINT_FAILED` rather than `BUSINESS_OUTCOME` (see
  [evidence/agent-phase7](../evidence/agent-phase7/README.md)).
- The catalog is supplied upfront because it is tiny. A tool-based catalog search would need a
  bounded multi-turn loop (proposal §1.2).
- Clarification is returned, not conversed: the caller re-invokes with a better goal.
