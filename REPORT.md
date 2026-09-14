# Report: Computer-Use Banking Automation

An LLM learns how to operate a banking UI once; that run is compiled into a typed capability
artifact; every later invocation is deterministic, model-free replay under a policy the model
cannot bypass. Everything below is implemented and exercised unless marked *design only*. Real
runs are in [`evidence/`](evidence/README.md); `pnpm check` runs 794 unit/contract/CLI and 174
real-browser tests with no model key.

The target is "Harbor Core", an owned legacy-style mock (Hono, server-rendered): login → member
search → member detail with the accounts table in an iframe, no test IDs, a deliberately present
"Open sub-account" form, nine fault toggles. Owning the target is what made fault-injection
evidence possible; nothing here touched a real bank system, credential, or person.

The design decision that shapes everything else: **the code contains no goal and no control
identities.** An earlier version of this system hard-coded one capability's acceptance checks
(`/members/:memberId/accounts`, "Savings row under Current balance") and a per-control allow-list
naming each button on the mock. It worked for one goal and could not learn a second. The
delivered version replaces both with two general mechanisms: the model declares a *GoalSpec*
that everything downstream derives from, and policy decides risk from the *measured structural
effect* of an action. The live evidence learns the savings balance, then the checking balance,
from the same loop with no code or policy change in between.

## Architecture

The agent decides *which* capability to use; the capability decides *how* the UI is operated.
Two paths share one action pipeline but never share a decision loop:

```text
goal ─► Capability router (LLM, one structured call over the learned catalog)
          │ execute              │ discover                        │ clarify / unsupported
          ▼                      ▼                                 ▼
     Replay engine        Discovery agent (LLM loop)          return to caller
     (no model)           intent → GoalSpec; observe → decide → act; acceptance
          │                      │ compile → save draft → verify in fresh sandboxes → publish
          ▼                      ▼
     typed outputs        discovery outputs (nothing executes again)

Shared action path:  measure structural effect → policy → Playwright adapter → HTTP proxy
Shared services:     HITL broker (control ownership) · sanitized evidence sink · immutable registry
```

**Modules** (`src/`): `artifact/` (schema, bindings, result contract, registry), `policy/` (pure
decisions from `policy.yaml`), `surface/` (Playwright adapter, effect measurement, HTTP proxy),
`replay/`, `discovery/` (engine, acceptance, model client, transcript, privacy), `compiler/`
(compile, verify), `hitl/` (broker, operator API, CLI console), `agent/` (router), `evidence/`, `cli/`.

**One choke point.** Every browser action — discovery, replay, or a human mid-handoff — goes
through `PlaywrightAdapter`, which measures what the *actual* node would do
(`src/surface/effects.ts`: read text, follow a same-origin link, type into a form, submit a form
with an exact field set), asks the policy, then dispatches. The model never holds a Playwright
handle; it gets opaque node-bound refs invalidated by any navigation or new observation. A
mandatory Chromium HTTP proxy re-checks every hop including redirects, and each POST needs a
one-use grant for the exact destination and form bytes.

**The app is data.** `policy.yaml` is the only place that knows Harbor: allowed pages, forms
with their field sets and risk, how a session is opened (login path, field labels, submit
label, banner), which interstitial dialogs are benign. Adding an application is a new YAML
file ([`docs/POLICY.md`](docs/POLICY.md)). Adding a goal is nothing at all.

**Entrypoints.** `discover` → `compile` → `replay` expose each stage directly, because
determinism and fault injection must be testable with no model in the loop. `pnpm agent --goal`
composes them and is the claim on stretch goal #1: it receives the learned catalog and invokes a
capability by name with typed args (`evidence/agent/warm-*`). The router never sees the UI,
chooses locators, or plans steps; it maps *goal → capability + typed inputs*, and the
application verifies the revision exists and the inputs satisfy the artifact. It is told that
the catalog is what has been learned, not the limit of the application, so an existing
capability for a different read never blocks learning a new one (`evidence/agent/cold-checking`).

