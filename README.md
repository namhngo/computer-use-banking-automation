# Computer-Use Banking Automation

A take-home prototype for LLM-driven UI discovery followed by deterministic capability replay.
The implementation is deliberately incremental and targets one synthetic local web app.

## Current Status

Phases 0-2 provide tooling, the local Harbor banking sandbox, typed capability/result contracts,
input binding, a filesystem capability registry, and pure policy authorization decisions.
Verified on Node 22.22.1: lint, strict typechecking, 484 unit/contract/HTTP/CLI tests, and 13 browser tests pass.
The agent, artifact compiler, replay engine, browser policy enforcement, and human handoff
are **not implemented yet**. The authored example and browser tests are not LLM discovery evidence.

See [the proposal](docs/PROPOSAL.md) for the architecture, review decisions, and phase gates.
See [the implemented contract guide](docs/CONTRACTS.md) for exact Phase 2 semantics.
Phase 3 connects the contracts to Playwright, actual policy enforcement, and deterministic replay.

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
This is a safe test target for the future policy engine, not an implementation of that engine:
automation must eventually block a prohibited action before invoking it.

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
preserves the same session and does not modify financial data. Actual automation-to-human
control transfer will be implemented in Phase 6. A fresh session must acknowledge notices again.
Expiry and slowness fire once per sandbox run/reset, not once per member or login.

### Test Harness Reset

`createMockApp({ credentials })` in `mock-app/app.ts` returns `{ app, reset }`. Tests inject
their own explicit synthetic credentials and never load the local `.env`. They call `reset()` to restore
the startup fault, or `reset('none')` to choose a clean scenario. Reset clears sessions, rearms
one-shot faults, and invalidates requests started before reset. Member fixtures are immutable.
Each test/run gets its own instance; this is not a concurrent multi-tenant test server.

There is intentionally **no HTTP reset endpoint and no JSON member-data API**. The agent will
receive only UI tools, not the factory/reset hook or direct fixture access. A future verification
runner can reset through this harness and create a fresh browser context; human handoff must
instead keep its existing live browser session.

## Configuration

Checks run without `.env`; starting the mock app requires its credential variables.
`.env.example` documents the settings:

| Variable | Default | Accepted values |
|---|---|---|
| `TARGET_URL` | `http://localhost:4000/` | HTTP URL on `localhost`, `127.0.0.1`, or `[::1]`, without credentials/query/fragment |
| `HEADLESS` | `true` | Exactly `true` or `false` |
| `MOCK_USERNAME` | None; required for server | Nonblank local operator ID, up to 100 characters |
| `MOCK_PASSWORD` | None; required for server | Local-only password, 8-200 characters, not all whitespace |

`pnpm config:check` and `pnpm mock-app` load `.env` if present; existing shell variables take
precedence. `config:check` validates the automation settings only; the mock server validates
its credentials on startup. No command prints the configured username or password.
The browser tests ignore these settings and always run headless with isolated test targets.
The standalone smoke test runs offline. `mock-app` uses `--port` and `--fault` for its scenario;
`TARGET_URL` describes the future automation target, not the server's bind address.
No model/provider credentials are read yet. `policy.yaml` now has validated deny-by-default
request and action rules for the two explicit loopback origins. The policy library can make
authorization decisions, but no replay/discovery engine enforces them in a browser yet.
The mock server still has its own local-only protections; those are a separate boundary.

Dependencies are pinned exactly with a committed lockfile. TypeScript 5.9.3 stays within the
supported range of the pinned TypeScript ESLint parser; the latest compiler is not assumed
compatible. pnpm's release-age checks are strict, and only esbuild's required install script
is allowed. AI SDK/provider packages will be selected and installed in Phase 4, not unused now.

## Data Handling

- Use synthetic member data only. Never add real credentials or financial/PII records.
- `.env` files, generated `artifacts/`, browser state, and raw traces/videos are ignored.
- Local mock credentials stay in `.env`; `.env.example` contains empty fields only. Public
  test credentials are injected by tests and are not fallback credentials for the running app.
- Future run outputs go into `artifacts/`, not directly into committed `evidence/`.
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
eligibility requires verified metadata, which the future verification workflow must substantiate.
Registry revisions cannot be overwritten, even for a status change. Generated artifacts belong
under ignored `artifacts/capabilities/`; reviewed submission evidence remains a separate step.

Policy action identities must come from a trusted adapter after locating a real control, not
from a model-supplied key or risk label. The current policy denies sub-account creation and
unknown-notice acknowledgment even though both notice types share the same POST route.

For details, supported limits, and Phase 3 responsibilities, see [CONTRACTS.md](docs/CONTRACTS.md).

## Planned Demo

These automation commands are planned, **not implemented yet**:

```bash
pnpm agent --goal "look up member 12345 and read their current savings balance"
pnpm discover --goal "look up member 12345 and read their current savings balance" --target http://localhost:4000
pnpm replay get_member_savings_balance --input memberId=67890
```

The default agent entrypoint will choose an existing compatible capability or discover one.
Direct replay remains model-free and independently testable. A successful cold discovery
will not trigger another execution after sandbox verification. Actual live discovery evidence
and the assignment's `REPORT.md` will be added when those phases are implemented.
