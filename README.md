# Computer-Use Banking Automation

A take-home prototype for LLM-driven UI discovery followed by deterministic capability replay.
The implementation is deliberately incremental and targets one synthetic local web app.

## Current Status

Phases 0-3 provide the local Harbor sandbox, typed capability contracts, registry, and working
model-free replay through Playwright with browser/network policy enforcement and private evidence.
Phase 4 adds a bounded discovery loop in which an OpenAI tool-calling model chooses actions from
redacted live observations while the engine classifies, authorizes, and dispatches each one.
Phase 5 compiles the resulting transcript into a draft artifact and verifies it by model-free
replay in fresh sandboxes before publishing a verified revision.
Phase 6 adds same-session human handoff: replay pauses on an unknown dialog, an operator claims
the very same headed browser through a loopback API, their actions are recorded in sanitized
form and still bound by policy, and automation resumes only after validating the resume.
Phase 7 adds the goal-driven entrypoint `pnpm agent --goal`: one structured model call routes a
goal to a verified capability (model-free replay), to discovery followed by compile and
fresh-sandbox verification, to a clarifying question, or to a refusal.
Verified on Node 22.22.1: lint, strict typechecking, 795 unit/contract/HTTP/CLI tests, and 172 browser tests pass.

Genuine live `gpt-4.1` discovery runs (success and not-found) are reviewed and published in
[evidence/discovery-phase4](evidence/discovery-phase4/README.md). Phase 5 compiles that live
transcript into a capability artifact, verifies it by model-free replay with two members in fresh
sandboxes, and publishes a verified revision that the production replay path then executes; see
[evidence/compile-phase5](evidence/compile-phase5/README.md). Offline tests drive the same
loops with explicitly test-only models (`source: "test"`). Real attended and unattended handoff
runs are in [evidence/hitl-phase6](evidence/hitl-phase6/README.md). Real live-router runs —
cold discover→compile→verify, warm replay, clarify, refuse, and a policy denial that was not
routed around — are in [evidence/agent-phase7](evidence/agent-phase7/README.md). The
assignment's `REPORT.md` is the remaining deliverable.

See [the proposal](docs/PROPOSAL.md) for the architecture, review decisions, and phase gates.
See [the contract guide](docs/CONTRACTS.md), [the replay guide](docs/REPLAY.md),
[the discovery guide](docs/DISCOVERY.md), [the compile guide](docs/COMPILE.md),
[the handoff guide](docs/HITL.md), and [the router guide](docs/ROUTER.md) for implemented
semantics and limitations.

## Setup

Use Node.js 22.13+ within the 22.x line (`.nvmrc` pins 22.22.1) and pnpm 11.13.0.
With Corepack available, `corepack enable` enables the package manager pinned in `package.json`.
Alternatively, install the exact version with `npm install --global pnpm@11.13.0`.

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm config:check
pnpm check
```

On Linux, install browser system dependencies if needed:

```bash
pnpm exec playwright install --with-deps chromium
```

Dependency and browser installation require internet access. After installation, checks run
without model keys or external services. Tests start and stop their own loopback servers on
temporary ports; there is no need to run `pnpm mock-app` first. No screenshots, videos, traces,
credentials, or browser storage are persisted by the tests.

## Commands

| Command | Purpose |
|---|---|
| `pnpm mock-app` | Start the local banking sandbox at `http://127.0.0.1:4000` |
| `pnpm agent --goal "..."` | Goal-driven entrypoint: routes to replay, discovery+verification, clarification, or refusal; requires `OPENAI_API_KEY` for the one routing call; see the agent demo below |
| `pnpm replay ...` | Execute a saved artifact without a model; `--hitl` enables same-session human handoff; see the demos below |
| `pnpm discover ...` | Bounded live-model discovery of the balance goal; requires `OPENAI_API_KEY`; see the discovery demo below |
| `pnpm compile ...` | Compile a discovery transcript into a draft artifact and optionally verify it in fresh sandboxes; no model |
| `pnpm lint` | ESLint with type-aware TypeScript rules and no warnings |
| `pnpm typecheck` | Strict TypeScript checking without emitting files |
| `pnpm test` | Artifact, binding, result, registry, policy, configuration, HTTP, and CLI tests; browser not required |
| `pnpm test:browser` | Chromium smoke test and real banking UI flows, including mobile and iframe failures |
| `pnpm browser:install` | Install the Chromium build matching the pinned Playwright version |
| `pnpm config:check` | Validate optional `.env` configuration without printing values |
| `pnpm check` | Lint, typecheck, unit/HTTP/CLI tests, and browser tests |

