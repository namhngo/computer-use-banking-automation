# Proposal: Computer-Use Automation System (interface.ai take-home)

> Working document. Sections marked **[REVISED]** changed from the original draft after review
> against the brief; **[NEW]** sections were missing entirely. Rationale for each change is inline
> so the reasoning can be lifted into `REPORT.md` later.

**Implementation status:** Phases 0 and 1 completed on 2026-09-11. `pnpm check` passes lint,
strict typechecking, 45 configuration/HTTP/CLI tests, and 13 Chromium tests (including desktop,
mobile, iframe failure, session recovery, reset isolation, and both shutdown signals).
See `README.md` for runnable setup, `pnpm mock-app`, environment configuration, and fault commands.
Phases 2 onward are still planned; no real discovery or replay evidence exists yet.

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
| 1 | Error taxonomy existed only in the *result type*, not in the *artifact* | Replay cannot know "Member not found" is a business outcome unless the artifact declares it | §3: `outcomes[]` and `recoverable[]` declared in schema |
| 2 | Transcript → artifact compilation hand-waved | Parameterization, conservative action retention, locator capture | §4.4: explicit compile + sandbox verification replay |
| 3 | Locator ladder was entirely DOM-based | Brief says "bias toward an approach that still works with no clean DOM" | §4.1 / §5.1: accessibility-tree observation, `visual` strategy in schema as declared seam |
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

One Node process, CLI-driven, plus a tiny HTTP server that exists only for the HITL handoff
signal. No queue, no DB, no services. The brief explicitly says not to build scaling
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
  evidence/       structured JSONL event log, screenshot capture, redaction
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
| Browser control | Playwright | Locators, auto-waiting, accessibility observations, headed mode for HITL; masked failure screenshots rather than raw traces |
| LLM layer | Vercel AI SDK + `@ai-sdk/anthropic` | Check compatible stable versions when introduced in Phase 4; pin exact versions and lockfile, rather than assuming the earlier v5 choice |
| Model | A supported tool-calling model configured via env | Verify model ID and provider access in Phase 4; record actual usage rather than promise a fixed cost |
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

### 3.1 Shape

```text
CapabilityArtifact
├── schemaVersion            "1.0" — schema evolution, separate from capability version
├── identity
│   ├── name                 snake_case, e.g. get_member_savings_balance
│   ├── version              integer, bumped on any step/target change
│   ├── description          human + agent readable
│   └── status               draft | verified | approved     (gates unattended replay)
├── app                       [NEW] identity of the surface this was recorded on
│   ├── appId                e.g. cu-backoffice
│   ├── appVersion           e.g. 3.2
│   ├── entryUrl
│   └── surface              web | legacy-web | desktop
├── risk                      read_only | reversible | irreversible   (= max over steps)
├── inputs                    { name: { type, required, description, sensitive, pattern? } }
├── outputs                   { name: { type, description, sensitive } }
├── steps[]                   ordered; each has a STABLE id (used by overrides + evidence)
│   ├── id                   e.g. s3_click_search
│   ├── action               navigate | click | fill | select | press | extract | wait | dismiss
│   ├── target               { strategies[] }  — ordered locator ladder, see §5.1
│   ├── value?               literal or {{inputName}} template
│   ├── output?              output name (extract only)
│   ├── parse?               [NEW] none | number | currency | date   (extract only)
│   ├── risk                 per-step classification
│   ├── waitFor?             condition before acting (url / text / role visible)
│   └── postcondition?       [NEW] condition asserting the step "took" — per-step checkpoint
├── outcomes[]                [NEW] declared business outcomes — detected after any step
│   └── { code, detector, description }      e.g. MEMBER_NOT_FOUND ← text "No member found"
├── recoverable[]             [NEW] known runtime conditions + deterministic recovery
│   └── { code, detector, recovery: dismiss | retry | rerun_steps[] , maxAttempts }
├── checkpoint                final success condition (goal actually reached)
└── provenance                [NEW] { discoveryRunId, model, recordedAt, verifiedAt, recordedBy }
```

### 3.2 Example

