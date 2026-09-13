# Reviewed Evidence

Reviewed, real deterministic replay runs are now available in
[replay-phase3/](replay-phase3/README.md): success, not-found, session recovery, and a permission
failure with a structural snapshot. They execute an authored draft, not an LLM-generated flow.

Genuine LLM discovery runs are in [discovery-phase4/](discovery-phase4/README.md): a live
`gpt-4.1` success run (including one engine-rejected premature completion claim) and a live
not-found business outcome with a structural snapshot. They contain `events.jsonl` and the
sanitized `discovery.json` transcript only; offline test-model runs are marked `source: "test"`
and are deliberately not published.

The artifact compiled from that live transcript, its two fresh-sandbox verification runs, the
published verified revision, and two model-free production replays of it (a third member and the
not-found outcome) are in [compile-phase5/](compile-phase5/README.md). This is the full
discover → compile → verify → replay thread.

Real same-session human-handoff runs are in [hitl-phase6/](hitl-phase6/README.md): an attended
headed run that paused on the unfamiliar notice, refused premature resumes, recorded the
operator's acknowledgement in the same window, and resumed to `SUCCESS`; and an unattended run
that expired into `NEEDS_HUMAN`. Each carries `events.jsonl`, a structural snapshot, and the
`intervention_1.json` audit record. The operator token is never written anywhere.

Real goal-driven router runs with the live `gpt-4.1` router are in
[agent-phase7/](agent-phase7/README.md): a cold run that discovered, compiled, verified in two
fresh sandboxes, and published a verified revision without executing again; a warm run that
replayed that revision model-free; a clarification; a refusal; and a permission denial that was
reported rather than rediscovered. Each carries the caller's `agent-result.json` plus the
delegated stage's sanitized logs and, for the cold run, both artifact revisions.

Generated runs belong in the ignored `artifacts/` directory. Only reviewed, sanitized example
artifacts and logs are published here. Do not add raw model transcripts,
browser storage, traces, credentials, or sensitive screenshots.