## Local Banking Target

```bash
pnpm mock-app
```

Before starting the server, set `MOCK_USERNAME` and `MOCK_PASSWORD` in your ignored `.env`
file (the variable names are documented in `.env.example`). Use local-only credentials;
the password must be at least 8 characters. There are no built-in login defaults, and missing
or invalid credentials prevent startup. Neither the UI nor startup logs display them.

Open `http://127.0.0.1:4000` and sign in with those configured values. Search by Member ID,
click **View member**, then read the **Savings** row in the account iframe.

| Member ID | Synthetic name | Savings | Checking |
|---|---|---|---|
| `12345` | Avery Sample | $1,234.56 | $250.00 |
| `67890` | Morgan Demo | $9,876.54 | $80.00 |
| `99999` | Does not exist | Search returns "No member found" | |

The target uses server-rendered forms with full-page submissions, table-based account views,
and an iframe rather than a client framework or test IDs. Account pages also enforce the demo
session, including direct iframe navigation. Sessions expire after 15 minutes.

**Open sub-account** is deliberately present but always returns 403 without changing data.
This is a safe test target. The replay adapter independently blocks the prohibited action
before dispatch; tests verify that no sub-account request reaches the server.

Use `--port` to run on a different port. Stop with Ctrl+C; active connections are closed.
Restarting clears sessions and resets the selected scenario. The server binds only to IPv4
loopback and rejects nonlocal request hostnames and cross-origin form submissions with an
Origin header. This is a trusted local sandbox, not production banking authentication.

### Fault Scenarios

Choose one fault per server run. Stop any existing instance before reusing its port:

```bash
pnpm mock-app --fault session_expired
pnpm mock-app --fault app_error --port 4001
```

| `--fault` | Observable behavior |
|---|---|
| `none` (default) | Normal flow; unknown/malformed member IDs still get normal business outcomes |
| `member_not_found` | Search always returns "No member found", even for a known member |
| `validation_error` | Search rejects valid-looking IDs with HTTP 422 and a visible validation message |
| `session_expired` | First valid search revokes the session and redirects to sign-in; re-login then succeeds |
| `slow_load` | First valid search takes 3 seconds; subsequent searches respond normally |
| `interstitial` | "System notice" interruption page must be acknowledged with **OK** |
| `unexpected_confirm` | Unfamiliar "Operator review required" interruption needs **Acknowledge notice** |
| `permission_denied` | Member detail and account panel return 403 with "Permission denied" |
| `app_error` | Member detail loads, but the account iframe returns 500 with "Account service unavailable" |

Notices are server-rendered HTML dialogs, not native browser confirmation boxes. Acknowledgment
preserves the same session and does not modify financial data. Replay dismisses the known
`interstitial` itself; `unexpected_confirm` is the handoff trigger (see the demo below).
A fresh session must acknowledge notices again.
Expiry and slowness fire once per sandbox run/reset, not once per member or login.

### Test Harness Reset

`createMockApp({ credentials })` in `mock-app/app.ts` returns `{ app, reset }`. Tests inject
their own explicit synthetic credentials and never load the local `.env`. They call `reset()` to restore
the startup fault, or `reset('none')` to choose a clean scenario. Reset clears sessions, rearms
one-shot faults, and invalidates requests started before reset. Member fixtures are immutable.
Each test/run gets its own instance; this is not a concurrent multi-tenant test server.

There is intentionally **no HTTP reset endpoint and no JSON member-data API**. The agent will
receive only UI tools, not the factory/reset hook or direct fixture access. The replay CLI's
sandbox mode creates a fresh instance and browser context; human handoff, by contrast, keeps
the existing live browser session and hands that same window to the operator.

## Configuration

Checks run without `.env`; starting the mock app requires its credential variables.
`.env.example` documents the settings:

| Variable | Default | Accepted values |
|---|---|---|
| `TARGET_URL` | `http://localhost:4000/` | HTTP URL on `localhost`, `127.0.0.1`, or `[::1]`, without credentials/query/fragment |
| `HEADLESS` | `true` | Exactly `true` or `false` |
| `MOCK_USERNAME` | None; required for server | Nonblank local operator ID, up to 100 characters |
| `MOCK_PASSWORD` | None; required for server | Local-only password, 8-200 characters, not all whitespace |
| `OPENAI_API_KEY` | None; required for `discover` only | Provider key; never printed, redacted from all evidence and model context |
| `DISCOVERY_MODEL` | `gpt-4.1` | `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, optionally with the `-2025-04-14` snapshot suffix |

`pnpm config:check`, `pnpm mock-app`, `pnpm replay`, and `pnpm discover` load `.env` if present; existing shell variables take
precedence. `config:check` validates the automation settings only; the mock server validates
its credentials on startup. No command prints the configured username or password.
The browser tests ignore these settings and always run headless with isolated test targets.
The standalone smoke test runs offline. `mock-app` uses `--port` and `--fault` for its scenario;
`TARGET_URL` supplies the standalone replay origin, not the mock server's bind address.
Only `pnpm discover` reads the provider key; without it the command fails closed with
`MODEL_NOT_CONFIGURED` and never falls back to a fake model. Tests and `pnpm check` make no
provider calls. `policy.yaml` has validated deny-by-default request and action rules for the
two explicit loopback origins. Replay and discovery enforce action grants and route Chromium
traffic through a local policy proxy, including every redirect hop and one-use
destination/body grants for POSTs. Sandbox mode permits only its newly owned origin.
The mock server still has its own local-only protections; those are a separate boundary.

Dependencies are pinned exactly with a committed lockfile. TypeScript 5.9.3 stays within the
supported range of the pinned TypeScript ESLint parser; the latest compiler is not assumed
compatible. pnpm's release-age checks are strict, and only esbuild's required install script
is allowed. The Vercel AI SDK (`ai`) and `@ai-sdk/openai` were added in Phase 4 and are the only
provider packages; there is no Anthropic or gateway configuration path.

## Data Handling

- Use synthetic member data only. Never add real credentials or financial/PII records.
- `.env` files, generated `artifacts/`, browser state, and raw traces/videos are ignored.
- Local mock credentials stay in `.env`; `.env.example` contains empty fields only. Public
  test credentials are injected by tests and are not fallback credentials for the running app.
- Run evidence goes into `artifacts/runs/`, not directly into committed `evidence/`.
- Business outputs are returned on stdout, never written into the normal evidence log. Do not
  redirect that result into public evidence without reviewing it.
- The discovery model receives only redacted UI observations, the goal, and the declared input;
  never credentials, selectors, trusted control identities, form values, source, or fixtures.
  Discovery transcripts parameterize the member ID and are refused if they contain a known
  secret or a value read from the UI.
- Publish only explicitly reviewed and sanitized examples in `evidence/`.
- Ignore rules reduce accidental commits; they are not a substitute for a secrets review.

## Capability Contracts

The [authored draft example](examples/get-member-savings-balance.json) uses the actual mock
flow, including the separate View member click and scoped account iframe. Its input is a
five-digit `memberId`; its outputs are `savingsBalanceCents` (integer cents) and `currency`.
It contains no concrete member input or login credentials and is not marked verified.

| Module | Phase 2 responsibility |
|---|---|
| `src/artifact/schema.ts` | Strict serializable schema plus cross-reference and budget validation |
| `src/artifact/bindings.ts` | Execution eligibility, exact typed inputs/outputs, symbolic references, strict money parsing |
| `src/artifact/result.ts` | Success, business outcome, failure, and human-request contracts |
| `src/artifact/registry.ts` | Immutable private revisions, atomic publication, validated load/list, known-sensitive-value rejection |
| `src/policy/policy.ts` | Strict YAML loading and separate request/action authorization decisions |

Drafts can be prepared only for explicit read-only sandbox verification. Normal replay
eligibility requires verified metadata, which `pnpm compile --verify` substantiates by publishing
a new revision after two fresh-sandbox replays succeed (`src/compiler/verify.ts`). Registry
revisions cannot be overwritten, even for a status change. Generated artifacts belong under
ignored `artifacts/capabilities/`; reviewed submission evidence remains a separate step.

Policy action identities must come from a trusted adapter after locating a real control, not
from a model-supplied key or risk label. The current policy denies sub-account creation and
unknown-notice acknowledgment even though both notice types share the same POST route.

`harbor-profile.ts` is deliberately app-specific: it recognizes permitted controls and their
effects, not the order of a task. It does not decide to search, open a result, or extract a balance.
The replay artifact supplies that order for replay; in discovery the model proposes it from live
observations and `src/discovery/harbor-goal.ts` holds the acceptance criteria that a completion
claim must satisfy. Authentication and some adapter details also remain Harbor-specific.
Supporting another app requires adapting its reviewed safety/auth profile and goal checks, not
simply pointing the current code at a different URL. The discovery loop itself in
`src/discovery/engine.ts` contains no UI recipe.

For details and supported limits, see [CONTRACTS.md](docs/CONTRACTS.md).

## Replay Demo

With mock credentials configured in `.env`, run the authored draft against a fresh sandbox:

```bash
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification
```

This starts and closes its own local target and Chromium session. It needs no model key and
no separately running mock app. Expected result: `SUCCESS`, with `savingsBalanceCents: 123456`
and `currency: "USD"`. The original draft is not overwritten or automatically approved.

```bash
# Expected business result, exit 0
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"99999"}' --sandbox --mode verification