Illustrative contract, not an executable fixture. Phase 2 finalizes condition/target unions;
Phase 3 validates them against the actual mock UI, including explicit iframe scope. The runner
establishes the declared entry state and session preconditions before the first step.

```json
{
  "schemaVersion": "1.0",
  "identity": {
    "name": "get_member_savings_balance",
    "version": 1,
    "description": "Look up a member by ID and return their current savings balance.",
    "status": "verified"
  },
  "app": { "appId": "cu-backoffice", "appVersion": "3.2", "entryUrl": "http://localhost:4000/", "surface": "legacy-web" },
  "risk": "read_only",
  "inputs": {
    "memberId": { "type": "string", "required": true, "pattern": "^[0-9]{5}$", "sensitive": true,
                  "description": "Member number as shown in the core system" }
  },
  "outputs": {
    "savingsBalance": { "type": "number", "sensitive": true, "description": "Current savings balance in USD" }
  },
  "steps": [
    {
      "id": "s1_fill_member_id",
      "action": "fill",
      "target": { "strategies": [
        { "type": "role", "role": "textbox", "name": "Member ID" },
        { "type": "label", "text": "Member ID" },
        { "type": "css", "selector": "form[action='/members/search'] input[name='q']" }
      ]},
      "value": "{{memberId}}",
      "risk": "read_only"
    },
    {
      "id": "s2_click_search",
      "action": "click",
      "target": { "strategies": [
        { "type": "role", "role": "button", "name": "Search" },
        { "type": "text", "text": "Search", "exact": true }
      ]},
      "risk": "read_only",
      "postcondition": { "type": "any_of", "conditions": [
        { "type": "url_matches", "pattern": "/members/\\d+" },
        { "type": "text_present", "text": "No member found" }
      ]}
    },
    {
      "id": "s3_extract_balance",
      "action": "extract",
      "target": { "strategies": [
        { "type": "role", "role": "cell", "name": "Savings balance", "relation": { "sibling": "next" } },
        { "type": "css", "selector": "#accounts tr:has(td:text-is('Savings')) td:nth-child(3)" }
      ]},
      "output": "savingsBalance",
      "parse": "currency",
      "risk": "read_only"
    }
  ],
  "outcomes": [
    { "code": "MEMBER_NOT_FOUND", "detector": { "type": "text_present", "text": "No member found" },
      "description": "No member exists with the given ID." },
    { "code": "INVALID_MEMBER_ID", "detector": { "type": "text_present", "text": "Member ID must be 5 digits" },
      "description": "Input rejected by the application's validation." }
  ],
  "recoverable": [
    { "code": "SESSION_EXPIRED", "detector": { "type": "url_matches", "pattern": "/login" },
      "recovery": { "type": "rerun_capability", "name": "login" }, "maxAttempts": 1 },
    { "code": "SYSTEM_NOTICE", "detector": { "type": "role_visible", "role": "dialog", "name": "System notice" },
      "recovery": { "type": "click", "target": { "strategies": [ { "type": "role", "role": "button", "name": "OK" } ] } },
      "maxAttempts": 2 }
  ],
  "checkpoint": {
    "type": "all_of",
    "conditions": [
      { "type": "member_matches_input", "input": "memberId" },
      { "type": "account_type_matches", "value": "Savings" },
      { "type": "output_valid", "output": "savingsBalance" }
    ]
  },
  "provenance": { "discoveryRunId": "run_01J...", "model": "claude-sonnet-4", "recordedAt": "2026-09-12T10:00:00Z", "verifiedAt": "2026-09-12T10:01:30Z" }
}
```

### 3.3 Design rationale (for REPORT.md)

- **Outcomes and recoverables are in the artifact** because they are properties of the
  application. A successful discovery cannot reveal every exception. Record which handlers
  were observed versus manually authored, and validate authored handlers using fault injection.
  Do not present unobserved exception behavior as learned by the model.
- **Stable step IDs** make tenant overrides, evidence, and human resume (`retry_step s2`)
  possible without positional coupling.
- **Per-step postconditions** turn "click worked" from an assumption into an assertion, which is
  what makes failures debuggable (expected X, observed Y, at step s2).
