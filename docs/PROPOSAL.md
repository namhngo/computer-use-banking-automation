# Proposal: Computer-Use Automation System (interface.ai take-home)

> Working document. Sections marked **[REVISED]** changed from the original draft after review
> against the brief; **[NEW]** sections were missing entirely. Rationale for each change is inline
> so the reasoning can be lifted into `REPORT.md` later.

**Implementation status:** Phases 0-3 completed through 2026-09-12. `pnpm check` passes lint,
strict typechecking, 579 unit/contract/HTTP/CLI tests, and 132 Chromium tests. Model-free replay,
guarded UI actions, network enforcement, and private evidence now work against the authored
draft. See [REPLAY.md](REPLAY.md), [CONTRACTS.md](CONTRACTS.md), and the reviewed
[replay evidence](../evidence/replay-phase3/README.md). LLM discovery, compilation/promotion,
and human handoff remain future phases; these replay runs are not discovery evidence.

---

## 0. Assessment summary

**Is the original proposal on the right track?** Yes. The core framing — *the agent decides what
capability to use; the capability determines how the UI is operated* — is exactly the brief's
through-line ("the model discovers, the artifact becomes a capability, deterministic replay is
how the agent invokes it"). The result taxonomy, explicit HITL state machine, and scope
discipline are all aligned with the evaluation criteria.

**Is it doable?** Yes, as a focused, time-boxed effort. The scaffolding (loop, schemas, replay,
guardrails, logging) is fast with AI-assisted development; the brief says so itself. The time
goes into the judgment pieces: artifact schema, transcript-to-artifact compilation, error
taxonomy, and the HITL seam.

**Gaps fixed in this revision (ordered by grading impact):**

| # | Gap in original draft | Why it matters | Fix |
|---|---|---|---|
| 1 | Error taxonomy existed only in the *result type*, not in the *artifact* | Replay cannot know "Member not found" is a business outcome unless the artifact declares it | §3: `outcomes[]`, `failures[]`, and `recoveries[]` declared in schema |
| 2 | Transcript → artifact compilation hand-waved | Parameterization, conservative action retention, locator capture | §4.4: explicit compile + sandbox verification replay |
| 3 | Locator ladder was entirely DOM-based | Brief says "bias toward an approach that still works with no clean DOM" | §4.1 / §5.1: scoped accessibility/structural targeting for web; visual/desktop remain design-only, not accepted schema variants |
| 4 | Target application unspecified | Owning the target is what makes error-injection evidence possible | §2.3: local legacy-style mock app with fault injection |
| 5 | Schema missing per-step postconditions, stable step IDs, app identity, provenance, approval, sensitivity flags, extraction parsing | Needed for tenant overrides, redaction, reviewability | §3 |
| 6 | HITL "same live session" mechanism and "record what the human did" not concrete | Graded as "not just a TODO" | §7 |
| 7 | Capability-router agent presented as core, with no explicit discover/replay entrypoints | Direct replay makes determinism and fault injection independently testable; router is optional in the brief | §1.2 / §10: keep explicit `discover` + `replay`; add `agent --goal` as our planned default UX after the core (Phase 7) |

### Review decisions and phase gates

This is a working proposal, not a claim that the system is implemented. These decisions
supersede the earlier draft and must be carried into each phase's tests:

| Finding | Decision | Phase gate |
|---|---|---|
| Repeated writes during discovery, verification, and execution | Read-only balance flow first; no extra execution after a successful cold run; verification only from a reset synthetic sandbox; no automatic write verification | 1, 3, 5, 7 |
| Safety claims stronger than enforcement | Pre-request destination checks plus post-navigation checks; synthetic data only; raw traces off; mask evidence before persistence | 2, 3, 8 |
| Snapshot refs and cross-surface reuse underspecified | Snapshot-scoped element mapping with frame scope; reject stale/ambiguous refs; desktop needs its own adapter and potentially different steps | 3, 4 |
| Compiler pruning and checkpoints too optimistic | Preserve actions conservatively; track authored exception handlers separately; verify requested member, account, and typed output | 2, 3, 5 |
| Human resume can duplicate or skip work | Explicit resume-state checks; skip only on verified completion; no blind write retry; recorder survives navigation | 6 |
| Router assumes one turn can search then choose, and types prove intent | Supply the tiny compatible catalog upfront; one structured route decision; clarify ambiguity; use `pnpm agent --goal` | 7 |

Phase 0 only establishes tooling, environment configuration, ignore rules, and a real browser
smoke test. It does not freeze the artifact schema or implement policy, discovery, or replay.

---

## 1. Architecture

### 1.1 Principle

The LLM is responsible for **discovery** — understanding a goal and finding a path through an
unknown UI. Execution of a discovered capability is **deterministic and model-free**. These two
paths share the same surface adapter and policy layer but never share a decision loop.

```text
Natural-language goal + configured target
                  |
                  v
Capability Agent (LLM, compatible catalog supplied upfront)
   | existing match          | no match              | ambiguous
   v                         v                       v
Replay Engine         Discovery Agent (LLM)      Ask for clarification
(no LLM)              observe -> decide -> act
   |                         |
   |                   Artifact Compiler
   |                         |
   |                   Save draft artifact
   |                         |
   |                   Reset synthetic sandbox
   |                   + read-only verification replay
   |                         |
   |                   Register verified artifact
   v                         v
Return outputs         Return completed result
                       (no additional execution)

Shared action path: policy -> Playwright surface adapter
Shared services: HITL control state + sanitized evidence sink
Direct commands: discover -> artifact; replay -> model-free execution
```

All browser actions — from discovery *and* replay — flow through one `SurfaceAdapter`
interface, and every action is checked by the `PolicyLayer` before the adapter executes it.
That single choke point is what makes the safety story credible: the LLM cannot bypass policy
because it never touches Playwright directly.

### 1.2 Two entrypoints, one pipeline

| Entrypoint | Who uses it | What it does |
|---|---|---|
| `pnpm agent --goal "..."` | Default goal-driven demo | Supply compatible catalog entries to the LLM; request a structured `execute`, `discover`, or `clarify` decision. Discovery completes the goal; do not execute again after verification. |
| `pnpm discover` / `pnpm replay` | Developers, reviewers, evidence generation | Direct access to each pipeline stage. Required by the brief's README demo path ("run the agent on a goal, then replay the resulting artifact") and needed for fault-injection runs with controlled inputs. |

The router is deliberately thin: it never sees the UI, never chooses locators, never decides
steps. It only maps *goal -> capability + typed inputs*. The application filters the catalog
by configured app/version, validates the selected name and inputs, and enforces policy.
Type validation does not prove the selected capability matches the user's intent. Missing
parameters or ambiguity lead to clarification, never guessed IDs or automatic discovery as a
way around denied execution. Replay failures are not automatically re-discovered and retried.

For one or two capabilities, supplying the catalog upfront avoids a search tool round trip.
A future tool-based catalog search would need a bounded multi-turn loop to use its results.
The router uses an LLM; the replay engine itself never does, and direct replay requires no
model credentials. The discovery agent is also a real agent, regardless of CLI entrypoint.

### 1.3 Boundaries (single process, justified)

One CLI-driven Node process with local HTTP listeners for the owned test target and policy
proxy. HITL will add a small operator signaling endpoint later. No queue, no DB, no distributed
services. The brief explicitly says not to build scaling
infrastructure; the seams (registry interface, evidence sink interface, adapter interface) are
where a production system would swap in real infrastructure.

### 1.4 Modules

```text
src/
  surface/        SurfaceAdapter interface + PlaywrightAdapter (observe / act / snapshot)
  policy/         allowlist config, action risk classification, enforcement
  discovery/      agent loop, tools, prompts, transcript recorder
  compiler/       transcript → CapabilityArtifact (parameterize, prune, locator capture)
  artifact/       Zod schemas, versioning, registry (filesystem)
  replay/         engine, locator resolver (ladder), waits, detectors, result contract
  hitl/           control-transfer state machine, intervention store, HTTP endpoints,
                  human-action recorder
  evidence/       private JSONL events and content-free structural snapshots
  agent/          capability router: catalog -> execute / discover / clarify decision
  cli/            agent (router), discover, replay, list, serve-operator
mock-app/         local legacy-style credit-union back-office (the target surface)
evidence/         committed runs: discovery, replay-success, replay-business-outcome,
                  replay-failure, hitl
```

---

## 2. Technology choices

### 2.1 Stack

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript (Node 22, pnpm, tsx) | Playwright's home; Zod inference; fast iteration |
| Browser control | Playwright / Chromium | Scoped locators and node refs; final guard plus DOM dispatch in one browser task; structural failure snapshots, no raw captures |
| Network guard | Local HTTP policy proxy | Checks every redirect hop and one-use POST destination/body grants; prevents allowed-route substitution after control authorization |
| LLM layer | Vercel AI SDK `ai` 7.0.90 + `@ai-sdk/openai` 4.0.60 **[REVISED in Phase 4]** | Pinned exactly with the lockfile. OpenAI Responses API replaced the earlier Anthropic plan; a per-call fetch wrapper captures wire usage/model/response IDs so failed calls still yield receipts |
| Policy parsing | `yaml` + Zod | Strict YAML without aliases, tags, duplicate keys or implicit policy widening; separate request/action decisions |
| Model | `DISCOVERY_MODEL` from the `gpt-4.1` / `-mini` / `-nano` family, `OPENAI_API_KEY` from env | Restricted to models verified compatible with the fixed request settings (`store: false`, no parallel tool calls, temperature 0); actual usage is recorded per call rather than a promised fixed cost |
| Schema / validation | Zod | Runtime validation of artifacts, tool args, results; one source of truth for types + JSON Schema export for reviewers |
| HTTP (HITL only) | Hono (or bare `node:http`) | Two endpoints; anything heavier is noise |
| Logging | Custom JSONL writer with redaction | Structured, greppable, no external platform |
| Tests | Vitest | Unit: schemas, policy, detectors, template binding. Integration: replay against mock app |
| Mock app | Hono, server-rendered HTML, no client framework | Full control over legacy traits and fault injection |

Phase 0 installs only the tooling and runtime dependencies it actually uses. AI SDK/provider
packages arrive in Phase 4; Hono arrives in Phase 1. Avoid placeholder modules and unused SDKs.

### 2.2 Why Vercel AI SDK — and how it is used

**Decision:** use AI SDK, but call `generateText` **once per loop iteration** with
`toolChoice: 'required'` and execute the chosen tool in our own code. Do *not* use the SDK's
multi-step auto-execution. This keeps recording, policy enforcement, and stopping conditions
unambiguously in application code, and makes the loop trivially explainable in an interview.

**Alternatives considered:**

| Option | Assessment |
|---|---|
| Direct Anthropic / OpenAI SDK | Equally defensible; ~100 lines of loop, zero framework surface. Rejected only because AI SDK gives Zod-typed tools and provider swap for near-zero cost. If AI SDK's API churns during the project, fall back to this. |
| Browser-agent frameworks (Stagehand, Browser Use, Magnitude) | Rejected. They own the loop, observation model, and locator strategy — the exact things being graded. |
| Native computer-use models (Anthropic Computer Use, OpenAI CUA) | Rejected as primary mechanism. Screenshot + coordinates are poor *replay* locators. Kept as a declared `visual` target strategy for surfaces with no accessibility tree. |
| Agent orchestration frameworks (LangGraph, Mastra) | Overkill for a single bounded loop. |

### 2.3 Target application **[NEW]**

A locally-run mock **credit-union back-office**, built to exercise the brief's "interesting
problems" on purpose:

- **Core flow:** member search -> member detail -> savings balance (read-only). Use synthetic
  member data only. A risky control can demonstrate policy blocking without committing a write.
- **Optional second flow:** reach sub-account review, stopping before final submission. Actual
  account creation and general write replay are deferred until duplicate-execution safeguards
  exist; they are not needed to meet the assignment.
- **Reset contract:** the test harness resets synthetic data and starts a fresh browser context
  at the declared entry point for verification. The agent still operates only the UI; it cannot
  call reset hooks or read fixture data. HITL, unlike verification, must retain the live session.
- **Phase 1 implementation:** `mock-app/app.ts` exposes a factory and an in-process reset hook,
  never an HTTP reset/data API. Requests carry a reset generation so old in-flight login/search
  requests cannot issue new sessions or consume a subsequent run's faults. Fixtures are
  immutable; faults are selected with `pnpm mock-app --fault <name>` or harness reset.
- **Local credentials:** `pnpm mock-app` reads `MOCK_USERNAME` and `MOCK_PASSWORD` from an
  ignored `.env` (shell values take precedence). Startup fails if they are absent or invalid;
  the UI and logs never display them. The factory requires explicit credential injection so
  tests remain hermetic with synthetic values. Credentials are runtime configuration, not
  capability inputs to persist; later agent authentication must keep them out of evidence.
- **Legacy traits:** table-based layout, no test IDs, generic class names, an `<iframe>` for the
  account panel, server-rendered forms with full-page posts, a login page with session cookie.
- **Fault injection** (via header/query/env toggle so evidence runs are reproducible):
  - `member_not_found` — business outcome
  - `validation_error` — business outcome (bad member ID format)
  - `session_expired` — recoverable (redirects to login; re-login sub-flow)
  - `slow_load` — recoverable (delay 3–8s)
  - `interstitial` — recoverable ("system notice" modal to dismiss)
  - `permission_denied` — hard failure
  - `app_error` — hard failure (500 page)
  - `unexpected_confirm` — unfamiliar HTML interruption page; future HITL trigger, not a native browser dialog

Using a public demo site was rejected: no fault injection, terms-of-service risk, no control
over legacy characteristics.

---

## 3. Capability artifact schema **[REVISED]**

The artifact is the contract between three parties: the replay engine (executes it), a human
reviewer (approves it), and a calling AI agent (invokes it). It is deliberately **not** a
transcript.

### 3.1 Implemented Phase 2 contract

The earlier illustrative schema is superseded by `src/artifact/schema.ts` and the detailed
[contract guide](CONTRACTS.md). Keeping one checked example avoids contradictory snippets.

```text
CapabilityArtifact (schemaVersion: 1)
  identity       name, immutable revision, description, draft | verified
  app            appId, appVersion, surface: web, entryPath, requiresSession
  risk           maximum declared business-step risk (not action permission)
  inputs/outputs required named string/number/boolean definitions + sensitive flags
  steps          unique IDs; navigate/click/fill/select/extract/wait
  targets        ordered strategies; optional frame chain and container scope
  outcomes       business-result conditions + authored/observed provenance
  failures       hard-stop UI conditions + provenance
  recoveries     bounded known dismissal or reauthenticate-and-restart
  limits         step/run timeouts and per-run recovery budget
  checkpoint     final concrete UI assertions
  provenance     authored timestamp or discovery run/model reference
  verification   run/time reference required for verified status
```

All fields are runtime validated; unknown keys, unsupported surfaces/actions, dangling refs,
duplicate IDs, invalid budgets, and parser/output mismatches are rejected. All business fields
are required in v1. Arbitrary regexes, optional/default fields, executable expressions, dynamic
URL templates, desktop selectors, and nested recovery capabilities are deliberately deferred.

### 3.2 Authored example

[`examples/get-member-savings-balance.json`](../examples/get-member-savings-balance.json) is
a schema-validated **draft authored by us**, not LLM discovery or replay evidence. It matches
Harbor Core v1.0, includes the separate View member click, and extracts the Savings row from
the account iframe using `table_cell` targeting. Final checks validate both outer and iframe
member identity and the USD currency.

The input is a five-digit string member ID. Outputs are `savingsBalanceCents` (integer cents)
and `currency` (string), avoiding floating-point monetary rounding. References use
`{ source: input, name: memberId }`, never guessed string substitution or concrete secrets.

### 3.3 Design rationale and storage

- Authored and observed exception handlers are distinct; a happy-path run cannot teach every
  business outcome. Fault tests must validate authored conditions separately.
- `prepareInvocation` checks exact app/version, inputs, and execution mode. Only read-only
  drafts can enter sandbox verification; normal replay requires verified read-only metadata.
  The future runner must still enforce actual UI policy and verify every checkpoint.
- Credentials are session-manager configuration, not persisted inputs or login capabilities.
  Reauthentication restarts at the entry navigation, then refills the member ID.
- The filesystem registry uses the full app/version/name/revision key, rejects overwrites,
  and publishes complete private files atomically. Status changes require a new revision.
  Verification metadata is a claim the real verification workflow must substantiate.
- Sensitive flags guide future evidence redaction; they do not sanitize arbitrary text.
  Registry persistence rejects supplied known sensitive values rather than altering selectors.
- `schemaVersion` and capability revision are independent. Unsupported schema versions fail
  explicitly. No migration layer is needed before a shipped/persisted compatibility requirement.

---

## 4. Discovery agent

### 4.1 Observation model **[REVISED]**

The agent observes a compact accessibility-oriented snapshot plus permitted URL/page context.
The web adapter owns a mapping from snapshot-scoped refs such as `[e12]` to actual elements
and frame scope. Merely adding IDs to `ariaSnapshot()` text does not create this mapping.
Phase 3 implements and tests ref-to-element resolution. Observations are bounded semantic DOM
views, not a claim of a complete browser accessibility tree. They stay in memory, not logs.

Invalidate refs on navigation or a new observation; recheck attachment and uniqueness before
acting. Duplicate names require frame/container scope, not an arbitrary first match. Capture
replay locators at action time; ephemeral refs never become persisted replay targets.

Role/name targeting is useful where semantics exist, but accessibility information can be
sparse on legacy markup too. Add scoped structural targeting for the implemented web surface.
Screenshots may supplement perception later; they are not a promise of generic visual replay.
Desktop and inaccessible surfaces remain design-only extensions, not solved by an enum field.

### 4.2 Tools (LLM-facing)

| Tool | Args | Notes |
|---|---|---|
| `observe` | — | returns snapshot; also auto-called after every action |
| `click` | `ref` | |
| `fill` | `ref`, `value: { source: input, name } \| { source: literal, value }` | Requires explicit parameter references; credentials stay in the session manager |
| `select` | `ref`, `option` | |
| `press` | `key` | |
| `navigate` | `url` | policy-checked against allowlist |
| `extract` | `ref`, `outputName`, `parse` | declares an output |
| `dismiss` | `ref` | for known interstitials; proposed as a bounded entry in `recoveries[]` |
| `note_outcome` | `code`, `detectorRef` | agent labels a business outcome it encountered |
| `complete` | `summary` | goal reached; triggers compilation |
| `request_human` | `reason` | escalation |

Before the loop starts, a single structured-output call turns the goal into a **capability
intent**: `{ name, description, inputs: { memberId: "12345" }, expectedOutputs }`. The loop
then knows the parameter names, so `fill` can reference `{ source: "input", name: "memberId" }` instead of a
literal — which is what makes the recorded artifact parameterizable without guessing.

### 4.3 Stopping conditions

- max steps (default 25), max wall-clock (default 3 min)
- repeated identical action ×3 → dead end
- policy violation → stop + evidence
- `request_human` → HITL state machine (§7)

### 4.4 Transcript → artifact compilation **[NEW]**

1. **Record** every tool call with: ref → resolved element's role, name, label, text, a
   generated CSS path, and bounding box. Multiple locator strategies are captured *at action
   time*, because that is the only moment the element is known to be correct.
2. **Preserve conservatively.** Returning to a URL does not prove intervening actions were
   irrelevant. A timeout also does not prove an action had no effect. Keep state-changing
   actions; only remove confirmed no-ops or reviewed redundancies and verify any simplification.
3. **Parameterize** via explicit input references in fills, selection, semantic targets, and
   checkpoints. V1 navigates fixed paths and clicks dynamic links; it does not interpolate
   inputs into CSS or URL strings. Reject accidentally embedded sensitive literals.
4. **Derive postconditions** from the observed state change after each action (URL change,
   new heading text) — proposed, then a human can edit.
5. **Emit** `CapabilityArtifact` with `status: draft`, validate with Zod.
6. **Verification replay:** for the read-only capability, reset the synthetic sandbox and use
   a fresh browser context at the declared entry point, not the discovery session's final page.
   Validate identity, account type, and output schema. Test another synthetic member to expose
   hardcoded values. Pass -> publish a new `verified` revision; fail -> retain the immutable
   draft plus sanitized diagnostics. Do not overwrite the saved draft's status/version.
   Never automatically replay writes for verification.
7. **Return the completed result**, with discovery and verification run IDs and separate
   artifact status. Do not execute again after verification. A completed business goal and a
   failed artifact verification are distinct facts; report both without blindly retrying the goal.

Step 6 is what makes the claim "the artifact replays deterministically" evidence-backed rather
than asserted. `complete` is a request to validate success, not authoritative proof of success.

---

## 5. Deterministic replay and error handling

### 5.1 Locator ladder **[REVISED]**

Each target holds an ordered `strategies[]`. The resolver tries each in order, requires exactly
one match, and records **which index resolved** in evidence (drift telemetry, see §9).

1. `role`: exact accessibility role and name.
2. `label`: exact form label association.
3. `text`: exact visible text.
4. `table_cell`: exact first-cell row label and header/one-based column, in a unique table.
5. `css`: a literal structural fallback.

Explicit frame/container scope applies to all strategies. XPath and visual targets are
design-only extensions and are rejected by the current schema, not silently treated as supported.

No strategy resolving → `FAILURE / TARGET_NOT_FOUND` with the snapshot attached.
Ambiguous matches stop unless an explicitly scoped strategy resolves the intended element;
never use `.first()` to hide ambiguity. Targets and conditions carry frame/container scope.
Unsupported target kinds fail clearly rather than pretending another surface was supported.

### 5.2 Step execution loop

```text
validate artifact, inputs, app compatibility, and execution mode
establish entry state and session preconditions
for step in artifact.steps:
    verify run is active                    # human ownership transitions arrive in Phase 6
    evaluate hard-stop, business-outcome, and recovery detectors
    wait for readiness while also checking exceptional states (bounded)
    resolve scoped target uniquely; classify actual node; enforce policy
    guard state and dispatch atomically; grant exact POST destination/body if needed
    evaluate exceptional states and assert postcondition (bounded)
verify requested member, account, and final checkpoint
parse and validate every declared output
return SUCCESS with outputs
```

Detectors run **after** each action as well as before the next, because an outcome typically
appears as a result of the action just taken.
Recovery is bounded across the run and uses the same policy path. Every successful recovery,
including notice dismissal, clears partial outputs and restarts this read-only flow at entry.
This prevents stale values from being returned after recovery changes the page. Nonfatal action
errors allow a bounded detector inspection, not blind redispatch. Policy/network/deadline
failure cancels pending operations. Unknown dialogs currently fail and close the session;
real human escalation/resume is Phase 6 work.

### 5.3 Result contract

Implemented in `src/artifact/result.ts`: `SUCCESS` with exact typed outputs,
`BUSINESS_OUTCOME` with an artifact-declared code, `FAILURE` with a sanitized diagnostic,
or `NEEDS_HUMAN` with an intervention reference. Common metadata carries run ID, step ID,
safe evidence filenames, and bounded recovery records. Only pre-step failures use a null
step and can be parsed without an artifact. Success identifies the final step and cannot
contain exhausted recoveries. See [the contract guide](CONTRACTS.md) for exact invariants.

`RECOVERABLE` is not a terminal result kind: it is an internal event. A recoverable condition
either recovers (and the run continues, recorded in evidence) or exhausts attempts and becomes
`FAILURE / RECOVERY_EXHAUSTED`. Exposing it to the caller as a result would leak an
implementation detail they cannot act on.

---

## 6. Safety and policy

- **Single choke point:** `PolicyLayer.check(action, context)` runs inside the `SurfaceAdapter`
  before every action, for discovery *and* replay. Prompt instructions are hints; the adapter is
  the enforcement.
- **Allowlist config** (`policy.yaml`): permitted origins, permitted path patterns, permitted
  action types, per-app. Phase 2 implements strict YAML loading and pure request/action
  authorization. Origins are exact, paths have only a five-digit member placeholder, and
  unknown/duplicate query parameters fail closed. Action grants use trusted adapter-derived
  target identities, not model risk labels. Conflicting overlapping rules are rejected.
  Phase 3 connects these decisions to the actual browser and transport.
- **Pre-request checks:** a mandatory Chromium HTTP proxy checks every hop before opening an
  upstream connection. A real experiment found ordinary Playwright routing could miss later
  redirect hops, so it is not the sole boundary. Every POST also requires a one-use grant for
  the exact destination and form bytes. Unauthorized traffic revokes forwarding immediately
  and closes the context, rather than waiting for a pending click to finish.
- **Headed browser isolation:** a private context marker separates controlled-page requests
  from Chromium background services. Unmarked traffic is still denied and cannot spend POST
  grants, but does not abort startup. Controlled-page policy violations remain fatal. The
  marker is stripped upstream and never persisted; headed watching was manually verified.
- **Dispatch guard:** disabled controls are not queued. Node/document/form state and actual
  classification are rechecked after evidence writes; a final check and fixed DOM dispatch
  occur in one browser task. This deliberately supports the server-rendered target, not apps
  requiring physical/isTrusted input events. No model-authored JavaScript is executed.
- **Unsupported channels:** CONNECT/HTTPS tunnels, WebSockets, service workers, downloads,
  and extra pages are blocked. Non-network URLs are not valid navigate actions. The local
  HTTP-only prototype is not a general browser/OS sandbox; see REPLAY.md for limits.
- **Risk classification:** application-owned action/target policy is authoritative. LLM labels
  and button-name heuristics may flag risk but cannot authorize actions. Unknown or irreversible
  actions are blocked in the prototype, including during discovery and recovery. Treat UI text
  as untrusted data, never instructions that can widen policy. Human handoff is not a bypass.
- **Synthetic data only:** use no real bank systems, real credentials, or real PII. Environment
  secrets must never enter artifacts, error messages, raw model transcripts, or normal logs.
- **Structured redaction:** sanitize inputs, outputs, URLs, targets, tool results, and errors
  before writing JSONL. Equality replacement alone is insufficient for derived/encoded values.
  Schema flags guide redaction but do not sanitize arbitrary UI text automatically.
- **Rich evidence:** Phase 3 persists structural DOM snapshots, not screenshots. Only normalized
  route templates, approved tags/roles, counts, visibility and presence booleans are accepted.
  Raw text, attribute values, signatures, screenshots, traces, videos and browser storage are
  excluded. An unavailable/closed surface is represented explicitly, not silently omitted.
- **Limits:** browser interception and app-specific masking are not a general browser sandbox
  or a regulated-data compliance solution. Test the supported web paths, document unsupported
  channels, and never claim arbitrary PII detection. The headed browser assumes a trusted local
  operator; OS/browser-chrome activity is not fully controlled or recorded.

---

## 7. Human-in-the-loop **[REVISED; planned for Phase 6]**

### 7.1 Control-transfer state machine

```text
AUTOMATION -> WAITING_FOR_HUMAN -> HUMAN_CONTROL -> VALIDATING_RESUME
     ^                                                |
     +------------ validated safe state --------------+
Resume validation failure -> remain paused; abort -> terminal cancelled result
```

`RunContext.controlOwner ∈ { automation, human:<operatorId>, none }`. The replay engine and
discovery loop both check ownership before every action; if not `automation`, they block on a
promise resolved only after resume validation succeeds. Quiesce in-flight actions before
allowing a claim; ownership checks alone cannot cancel an action already dispatched. Reject
duplicate claims and non-owner resume requests. This is the seam the brief asks about.

### 7.2 Mechanism

- Browser runs **headed**. The operator uses the *same* Chromium window — literally the same
  session, cookies, page state. No second session, no co-browsing infra.
- Intervention record: `{ id, runId, goalOrCapability, stepId, reason, screenshotPath,
  snapshotPath, url, createdAt, controlOwner }` written to disk and printed to console.
- Minimal HTTP: `GET /interventions`, `POST /interventions/:id/claim`,
  `POST /interventions/:id/resume { action: retry_step | skip_step | abort, note }`.
  Bind to loopback, require a per-run operator token, and validate state transitions. The
  operator UI is `curl` or a small page; remote authentication/co-browsing is not built.
- **Resume semantics:** `skip_step` requires a declared postcondition proving the human
  completed it. `retry_step` requires the expected pre-state and a safely repeatable action.
  Without either proof, remain paused or abort. Never retry a possibly completed write or
  allow skipping a blocked irreversible action. Recheck target, member identity, and policy.
- **Recording what the human did:** use context/page bindings plus init scripts so sanitized
  click/input metadata is captured across supported frames and navigation. Gate recording on
  human ownership; do not record typed values. Capture masked before/after state. Native
  dialogs, browser chrome, and OS activity need separate handling or explicit limitations.
- **Triggers:** discovery `request_human`; exhausted safe recovery; an unknown dialog; a
  blocked/risky step needing operator assessment. Assessment may abort or restore a safe state,
  but cannot authorize an irreversible operation that the prototype policy prohibits.

---

## 8. Evidence and observability

- Phase 3 writes `artifacts/runs/<runId>/events.jsonl`, with strict structural event fields:
  run/time, phase, step, action, trusted target key, strategy index, recovery attempt/outcome,
  and terminal code. No raw values, URLs, selectors, or exception objects are accepted.
- `snapshot_N.json` is the richer failure signal, with bounded, content-free DOM structure.
  Known sensitive values are additionally redacted from metadata; arbitrary PII detection is
  not claimed. Business outputs return to the caller, not the persisted log.
- Reviewed real runs are under `evidence/replay-phase3/`. The original run IDs/timestamps are
  retained, and the source artifact is explicitly authored/draft. Discovery/model-decision and
  human-handoff evidence will be added only when those later phases actually run.

---

## 9. Heterogeneity and multi-tenant (design only)

### 9.1 Surface abstraction

The implemented adapter exposes `observe`, `resolve`, `act`, `checkCondition`, `navigate`,
`authenticate`, `snapshot`, `health`, and `close`. `resolve` returns an opaque, node-bound ref;
raw Playwright pages are not exposed to model tools. The precise web API is in
`src/surface/playwright-adapter.ts`; avoid a speculative generic desktop implementation.

The business contract and replay control structure are reusable, but targets and some
conditions are surface-specific, including navigation/session lifecycle. Adapter selection is application configuration, not an
LLM decision. Chromium is a browser, not a Playwright-only technology; Playwright also supports
Firefox and WebKit. Legacy web can still use Playwright even when markup is non-semantic.

A desktop surface needs a new adapter (for example OS accessibility APIs) and possibly a new
surface-specific flow. It is not guaranteed to use identical steps or locators. Tag locator
kinds, validate adapter support, and fail explicitly on unsupported capabilities. Adding
`surface: desktop` alone does not implement desktop automation. OCR/visual targeting remains
design-only; the prototype implements one local web app, including scoped iframe traversal.

### 9.2 Multi-tenant reuse

- Artifact is keyed by `(appId, appVersion)`, not tenant. Tenants bind to an artifact via a
  small **override document**: `{ tenantId, appId, artifactName, artifactVersion,
  stepOverrides: { [stepId]: { target?, value?, waitFor? } }, entryUrl, extraRecoverables[] }`.
  Overrides are merged at load time; stable step IDs make this safe.
- **Drift detection:** the replay engine records `strategyIndex` per step. A
  tenant whose steps consistently resolve on index ≥ 2 (fell past role/label) or whose
  postcondition timings degrade is flagged. Repeated `TARGET_NOT_FOUND` on one tenant with
  success on others → propose an override, never a re-record.
- **Canonicalization** (stretch): `/members/12345` → `/members/:memberId` in `url_matches`
  conditions by matching against known input values at compile time.

---

## 10. Scope and implementation plan

### 10.1 Cut lines

**Build:** mock app with fault injection; discovery agent (real LLM run); compiler +
verification replay; replay engine with ladder, detectors, result contract; policy layer;
HITL state machine + HTTP + headed handoff + human-action capture; evidence; capability
router (`agent --goal`) as the agent-facing entrypoint; tests where it counts; README + REPORT.

**Mock / declare only:** operator UI (curl + static page), `visual` strategy, desktop adapter,
tenant override merging (schema + one unit test, no second app variant unless time allows),
canonicalization.

**Do not build:** queues, DB, auth, multi-process, dashboards, OpenTelemetry export.

### 10.2 Phases

Each phase ends in something runnable and verified. Commit/push only when requested. Do not
start the next phase until its prerequisites and the review gates above have passing tests.

| Phase | Deliverable | Definition of done |
|---|---|---|
| **0. Skeleton** (½ day) | TypeScript, pinned tooling/lockfile, pnpm, Vitest, Playwright/Chromium, validated environment config, deny-by-default policy template, secret/evidence ignore rules, README | Lint + typecheck + meaningful config tests + real browser smoke test pass without model keys; no future-phase stubs presented as working |
| **1. Mock app** (½–1 day) | Hono server: login, member search, member detail (iframe accounts panel); synthetic fixtures, reset hook, fault toggles, risky control blocked from automation | Read-only flow works manually, another member has distinct data, reset restores entry state, faults produce expected states; second business flow deferred |
| **2. Artifact schema + policy** (completed) | Strict artifact/target/condition/result schemas; explicit input references, integer cents, invocation eligibility, immutable registry; pure policy decisions | Contract, parser, corruption/symlink/concurrent-write, secret-guard, route/action, overlapping-risk, and bounded-recovery tests pass; example remains authored/draft |
| **3. Surface adapter + replay engine** (completed) | Node-bound refs, scoped targeting, guarded DOM dispatch, mandatory HTTP proxy/POST grants, bounded replay/recovery, CLI, structural evidence | Actual authored-draft runs: success, not-found, recovery, hard failure; stale/ambiguous refs, wrong-frame identity, late control mutation, redirects, cancellation, and evidence tests pass; no LLM dependency |
| **4. Discovery agent** (completed) | intent extraction, redacted semantic observation with node refs, seven schema-checked tools, bounded loop with trusted classification and completion verification, sanitized transcript recorder, OpenAI client with per-call receipts, `pnpm discover` CLI | Offline: test-only models complete the goal in varying orders and every unsafe proposal is rejected. Live: `gpt-4.1` completed the balance goal in 9 turns and reported a verified not-found outcome; transcripts + events reviewed in `evidence/discovery-phase4/` |
| **5. Compiler + verification** (½–1 day) | conservative transcript compilation, explicit handler provenance, fresh-state sandbox verification | Discovered artifact replays with two synthetic member IDs; output/identity checks pass; ambiguous action effects are not pruned; writes are never automatically verified |
| **6. HITL** (½–1 day) | state machine, loopback HTTP, ownership, navigation-safe human recorder, validated resume | Same-session handoff and completion; negative tests for competing claims, unsafe skip/retry, stale state, blocked actions, and recording after navigation |
| **7. Capability router** (½ day) | `pnpm agent --goal`: compatible catalog supplied upfront; structured execute/discover/clarify decision | Cold run discovers and verifies without extra execution; warm run replays; ambiguous goals clarify; no rediscovery on policy denial; no automatic duplicate writes |
| **8. Evidence set + docs** (½–1 day) | reviewed `evidence/`, README (setup, agent and direct commands, offline replay), REPORT with seven exact headings | Fresh-clone demo works; evidence review finds no secrets/raw sensitive captures; README distinguishes completed work from future plans |
| **9. Stretch** (only if 0–8 solid) | second app variant with tenant overrides *or* multi-run stability score | One shown end-to-end |

Time-box target: **about 7 focused days**, not a delivery guarantee; the phase estimates may
exceed it. Reassess at each gate and cut the optional second flow/visual extras first.
Phase 7 is small because it only composes pieces from Phases 3–5; if it threatens the
time-box, it is the first thing to cut back to "explicit commands only."

### 10.3 Demo path (target for README)

The `pnpm agent` router and operator endpoints below remain planned. The implemented Phase 3
replay and Phase 4 discovery paths are shown separately so a draft is never silently promoted
or run outside verification, and a discovery transcript is never mistaken for an artifact. Generated evidence stays ignored until reviewed for publication.

```bash
pnpm mock-app                                                   # terminal 1

# Agent-facing path: one goal, the router decides
pnpm agent --goal "look up member 12345 and read their current savings balance"
#   cold: discover -> compile -> reset sandbox -> verify -> return completed result; no extra execution
pnpm agent --goal "look up member 67890 and read their current savings balance"
#   warm: routes to get_member_savings_balance → replay only, no discovery, no UI reasoning

# Implemented now (Phase 4): live OpenAI discovery against an owned sandbox → sanitized transcript
# Requires OPENAI_API_KEY in the ignored .env. Compilation into an artifact is Phase 5.
pnpm discover --goal "look up member 12345 and read their current savings balance" --sandbox
pnpm discover --goal "look up member 12345 and read their current savings balance" \
              --target http://localhost:4000/

# Implemented now: owned sandbox, authored draft, no model
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification
# Add --fault session_expired or --fault permission_denied for exceptional runs.
# --fault unexpected_confirm currently fails UNEXPECTED_DIALOG; no fake handoff.

# Once a verified registry revision exists, normal model-free replay is also available:
pnpm replay get_member_savings_balance --version 2 --inputs '{"memberId":"67890"}'

# Planned operator signaling (Phase 6)
curl -X POST "http://localhost:4100/interventions/$INTERVENTION_ID/claim" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
#   ... operator acts in the headed browser ...
curl -X POST "http://localhost:4100/interventions/$INTERVENTION_ID/resume" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"retry_step"}'
# Resume succeeds only if the expected pre-state and safe-retry conditions are verified.
```

---

## 11. Decisions carried forward

1. Preserve the implemented `table_cell` exact row/header matching and explicit iframe scope. Validate
   uniqueness, stale refs, and requested member identity; never hide ambiguity with `.first()`.
2. Re-login is a session-manager operation using runtime credentials, not nested capability
   execution. Reauthentication restarts at the safe entry step and refills inputs.
3. Use the trusted Harbor target classifier for action authorization. A model
   cannot supply its own `targetKey`; a known and an unknown notice share a route but not a grant.
4. Keep vision and desktop execution out of this slice. The schema deliberately rejects
   unimplemented target kinds; describe future extension in the report without claiming reuse
   of identical steps across unrelated surfaces.
5. Headed handoff remains local and same-session. Phase 6 must define safe resumed-result
   semantics, especially after an exhausted automatic recovery, without deleting audit history.
