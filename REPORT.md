# Report: Computer-Use Banking Automation

A prototype in which an LLM discovers how to operate a banking UI once, the recording is compiled
into a typed capability artifact, and every later invocation is deterministic, model-free replay
under a policy layer the model cannot bypass. Everything described here is implemented and
exercised unless it is explicitly marked *design only*. Real runs are in [`evidence/`](evidence/README.md);
`pnpm check` runs 795 unit/contract/CLI tests and 172 real-browser tests without any model key.

The one implemented capability is `get_member_savings_balance` against "Harbor Core", an owned
legacy-style mock (Hono, server-rendered, login → member search → member detail with the
accounts table inside an iframe, fault toggles). Owning the target is what made fault-injection
evidence possible; nothing here touched a real bank system, credential, or person.

## Architecture

**Principle.** The agent decides *which* capability to use; the capability decides *how* the UI is
operated. Two paths share one action pipeline but never share a decision loop:

```text
goal ─► Capability router (LLM, one structured call over the verified catalog)
          │ execute              │ discover                        │ clarify / unsupported
          ▼                      ▼                                 ▼
     Replay engine        Discovery agent (LLM loop)          return to caller
     (no model)           observe → decide → act
          │                      │ compile → save draft → verify in fresh sandboxes → publish
          ▼                      ▼
     typed outputs        discovery outputs (nothing executes again)

Shared action path:  trusted control classification → policy → Playwright surface adapter → HTTP proxy
Shared services:     HITL broker (control ownership) · sanitized evidence sink · immutable registry
```

**Modules** (`src/`): `artifact/` (schema, bindings, result contract, registry), `policy/`
(pure allow-list decisions), `surface/` (Playwright adapter, Harbor profile, proxy), `replay/`
(engine), `discovery/` (engine, model client, transcript, privacy), `compiler/` (compile,
verify), `hitl/` (broker, operator API), `agent/` (router), `evidence/`, `cli/`.

**The one choke point.** Every browser action — from discovery, replay, or a human during a
handoff — goes through `PlaywrightAdapter`, which classifies the *actual* node with the trusted
Harbor profile, asks the policy layer, and only then dispatches. The model never holds a
Playwright handle; it receives opaque node-bound refs (`e12_3`) that are invalidated by any
navigation or new observation. A mandatory Chromium HTTP proxy re-checks every hop, including
redirects, and every POST needs a one-use grant for the exact destination and form bytes.

**Entrypoints.** `pnpm agent --goal` is the agent-facing UX (Phase 7). `pnpm discover`,
`pnpm compile`, and `pnpm replay` expose each stage directly because determinism and fault
injection have to be testable without a model in the loop. The router is deliberately thin: it
never sees the UI, never chooses locators, never plans steps. It maps *goal → capability + typed
inputs*, and the application then checks that the named capability and revision exist, that the
inputs satisfy the artifact, and that discovery is even permitted (only with an empty catalog).

**Boundaries.** One Node process, loopback listeners only, filesystem registry. No queue, DB,
or dashboard; the seams (registry, evidence sink, surface adapter) are interfaces.

## Artifact schema

The artifact (`src/artifact/schema.ts`, guide in [`docs/CONTRACTS.md`](docs/CONTRACTS.md)) is
the contract between the replay engine that executes it, the reviewer who approves it, and the
agent that invokes it. It is not a transcript.