- **`status` gate:** draft artifacts run only in explicit sandbox verification mode. Verified
  read-only artifacts may replay on the configured synthetic local target. Approval is a
  separate future gate for unattended non-sandbox execution, not something the model grants
  itself. The prototype blocks irreversible actions regardless of artifact status.
- **`sensitive` flags** drive redaction in logs and evidence at the schema level, not by
  regex guessing.
- **`schemaVersion` vs `identity.version`**: schema evolution and capability evolution are
  independent concerns.

---

## 4. Discovery agent

### 4.1 Observation model **[REVISED]**

The agent observes a compact accessibility-oriented snapshot plus permitted URL/page context.
The web adapter owns a mapping from snapshot-scoped refs such as `[e12]` to actual elements
and frame scope. Merely adding IDs to `ariaSnapshot()` text does not create this mapping.
Phase 3 must prove ref-to-element resolution before Phase 4 relies on it.

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
| `fill` | `ref`, `valueFrom: { input: name } \| { literal: string }` | **forces parameterization** — the agent must say which declared input it is typing |
| `select` | `ref`, `option` | |
| `press` | `key` | |
| `navigate` | `url` | policy-checked against allowlist |
| `extract` | `ref`, `outputName`, `parse` | declares an output |
| `dismiss` | `ref` | for interstitials; recorded into `recoverable[]` |
| `note_outcome` | `code`, `detectorRef` | agent labels a business outcome it encountered |
| `complete` | `summary` | goal reached; triggers compilation |
| `request_human` | `reason` | escalation |

Before the loop starts, a single structured-output call turns the goal into a **capability
intent**: `{ name, description, inputs: { memberId: "12345" }, expectedOutputs }`. The loop
then knows the parameter names, so `fill` can reference `{ input: "memberId" }` instead of a
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
3. **Parameterize** via `valueFrom.input` references. Bind member IDs in navigation, selection,
   targets, and checkpoints as well as fills; reject accidentally embedded sensitive literals.
4. **Derive postconditions** from the observed state change after each action (URL change,
   new heading text) — proposed, then a human can edit.
5. **Emit** `CapabilityArtifact` with `status: draft`, validate with Zod.
6. **Verification replay:** for the read-only capability, reset the synthetic sandbox and use
   a fresh browser context at the declared entry point, not the discovery session's final page.
   Validate identity, account type, and output schema. Test another synthetic member to expose
   hardcoded values. Pass -> `verified`; fail -> retain a draft plus sanitized diagnostics.
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

1. `role` — accessibility role + name (+ optional relation: within / sibling / nth)
2. `label` — form label association
3. `text` — visible text, exact or contains
4. `css` — generated at record time, generic-class-tolerant
5. `xpath` — legacy fallback
6. `visual` — **declared, not implemented**: anchor text + offset or normalized coordinates on
   a screenshot. This is the seam for surfaces with no accessibility tree.

No strategy resolving → `FAILURE / TARGET_NOT_FOUND` with the snapshot attached.
Ambiguous matches stop unless an explicitly scoped strategy resolves the intended element;
never use `.first()` to hide ambiguity. Targets and conditions carry frame/container scope.
Unsupported target kinds fail clearly rather than pretending another surface was supported.

### 5.2 Step execution loop

```text
validate artifact, inputs, app compatibility, and execution mode
establish entry state and session preconditions
for step in artifact.steps:
    await automation ownership
    evaluate hard-stop, business-outcome, and recovery detectors
    wait for readiness while also checking exceptional states (bounded)
    enforce policy; resolve scoped target uniquely
    perform action with typed parameter binding
    evaluate exceptional states and assert postcondition (bounded)
verify requested member, account, and final checkpoint
parse and validate every declared output
return SUCCESS with outputs
```

Detectors run **after** each action as well as before the next, because an outcome typically
appears as a result of the action just taken.
Recovery is bounded across the run and uses the same policy path. After re-login, restore and
verify a known safe resume state rather than blindly retrying a detail-page step on the login
landing page. Retry only operations whose repetition is safe; uncertain write effects escalate.
Never automatically dismiss unknown confirmation dialogs.

