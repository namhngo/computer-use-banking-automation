# Computer-Use Banking Automation

An LLM learns how to operate a legacy-style banking UI once; that run is compiled into a typed,
versioned capability artifact; and every later invocation is deterministic, model-free replay
under a policy the model cannot bypass. When automation gets stuck, it hands the very same
browser to a person and resumes only after validating what they did.

Nothing in the code is about a particular goal. The model declares what it is looking for as a
contract (inputs that identify the record, outputs to read, their parsers); acceptance, the
artifact, and the router all derive from that declaration. Risk is decided by what an action
structurally does in the page (read text, follow a link, submit a listed form), measured on the
live DOM and judged by `policy.yaml`. The live evidence learns two different reads —
savings balance, then checking balance — from the same loop with no code change in between.

- **[REPORT.md](REPORT.md)** — the design write-up.
- **[evidence/](evidence/README.md)** — real `gpt-4.1` runs: two goals discovered, compiled and
  verified; model-free replays; failures and refusals; a same-browser handoff during discovery.
- Verified on Node 22.22.1: lint, strict typechecking, **794** unit/contract/CLI tests and
  **174** real-browser tests pass with no model key (`pnpm check`).

## Setup

Node.js 22.13+ (`.nvmrc` pins 22.22.1) and pnpm 11.13.0 (`corepack enable`, or
`npm install --global pnpm@11.13.0`).

```bash
pnpm install --frozen-lockfile
pnpm browser:install            # Chromium for the pinned Playwright; on Linux add --with-deps
cp .env.example .env            # set MOCK_USERNAME / MOCK_PASSWORD (local-only, 8+ chars)
pnpm check                      # lint + typecheck + unit + browser tests, no model key needed
```

**Keys.** Only `pnpm discover` and `pnpm agent` read `OPENAI_API_KEY` from `.env`, and only for
the model calls themselves. Replay, compile, verification, handoff and the whole test suite make
no provider calls. Without a key those two commands fail closed with `MODEL_NOT_CONFIGURED`.

## Demo path

Every command below owns a fresh sandbox and Chromium session through `--sandbox`; you do not
need to start `pnpm mock-app` first (`--target http://localhost:4000/` uses a running one).

```bash
# 1. Run the agent on a goal. Empty catalog -> live gpt-4.1 discovery -> compile -> verify in two
#    fresh sandboxes -> answer. Prints DISCOVERED with outputs { savings_balance: 123456 } and the
#    verified capability get_member_savings_balance v2.
pnpm agent --goal "What is the current savings balance for member 12345?" --sandbox --verify-inputs 67890

# 2. Replay the resulting artifact. No model: the router sees the verified capability and executes it.
pnpm agent --goal "What is the current savings balance for member 67890?" --sandbox
#    or directly, still model-free:
pnpm replay get_member_savings_balance --version 2 --inputs '{"member_id":"67890"}' --sandbox

# 3. A different read, same loop, no new code: discovers get_member_checking_balance.
pnpm agent --goal "How much does member 12345 have in their checking account?" --sandbox --verify-inputs 67890

# 4. Error states and refusals.
pnpm replay get_member_savings_balance --version 2 --inputs '{"member_id":"12345"}' --sandbox --fault permission_denied
pnpm agent --goal "Transfer 50 dollars from member 12345 savings to checking" --sandbox   # UNSUPPORTED_GOAL
pnpm agent --goal "What is the savings balance?" --sandbox                               # CLARIFICATION_REQUIRED

# 5. Human handoff is part of every run, not a mode. The sandbox raises an unfamiliar notice after
#    sign-in; the run pauses with the Chromium window open, prints claim/resume curl commands on
#    stderr, and continues after you acknowledge the notice and resume. (--unattended, or
#    HEADLESS=true, turns this off: the same condition then ends the run with evidence.)
pnpm agent --goal "What is the current savings balance for member 12345?" --sandbox --fault unexpected_confirm

# Without a model key: replay the hand-written draft, including an authored session recovery.
pnpm replay --artifact examples/get-member-savings-balance.json --inputs '{"memberId":"12345"}' --sandbox --mode verification --fault session_expired
```

Every run writes private evidence to `artifacts/runs/<runId>/` (`events.jsonl`, structural DOM
snapshots on failure, the sanitized discovery transcript, intervention records). Business
outputs are printed on stdout and never written to evidence.

## How the requirements are met

