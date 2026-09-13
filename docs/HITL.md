# Human-In-The-Loop Handoff

Phase 6 implements the seam the brief asks about: when replay meets something it must not handle
on its own, it pauses, offers **the same live browser session** to an operator, records what the
operator did in sanitized form, and resumes only after validating the operator's chosen resume
action against the live page. Nothing here is a mock: the runs in
[`evidence/hitl-phase6/`](../evidence/hitl-phase6/README.md) are real.

## Run It

```bash
HEADLESS=false pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification \
  --fault unexpected_confirm --hitl [--hitl-port 4100] [--hitl-wait-ms 300000]
```

`--hitl` requires a headed browser (`HEADLESS=false`), because a handoff nobody can see is just
a longer failure. On start the CLI prints, to stderr only, the loopback endpoint and a one-time
per-run bearer token:

```text
[hitl] operator endpoint http://127.0.0.1:4100
[hitl] export HITL_TOKEN=<48 hex chars>
```

When the run pauses it prints the intervention ID together with ready-to-paste `claim` and
`resume` commands. The operator API is three routes, JSON in/out, bound to `127.0.0.1`:

| Route | Body | Effect |
| --- | --- | --- |
| `GET /interventions` | – | Lists interventions with state and `controlOwner` |
| `POST /interventions/:id/claim` | `{ "operatorId" }` | `waiting → human_control`; enables the recorder and human-permitted submissions |
| `POST /interventions/:id/resume` | `{ "operatorId", "action": "retry_step" \| "skip_step" \| "abort", "note"? }` | Validated resume; the note is for the console, never evidence |

Every route needs `Authorization: Bearer $HITL_TOKEN` (constant-time compare). Bodies are JSON
only, at most 4 KiB, strict shape; anything else is `400 INVALID_BODY` without touching state.

## State Machine

```text
waiting ──claim──▶ human_control ──resume──▶ validating ──accepted──▶ resumed
                        ▲                         │
                        └──────── rejected ───────┘
(any open state) ──abort──▶ aborted        (budget elapsed / browser lost) ──▶ expired
```

Implemented in `src/hitl/interventions.ts` (`InterventionBroker`) and driven by
`src/replay/engine.ts`:

- **Ownership is explicit.** `controlOwner ∈ { automation, human, none }`. The engine's
  `health()` check, which runs before every browser operation, throws `CONTROL_NOT_OWNED` unless
  automation owns the browser, and the engine blocks on the intervention promise while it does
  not. A claim while `human_control` → `409 ALREADY_CLAIMED`; a resume from anyone but the
  claimant → `409 NOT_OWNER`; a resume during validation → `409 VALIDATION_IN_PROGRESS`;
  anything after close → `409 INTERVENTION_CLOSED`.
- **Quiescence.** Handoff only opens between actions, from the detector path, never with a
  dispatch in flight. An in-flight action that was already sent cannot be cancelled by an
  ownership flag, so the engine never hands off in that window.
- **Budgets.** The automation clock (`limits.runTimeoutMs`) pauses while a human owns the
  browser; the surface keeps a hard cap of `runTimeoutMs + maxWaitMs`. If nobody resumes within
  `--hitl-wait-ms` the run ends `NEEDS_HUMAN { interventionId, reason }`. A watchdog also closes
  the intervention if the operator closes the window or trips a policy violation.

## Trigger

An unknown dialog (`UNEXPECTED_DIALOG`) detected on a page whose surface is still healthy. That
is the only trigger today. Native `window.confirm`-style dialogs still make the surface fatal and
cannot be handed off; the mock's `unexpected_confirm` fault is an HTML interruption page. An
exhausted safe recovery, a blocked risky step, and discovery's `request_human` remain terminal
(`RECOVERY_EXHAUSTED`, `POLICY_BLOCKED`, `HUMAN_REQUIRED`) and are documented as future triggers.

## Resume Semantics

The engine validates the requested action **while the human still owns the browser**, against
the live page, and a rejection leaves them in control rather than guessing:

| Action | Accepted only if | Then |
| --- | --- | --- |
| `retry_step` | no unknown dialog remains; the paused step is `read_only` (`UNSAFE_RETRY` otherwise) | Partial outputs are cleared and the read-only flow restarts at its entry navigation, so identity checks and checkpoints re-run in the human's repaired session |
| `skip_step` | no unknown dialog remains; the step has a declared postcondition (or wait condition) and it holds right now (`SKIP_NOT_PROVABLE`, `POSTCONDITION_NOT_MET`) | The step is marked `step_finished outcome=human` and automation continues with the next step |
| `abort` | always | `FAILURE / ABORTED_BY_OPERATOR`; audit history is kept |

`skip_step` is never accepted for an `extract` step: the page cannot prove a value was read, and
a human cannot type an output in. A retry is never a re-dispatch of a possibly completed write;
in this prototype every replayable step is read-only, so restart-at-entry is the safe form.

## Human Handoff Is Not A Bypass

The operator's browser still goes through the same policy proxy with the same one-use POST
grants. `policy.yaml` gained a `humanActions` section:

```yaml
humanActions:
  - { action: click, path: /notice, targetKey: operator_notice_acknowledge, risk: reversible }
```

While a human owns the browser, an init script (installed at the context, so it survives
navigation) intercepts every form submission, tags the actual submitter with a one-time marker,
and asks the trusted side. `PlaywrightAdapter.humanSubmit` classifies the node with the same
trusted profile automation uses, calls `authorizeHumanAction`, and only then issues a grant for
exactly that destination and form body before re-issuing the submission natively. An unlisted
submission (for example `sign_in`) is prevented, recorded as `human_action submit … blocked`,
and never reaches the network. GET navigation remains governed by `requests`. `humanActions`
accepts `read_only`/`reversible` only; irreversible operations cannot be authorized by anyone.

## Recording What The Human Did

The recorder captures `click` and `submit` events across frames and navigations while, and only
while, a human owns control. Each record is `{ action, targetKey?, outcome, path, at }` where
`targetKey` is the trusted classification (or absent) and `path` is the canonical route. Typed
values, URLs, element text, and the operator's note are never captured. The records live in the
run's `events.jsonl` (`human_action`) and in `intervention_N.json`, which also carries every
state transition with its rejection code. Both pass through the evidence sink's schema and
redaction like every other artifact.

## Limits

- Local, trusted operator only. No remote access, authentication beyond the per-run token, or
  co-browsing. Bind address is loopback and not configurable.
- Native browser dialogs, browser chrome, DevTools, and OS-level activity are neither recorded
  nor controllable; a native dialog remains fatal.
- Recording is at the DOM event level: a click is recorded once at capture time, keyboard-only
  interactions other than form submission are not recorded, and there are no screenshots.
- One open intervention per run; one broker per run; the token is printed once and never stored.
- `retry_step` restarts at entry rather than resuming mid-flow. That is the correct choice for
  read-only flows and the only kind this prototype replays; a write-capable flow would need
  step-level idempotency proofs the schema does not yet express.