```text
CapabilityArtifact (schemaVersion 1)
  identity      name, immutable revision, description, status: draft | verified
  app           appId, appVersion, surface: web, entryPath, requiresSession
  risk          read_only | reversible | irreversible (maximum declared business-step risk)
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

Design choices worth defending:

- **Values are references, never literals.** A fill is `{ source: "input", name: "memberId" }`.
  The compiler refuses a transcript whose actions embed the discovery member, and the registry
  refuses to save any artifact containing a supplied sensitive value (credentials, inputs).
  Verification with a *second* member is what catches a hardcoded fixture the schema cannot see.
- **The error taxonomy lives in the artifact, not only in the result type.** Replay cannot know
  "No member found" is a business outcome unless the artifact declares it. Authored and observed
  handlers carry separate provenance: a happy-path run cannot teach every outcome.
- **Revisions are immutable, status included.** Verification publishes a new revision
  (`v1 draft → v2 verified`); the draft is never mutated. Only `verified` + `read_only`
  artifacts are eligible for normal replay; drafts run only in `verification` mode in an owned
  sandbox.
- **Postconditions are observed, not invented.** The compiler asserts what the model touched
  *next* after each action, plus the literal path when it was not parameterized. It proposes
  nothing it did not see, keeps state-changing actions conservatively, and leaves no step for
  a rejected proposal.
- **Deliberately absent in v1:** regexes, executable expressions, URL templates, optional or
  defaulted fields, nested capabilities, and unimplemented target kinds (`visual`, desktop).
  Unsupported variants are rejected by the parser rather than accepted and silently ignored.

Two concrete artifacts: the authored draft [`examples/get-member-savings-balance.json`](examples/get-member-savings-balance.json)
and the live-discovered, verified [`evidence/compile-phase5/get_member_savings_balance.v2.verified.json`](evidence/compile-phase5/get_member_savings_balance.v2.verified.json).

## Determinism & error handling

**Replay never consults a model.** The engine (`src/replay/engine.ts`) validates eligibility,
inputs, and app identity; establishes the entry state through permitted UI controls; then for
each step: checks that automation owns the browser, evaluates hard-stop / outcome / recovery
detectors, resolves the scoped target requiring *exactly one* match (ambiguity fails; `.first()`
is never used), classifies the actual node, authorizes, dispatches guarded and atomically, and
re-evaluates detectors and the postcondition. Detectors run after each action as well as before
the next, because an outcome usually appears as the result of the action just taken. The final
checkpoint re-verifies member identity in both the main document and the iframe and the
currency before outputs are parsed and typed.

**Result contract** (`src/artifact/result.ts`): `SUCCESS { outputs }`, `BUSINESS_OUTCOME { code }`
from the artifact's declared outcomes, `FAILURE { code, sanitized diagnostic }`, or
`NEEDS_HUMAN { interventionId, reason }`. Every result carries run ID, step reached, evidence
filenames, and bounded recovery records. "Recoverable" is an internal event, not a result kind:
a recoverable condition either recovers (recorded in evidence) or exhausts its budget and becomes
`FAILURE / RECOVERY_EXHAUSTED`.

**Recovery is bounded and restarts, never resumes blind.** A session expiry re-authenticates
through the session manager (credentials are configuration, not artifact inputs) and restarts the
read-only flow at entry with partial outputs cleared, so a stale value can never be returned after
the page changed under recovery. Unknown dialogs are fatal unless a handoff broker is attached.

**Evidence of determinism** — all real runs, run IDs preserved:

| Run | Result | Where |
|---|---|---|
| Authored draft, member 12345 | `SUCCESS`, six steps | `evidence/replay-phase3/success` |
| Member 99999 | `BUSINESS_OUTCOME / MEMBER_NOT_FOUND` at the search step | `replay-phase3/not-found` |
| Fault `session_expired` | `SUCCESS` after one re-authentication and entry restart | `replay-phase3/session-recovery` |
| Fault `permission_denied` | `FAILURE / PERMISSION_DENIED` + structural snapshot | `replay-phase3/permission-denied` |
| Live-discovered draft, two members, fresh sandboxes | both `SUCCESS` → v2 published | `compile-phase5/verification-*` |
| Verified v2, member 67890 (never seen by the model) | `SUCCESS`, 987654 cents | `compile-phase5/replay-67890` |
| Verified v2, member 99999 | `BUSINESS_OUTCOME / MEMBER_NOT_FOUND` via the *observed* handler | `compile-phase5/replay-99999` |

**Drift telemetry.** Every resolved target records which strategy index matched
(`action_authorized … strategyIndex`). Consistent fall-through past role/label is the signal
for a tenant override (see below) rather than a re-record.

**Discovery is bounded too.** Max steps, wall clock, tokens, three repeated decisions, and three
consecutive retryable errors all stop the run. Every model reply is one strict-schema tool call
at temperature 0; prose, multiple calls, or unknown tools fail the turn. Provider usage and
response IDs are captured at the wire and validated before the SDK can synthesize them.
`complete` is a *claim* the engine verifies by re-resolving every read under one consistent
document state; the live run contains one rejected premature claim (turn 7), which left no step.

## Heterogeneity & multi-tenant

*Implemented:* one web surface, with the parts that make it extensible tested. *Design only:*
desktop, visual targeting, tenant overrides.

**Surface seam.** `SurfaceAdapter` exposes `observe`, `resolve`, `act`, `checkCondition`,
`navigate`, `authenticate`, `snapshot`, `health`, `close`. Discovery and replay use only this
interface; adapter selection is application configuration, not an LLM decision. Observations
are bounded semantic views (roles, labels, text, table row/column, frame scope) rather than a
full accessibility tree, and they work on the mock's non-semantic legacy markup because the
ladder falls through to `table_cell` and structural `css`. The brief's "still works with no clean
DOM" bias is honoured at the schema level — `strategies[]` is ordered and per-target, and the
schema reserves a `visual` kind — but no screenshot-and-coordinates strategy is implemented, and
the schema *rejects* it rather than pretending. A desktop surface needs its own adapter (OS
accessibility APIs) and may need different steps; the business contract (inputs, outputs,
outcomes, checkpoint) is what carries over, not the locators.

**Per-app profile.** Policy keys on trusted control identities (`search_member`, `view_member`,
`open_sub_account`, `operator_notice_acknowledge`), derived from the real element by
`src/surface/harbor-profile.ts`. Supporting another application means writing and reviewing its
profile and goal acceptance checks, not just a new prompt. This is a real cost and I would rather
state it than hide it behind a config flag.

**Multi-tenant reuse** (*design only*, from [`docs/PROPOSAL.md` §9.2](docs/PROPOSAL.md)):
artifacts are keyed by `(appId, appVersion)`, not tenant. A tenant binds through a small override
document `{ tenantId, appId, artifactName, artifactVersion, stepOverrides: { [stepId]: { target?,
value?, waitFor? } }, entryUrl, extraRecoverables[] }` merged at load time — stable step IDs are
what make that safe. Drift detection uses the recorded `strategyIndex` and postcondition timing:
one tenant repeatedly resolving on index ≥ 2, or failing `TARGET_NOT_FOUND` where others succeed,
proposes an override. Path canonicalization (`/members/12345 → /members/:memberId`) is already
implemented for transcripts and evidence and would be reused for tenant `url_matches` conditions.

## Escalation & handoff

Implemented in Phase 6 ([`docs/HITL.md`](docs/HITL.md), real runs in
[`evidence/hitl-phase6`](evidence/hitl-phase6/README.md)). The seam is control *ownership*:

```text
waiting → human_control → validating → resumed | aborted | expired
RunContext.controlOwner ∈ { automation, human:<operatorId>, none }
```

- **Trigger and pause.** On an unknown dialog (and only when a broker is attached and the
  adapter is healthy), replay opens an intervention, snapshots structure, quiesces in-flight
  work, and blocks. The automation clock pauses so a slow operator does not turn into a
  `RUN_TIMEOUT`. A watchdog polls browser health so an operator closing the window is detected.
- **Same live session.** The browser runs headed; the operator uses the very same Chromium
  window, cookies, and page. A loopback Hono API (`GET /interventions`, `POST …/claim`,
  `POST …/resume`) with a per-run 48-hex bearer token (printed once, never stored) validates
  every transition: competing claims, non-owner resumes, and resumes before a claim are refused.
- **Recording what the human did.** A context-level init script (so it survives navigation)
  captures clicks and form submissions while — and only while — a human owns the browser, tags
  the actual node with a one-time marker, and hands it to the trusted side, which classifies it
  with the same profile automation uses. Typed values are never recorded. The record lands in
  `intervention_N.json` with the full transition history.
- **Handoff is not a bypass.** Operator form submissions go through the same proxy and need a
  grant issued by `policy.yaml › humanActions`, which accepts `read_only`/`reversible` only. In
  the tests an operator's `sign_in` POST is prevented and recorded as `blocked`. Nobody can
  authorize an irreversible action, including a human.
- **Resume semantics.** `retry_step` requires the dialog to be gone and a `read_only` step, then
  restarts at entry with outputs cleared. `skip_step` requires a declared postcondition that
  proves the human completed the step; extract steps and steps without a provable postcondition
  cannot be skipped. `abort` yields `ABORTED_BY_OPERATOR`. Expiry yields `NEEDS_HUMAN`.

Evidence: an attended run that paused on the unfamiliar notice, refused a premature resume,
recorded the operator's acknowledgement, validated the resume, and finished `SUCCESS`; and an
unattended run that expired to `NEEDS_HUMAN`. Discovery's `request_human` currently ends the run
as `BLOCKED` with evidence rather than opening a live handoff — see Cuts.

## Safety

- **Deny by default, per app** (`policy.yaml`): exact origins, path patterns with only a
  five-digit member placeholder, action types keyed on trusted target identity and risk.
  Overlapping conflicting rules are rejected at load. Unknown or duplicate query parameters fail
  closed. The mock's "risky" control is classified and blocked for automation and for humans.
- **Risk labels come from the application, never the model.** A model or artifact cannot
  supply its own `targetKey`; naming a different submitter "Search" does not make it the member
  search. UI text is treated as untrusted data in every prompt, and the router and intent prompts
  say so explicitly.
- **Pre-request enforcement, not post-hoc logging.** The Chromium HTTP proxy checks every hop
  before opening an upstream connection (an experiment showed ordinary Playwright routing can
  miss later redirect hops). Unauthorized traffic revokes forwarding and closes the context
  immediately. CONNECT/HTTPS tunnels, WebSockets, service workers, downloads, and extra pages
  are blocked. No model-authored JavaScript is ever executed.
- **Discovery does not write, and cannot be talked into it.** The policy denies writes, the
  acceptance checks can only be satisfied by reads, and the router refuses goals that change
  financial data (`UNSUPPORTED_GOAL / changes_financial_data` in the live evidence). Verification
  never automatically replays a write to prove it, by construction (`verifyDraft` refuses
  non-`read_only` drafts).
- **No duplicate execution.** A cold `pnpm agent` run returns the discovery's own outputs after
  verification; the target saw exactly one member search (`evidence/agent-phase7/cold`). A
  policy denial during replay is returned as a `FAILURE`, never routed around by rediscovery.
- **Secrets and PII.** Synthetic data only. Model input and output pass through a secret guard
  keyed on the provider key, credentials, and invocation values; a goal containing a known secret
  never reaches the provider. Evidence is structural: `events.jsonl` holds routes, target keys,
  strategy indices, and codes — no raw values, URLs, selectors, or exception objects — and
  `snapshot_N.json` holds bounded, content-free DOM structure. No screenshots, traces, videos, or
  browser storage are persisted. Outputs return to the caller, not the log. Registry writes reject
  known sensitive values rather than editing selectors. Setup failures never echo the goal, paths,
  or configuration values.
- **Honest limits.** This is a policy layer for one HTTP-only local app, not a browser or OS
  sandbox and not a regulated-data compliance solution; it does not claim general PII detection.
  The headed handoff assumes a trusted local operator; browser chrome, native dialogs, and OS
  activity are neither recorded nor controlled.

## Cuts

What was deliberately not built, and what I would do next, in priority order.

1. **Observed outcome handlers on the agent's cold path.** `pnpm agent` compiles only the success
   transcript, so its artifact has no `MEMBER_NOT_FOUND` handler and a not-found member replays
   to `CHECKPOINT_FAILED` (visible in `evidence/agent-phase7`). The handler exists — `pnpm
   compile --outcome-run` adds it from a separate not-found transcript — but the router does not
   yet chain a second discovery for it. Doing so safely means deciding when a *failed* replay is
   evidence of a new outcome versus a bug; I left that decision explicit rather than automatic.
2. **Live handoff during discovery.** `request_human` and exhausted recovery end the run with
   evidence; only replay's unknown-dialog path opens the same-session handoff. The broker and
   adapter recording are surface-independent, so this is wiring, but it needs the resume
   semantics defined for a non-deterministic loop.
3. **Visual / no-DOM targeting.** Reserved as a schema kind and rejected; not implemented. The
   ladder falls through to structural CSS today, which was enough for the legacy-style mock.
4. **Tenant override merging and a second app variant.** Designed (§Heterogeneity), not coded.
   Phase 9's "multi-run stability score" was also cut; verification proves replayability at one
   point in time, not over many runs.
5. **Write-capable capabilities.** Everything about resume (`retry_step` restarts at entry),
   verification, and the router assumes read-only flows. Writes need step-level idempotency
   proofs the schema does not yet express; I would rather add that as a schema change than allow
   `reversible` steps into verification first.
6. **Catalog search as a tool.** The catalog is supplied upfront because it has one entry. A
   tool-based search needs a bounded multi-turn router loop.
7. **Operational plumbing:** queues, DB, remote operator auth/co-browsing, dashboards, OTel
   export, physical input events for apps that require `isTrusted`.

Two judgment calls I would defend under review: keeping `harbor-profile.ts` as a hand-written
trusted classifier (it is the reason the model cannot self-authorize; in the discovery tests it
stops a scripted model from clicking **Open sub-account** with zero POSTs reaching the server),
and keeping explicit `discover` / `compile` /
`replay` commands alongside `agent --goal` so a draft is never silently promoted and a discovery
transcript is never mistaken for an artifact.
