# Report: Computer-Use Banking Automation

An LLM discovers how to operate a banking UI once; that run is compiled into a typed capability
artifact; every later invocation is deterministic, model-free replay under a policy layer the model
cannot bypass. Everything below is implemented and exercised unless marked *design only*. Real runs
are in [`evidence/`](evidence/README.md); `pnpm check` runs 795 unit/contract/CLI and 172
real-browser tests with no model key.

The implemented capability is `get_member_savings_balance` against "Harbor Core", an owned
legacy-style mock (Hono, server-rendered): login → member search → member detail with the accounts
table in an iframe, no test IDs, nine fault toggles. Owning the target is what made fault-injection
evidence possible; nothing here touched a real bank system, credential, or person.

## Architecture

The agent decides *which* capability to use; the capability decides *how* the UI is operated. Two
paths share one action pipeline but never share a decision loop:

```text
goal ─► Capability router (LLM, one structured call over the verified catalog)
          │ execute              │ discover                        │ clarify / unsupported
          ▼                      ▼                                 ▼
     Replay engine        Discovery agent (LLM loop)          return to caller
     (no model)           observe → decide → act
          │                      │ compile → save draft → verify in fresh sandboxes → publish
          ▼                      ▼
     typed outputs        discovery outputs (nothing executes again)

Shared action path:  trusted control classification → policy → Playwright adapter → HTTP proxy
Shared services:     HITL broker (control ownership) · sanitized evidence sink · immutable registry
```

**Modules** (`src/`): `artifact/` (schema, bindings, result contract, registry), `policy/` (pure
allow-list decisions), `surface/` (Playwright adapter, Harbor profile, HTTP proxy), `replay/`
(engine), `discovery/` (engine, model client, transcript, privacy), `compiler/` (compile, verify),
`hitl/` (broker, operator API), `agent/` (router), `evidence/`, `cli/`.

**One choke point.** Every browser action — discovery, replay, or a human mid-handoff — goes
through `PlaywrightAdapter`, which classifies the *actual* node via the trusted Harbor profile,
asks the policy layer, then dispatches. The model never holds a Playwright handle; it gets opaque
node-bound refs invalidated by any navigation or new observation. A mandatory Chromium HTTP proxy
re-checks every hop including redirects, and each POST needs a one-use grant for the exact
destination and form bytes.

**Entrypoints.** `discover` → `compile` → `replay` expose each stage directly, because determinism
and fault injection must be testable with no model in the loop. `pnpm agent --goal` composes them
and is this submission's claim on stretch goal #1: it receives the verified catalog and invokes a
capability by name with typed args (`evidence/agent-phase7/warm`). The router never sees the UI,
chooses locators, or plans steps — it maps *goal → capability + typed inputs*, then the application
verifies the revision exists, the inputs satisfy the artifact, and discovery is permitted at all
(empty catalog only). Partial claims on two further stretch goals: draft→verified gating of
unattended replay (no reliability scoring), and route canonicalization
(`/members/12345 → /members/:memberId`).

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
  outputs       same shape; savingsBalanceCents is an integer, never a float
  steps[]       stable IDs; navigate | click | fill | select | extract | wait; each with a
                scoped target, per-step risk, and a postcondition
  target        ordered strategies[]: role → label → text → table_cell → css, plus an
                explicit frame chain and container scope
  outcomes[]    business results (e.g. MEMBER_NOT_FOUND) with detector condition and
                provenance: authored | observed(runId)
  failures[]    hard-stop UI conditions with provenance
  recoveries[]  bounded: dismiss a known notice, or reauthenticate-and-restart
  limits        step/run timeouts, per-run recovery budget
  checkpoint    final concrete assertions (member identity in main doc and iframe, currency)
  provenance    authored | discovered(runId, model)
  verification  runId + time, required for status: verified
