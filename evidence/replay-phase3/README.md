# Phase 3 Replay Evidence

These are reviewed copies of real CLI runs against fresh local Harbor sandboxes on
2026-09-12. No LLM participated. The source is the unchanged, manually authored
[draft artifact](../../examples/get-member-savings-balance.json), not a discovery recording.

| Directory | Synthetic input | Fault | Observed result |
|---|---|---|---|
| `success/` | Member `12345` | None | SUCCESS, all six steps completed |
| `not-found/` | Member `99999` | None | BUSINESS_OUTCOME / MEMBER_NOT_FOUND at search |
| `session-recovery/` | Member `67890` | session_expired | SUCCESS after one reauthentication and entry restart |
| `permission-denied/` | Member `12345` | permission_denied | FAILURE / PERMISSION_DENIED before extraction, plus structural DOM snapshot |

Common command:

```bash
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification
```

Change the synthetic input and add `--fault` according to the table. Local mock credentials
come from the ignored `.env`. The event logs omit credentials, member values, names, and
balances; outputs were returned to the invoking caller, not copied into these logs.

The original run IDs and timestamps are preserved. `snapshot_1.json` records structure only,
including the visible alert on the failure page and a parameterized member route. It is not a
raw DOM dump or screenshot. The draft artifact is not automatically promoted by these commands.

Genuine discovery evidence, generated capability artifacts, and human-handoff evidence remain
future deliverables. These runs establish only the deterministic replay portion.
