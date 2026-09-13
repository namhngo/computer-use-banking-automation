# Phase 4: Bounded LLM Discovery

Phase 4 lets a tool-calling model choose the next UI action from fresh, redacted observations of
the real browser. The engine, not the model, authorizes and dispatches every action through the
same guarded surface and network boundary that Phase 3 replay uses. Compilation of a discovery
transcript into a replayable artifact is Phase 5 ([COMPILE.md](COMPILE.md)); replay-time human
handoff is Phase 6 ([HITL.md](HITL.md)). Discovery's own `request_human` still ends the run with
`HUMAN_REQUIRED` rather than pausing: the discovery loop is not wired to the handoff broker.

## Status

The loop, OpenAI client, sanitized transcript, and CLI are implemented. Offline tests drive them
with explicitly test-only models against the real mock app in a real Chromium session; those
runs are recorded with `source: "test"` and are not presented as discovery evidence.

The Phase 4 gate is met: reviewed live `gpt-4.1` runs (a 9-turn success and a 3-turn not-found
business outcome) are in [evidence/discovery-phase4](../evidence/discovery-phase4/README.md).
The first live attempt exposed a contract bug — success claims required `ref: null` through a
Zod refinement invisible in the JSON Schema the model receives, and the model naturally attached
the evidence ref — which was fixed by ignoring the ref on success rather than by prompting.

## Run Discovery

Set the mock credentials, `OPENAI_API_KEY`, and optionally `DISCOVERY_MODEL` in `.env`, then:

```bash
pnpm discover --goal "look up member 12345 and read their current savings balance" --sandbox
```

`--sandbox` starts a fresh mock instance on an ephemeral loopback port and a fresh browser, and
closes both afterward; `pnpm mock-app` is not needed. Alternatively point at a running instance:

```bash
pnpm discover --goal "look up member 12345 and read their current savings balance" \
  --target http://localhost:4000/
```

`--target` must be an `http://` loopback origin with no path, query, fragment, or credentials.
`--fault <name>` is accepted only with `--sandbox`. Flags cannot be repeated.

| Flag | Default | Bound |
|---|---|---|
| `--max-steps` | 25 | 1-50 model action turns |
| `--max-duration-ms` | 180000 | 1-300000 for the whole run, including model calls |
| `--model-timeout-ms` | 30000 | 1-60000 per model call |
| `--max-tokens` | 40000 | 1-200000 input plus output tokens across all calls |
| `--policy` | `policy.yaml` | Trusted local path |
| `--evidence-root` | `artifacts/runs` | Trusted local path |

The command prints one JSON result line on stdout and exits 0 for `SUCCESS` and
`BUSINESS_OUTCOME`, otherwise 1. A success looks like:

```json
{ "kind": "SUCCESS", "runId": "run_...", "code": "COMPLETED", "source": "live", "turns": 8,
  "usage": { "inputTokens": 12345, "outputTokens": 210 }, "usageComplete": true,
  "evidence": ["events.jsonl", "discovery.json"],
  "outputs": { "savingsBalanceCents": 123456, "currency": "USD" } }
```

`usage` is the sum of provider-reported tokens. `usageComplete` is false when any call failed
without a usable receipt, so a zero never masquerades as a confirmed free call. Business outputs
appear only on stdout, never in evidence files.

### Result Kinds

| Kind | Codes | Meaning |
|---|---|---|
| `SUCCESS` | `COMPLETED` | All four reads verified for the declared member |
| `BUSINESS_OUTCOME` | `MEMBER_NOT_FOUND`, `INVALID_MEMBER_ID` | Verified against the live alert after an actual search for the declared member |
| `CLARIFICATION_REQUIRED` | same | Intent needs a member ID, or the goal's five-digit ID is absent, duplicated, or disagrees with intent |
| `UNSUPPORTED_GOAL` | same | Intent is not the supported read-only balance family |
| `BLOCKED` | `POLICY_BLOCKED`, `UNEXPECTED_DIALOG`, `SESSION_REQUIRED`, `HUMAN_REQUIRED`, `TOKEN_LIMIT`, `STEP_LIMIT`, `DEAD_END` | Stopped by policy, an unknown notice, session loss, a human request, or a budget |
| `FAILURE` | `MODEL_ERROR`, `MODEL_TIMEOUT`, `RUN_TIMEOUT`, `SURFACE_TIMEOUT`, `INVALID_DECISION`, `EVIDENCE_ERROR`, `TRANSCRIPT_UNSAFE`, `TRANSCRIPT_WRITE_FAILED`, `UNSAFE_GOAL`, `CONTEXT_LIMIT`, `RESOURCE_CLOSE_FAILED`, `INVALID_OPTIONS`, surface codes | Engine, model, evidence, or browser failure |
| `FAILURE` (CLI setup) | `CLI_INVALID`, `CONFIG_ERROR`, `MODEL_NOT_CONFIGURED` | Rejected before any browser or provider call; no evidence directory is created |

`SESSION_REQUIRED` is deliberately blocking: discovery does not re-login. Reauthentication is a
replay recovery with a declared entry step, not something a model should improvise mid-discovery.
`UNEXPECTED_DIALOG` is detected before the model is asked, so no decision is solicited through an
unknown notice. `DEAD_END` fires after three identical decisions against an unchanged observation.

## Execution Path