```

- **Values are references, never literals** — a fill is `{ source: "input", name: "memberId" }`.
  The compiler rejects transcripts embedding the discovery member; the registry rejects artifacts
  containing a supplied sensitive value (credentials, invocation inputs). Verifying with a *second*
  member is what catches a hardcoded fixture the schema cannot see.
- **The error taxonomy lives in the artifact**, not only the result type: replay cannot know "No
  member found" is a business outcome unless declared. Authored vs. observed provenance is tracked
  separately, because a happy-path run cannot teach every outcome.
- **Revisions are immutable, status included.** Verification publishes `v1 draft → v2 verified`;
  the draft is never mutated. Only `verified` + `read_only` artifacts are eligible for normal
  replay; drafts run only in `verification` mode in an owned sandbox.
- **Postconditions are observed, not invented.** The compiler asserts what the model actually
  touched next after each action, plus the literal path where it was not parameterized. It keeps
  state-changing actions conservatively and emits no step for a rejected proposal.
- **Absent in v1 by choice:** regexes, executable expressions, URL templates, optional fields,
  nested capabilities, and unimplemented target kinds (`visual`, desktop) — rejected by the parser
  rather than silently ignored.

Concrete artifacts: the authored draft [`examples/get-member-savings-balance.json`](examples/get-member-savings-balance.json)
and the live-discovered, verified [`v2`](evidence/compile-phase5/get_member_savings_balance.v2.verified.json).

## Determinism & error handling

**Replay never consults a model.** `src/replay/engine.ts` first validates eligibility, inputs, and
app identity, then establishes entry state through permitted UI controls. Per step it confirms
automation owns the browser, evaluates hard-stop/outcome/recovery detectors, resolves the scoped
target requiring *exactly one* match (ambiguity fails; `.first()` is never used), classifies the
actual node, authorizes, dispatches atomically, then re-evaluates detectors and the postcondition.
Detectors run after each action as well as before the next, because an outcome usually appears as
the result of the action just taken. The final checkpoint re-verifies member identity in both
documents plus currency before outputs are parsed and typed.

**Result contract** (`src/artifact/result.ts`): `SUCCESS { outputs }`, `BUSINESS_OUTCOME { code }`
from the artifact's declared outcomes, `FAILURE { code, expected, observed }`, or
`NEEDS_HUMAN { interventionId, reason }` — each carrying run ID, step reached, evidence filenames,
and bounded recovery records. `parseReplayResult` then independently re-validates the engine's own
result: `SUCCESS` must have reached the final step with zero exhausted recoveries and typed
outputs, and every outcome code must be one the artifact declares. The engine cannot return a
result the artifact never authorized. "Recoverable" is an internal event, never a result kind — it
recovers, or exhausts its budget and becomes `FAILURE / RECOVERY_EXHAUSTED`.

**Recovery restarts, never resumes blind.** Session expiry re-authenticates through the session
manager (credentials are configuration, not artifact inputs) and restarts the read-only flow at
entry with partial outputs cleared, so a stale value cannot survive a page change underneath it.
Non-fatal action errors get exactly one bounded detector re-inspection and are never blindly
retried; sticky policy/network/evidence/deadline failures always stop.

| Run (all real, run IDs preserved) | Result | Where |
|---|---|---|
| Authored draft, member 12345 | `SUCCESS`, six steps | `replay-phase3/success` |
| Member 99999 | `BUSINESS_OUTCOME / MEMBER_NOT_FOUND` at search | `replay-phase3/not-found` |
| Fault `session_expired` | `SUCCESS` after one re-auth and entry restart | `replay-phase3/session-recovery` |
| Fault `permission_denied` | `FAILURE / PERMISSION_DENIED` + snapshot | `replay-phase3/permission-denied` |
| Verified v2, member 67890 (unseen by the model) | `SUCCESS`, 987654 cents | `compile-phase5/replay-67890` |
| Verified v2, member 99999 | `BUSINESS_OUTCOME` via the *observed* handler | `compile-phase5/replay-99999` |

**Drift telemetry.** Every resolved target records which strategy index matched; consistent
fall-through past role/label is the signal for a tenant override rather than a re-record.

**Discovery is bounded too.** Max steps, wall clock, tokens, three repeated decisions, and three
consecutive retryable errors each stop the run. Every reply is one strict-schema tool call at
temperature 0; prose, multiple calls, or unknown tools fail the turn. Usage and response IDs are
captured at the wire before the SDK can synthesize them. `complete` is a *claim* the engine
verifies by re-resolving every read under one consistent document state — the live run contains one
rejected premature claim, which left no step behind.

## Heterogeneity & multi-tenant

*Implemented:* one web surface, with the extensibility seams tested. *Design only:* desktop, visual
targeting, tenant overrides.

**Surface seam.** `SurfaceAdapter` exposes `observe`, `resolve`, `act`, `checkCondition`,
`navigate`, `authenticate`, `snapshot`, `health`, `close`; discovery and replay use nothing else,
and adapter selection is configuration rather than an LLM decision. Observations are bounded
semantic views (roles, labels, text, table row/column, frame scope), not a full accessibility tree,
and they survive the mock's non-semantic markup because the ladder falls through to `table_cell`
and structural `css`. The "no clean DOM" bias is honoured at schema level — `strategies[]` is
ordered and per-target, and a `visual` kind is reserved — but no screenshot-and-coordinates
strategy exists, and the schema *rejects* it rather than pretending. A desktop surface needs its
own adapter (OS accessibility APIs) and possibly different steps; what carries over is the business
contract (inputs, outputs, outcomes, checkpoint), not the locators.

**Per-app profile.** Policy keys on trusted control identities (`search_member`, `view_member`,
`open_sub_account`, `operator_notice_acknowledge`) derived from the real element by
`src/surface/harbor-profile.ts`. Supporting another application means writing and reviewing its
profile and goal acceptance checks, not just a new prompt — a real cost I would rather state than
hide behind a config flag.

**Multi-tenant reuse** (*design only*). Artifacts key on `(appId, appVersion)`, not tenant. A
tenant binds via an override document `{ tenantId, appId, artifactName, artifactVersion,
stepOverrides: { [stepId]: { target?, value?, waitFor? } }, entryUrl, extraRecoverables[] }` merged
at load time; stable step IDs make that safe. Drift detection uses recorded `strategyIndex` and
postcondition timing — one tenant repeatedly resolving at index ≥ 2, or failing `TARGET_NOT_FOUND`
where others succeed, proposes an override. Route canonicalization already exists and would be
reused for tenant `url_matches`.

## Escalation & handoff

The seam is control *ownership* ([`docs/HITL.md`](docs/HITL.md), runs in
[`evidence/hitl-phase6`](evidence/hitl-phase6/README.md)):

```text
waiting → human_control → validating → resumed | aborted | expired
RunContext.controlOwner ∈ { automation, human:<operatorId>, none }
```

- **Trigger and pause.** On an unknown dialog — only with a broker attached and a healthy adapter —
  replay opens an intervention, snapshots structure, quiesces in-flight work, and blocks. The
  automation clock pauses so a slow operator is not a `RUN_TIMEOUT`, and a watchdog polls browser
  health so an operator closing the window is detected.
- **Same live session.** Headed browser; the operator uses the very same window, cookies, and page.
  A loopback API (`GET /interventions`, `POST …/claim`, `POST …/resume`) with a per-run bearer
  token (printed once, never stored) refuses competing claims, non-owner resumes, and resumes
  before a claim.
- **Recording what the human did.** A context-level init script (surviving navigation) captures
  clicks and submissions only while a human owns the browser, tags the node with a one-time marker,
  and hands it to the trusted side, which classifies it with the same profile automation uses.
  Typed values are never recorded; the record lands in `intervention_N.json` with full history.
- **Handoff is not a bypass.** Operator submissions traverse the same proxy and need a grant from
  `policy.yaml › humanActions`, which accepts `read_only`/`reversible` only. In tests an operator's
  `sign_in` POST is prevented and recorded as `blocked`. Nobody authorizes an irreversible action,
  human included.
- **Resume semantics.** `retry_step` requires the dialog gone and a `read_only` step, then restarts
  at entry with outputs cleared. `skip_step` requires a postcondition proving the human finished
  it; extract steps cannot be skipped. `abort` → `ABORTED_BY_OPERATOR`; expiry → `NEEDS_HUMAN`.

Evidence: an attended run that paused on the unfamiliar notice, refused a premature resume,
recorded the acknowledgement, validated the resume, and finished `SUCCESS`; plus an unattended run
that expired to `NEEDS_HUMAN`. Discovery's `request_human` ends the run as `BLOCKED` with evidence
rather than opening a live handoff — see Cuts.

## Safety

- **Deny by default, per app** (`policy.yaml`): exact origins, paths with only a five-digit member
  placeholder, action types keyed on trusted target identity and risk. Conflicting overlapping
  rules are rejected at load; unknown or duplicate query parameters fail closed. The mock's risky
  control is blocked for automation *and* for humans.
- **Risk labels come from the application, never the model.** Neither model nor artifact can supply
  a `targetKey`; naming a different submitter "Search" does not make it the member search. UI text
  is untrusted data in every prompt.
- **Pre-request enforcement, not post-hoc logging.** The proxy checks every hop before opening an
  upstream connection — an experiment showed ordinary Playwright routing can miss later redirect
  hops. Unauthorized traffic revokes forwarding and closes the context immediately. CONNECT/HTTPS
  tunnels, WebSockets, service workers, downloads, and extra pages are blocked; no model-authored
  JavaScript ever executes.
- **Discovery cannot be talked into writing.** Policy denies writes, acceptance checks are
  satisfiable only by reads, and the router refuses goals that change financial data
  (`UNSUPPORTED_GOAL / changes_financial_data`, in the live evidence). `verifyDraft` refuses
  non-`read_only` drafts, so verification never replays a write to prove it.
- **No duplicate execution.** A cold `pnpm agent` run returns the discovery's own outputs after
  verification — the target saw exactly one member search. A policy denial during replay returns
  `FAILURE`, never rediscovery.
- **Secrets and PII.** Synthetic data only. Model input and output pass a secret guard keyed on the
  provider key, credentials, and invocation values, so a goal containing a known secret never
  reaches the provider. Evidence is structural: `events.jsonl` holds routes, target keys, strategy
  indices, and codes — no raw values, URLs, selectors, or exceptions — and `snapshot_N.json` holds
  bounded content-free DOM structure. No screenshots, traces, videos, or browser storage persist;
  outputs return to the caller, not the log.
- **Honest limits.** A policy layer for one HTTP-only local app — not a browser or OS sandbox, not
  a compliance solution, and no claim of general PII detection. The headed handoff assumes a
  trusted local operator; browser chrome, native dialogs, and OS activity are neither recorded nor
  controlled.

## Cuts

1. **Observed outcome handlers on the router's cold path.** `pnpm agent` compiles only the success
   transcript, so its artifact lacks a `MEMBER_NOT_FOUND` handler and a not-found member replays to
   `CHECKPOINT_FAILED` (`evidence/agent-phase7`). The handler exists via
   `pnpm compile --outcome-run`, but the router does not chain a second discovery: doing that
   safely means deciding when a *failed* replay is evidence of a new outcome versus a bug, and I
   left that explicit rather than automatic.
2. **Live handoff during discovery.** `request_human` and exhausted recovery end with evidence;
   only replay's unknown-dialog path opens the same-session handoff. Broker and recording are
   surface-independent, so this is wiring — but it needs resume semantics for a non-deterministic
   loop.
3. **Visual / no-DOM targeting.** Reserved as a schema kind and rejected. The ladder falls through
   to structural CSS, which sufficed for this legacy-style mock.
4. **Tenant override merging and a second app variant.** Designed above, not coded. Multi-run
   stability scoring was also cut: verification proves replayability at one point in time.
5. **Write-capable capabilities.** Resume, verification, and the router all assume read-only flows.
   Writes need step-level idempotency proofs the schema cannot yet express; I would add that as a
   schema change rather than admit `reversible` steps into verification first.
6. **Operational plumbing:** queues, DB, remote operator auth/co-browsing, dashboards, OTel export,
   tool-based catalog search (passed upfront, as it has one entry), and physical input events for
   apps requiring `isTrusted`.

Two judgment calls I would defend. Keeping `harbor-profile.ts` a hand-written trusted classifier is
the reason the model cannot self-authorize — in the discovery tests it stops a scripted model from
clicking **Open sub-account** with zero POSTs reaching the server. And keeping explicit `discover` /
`compile` / `replay` alongside `agent --goal` means a draft is never silently promoted and a
transcript is never mistaken for a capability.