# One bounded reauthentication, then success
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"67890"}' --sandbox --mode verification --fault session_expired

# Hard failure with a structural DOM snapshot, exit 1
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification --fault permission_denied
```

The default mode is normal `replay` and requires verified metadata; a draft needs explicit
`--sandbox --mode verification`. Registered capabilities require an exact name and `--version`.
See [REPLAY.md](docs/REPLAY.md) for flags, guarded DOM dispatch, HTTP-only scope, evidence,
and recovery behavior. Reviewed actual runs are in [evidence/replay-phase3](evidence/replay-phase3/README.md).

Without `--hitl`, unknown dialogs stop with `UNEXPECTED_DIALOG` and close the session.

## Human Handoff Demo

Trigger the unfamiliar notice and let a person clear it in the same browser window:

```bash
HEADLESS=false pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification \
  --fault unexpected_confirm --hitl
```

The run signs in, meets the "Operator review required" page, prints an intervention ID plus a
one-time `HITL_TOKEN` to stderr, and pauses. In a second terminal:

```bash
export HITL_TOKEN=...   # from the first terminal
curl -sS -X POST http://127.0.0.1:4100/interventions/$ID/claim \
  -H "Authorization: Bearer $HITL_TOKEN" -H "Content-Type: application/json" -d '{"operatorId":"you"}'
#   ... click "Acknowledge notice" in the headed Chromium window ...
curl -sS -X POST http://127.0.0.1:4100/interventions/$ID/resume \
  -H "Authorization: Bearer $HITL_TOKEN" -H "Content-Type: application/json" \
  -d '{"operatorId":"you","action":"retry_step"}'
```

Resume is refused (`409 DIALOG_STILL_PRESENT`) until the notice is really gone; a second
operator cannot claim or resume; the operator's click and the acknowledgement POST are recorded
as `human_action` events with the trusted targetKey, and only because `policy.yaml › humanActions`
lists that targetKey does the proxy let the POST through. The run then finishes with `SUCCESS`.
Leave it unattended and it ends `NEEDS_HUMAN` with a persisted `intervention_1.json`.
See [HITL.md](docs/HITL.md) and the real runs in [evidence/hitl-phase6](evidence/hitl-phase6/README.md).

## Discovery Demo

With mock credentials and `OPENAI_API_KEY` in `.env`, let the model discover the flow against a
fresh sandbox:

```bash
pnpm discover --goal "look up member 12345 and read their current savings balance" --sandbox
```

The model sees the goal, the declared `memberId`, and redacted observations of the live page,
and picks one tool per turn (`fill`, `click`, `extract`, `navigate`, `wait`, `complete`,
`request_human`). The engine classifies each chosen element with the trusted Harbor profile,
blocks anything the policy does not permit before any request is sent, and accepts a success
claim only after re-reading the member identity, savings balance, and currency for the declared
member under one consistent document state. Expected result: `SUCCESS` with
`savingsBalanceCents: 123456`, `currency: "USD"`, `source: "live"`, and token usage.

```bash
# Verified business outcome from the live alert, exit 0
pnpm discover --goal "look up member 99999 and read their current savings balance" --sandbox

# Session loss during discovery is BLOCKED / SESSION_REQUIRED, not an improvised re-login; exit 1
pnpm discover --goal "look up member 12345 and read their current savings balance" --sandbox --fault session_expired

