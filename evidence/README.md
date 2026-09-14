# Reviewed Evidence

Real runs against the local sandbox, committed with their original run IDs. Every model call
here is `gpt-4.1` (`source: "live"`); test doubles never produce evidence. Each directory holds
the CLI's JSON result plus the private run directories it created (`events.jsonl`, structural
`snapshot_N.json` on non-success, sanitized `discovery.json` transcripts, `intervention_N.json`).
No credentials, member identifiers, balances or UI text appear in any file; paths spell
identifiers as `:id`.

All agent runs were made in one session against one registry, in this order, so the catalog the
router saw grows as you read down.

| Directory | Command | What it shows |
| --- | --- | --- |
| `agent/cold-savings` | `pnpm agent --goal "What is the current savings balance for member 12345?" --sandbox --verify-inputs 67890` | Empty catalog → `discover`. The model declared `get_member_savings_balance { member_id → savings_balance }`, learned the flow in 6 turns, the transcript compiled to v1 and verified in two fresh sandboxes as v2. Result carries the answer; nothing ran again. |
| `agent/cold-checking` | `pnpm agent --goal "How much does member 67890 have in their checking account?" --sandbox --verify-inputs 12345` | A read the previous design could not express. Router saw the savings capability and still chose `discover`; the same loop learned `get_member_checking_balance { member_id → checking_account_balance }` in 7 turns, verified as v2. No code or policy changed between this run and the last. |
| `agent/warm-savings`, `agent/warm-checking` | same goals, other members | `execute`: model-free replay of the verified revision, correct outputs. |
| `agent/not-found` | member 99999 | `execute` of the agent-compiled savings capability, which has no observed outcome yet: `FAILURE / CHECKPOINT_FAILED` at the search click, nothing guessed. Compare `replay/compiled-member_not_found`. |
| `agent/denied` | `--fault permission_denied` | `execute` returning the replay `FAILURE`; the router does not rediscover around a denial. |
| `agent/unsupported` | "Transfer 50 dollars …" | `UNSUPPORTED_GOAL / changes_data`, no browser. |
| `agent/clarify` | "What is the savings balance?" | `CLARIFICATION_REQUIRED / missing_input` with a one-line question, no browser. |
| `agent/cold-not-found` | member 99999, fresh registry | Discovery ending in a verified business outcome (`NO_MEMBER_FOUND`, a code the model chose, confirmed on the live message after a real submission). Not compiled (`compiled: null`). |
| `compile` | `pnpm compile --run <cold-savings> --outcome-run <cold-not-found> --verify --sandbox --verify-inputs '{"member_id":"12345"}' --verify-inputs '{"member_id":"67890"}'` | The compile CLI merging an observed outcome into the draft (the two transcripts' contracts match), then `VERIFIED` v2. The v1 draft and v2 verified artifacts are included. |
| `replay/compiled-*` | `pnpm replay get_member_savings_balance --version 2 --inputs '{"member_id":"12345"}' --sandbox --fault <fault>` | The compiled+verified artifact: `none` → `SUCCESS`; `member_not_found` → `BUSINESS_OUTCOME / NO_MEMBER_FOUND`; `permission_denied` and `session_expired` → `FAILURE / CHECKPOINT_FAILED` (a compiled artifact has no authored recoveries). |
| `replay/authored-*` | `pnpm replay --artifact examples/get-member-savings-balance.json --inputs '{"memberId":"12345"}' --sandbox --mode verification --fault <fault>` | The hand-written draft with an authored recovery: `session_expired` recovers (`SESSION_EXPIRED` recovery, then `SUCCESS`). Needs no model key. |
| `hitl/discovery-handoff` | `pnpm agent --goal "What is the current savings balance for member 12345?" --sandbox --fault unexpected_confirm` | Same-browser handoff **during discovery** with the live model and a real person: an unfamiliar dialog after sign-in pauses the loop at turn 1, operator `nam` claims over the HTTP console, **clicks Acknowledge notice in the handed-over Chromium window** (`human_action click` + `submit … allowed` on `/notice` in `intervention_1.json`), resumes with `retry_step`, and the model finishes the read (`SUCCESS`, 7 turns). `operator-console.log` is what the CLI printed. The agent result is `DISCOVERED` with the answer and `compiled: { draft: null, code: COMPILE_HUMAN_ASSISTED }`: a helped run is not compiled into a recipe. |
| `capabilities` | — | The four artifacts the agent runs produced (savings v1/v2, checking v1/v2). |

The attended and unattended replay handoffs (claim, blocked operator submission, abort, expiry)
are exercised by `tests/browser/hitl.test.ts` against the same engine; they produce identical
evidence shapes but are not committed here because their operator is the test itself.

## Mapping to the brief's deliverable

| Asked for | Where |
| --- | --- |
| Agent discovering a flow from a goal | `agent/cold-savings`, `agent/cold-checking`, `hitl/discovery-handoff` (`discovery/discovery.json`, `events.jsonl`) |
| The resulting artifact | `capabilities/`, `compile/` |
| Model-free replay of that artifact | `agent/warm-*`, `replay/compiled-none`, `compile/verification-*` |
| Failure and outcome handling | `replay/compiled-*`, `replay/authored-*`, `agent/not-found`, `agent/denied` |
| Human handoff | `hitl/discovery-handoff` |
| Refusals | `agent/unsupported`, `agent/clarify` |
