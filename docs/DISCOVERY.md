# Discovery: The Goal-Agnostic Agent Loop

Discovery lets a tool-calling model learn a read-only flow from live observations of the real
browser. The loop knows nothing about any particular goal: the model declares what it is looking
for as a **GoalSpec**, and every later check is derived from that declaration. The engine, not
the model, authorises and dispatches every action through the same surface, policy and network
boundary that model-free replay uses ([POLICY.md](POLICY.md), [REPLAY.md](REPLAY.md)).

## Run it

```bash
pnpm discover --goal "What is the current savings balance for member 12345?" --sandbox
pnpm discover --goal "How much does member 67890 have in their checking account?" --sandbox
```

`--sandbox` starts a fresh mock instance and browser and closes both afterwards; `pnpm mock-app`
is not needed. `--target http://localhost:4000/` points at a running instance instead. One JSON
line is printed; exit 0 for `SUCCESS` and `BUSINESS_OUTCOME`.

| Flag | Default | Bound |
|---|---|---|
| `--max-steps` | 25 | 1-50 model action turns |
| `--max-duration-ms` | 180000 | 1-300000 for the whole run |
| `--model-timeout-ms` | 30000 | 1-60000 per model call |
| `--max-tokens` | 40000 | 1-200000 input plus output tokens |

## The GoalSpec

The first model call turns the goal text into a contract:

```json
{ "status": "ready", "goal": {
    "name": "get_member_checking_balance",
    "description": "Retrieve the checking account balance for a specific member.",
    "inputs":  [{ "name": "member_id", "value": "67890", "description": "..." }],
    "outputs": [{ "name": "checking_account_balance", "parser": "usd_cents", "description": "...", "sensitive": true }] } }
```

The engine accepts it only if every input value is written literally in the goal (no invented
or completed identifiers), the capability name does not embed an input value, and the declared
names are valid identifiers. `clarify` and `unsupported` end the run before any browser starts.
From here on:

- the tool schemas are built from the spec: `fill` may name only a declared input, `extract`
  only a declared input or output, `complete` claims `success` or a `business_outcome` with an
  `UPPER_SNAKE` code and the ref of the visible message;
- the transcript records the spec (names, parsers, descriptions, input format and width, never
  the values) and the compiler derives the artifact's contract from it;
- every input value is treated as sensitive and redacted from all evidence.

## Acceptance is generic

`src/discovery/acceptance.ts` decides whether what the model read proves its claim, using only
the spec:

- reading an **input** back is an identity check: the text must equal the declared value
  (`WRONG_IDENTITY` otherwise);
- reading an **output** must parse with its declared parser (`EXTRACTION_FAILED` otherwise);
- a **success** claim needs, for every output, a read of that output and a read of every input
  in the *same document or frame*; all of those reads are re-resolved and re-read under one
  unchanged document state, and the outputs returned are the re-read values
  (`INCOMPLETE_EVIDENCE`, `STATE_CHANGED`);
- a **business outcome** needs a live `alert`/`status` element in the main document, on a page
  reached by a form submission that carried every declared input value.

This is the generic form of "the balance you are showing me belongs to the member I asked
about", and it is why swapping the accounts frame to another member, or submitting a different
identifier, is refused without the code knowing what a member is.

## Execution path

```text
goal
  -> reject goals containing known secrets (no provider call)
  -> intent call -> GoalSpec (or clarify / unsupported)
  -> private evidence, browser, enforced network boundary; sign in per policy.session
  -> loop (bounded by steps, tokens, duration, repetition):
       unknown dialog?   -> handoff with --hitl, otherwise BLOCKED
       observe -> redact -> model.decide(spec) -> strict tool parse
       capture ref -> measure effect -> authorize -> dispatch -> record receipt
       complete -> re-verify every read under one document state
  -> events, structural snapshot on non-success, sanitized transcript
```

The model receives the goal, the spec, the current observation (refs, tags, labels, text, frame
path, hrefs, table row/column), the last five action results and which names were extracted
where. It never receives selectors, effects, form values, credentials or source. Any string
containing a known secret is replaced whole by `[REDACTED]`.

## Result kinds

| Kind | Codes | Meaning |
|---|---|---|
| `SUCCESS` | `COMPLETED` | Every declared output re-verified for the declared identity; `outputs` and `goal` are returned |
| `BUSINESS_OUTCOME` | model-chosen code, e.g. `NO_MEMBER_FOUND` | Verified on a live message after submitting the inputs |
| `CLARIFICATION_REQUIRED` | same | Intent asked to clarify, or declared an input the goal does not contain |
| `UNSUPPORTED_GOAL` | same | Not a read of this application |
| `BLOCKED` | `POLICY_BLOCKED`, `UNEXPECTED_DIALOG`, `SESSION_REQUIRED`, `HUMAN_REQUIRED`, `NEEDS_HUMAN`, `ABORTED_BY_OPERATOR`, `TOKEN_LIMIT`, `STEP_LIMIT`, `DEAD_END` | Stopped by policy, an unknown notice, session loss, a human, or a budget |
| `FAILURE` | `MODEL_ERROR`, `MODEL_TIMEOUT`, `RUN_TIMEOUT`, `EVIDENCE_ERROR`, `TRANSCRIPT_UNSAFE`, … | Engine, model, evidence or browser failure |

## Human handoff during discovery

With a broker attached (`pnpm agent --hitl`, or `scripts/hitl-discovery-demo.ts`), an unknown
dialog or a `request_human` decision pauses the loop instead of ending it: the operator claims
the very same browser, acts, and resumes with `retry_step`; the model then re-plans from a fresh
observation. `skip_step` is refused (there is no fixed step to skip). The transcript keeps a
`HUMAN_RESUMED` mark and the compiler refuses to compile such a run: the goal was answered, but a
recipe that needed a person is not a replayable recipe. See [HITL.md](HITL.md).

## Evidence

`artifacts/runs/<runId>/` holds `events.jsonl`, `snapshot_N.json` on non-success, and
`discovery.json`: model call receipts and, for confirmed dispatches only, the captured target,
the measured effect kind and canonical paths. Literal input values in targets become
`{ "source": "input", "name": ... }`, identifiers in paths become `:id`, and every string is
checked against credentials, the provider key, the inputs and the values read from the UI.

## Limits

- Reads only: the policy denies writes and acceptance cannot be satisfied by anything but reads.
- Every input must be visible in the document that shows the outputs. A read whose selecting
  input is never displayed (a date-range filter, say) would need an acceptance extension.
- One origin, HTTP loopback, 10 frames and 200 controls per observation, three retries or three
  repeated decisions stop the run. No vision or physical input events.
