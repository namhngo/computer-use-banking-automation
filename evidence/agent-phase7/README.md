# Phase 7 Capability Router Evidence

Real `pnpm agent --goal` runs with the live `gpt-4.1` router against an owned sandbox, all from
2026-09-13, run IDs and timestamps preserved. Each `agent-result.json` is the exact stdout the
caller received; it is the only place outputs appear. Every `events.jsonl` is the sanitized
run log written by the pipeline stage the router delegated to. The router itself never saw the
UI: its whole input was the goal plus the catalog listed in `routing.catalog`.

| Directory | Command | Router decision | What happened |
|---|---|---|---|
| `cold/` | `pnpm agent --goal "look up member 12345 and read their current savings balance" --sandbox --verify-inputs '{"memberId":"67890"}'` | `discover` (catalog empty) | Live discovery `SUCCESS` in 9 turns (`discovery/`), transcript compiled into `get_member_savings_balance.v1.draft.json`, draft replayed model-free in two brand-new sandboxes (`verification-12345/`, `verification-67890/`), `v2.verified.json` published. Result returned from the discovery outputs; nothing ran again after verification. |
| `warm/` | `pnpm agent --goal "look up member 67890 and read their current savings balance" --sandbox` | `execute` v2 | Model-free replay of the revision the cold run had just verified: `SUCCESS` at `extract_t6` for a member the router never saw during discovery. No discovery model call was made. |
| `clarify/` | `pnpm agent --goal "read the current savings balance for one of our members" --sandbox` | `clarify` | `CLARIFICATION_REQUIRED / missing_member_id` with one question. No browser started; no identifier was guessed. |
| `unsupported/` | `pnpm agent --goal "transfer 500 dollars from member 12345 savings into their checking account" --sandbox` | `unsupported` | `UNSUPPORTED_GOAL / changes_financial_data`. The catalog contained a read-only capability; the router did not stretch it. |
| `denied/` | `pnpm agent --goal "look up member 12345 ..." --sandbox --fault permission_denied` | `execute` v2 | Replay hit the permission fault and returned `EXECUTED` with a `FAILURE / CHECKPOINT_FAILED` result and a structural snapshot. The router did not fall back to discovery to route around the denial. |

Routing receipts (`routing.modelId`, `responseId`, `usage`) are the provider's own, captured
at the wire and checked before the SDK could synthesize them; see `src/discovery/model.ts`.

## What to check

- `cold/agent-result.json › compiled.verificationRuns` are exactly the two `verification-*`
  directories, and `discovery.runId` is the `discovery/` run. There is no third execution run.
- `cold/get_member_savings_balance.v2.verified.json` has the same step IDs as the Phase 5
  artifact (`fill_t1, click_t2, click_t3, extract_t5, extract_t6`) with `provenance.runId`
  pointing at this discovery run. It has **no `outcomes`**: the cold path compiles only the
  success transcript, so a not-found member currently ends in `CHECKPOINT_FAILED` rather than
  `BUSINESS_OUTCOME`. Adding the observed outcome still goes through `pnpm compile --outcome-run`
  (see [compile-phase5](../compile-phase5/README.md)); the router does not invent handlers.
- No log or artifact contains a member ID, balance, credential, or the goal text. The only
  `password` hit is the structural target key `login_password`.
- `warm/agent-result.json › routing.catalog` shows the router was offered exactly one entry and
  chose it; `clarify/` and `unsupported/` show it was offered the same entry and declined.
