# Compilation And Verification

The compiler turns a sanitized discovery transcript into a `CapabilityArtifact` and proves that the
artifact replays without the model before it can be used in production. The compiler is
deliberately conservative: it emits only what the transcript demonstrates, and verification is
the evidence that "the artifact replays deterministically" rather than an assertion.

## Run It

```bash
# Compile only: saves an immutable draft revision to the registry
pnpm compile --run <discovery-runId> [--outcome-run <business-outcome-runId> ...]

# Compile, then verify in fresh sandboxes and publish a verified revision on success
pnpm compile --run <discovery-runId> --outcome-run <not-found-runId> --name get_member_savings_balance \
  --verify --sandbox --verify-inputs '{"member_id":"12345"}' --verify-inputs '{"member_id":"67890"}'
```

`--run` names a directory under `--evidence-root` (default `artifacts/runs`) containing
`discovery.json`. `--outcome-run` may repeat; each must be a `BUSINESS_OUTCOME` transcript whose
declared contract has the same shape (name, input names and formats, output names and parsers).
`--name` and `--version` (default `1`) choose the draft revision; a revision that already exists
is refused, never overwritten. Verification inputs are keyed by the names the transcript's
contract declared (`member_id` in the live runs).
`--verify` requires `--sandbox` and at least two distinct `--verify-inputs`; verification through
the CLI runs only against sandboxes the CLI itself creates. No model key is read.

Result on stdout, exit 0 for `COMPILED` and `VERIFIED`:

```json
{ "kind": "VERIFIED", "draft": { "...": "version": 1 }, "verified": { "...": "version": 2 },
  "attempts": [{ "runId": "run_...", "kind": "SUCCESS", "evidence": ["events.jsonl"] }, { "...": "..." }] }
```

`REJECTED` keeps the draft and reports the first failing attempt's code. `FAILURE` carries a
`COMPILE_*` refusal code, `TRANSCRIPT_UNREADABLE`, `CLI_INVALID`, `CONFIG_ERROR`,
`REGISTRY_ERROR`, or `VERIFY_FAILED`. Verification inputs are never echoed.

## Compilation Rules

`src/compiler/compile.ts` has no registry of goals. The capability contract is the GoalSpec the
model declared and the engine verified, as recorded in the transcript: input names become
sensitive string fields (`digits` inputs at the width observed, text bounded), output names take
their declared parser and type, and an `extract` of an input name is an identity check rather
than a step. The compiler knows nothing about UI order or selectors; everything else comes from
the transcript.

| Transcript fact | Artifact result |
|---|---|
| First confirmed dispatch's page path | `app.entryPath` and an `entry` navigate step; must be a literal path |
| `fill` receipt with `{ source: "input" }` value | `fill` step with the captured target; literal values are refused |
| `click` / `navigate` receipt | Step whose `postcondition` is `visible(<next control the model acted on>)`, plus `path_equals` when that page path is literal |
| `extract` receipt for an output field | `extract` step with the goal's parser; only the last confirmed read per output is kept |
| `extract` receipt for an identity field | `text_equals(target, input)` condition in the `checkpoint`, not a step |
| `rejected` / `blocked` record | Nothing; the engine guarantees it never dispatched |
| `wait` receipt | Nothing; replay owns its own waits and timeouts |
| Terminal `complete` of an outcome transcript | `outcomes[]` entry with `provenance: { source: "observed", runId }` |

Refusals rather than guesses: `COMPILE_NOT_SUCCESSFUL`, `COMPILE_HUMAN_ASSISTED` (a person acted
in the browser mid-run, so the model's steps alone are not a recipe), `COMPILE_NO_DISPATCHES`,
`COMPILE_AMBIGUOUS_ENTRY` (parameterized entry or navigate path), `COMPILE_AMBIGUOUS_EFFECT` (a
click with no observed consequence to assert), `COMPILE_UNBOUND_FILL`, `COMPILE_NO_IDENTITY_CHECK`,
`COMPILE_MISSING_OUTPUT`, `COMPILE_UNKNOWN_FIELD`, `COMPILE_INVALID_OUTCOME`,
`COMPILE_SENSITIVE_LITERAL`, `COMPILE_INVALID_ARTIFACT`.

The output is always `status: "draft"`, `risk: "read_only"`, with empty `failures` and
`recoveries`, `provenance.source: "discovered"` citing the discovery run and model, and no
`verification` block. A reviewer adds authored handlers; the compiler never invents them.

## Verification Rules

`src/compiler/verify.ts` accepts only an unverified, read-only draft and at least two distinct
input sets. It saves the draft first so a failed verification still leaves a reviewable
revision, then for each input set creates a brand-new target and browser (via the injected
factory; the CLI spins up a fresh mock instance) and runs the model-free replay engine in
`verification` mode from the declared entry path. Any non-`SUCCESS` result stops verification
and returns `REJECTED`. On success, a **new** revision (`version + 1`, `status: "verified"`,
`verification.runId` = last run) is published; the draft is untouched.

Two members are the minimum because a compiler bug that hardcodes the discovery member passes a
single-member check. The registry additionally refuses any artifact containing a known input
value as a literal before a browser starts. Writes are never automatically verified: a draft
with any non-read-only step is rejected outright.

## Limits

- The contract is only as good as the declaration: a `digits` input is pinned to the width seen
  during discovery, and an output's parser is the one the model chose. Verification with a second
  input catches the common mistakes; a reviewer can still widen or tighten fields on the draft.
- Postconditions assert what the model touched next, which is sufficient but not necessarily the
  most descriptive check; a reviewer may strengthen them. They are never weakened automatically.
- No handler inference from failures or notices seen during discovery. Discovery stops on those,
  so there is no successful transcript to compile them from.
- Verification proves replayability on the synthetic sandbox at one point in time, not stability
  over many runs.