### 5.3 Result contract

```ts
type ReplayResult =
  | { kind: 'SUCCESS'; outputs: Record<string, unknown>; evidence: EvidenceRef }
  | { kind: 'BUSINESS_OUTCOME'; code: string; message: string; atStep: string; evidence: EvidenceRef }
  | { kind: 'FAILURE'; code: FailureCode; atStep: string; expected: string; observed: string;
      recoveryAttempted: RecoveryRecord[]; evidence: EvidenceRef }
  | { kind: 'NEEDS_HUMAN'; interventionId: string; reason: string; atStep: string }

type FailureCode = 'TARGET_NOT_FOUND' | 'AMBIGUOUS_TARGET' | 'POSTCONDITION_FAILED'
  | 'CHECKPOINT_FAILED' | 'TIMEOUT' | 'PERMISSION_DENIED' | 'APP_ERROR'
  | 'POLICY_BLOCKED' | 'RECOVERY_EXHAUSTED' | 'UNEXPECTED_DIALOG'
```

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
  action types, per-app. Phase 0 supplies a deny-by-default template only; Phase 2 implements
  schema validation and Phase 3 enforces it. Configuration alone is not a security boundary.
- **Pre-request checks:** validate explicit destinations before navigation and install browser
  context request interception before opening pages. Test disallowed requests triggered by
  clicks, form submissions, redirects, frames, and popups. Block service workers in the
  prototype; block or explicitly handle channels outside ordinary HTTP routing. Separate
  permitted resource loading from permitted UI actions. Keep post-navigation checks as defense
  in depth, not as prevention of a request that already happened.
- **Risk classification:** application-owned action/target policy is authoritative. LLM labels
  and button-name heuristics may flag risk but cannot authorize actions. Unknown or irreversible
  actions are blocked in the prototype, including during discovery and recovery. Treat UI text
  as untrusted data, never instructions that can widen policy. Human handoff is not a bypass.
- **Synthetic data only:** use no real bank systems, real credentials, or real PII. Environment
  secrets must never enter artifacts, error messages, raw model transcripts, or normal logs.
- **Structured redaction:** sanitize inputs, outputs, URLs, targets, tool results, and errors
  before writing JSONL. Equality replacement alone is insufficient for derived/encoded values.
  Schema flags guide redaction but do not sanitize arbitrary UI text automatically.
- **Rich evidence:** use field-masked screenshots or sanitized snapshots. Apply masking before
  capture/persistence, including supported frames; if safe capture is uncertain, omit the image
  and retain sanitized diagnostics. Raw Playwright traces, videos, network dumps, and browser
  storage state are off by default and are not submission evidence.
- **Limits:** browser interception and app-specific masking are not a general browser sandbox
  or a regulated-data compliance solution. Test the supported web paths, document unsupported
  channels, and never claim arbitrary PII detection. The headed browser assumes a trusted local
  operator; OS/browser-chrome activity is not fully controlled or recorded.

---

## 7. Human-in-the-loop **[REVISED]**

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

- One JSONL file per run: `evidence/<runId>/events.jsonl`. Event: `{ ts, runId, phase:
  discovery|compile|verify|replay|hitl, stepId?, type, action?, target?, resolvedStrategyIndex?,
  result?, outcome?, failure?, controlOwner, durationMs }`. Discovery events also include the
  model's stated reasoning for the action (from the tool call), redacted.
- Masked screenshots or sanitized snapshots at failures and HITL transitions provide the
  richer signal. Optional checkpoints use the same capture policy. Raw traces remain off.
- Generated runs live in ignored `artifacts/`. Only explicitly reviewed, sanitized examples
  are copied into committed `evidence/`; never commit a raw discovery transcript or API key.
- `evidence/` committed set: `discovery/` (real LLM run), `replay-success/`,
  `replay-member-not-found/`, `replay-session-expired-recovered/`, `replay-hard-failure/`,
  `hitl-handoff/`, plus the saved artifact JSON.

---