**Boundaries.** One Node process, loopback listeners, filesystem registry. No queue, DB, or
dashboard; the seams (registry, evidence sink, surface adapter) are interfaces.

## Artifact schema

The artifact (`src/artifact/schema.ts`, detail in [`docs/CONTRACTS.md`](docs/CONTRACTS.md)) is the
contract between the engine that executes it, the reviewer who approves it, and the agent that
invokes it. It is not a transcript.

```text
CapabilityArtifact (schemaVersion 1)
  identity      name, immutable revision, description, status: draft | verified
  app           appId, appVersion, surface: web, entryPath, requiresSession
  risk          read_only | reversible | irreversible (max declared business-step risk)
  inputs        named string/number/boolean fields with format, bounds, sensitive flag
  outputs       same shape; money is integer cents, never a float
  steps[]       stable IDs; navigate | click | fill | select | extract | wait; each with a
                scoped target, per-step risk, and a postcondition
  target        ordered strategies[]: role → label → text → table_cell → css, plus an
                explicit frame chain and container scope
  outcomes[]    business results (e.g. NO_MEMBER_FOUND) with detector condition and
                provenance: authored | observed(runId)
  failures[]    hard-stop UI conditions with provenance
  recoveries[]  bounded: dismiss a known notice, or reauthenticate-and-restart
  limits        step/run timeouts, per-run recovery budget
  checkpoint    identity assertions: each input read back in the document that shows the outputs
  provenance    authored | discovered(runId, model)
  verification  runId + time, required for status: verified
```

**Where the contract comes from.** The first discovery call turns the goal into a GoalSpec:
`name`, `inputs[{name, value, description}]`, `outputs[{name, parser, description, sensitive}]`.
The engine accepts it only if every input value is written literally in the goal and the name
does not embed a value. From then on the tool schemas admit only declared names, acceptance
checks are derived from it, the transcript records it (without values), and the compiler builds
`inputs`/`outputs` from it: a `digits` input becomes a sensitive string pinned to the observed
width, an output takes its declared parser and type, and an `extract` of an input name becomes an
identity `checkpoint` rather than a step. In the live runs the model named `member_id →
savings_balance` and `member_id → checking_account_balance`.

- **Values are references, never literals.** A fill is `{ source: "input", name: "member_id" }`.
  The compiler rejects transcripts embedding an input value; the registry rejects artifacts
  containing a supplied sensitive value. Verifying with a *second* record is what catches a
  hardcoded fixture the schema cannot see.
- **The error taxonomy lives in the artifact.** Replay cannot know "No member found" is a
  business outcome unless declared; outcomes carry authored vs. observed provenance, and an
  observed outcome transcript is merged only if its declared contract has the same shape.
- **Revisions are immutable, status included.** Verification publishes `v1 draft → v2 verified`;
  only `verified` + `read_only` artifacts replay normally; drafts run only in `verification`
  mode in an owned sandbox.
- **Postconditions are observed, not invented.** The compiler asserts what the model actually
  touched next after each action, plus the literal path where it was not parameterized, and
  emits no step for a rejected proposal.
- **Absent in v1 by choice:** regexes, executable expressions, URL templates, nested
  capabilities, and unimplemented target kinds (`visual`, desktop), rejected by the parser
  rather than silently ignored.

Concrete artifacts: the authored draft [`examples/get-member-savings-balance.json`](examples/get-member-savings-balance.json)
and the four the agent produced live in [`evidence/capabilities/`](evidence/capabilities/).

## Determinism & error handling

**Replay never consults a model.** `src/replay/engine.ts` validates eligibility, inputs, and app
identity, establishes entry state through permitted UI controls, then per step confirms
automation owns the browser, evaluates hard-stop/outcome/recovery detectors, resolves the scoped
target requiring *exactly one* match (ambiguity fails; `.first()` is never used), measures the
node's effect, authorizes, dispatches atomically, then re-evaluates detectors and the
postcondition. The final checkpoint re-verifies identity before outputs are parsed and typed.

