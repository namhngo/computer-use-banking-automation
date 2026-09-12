# Phase 5 Compile And Verification Evidence

This directory closes the loop from the assignment's through-line: the live `gpt-4.1` discovery
transcript in [discovery-phase4/success](../discovery-phase4/success/discovery.json) was compiled
into a capability artifact, verified by model-free replay in fresh sandboxes with two members,
and the verified revision was then replayed as the production path. All runs are from
2026-09-12; run IDs and timestamps are preserved. No LLM participated after discovery.

| File / directory | What it is |
|---|---|
| `get_member_savings_balance.v1.draft.json` | Draft compiled from the discovery transcript. `provenance.source: "discovered"` cites the discovery run and model; the `MEMBER_NOT_FOUND` outcome cites the not-found discovery run as `observed`. |
| `get_member_savings_balance.v2.verified.json` | New revision published only after both verification runs succeeded. Identical steps; `status: "verified"` and `verification.runId` added. The draft was not modified. |
| `verification-12345/`, `verification-67890/` | Replay of the **draft** in `verification` mode, each in a brand-new sandbox and browser. Both `SUCCESS`; outputs went to the caller, not the log. |
| `replay-67890/` | Production `replay` of **v2** from the registry: `SUCCESS` with `savingsBalanceCents: 987654`, a member the model never saw during discovery. |
| `replay-99999/` | Production `replay` of v2: `BUSINESS_OUTCOME / MEMBER_NOT_FOUND` at `click_t2`, detected by the observed outcome handler. |

Commands (mock credentials from the ignored `.env`; no model key needed):

```bash
pnpm compile --run <discovery-runId> --outcome-run <not-found-runId> \
  --verify --sandbox --verify-inputs '{"memberId":"12345"}' --verify-inputs '{"memberId":"67890"}'
pnpm replay get_member_savings_balance --version 2 --inputs '{"memberId":"67890"}' --sandbox
pnpm replay get_member_savings_balance --version 2 --inputs '{"memberId":"99999"}' --sandbox
```

## What to look for in the artifact

- Steps `fill_t1`, `click_t2`, `click_t3`, `extract_t5`, `extract_t6` are the model's confirmed
  dispatches in order (turn numbers in the IDs). Turn 4 and turn 8 were identity reads and became
  the checkpoint; turn 7 was a rejected completion claim and left no step. Nothing was reordered.
- Every `postcondition` is the control the model acted on next, plus the literal path when it
  was not parameterized. The compiler proposed no condition it did not observe.
- The member value appears only as `{ "source": "input", "name": "memberId" }`, including inside
  the iframe identity locator. Member routes are `/members/:memberId` in the transcript and are
  not navigated directly by the artifact.
- `recoveries` and `failures` are empty: the transcript contained no evidence for them. The
  authored example shows what a reviewer would add; the compiler does not invent handlers.

The verification also rejects drafts that only work for the discovery member: see
`tests/browser/compile-verify.test.ts` for a hardcoded input literal (refused before any browser
starts) and a hardcoded fixture name (exposed by the second member with `CHECKPOINT_FAILED`).
Same-session human-handoff evidence remains a Phase 6 deliverable.