# Against an already running mock app
pnpm discover --goal "look up member 67890 and read their current savings balance" --target http://localhost:4000/
```

Each run writes `events.jsonl`, `discovery.json` (a sanitized transcript with model calls, usage,
and confirmed action receipts), and a structural snapshot on non-success to `artifacts/runs/`.
See [DISCOVERY.md](docs/DISCOVERY.md) for flags, tools, enforcement, result codes, and limits.
The transcript is not a capability artifact; the next step compiles it.

Reviewed live runs of exactly these commands are in
[evidence/discovery-phase4](evidence/discovery-phase4/README.md). The offline tests drive the
same loop with test-only models and mark them `source: "test"`.

## Compile And Verify Demo

Turn the discovery transcript into a capability and prove it replays without the model. Use
the run IDs printed by the two `discover` commands above (success and not-found):

```bash
pnpm compile --run <success-runId> --outcome-run <not-found-runId> \
  --verify --sandbox --verify-inputs '{"memberId":"12345"}' --verify-inputs '{"memberId":"67890"}'
```

This saves an immutable draft (v1) to `artifacts/capabilities/`, replays it in `verification`
mode in a brand-new sandbox and browser for each member, and on two successes publishes v2 with
`status: "verified"`. The draft is never modified. Then the production path needs no model:

```bash
pnpm replay get_member_savings_balance --version 2 --inputs '{"memberId":"67890"}' --sandbox
#   SUCCESS, savingsBalanceCents 987654 — a member the model never saw
pnpm replay get_member_savings_balance --version 2 --inputs '{"memberId":"99999"}' --sandbox
#   BUSINESS_OUTCOME / MEMBER_NOT_FOUND via the observed outcome handler
pnpm replay get_member_savings_balance --version 1 --inputs '{"memberId":"12345"}' --sandbox
#   FAILURE / INVOCATION_INVALID — drafts are not eligible for production replay
```

Every step, locator, and postcondition in the artifact is something the model actually did or
acted on; the compiler refuses to guess (see [COMPILE.md](docs/COMPILE.md)). Reviewed copies of
the compiled artifacts and all four run logs are in [evidence/compile-phase5](evidence/compile-phase5/README.md).

## Agent Demo

The goal-driven entrypoint composes the stages above. It needs `OPENAI_API_KEY` for one routing
call (and for discovery on a cold run); the replay it delegates to is still model-free. Start
from an empty `artifacts/capabilities/` to see the cold path:

```bash
# Cold: catalog empty → discover → compile → verify in two fresh sandboxes → publish v2.
# The result is the discovery's own output; nothing executes again after verification.
pnpm agent --goal "look up member 12345 and read their current savings balance" \
  --sandbox --verify-inputs '{"memberId":"67890"}'
#   {"kind":"DISCOVERED", "routing":{"decision":"discover","catalog":[]}, "discovery":{"kind":"SUCCESS",...},
#    "compiled":{"draft":{...,"version":1},"verified":{...,"version":2},"verificationRuns":[...]}}

# Warm: catalog now lists v2 → execute → model-free replay, no discovery call.
pnpm agent --goal "look up member 67890 and read their current savings balance" --sandbox
#   {"kind":"EXECUTED", "routing":{"decision":"execute","catalog":[{"name":"get_member_savings_balance","version":2}]},
#    "result":{"kind":"SUCCESS","outputs":{"savingsBalanceCents":987654,"currency":"USD"}}}

pnpm agent --goal "read the current savings balance for one of our members" --sandbox
#   CLARIFICATION_REQUIRED / missing_member_id — no identifier is guessed, no browser starts
pnpm agent --goal "transfer 500 dollars from member 12345 savings into their checking account" --sandbox
#   UNSUPPORTED_GOAL / changes_financial_data
pnpm agent --goal "look up member 12345 and read their current savings balance" --sandbox --fault permission_denied
#   EXECUTED with a FAILURE result — the denial is reported, never routed around by rediscovery
```

Without `--sandbox` (against `pnpm mock-app` or `--target`) a cold run saves the draft but cannot
verify it, because verification needs sandboxes this process owns; the draft stays out of the
catalog. See [ROUTER.md](docs/ROUTER.md) for the decision contract and non-behaviours, and the
real runs in [evidence/agent-phase7](evidence/agent-phase7/README.md). The assignment's
`REPORT.md` is the remaining deliverable.