**Result contract** (`src/artifact/result.ts`): `SUCCESS { outputs }`, `BUSINESS_OUTCOME { code }`
from the artifact's declared outcomes, `FAILURE { code, expected, observed }`, or
`NEEDS_HUMAN { interventionId, reason }`, each with run ID, step reached, evidence filenames, and
bounded recovery records. `parseReplayResult` independently re-validates the engine's own result;
the engine cannot return a result the artifact never authorized. "Recoverable" is an internal
event, never a result kind.

**Recovery restarts, never resumes blind.** Session expiry re-authenticates through the policy's
session block (credentials are configuration, not artifact inputs) and restarts the read-only
flow at entry with partial outputs cleared. Non-fatal action errors get one bounded detector
re-inspection; sticky policy/network/evidence/deadline failures always stop.

| Run (all real, run IDs preserved) | Result | Where |
|---|---|---|
| Agent-verified v2, member 67890 (unseen by the model) | `SUCCESS`, 987654 cents | `agent/warm-savings` |
| Agent-verified checking v2, member 12345 | `SUCCESS`, 25000 cents | `agent/warm-checking` |
| Compiled+verified v2 with observed outcome, fault `member_not_found` | `BUSINESS_OUTCOME / NO_MEMBER_FOUND` | `replay/compiled-member_not_found` |
| Same artifact, faults `permission_denied`, `session_expired` | `FAILURE / CHECKPOINT_FAILED`, no authored recovery | `replay/compiled-*` |
| Authored draft, fault `session_expired` | `SUCCESS` after one re-auth and entry restart | `replay/authored-session_expired` |
| Agent-verified v2 without an outcome yet, member 99999 | `FAILURE / CHECKPOINT_FAILED` at search, nothing guessed | `agent/not-found` |

**Discovery is bounded and audited.** Max steps, wall clock, tokens, three repeated decisions,
and three consecutive retryable errors each stop the run. Every reply is one strict-schema tool
call at temperature 0; usage and response IDs are captured at the wire. `complete` is a *claim*:
`src/discovery/acceptance.ts` requires, for every declared output, a read of that output and a
read of every declared input in the *same document or frame*, then re-resolves and re-reads all
of them under one unchanged document state and returns the re-read values. That single generic
rule is what "this balance belongs to the member you asked about" becomes when no code knows what
a member is; the browser tests swap the accounts iframe to another member's record and get
`WRONG_IDENTITY`, and submit a different identifier and get the outcome claim refused.

**Drift telemetry.** Every resolved target records which strategy index matched; consistent
fall-through past role/label is the signal for a tenant override rather than a re-record.

## Heterogeneity & multi-tenant

*Implemented:* one web surface with the extensibility seams tested, and the app profile as data.
*Design only:* desktop, visual targeting, tenant overrides.

**Surface seam.** `PlaywrightAdapter` exposes `observe`, `resolve`, `capture`, `act`,
`checkCondition`, `navigate`, `authenticate`, `snapshot`, `health`, human-control hooks and
`close`; discovery and replay use nothing else. Observations are bounded semantic views (roles,
labels, text, table row/column, frame scope), and they survive the mock's non-semantic markup
because the ladder falls through to `table_cell` and structural `css`. A `visual` kind is
reserved and rejected rather than faked. A desktop surface needs its own adapter; what carries
over is the business contract (inputs, outputs, outcomes, checkpoint), not the locators.

**Per-app profile is configuration.** `policy.yaml` names pages, forms and their field sets,
the session recipe and benign dialogs. Supporting another server-rendered application means
writing and reviewing that file. What would need a schema extension, reviewed once for
everyone: script-driven controls with no form, GET forms, client-side wizards, and reads whose
selecting input is never displayed on the page (the identity rule would have nothing to check).

