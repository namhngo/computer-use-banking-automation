# Reviewed Evidence

Real runs, committed with their original run IDs and timestamps. Directory names carry the
development phase they were produced in; the mapping to the assignment's Deliverable 3 is:

| Deliverable 3 asks for | Where |
|---|---|
| A saved example artifact | [`compile-phase5/get_member_savings_balance.v2.verified.json`](compile-phase5/get_member_savings_balance.v2.verified.json) (live-discovered, verified) and [`../examples/get-member-savings-balance.json`](../examples/get-member-savings-balance.json) (authored draft) |
| Logs from a discovery run | [discovery-phase4/](discovery-phase4/README.md) — live `gpt-4.1` |
| Logs from a replay run | [replay-phase3/](replay-phase3/README.md) and [compile-phase5/](compile-phase5/README.md) — all model-free |
| A replay hitting an error or exceptional state | `replay-phase3/not-found` (business outcome), `replay-phase3/permission-denied` (hard failure + snapshot), `replay-phase3/session-recovery` (recovered), `compile-phase5/replay-99999` (observed outcome handler) |

## What each directory contains

**[replay-phase3/](replay-phase3/README.md)** — four model-free replays of the authored draft
covering every result kind: success, `MEMBER_NOT_FOUND` business outcome, a bounded session-expiry
recovery, and a `PERMISSION_DENIED` hard failure with a structural DOM snapshot.

**[discovery-phase4/](discovery-phase4/README.md)** — genuine live `gpt-4.1` discovery: a success
run (including one premature completion claim the engine rejected) and a not-found business
outcome with a structural snapshot. Contains `events.jsonl` and the sanitized `discovery.json`
transcript only. Offline test-model runs are marked `source: "test"` and deliberately not
published here.

**[compile-phase5/](compile-phase5/README.md)** — the full discover → compile → verify → replay
thread: the artifact compiled from that live transcript, its two fresh-sandbox verification runs,
the published verified revision, and two model-free production replays of it (a third member the
model never saw, plus the not-found outcome).

**[hitl-phase6/](hitl-phase6/README.md)** — real same-session human handoff: an attended headed run
that paused on the unfamiliar notice, refused premature resumes, recorded the operator's
acknowledgement in that same window, and resumed to `SUCCESS`; plus an unattended run that expired
into `NEEDS_HUMAN`. Each carries `events.jsonl`, a structural snapshot, and the
`intervention_1.json` audit record. The operator token is never written anywhere.

**[agent-phase7/](agent-phase7/README.md)** — goal-driven router runs with the live `gpt-4.1`
router: a cold run that discovered, compiled, verified in two fresh sandboxes, and published a
verified revision without executing again; a warm run that replayed that revision model-free; a
clarification; a refusal; and a permission denial that was reported rather than rediscovered. Each
carries the caller's `agent-result.json` plus the delegated stage's sanitized logs, and for the
cold run both artifact revisions.

## Handling

Generated runs belong in the ignored `artifacts/` directory. Only reviewed, sanitized examples are
published here. Evidence is structural by construction — routes, trusted target keys, strategy
indices, result codes — with no raw values, URLs, selectors, or exception objects. Do not add raw
model transcripts, browser storage, traces, credentials, or sensitive screenshots.