## 9. Heterogeneity and multi-tenant (design only)

### 9.1 Surface abstraction

```ts
interface SurfaceAdapter {
  observe(): Promise<Snapshot>                       // a11y-tree-shaped, ref-addressed
  resolve(target: Target): Promise<Handle | null>    // runs the ladder
  act(handle: Handle, action: Action): Promise<void>
  checkCondition(c: Condition): Promise<boolean>
  screenshot(): Promise<Buffer>
}
```

The business contract and replay control structure are reusable, but targets and some
conditions are surface-specific. The illustrative adapter interface will be refined in Phase 3,
including navigation/session lifecycle. Adapter selection is application configuration, not an
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
- **Drift detection:** the replay engine already records `resolvedStrategyIndex` per step. A
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
| **2. Artifact schema + policy** (½ day) | Zod schemas for artifact, conditions, targets, results; registry (fs); `PolicyLayer` | Unit tests: valid/invalid artifacts, template binding, allowlist decisions, risk classification |
| **3. Surface adapter + replay engine** (1 day) | `PlaywrightAdapter`, scoped refs/locators, waits, detectors, policy enforcement, sanitized evidence | Hand-written artifact: success, not-found, session recovery, hard failure; also stale/ambiguous refs, iframe scope, identity/output validation, blocked network/action paths, and redaction tests; replay has no model dependency |
| **4. Discovery agent** (1 day) | intent extraction, a11y snapshot with refs, tools, bounded loop, transcript recorder | One real LLM run completes the balance goal against the mock app; transcript + events saved |
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

These are planned commands, not Phase 0 functionality. The configured default target is the
single local app; explicit `--target` remains supported and policy-checked. The first demo uses
an empty sandbox registry. Generated evidence stays ignored until reviewed for publication.

```bash
pnpm mock-app                                                   # terminal 1

# Agent-facing path: one goal, the router decides
pnpm agent --goal "look up member 12345 and read their current savings balance"
#   cold: discover -> compile -> reset sandbox -> verify -> return completed result; no extra execution
pnpm agent --goal "look up member 67890 and read their current savings balance"
#   warm: routes to get_member_savings_balance → replay only, no discovery, no UI reasoning

# Explicit path: each stage on its own (required by brief; used for evidence + fault injection)
pnpm discover --goal "look up member 12345 and read their current savings balance" \
              --target http://localhost:4000                    # real LLM run → artifact
pnpm replay get_member_savings_balance --input memberId=12345   # SUCCESS
pnpm replay get_member_savings_balance --input memberId=99999   # BUSINESS_OUTCOME MEMBER_NOT_FOUND
pnpm replay get_member_savings_balance --input memberId=12345 --fault session_expired   # recovered
pnpm replay get_member_savings_balance --input memberId=12345 --fault permission_denied # FAILURE
pnpm replay get_member_savings_balance --input memberId=12345 --fault unexpected_confirm # NEEDS_HUMAN
curl -X POST "http://localhost:4100/interventions/$INTERVENTION_ID/claim" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
#   ... operator acts in the headed browser ...
curl -X POST "http://localhost:4100/interventions/$INTERVENTION_ID/resume" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"retry_step"}'
# Resume succeeds only if the expected pre-state and safe-retry conditions are verified.
```

---

## 11. Open questions to settle before Phase 3

1. Extraction locator for table cells: `role=cell` + sibling relation vs. a `table` strategy
   (`{ type: 'table', rowHeader: 'Savings', column: 'Balance' }`). The latter is more legible
   for reviewers and closer to how legacy screens are actually read. Lean: add `table` as a
   first-class strategy.
2. Should `recoverable.recovery.rerun_capability` (re-login) be allowed to nest, or is one level
   enough? Lean: one level, hard-coded, to avoid recursive replay.
3. Vision: send screenshots to the model during discovery or a11y-only? Lean: a11y-only by
   default, `--vision` flag. Keeps cost and evidence size down; note as a knob in the report.
4. Headed handoff: the operator must be on the same machine. State this limit and describe CDP
   endpoint exposure / noVNC as the production path in REPORT.md §5.