| Requirement | Implementation | Evidence |
|---|---|---|
| Goal-driven agent loop | `src/discovery/engine.ts`: one strict tool call per turn; `src/discovery/acceptance.ts` proves a claim from the declared contract | `evidence/agent/cold-*`, `evidence/hitl/discovery-handoff` |
| Structured artifact | `src/artifact/schema.ts`; compiled from the transcript's contract by `src/compiler/compile.ts`; verified by `src/compiler/verify.ts` | `evidence/capabilities`, `evidence/compile` |
| Deterministic replay | `src/replay/engine.ts`; result contract `src/artifact/result.ts` | `evidence/agent/warm-*`, `evidence/replay` |
| Safety and policy | `policy.yaml`, `src/policy/policy.ts`, `src/surface/effects.ts`, `src/surface/network.ts` | `evidence/agent/denied`, `evidence/agent/unsupported`, `tests/browser/adapter.test.ts` |
| Evidence and observability | `src/evidence/evidence.ts`: structural `events.jsonl`, redacted DOM snapshots, transcripts | every run directory |
| Human-in-the-loop | `src/hitl/`: broker, loopback operator API, same headed browser; wired into discovery and replay | `evidence/hitl`, `tests/browser/hitl.test.ts` |
| Heterogeneity and tenancy | `PlaywrightAdapter` behind a narrow surface; the app profile is `policy.yaml` data | [REPORT.md](REPORT.md) |

Deeper docs: [policy](docs/POLICY.md), [discovery](docs/DISCOVERY.md), [compile](docs/COMPILE.md),
[replay](docs/REPLAY.md), [handoff](docs/HITL.md), [router](docs/ROUTER.md),
[contracts](docs/CONTRACTS.md), and the original [proposal](docs/PROPOSAL.md).

## Commands

| Command | Purpose |
|---|---|
| `pnpm agent --goal "..."` | Goal-driven entrypoint: execute a verified capability, or discover, compile and verify a new one |
| `pnpm discover --goal "..."` | Discovery alone; prints the run ID for `pnpm compile` |
| `pnpm compile --run <runId> [--outcome-run <runId>] [--verify --sandbox --verify-inputs ...]` | Compile a transcript into a draft; optionally verify and publish |
| `pnpm replay <name> --version N --inputs '{...}'` / `--artifact <file>` | Model-free replay; `--fault` (sandbox only) |
| `pnpm mock-app [--port 4000] [--fault <name>]` | Run the sandbox standalone |
| `pnpm check` | `lint`, `typecheck`, `test` (unit/HTTP/CLI) and `test:browser` |

Common flags: `--sandbox`, `--target <http loopback URL>`, `--policy policy.yaml`,
`--registry artifacts/capabilities`, `--evidence-root artifacts/runs`. Discovery budgets:
`--max-steps`, `--max-duration-ms`, `--model-timeout-ms`, `--max-tokens`. Attendance:
`agent`, `discover` and `replay` are attended by default (visible browser, operator console on
`--hitl-port`, pause up to `--hitl-wait-ms`); `--unattended` or `HEADLESS=true` runs headless
with no console.

## The sandbox

"Harbor Core" is an owned server-rendered credit-union servicing app: sign in → member search →
member detail, with the accounts table inside an iframe, no test IDs, a deliberately present
"Open sub-account" form that the policy never lists, and injectable faults.

| Member ID | Name | Savings | Checking |
|---|---|---|---|
| `12345` | Avery Sample | $1,234.56 | $250.00 |
| `67890` | Morgan Demo | $9,876.54 | $80.00 |
| `99999` | does not exist | "No member found" | |

| `--fault` | Behaviour |
|---|---|
| `member_not_found` / `validation_error` | Search shows a business message instead of a result |
| `session_expired` / `slow_load` | First search revokes the session / takes 3 s (once per instance) |
| `interstitial` | A known "System notice" dialog automation may acknowledge (`policy.yaml › knownDialogs`) |
| `unexpected_confirm` | An unfamiliar dialog: automation hands the browser to a person (or stops with evidence when unattended) |
| `permission_denied` / `app_error` | Member detail returns 403 / the accounts iframe returns 500 |

Sessions expire after 15 minutes; the server binds to IPv4 loopback only. Tests use
`createMockApp({ credentials })` with their own synthetic credentials and never read `.env`.

## Configuration and data handling

`.env` (never committed): `MOCK_USERNAME`, `MOCK_PASSWORD` (required to run the sandbox),
`OPENAI_API_KEY` (discover/agent only), `DISCOVERY_MODEL` (`gpt-4.1`, `-mini`, `-nano`),
`TARGET_URL` (default `http://localhost:4000/`), `HEADLESS` (unset or `false` = attended runs
with a visible browser; `true` = unattended). `pnpm config:check` validates without printing values.

Synthetic data only. The model receives redacted UI observations, the goal and its own declared
contract; never credentials, selectors, form values, source or fixtures. Input values, outputs,
credentials and the provider key are redacted from every evidence file; identifiers in paths are
spelled `:id`; a transcript that would leak is refused rather than written. Publish only
reviewed runs under `evidence/`.