```text
goal
  -> reject goals containing known secrets (no provider call)
  -> intent call: ready / clarify / unsupported, declared memberId
  -> the goal must contain exactly one five-digit ID equal to the declared memberId
  -> create private evidence, browser, and enforced network boundary; authenticate
  -> loop (bounded by steps, tokens, duration, and repetition):
       unknown dialog?  -> BLOCKED
       observe          -> redact -> model.decide -> strict tool parse
       capture ref      -> trusted classify -> authorize -> dispatch -> record receipt
       complete         -> re-resolve every read under one consistent document state
  -> write events, structural snapshot on non-success, sanitized transcript
  -> close owned resources; a failed or hung close fails the run
```

`src/discovery/engine.ts` owns this loop. `src/discovery/model.ts` owns the OpenAI client.
`src/discovery/harbor-goal.ts` holds the acceptance criteria for the one supported goal family.
`src/discovery/transcript.ts` writes the sanitized transcript. `src/discovery/privacy.ts`
implements known-value redaction.

## Model Tools And Context

The model receives the goal, `inputs: { memberId }`, the current observation, the last five
action results, and which fields have been extracted. Each observed control exposes a ref, tag,
label, text, frame path, enabled state, input type, same-origin href, select options, `main` or
`frame` scope, and table row/column labels where relevant. It does **not** receive selectors,
resolution strategies, trusted control identities, form values, credentials, source code,
fixtures, or the example artifact. Any string containing a known secret is replaced whole by
`[REDACTED]`. Contexts over 60,000 characters stop the run with `CONTEXT_LIMIT`.

| Tool | Input | Engine enforcement |
|---|---|---|
| `fill` | `ref`, `input: "memberId"` | Only the declared input; the ref must classify as the member ID field or `FIELD_MISMATCH` |
| `click` | `ref` | Ref must classify to a permitted control or `POLICY_BLOCKED`; Search requires the form's live `memberId` value to equal the declared member or `WRONG_MEMBER` |
| `extract` | `ref`, `field` | Ref must classify as that field for the declared member's route; identity reads must equal the declared ID |
| `navigate` | `path` | Only the current path or an href present in a fresh observation, else `UNOBSERVED_NAVIGATION` |
| `wait` | `ms` 50-1000 | Bounded pause |
| `complete` | `outcome`, `ref` | Success is judged only on recorded extracts (`memberId` in main and frame plus balance and currency in frame, all re-read under one document state); any ref on a success claim is ignored. Business outcomes need the ref of a live `alert` on the search page after an actual submission |
| `request_human` | `code` | Returns `HUMAN_REQUIRED`; no intervention or session handoff is faked |

Every action first captures the live element, classifies it with the trusted Harbor profile, and
checks the ref is still the same node. Model-supplied `targetKey`, literal fill values, extra
input fields, and unknown tools are schema rejections. A rejected or failed dispatch is recorded
with its code but never with a target, so the transcript cannot suggest it happened. Any
successful fill, click, or navigate clears prior extracted evidence.

## Model Client

`readDiscoveryModel()` requires `OPENAI_API_KEY` and accepts `DISCOVERY_MODEL` from the
`gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano` family (including `-2025-04-14` snapshots). Calls use
the OpenAI Responses API through the Vercel AI SDK with `toolChoice` required, a single step,
temperature 0, 512 output tokens, no SDK retries, `store: false`, parallel tool calls disabled,
telemetry off, and no request/response bodies attached to results.

A per-call fetch wrapper reads the wire `status`, `usage`, `model`, and `id` before the SDK
normalizes them, so a failed or incomplete response still yields a usage receipt where one exists.
Provider errors are never rethrown with their original message or cause; only a sanitized
`ModelCallError` with the receipt escapes. Model and response IDs are checked against known
secrets and a conservative character set before they are recorded.

## Evidence

Runs write to ignored `artifacts/runs/<runId>/` with private permissions:

- `events.jsonl`: discovery lifecycle events (`discovery_started`, `model_call`,
  `surface_starting`, `decision_selected`, `decision_finished`, `discovery_finished`) plus the
  surface, policy, and network events shared with replay. No goal text, UI text, or outputs.
- `snapshot_N.json`: structural DOM snapshot on any non-success outcome, as in replay.
- `discovery.json`: the sanitized transcript. `calls` lists each model call's turn, phase,
  configured and returned model ID, response ID, usage, and status. `records` lists each
  decision's tool, reason, status, code, and, for confirmed dispatches only, the captured
  target, trusted `targetKey`, and paths.

Before writing, member routes are canonicalized to `/members/:memberId`, literal member values
in targets become `{ "source": "input", "name": "memberId" }`, and every string is checked
against credentials, the provider key, the goal's member ID, and values read from the UI. A
transcript that fails these checks is not written and the run reports `TRANSCRIPT_UNSAFE`.

The transcript is the input to `pnpm compile` (see [COMPILE.md](COMPILE.md)), not a capability
artifact. It does not grant replay eligibility and is not registered. Business-outcome `complete`
records carry the claimed `outcome` so the compiler can emit an `observed` handler without
inferring it from UI text.

## Limits

- One goal family (`member_savings_balance`), one input (`memberId`), one origin, HTTP only.
- Observations are capped at 10 frames and 200 controls; `truncated` tells the model so.
- Three consecutive retryable errors, or three repeated decisions, stop the run.
- The Harbor profile still supplies control identities and acceptance criteria. Supporting
  another app means writing its reviewed profile and goal checks, not only a new prompt.
- No vision, desktop control, or physical input events. No writes; the policy denies them and
  the acceptance checks cannot be satisfied by anything except reads.