**Multi-tenant reuse** (*design only*). Artifacts key on `(appId, appVersion)`, not tenant. A
tenant binds via an override document `{ tenantId, appId, artifactName, artifactVersion,
stepOverrides: { [stepId]: { target?, value?, waitFor? } }, entryUrl, extraRecoverables[] }`
merged at load time; stable step IDs make that safe. Drift detection uses recorded
`strategyIndex` and postcondition timing. Route canonicalization (`/members/12345 →
/members/:id`) already exists and would be reused for tenant `url_matches`.

## Escalation & handoff

The seam is control *ownership* ([`docs/HITL.md`](docs/HITL.md)), and it is reachable from both
places the brief names: a replay that cannot recover, and the discovery loop when the agent is
stuck.

```text
waiting → human_control → validating → resumed | aborted | expired
controlOwner ∈ { automation, human:<operatorId>, none }
```

- **Triggers.** Replay: an unknown dialog on a healthy page. Discovery: an unknown dialog
  before or after the model's decision, or the model's own `request_human`. A blocked risky
  step stays a policy denial: a person is never invited to do what automation may not.
- **Pause.** The engine opens an intervention, snapshots structure, and blocks between actions,
  never with a dispatch in flight. The automation clock pauses so a slow operator is not a
  `RUN_TIMEOUT`; a watchdog notices a closed window.
- **Same live session.** Headed browser; the operator uses the very same window, cookies, and
  page. A loopback API (`GET /interventions`, `POST …/claim`, `POST …/resume`) with a per-run
  bearer token (printed once, never stored) refuses competing claims and non-owner resumes.
  `pnpm agent --hitl` and `pnpm replay --hitl` share one console (`src/hitl/cli.ts`).
- **Recording what the human did.** A context-level init script captures clicks and
  submissions only while a human owns the browser and hands the node to the trusted side, which
  measures its effect exactly as for automation. Typed values are never recorded.
- **Handoff is not a bypass.** Operator submissions traverse the same proxy and need a form
  rule from `policy.yaml › forms` or `humanForms`. In the browser tests an operator's "Open
  sub-account" submission is prevented and recorded as `blocked`; the same tests cover claim,
  refused premature resume, abort and expiry.
- **Resume semantics.** Replay: `retry_step` requires the dialog gone and a `read_only` step,
  then restarts at entry with outputs cleared; `skip_step` requires a postcondition proving the
  human finished it. Discovery: `retry_step` forgets earlier reads and asks the model for its
  next action from a fresh observation; `skip_step` is refused because there is no fixed step.
  `abort` → `ABORTED_BY_OPERATOR`; expiry → `NEEDS_HUMAN`.
- **A helped run answers but is not a recipe.** The transcript keeps a `HUMAN_RESUMED` mark and
  `pnpm compile` refuses it with `COMPILE_HUMAN_ASSISTED`; the model's steps alone did not reach
  the result.

Evidence: `evidence/hitl/discovery-handoff` is a live-model discovery that paused at turn 1 on an
unfamiliar notice, was claimed over the HTTP console, acknowledged in the same browser (recorded
as `human_action` events), resumed, and finished `SUCCESS`. The operator's click was scripted on
the handed-over page so the run is reproducible; the mechanism is identical to a person's click.

## Safety

- **Deny by default, per app** (`policy.yaml`): exact origins; pages with an opaque `:id`
  placeholder and enumerated query values; forms matched by POST path *and* exact field set;
  benign dialog names. Unknown or duplicate query parameters, escapes, traversal and userinfo
  fail closed. The mock's "Open sub-account" form is unlisted, so it is blocked for automation
  *and* for humans; the browser tests assert zero such POSTs reach the server.
- **Risk comes from the page's structure, never from the model or the artifact.** The adapter
  measures the node's effect immediately before dispatch; if the measurement changed, nothing is
  sent (`STALE_REF`). Naming a different submitter "Search" does not make its form permitted.
  Reading is `textContent` only, so a typed value never crosses that boundary. UI text is
  untrusted data in every prompt.
