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
discover → compile → verify → replay thread. Same-session human-handoff evidence remains pending.

Generated runs belong in the ignored `artifacts/` directory. Only reviewed, sanitized example
artifacts and logs will be published here in later phases. Do not add raw model transcripts,
browser storage, traces, credentials, or sensitive screenshots.
