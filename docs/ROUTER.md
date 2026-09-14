# Capability Router (`pnpm agent --goal`)

The router is the goal-driven entrypoint. It is deliberately thin: one model call maps
*goal → decision*, and everything after that is a pipeline stage that already exists and is
independently tested (`src/replay`, `src/discovery`, `src/compiler`). The router never sees the
UI, never chooses locators or steps, and never runs without the application validating its
decision. Nothing in it names a goal: the catalog is whatever has been learned for the
application so far, and any read the catalog lacks is learned by discovery.

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
artifacts, which were compiled from the contract a discovery run declared and then verified.
Steps, selectors, checkpoints, and handlers are not sent. The prompt tells the model that the
catalog is what has been learned, not the limit of the application, and that a similar entry
returning something else (another account, another field) does not fulfil the goal.

Output is exactly one tool call, parsed with strict schemas (`routeToolSchemas`):

| Tool | Input | Application check afterwards |
|---|---|---|
| `execute` | `capability`, `version`, `inputs` (string map, ≤ 8 keys) | Name and version must be in the catalog (`CAPABILITY_NOT_FOUND` otherwise). Inputs are validated by the replay engine against the artifact's field definitions (`INPUT_INVALID`). |
| `discover` | `reason: no_compatible_capability`, `inputs` (identifiers copied verbatim from the goal, ≤ 8) | Requires a discovery model (`MODEL_NOT_CONFIGURED`). Discovery re-derives its own contract from the goal; the router's inputs are treated as sensitive and otherwise unused. |
| `clarify` | `reason: missing_input \| ambiguous_input \| ambiguous_goal`, `question` ≤ 300 chars | Returned verbatim. |
| `unsupported` | `reason: changes_data \| not_a_read \| unsafe_request` | Returned verbatim. |

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
- **No settling for a neighbour.** An existing capability for a different read never blocks
  learning a new one; the live evidence learns `get_member_checking_balance` next to
  `get_member_savings_balance` from the same loop.
- **Drafts stay drafts.** Verification requires owned sandboxes (`--sandbox`) and at least two
  distinct inputs (the goal's values plus `--verify-inputs`). Otherwise the draft is saved with
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
pnpm agent --goal "..." [--sandbox [--fault <fault>] [--verify-inputs 67890]...]
                        [--target http://localhost:4000/] [--policy policy.yaml]
                        [--registry artifacts/capabilities] [--evidence-root artifacts/runs]
                        [--max-steps N] [--max-duration-ms N] [--model-timeout-ms N] [--max-tokens N]
                        [--hitl [--hitl-port 4100] [--hitl-wait-ms 300000]]
```

`--verify-inputs` takes bare values matched to the discovered contract's inputs in order
(`67890`), a `name=value` list, or a JSON object. `OPENAI_API_KEY` is required for the router
itself (`MODEL_NOT_CONFIGURED` otherwise); the replay it delegates to is still model-free.
`--fault` and `--verify-inputs` only apply with `--sandbox`. `--hitl` needs `HEADLESS=false` and
offers the same-browser handoff to both discovery and replay ([HITL.md](HITL.md)). Setup
failures print a `FAILURE` result with a code and never echo the goal, paths, or configuration
values.

## Known limitations

- The cold path compiles only the success transcript. Observed business outcomes (e.g. the
  not-found message) are added by `pnpm compile --outcome-run`; until then a not-found member
  replays to `CHECKPOINT_FAILED` rather than `BUSINESS_OUTCOME` (compare
  `evidence/agent/not-found` with `evidence/replay/compiled-member_not_found`).
- Input names are chosen by the model per discovery (`member_id` in the live runs). Two
  discoveries of the same read at temperature 0 agreed, and the compiler checks contract shape
  before merging an outcome transcript, but a later run could still produce a sibling capability
  with a differently named input rather than a new revision.
- The catalog is supplied upfront because it is tiny. A tool-based catalog search would need a
  bounded multi-turn loop (proposal §1.2).
- Clarification is returned, not conversed: the caller re-invokes with a better goal.
