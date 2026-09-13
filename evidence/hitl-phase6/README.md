# Phase 6 Evidence: Same-Session Human Handoff

Two real runs of the replay engine against the Harbor sandbox with `--fault unexpected_confirm`,
which renders an unfamiliar "Operator review required" notice that automation is not permitted
to acknowledge. Both ran with the real loopback operator API (`src/hitl/server.ts`) and the
authored draft artifact (`examples/get-member-savings-balance.json`), member `12345`. Original
run IDs and timestamps are retained. Neither directory contains typed values, URLs, the operator
token, credentials, member IDs, or balances; the only match for "password" is the structural
`login_password` targetKey of the sign-in prerequisite, as in earlier phases.

## attended/ — `run_a5e44b9086c54619bd90f1ce7180dc31` → `SUCCESS`

Headed Chromium. Sequence, all visible in `events.jsonl` and `intervention_1.json`:

1. Sign-in redirected to `/notice`; the first step (`open_search`) detected an unknown dialog.
   Instead of failing, the engine opened intervention `iv_d758736ae16a441aae8070bcead0740b`
   (`intervention_opened`), saved `snapshot_1.json` of the `/notice` page, and paused with
   `controlOwner: none`.
2. Operator API: `resume` before any claim → `409 NOT_UNDER_HUMAN_CONTROL`; `claim` as `nam` →
   `human_control`; `resume retry_step` while the notice was still on screen →
   `409 DIALOG_STILL_PRESENT` (the transition and code are in `intervention_1.json`).
3. The operator clicked **Acknowledge notice** in the same Chromium window (same page, same
   session cookie). The recorder logged `human_action click … recorded` and `human_action submit
   … allowed`, both classified by the trusted profile as `operator_notice_acknowledge`, the one
   targetKey `policy.yaml › humanActions` permits. The POST went through the same policy proxy
   with a one-use grant issued only because that rule matched.
4. `resume retry_step` → validated (no dialog, read-only step) → `intervention_closed
   outcome=resumed action=retry_step`. Automation resumed at the entry step in the same browser
   and completed all six steps: `SUCCESS` with the expected outputs (returned to the caller,
   not written to evidence).

How the operator acted: the HTTP calls were made with the real per-run bearer token; the click was
a real mouse click delivered to the headed window at the button's on-screen coordinates by a small
local harness (kept outside the repo), because no second person was present. The browser cannot
tell the difference and the engine/proxy/recorder path is identical to a human at the keyboard.

## unattended/ — `run_cae2f66ee3364f79a6bba99543c1329a` → `NEEDS_HUMAN`

Same fault, no operator, five-second handoff budget. The engine opened
`iv_33d4a6f2796c427395cbc7932898deda`, nobody claimed it, the budget expired, and the run ended
with `NEEDS_HUMAN { interventionId, reason: UNEXPECTED_DIALOG }` at `open_search`.
`intervention_1.json` shows `waiting → expired`, no operator, no human actions. No `/notice`
POST was ever sent: an unattended run does not guess.

## Reproduce

```bash
pnpm mock-app --fault unexpected_confirm          # or let --sandbox spawn it
HEADLESS=false pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification \
  --fault unexpected_confirm --hitl
# stderr prints the loopback endpoint, a one-time HITL_TOKEN, and claim/resume curl recipes.
```

See [docs/HITL.md](../../docs/HITL.md) for the state machine, the resume validation rules, and
the limitations of the recorder.