- **Pre-request enforcement, not post-hoc logging.** The proxy checks every hop before opening
  an upstream connection. Unauthorized traffic revokes forwarding and closes the context.
  CONNECT/HTTPS tunnels, WebSockets, service workers, downloads, and extra pages are blocked; no
  model-authored JavaScript ever executes.
- **Discovery cannot be talked into writing.** Policy lists no write form, acceptance is
  satisfiable only by reads, the intent step refuses goals that change data, and the router
  refuses them independently (`UNSUPPORTED_GOAL / changes_data`, in the live evidence).
  `verifyDraft` refuses non-`read_only` drafts.
- **Inputs are proven, not trusted.** The model may only declare inputs that appear verbatim in
  the goal, may only fill declared inputs (values come from the declaration, never the model),
  and must read every input back in the document that shows the outputs.
- **No duplicate execution.** A cold `pnpm agent` run returns the discovery's own outputs after
  verification; the target saw exactly one search. A policy denial during replay returns
  `FAILURE`, never rediscovery.
- **Secrets and PII.** Synthetic data only. Model input and output pass a secret guard keyed on
  the provider key and credentials. Every declared input value and every value read from the UI
  is added to the evidence redaction set; identifiers in paths are spelled `:id` and the evidence
  sink refuses digit-only segments outright. `events.jsonl` holds routes, effect kinds, strategy
  indices and codes; snapshots hold content-free DOM structure. No screenshots, traces, videos, or
  browser storage persist; outputs return to the caller, not the log.
- **Honest limits.** A policy layer for one HTTP-only local app, not a browser or OS sandbox, not
  a compliance solution, and no claim of general PII detection. The headed handoff assumes a
  trusted local operator; browser chrome, native dialogs, and OS activity are neither recorded
  nor controlled.

## Cuts

1. **Observed outcome handlers on the router's cold path.** `pnpm agent` compiles only the success
   transcript, so its artifact lacks an outcome handler until `pnpm compile --outcome-run` adds
   one; a not-found member replays to `CHECKPOINT_FAILED` (`evidence/agent/not-found`). Chaining a
   second discovery automatically means deciding when a *failed* replay is evidence of a new
   outcome versus a bug; I left that explicit.
2. **Contract identity across discoveries.** The model names inputs and outputs. Two live
   discoveries at temperature 0 agreed exactly, and the compiler checks shape before merging an
   outcome transcript, but a later run could still produce a sibling capability with a
   differently named input instead of a new revision. A normalising step (or letting the router
   pass the catalog's field names into the intent call) is the obvious next move.
3. **Reads whose input is never displayed.** The identity rule requires each input to be visible
   where the outputs are. A filter-style input (date range, status) would need an acceptance
   extension that proves the filter was applied some other way.
4. **Visual / no-DOM targeting.** Reserved as a schema kind and rejected. The ladder falls
   through to structural CSS, which sufficed for this legacy-style mock.
5. **Tenant override merging, a second app, and multi-run stability scoring.** Designed above,
   not coded. Verification proves replayability at one point in time.
6. **Write-capable capabilities.** Resume, verification, and the router all assume read-only
   flows. Writes need step-level idempotency proofs the schema cannot yet express.
7. **Operational plumbing:** queues, DB, remote operator auth/co-browsing, dashboards, OTel
   export, tool-based catalog search, and physical input events for apps requiring `isTrusted`.

Two judgment calls I would defend. Replacing the hand-written control allow-list with measured
structural effects lost nothing that mattered for safety, because the dangerous thing about a
button is the request it sends, not its label, and gained a system that learns a new read with
no code change. And keeping explicit `discover` / `compile` / `replay` alongside `agent --goal`
means a draft is never silently promoted and a transcript is never mistaken for a capability.
