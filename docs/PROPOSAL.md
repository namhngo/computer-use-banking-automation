# Proposal: Computer-Use Automation System (interface.ai take-home)

> Working document. Sections marked **[REVISED]** changed from the original draft after review
> against the brief; **[NEW]** sections were missing entirely. Rationale for each change is inline
> so the reasoning can be lifted into `REPORT.md` later.

---

## 0. Assessment summary

**Is the original proposal on the right track?** Yes. The core framing — *the agent decides what
capability to use; the capability determines how the UI is operated* — is exactly the brief's
through-line ("the model discovers, the artifact becomes a capability, deterministic replay is
how the agent invokes it"). The result taxonomy, explicit HITL state machine, and scope
discipline are all aligned with the evaluation criteria.

**Is it doable?** Yes, as a focused 4–6 day effort. The scaffolding (loop, schemas, replay,
guardrails, logging) is fast with AI-assisted development; the brief says so itself. The time
goes into the judgment pieces: artifact schema, transcript-to-artifact compilation, error
taxonomy, and the HITL seam.

**Gaps fixed in this revision (ordered by grading impact):**

| # | Gap in original draft | Why it matters | Fix |
|---|---|---|---|
| 1 | Error taxonomy existed only in the *result type*, not in the *artifact* | Replay cannot know "Member not found" is a business outcome unless the artifact declares it | §3: `outcomes[]` and `recoverable[]` declared in schema |
| 2 | Transcript → artifact compilation hand-waved | Hardest part of the project; parameterization, dead-end pruning, locator capture | §4.3: explicit compile + verification replay |
| 3 | Locator ladder was entirely DOM-based | Brief says "bias toward an approach that still works with no clean DOM" | §4.1 / §5.1: accessibility-tree observation, `visual` strategy in schema as declared seam |
| 4 | Target application unspecified | Owning the target is what makes error-injection evidence possible | §2.3: local legacy-style mock app with fault injection |
| 5 | Schema missing per-step postconditions, stable step IDs, app identity, provenance, approval, sensitivity flags, extraction parsing | Needed for tenant overrides, redaction, reviewability | §3 |
| 6 | HITL "same live session" mechanism and "record what the human did" not concrete | Graded as "not just a TODO" | §7 |
| 7 | Capability-router agent presented as core, with no explicit discover/replay entrypoints | Brief requires explicit "run the agent on a goal, then replay the artifact" commands; fault-injection evidence needs direct replay. Router is stretch goal #1 | §1.4 / §10: keep explicit `discover` + `replay`; add `run --goal` router as the agent entrypoint, built after core (Phase 7) |

---

## 1. Architecture

### 1.1 Principle

The LLM is responsible for **discovery** — understanding a goal and finding a path through an
unknown UI. Execution of a discovered capability is **deterministic and model-free**. These two
paths share the same surface adapter and policy layer but never share a decision loop.

```text
                 Natural-language goal + target
                              │
                              ▼
                 ┌─────────────────────────┐
                 │  Capability Agent (LLM) │   one tool-calling turn:
                 │  `run --goal`           │   find_capabilities → execute | discover
                 └──────┬───────────┬──────┘
          no match      │           │  match
                        ▼           │
                 ┌─────────────────────────┐
                 │  Discovery Agent (LLM)  │   observe → decide → act, bounded
                 └────────────┬────────────┘
                              │ successful transcript
                              ▼
                 ┌─────────────────────────┐
                 │  Artifact Compiler      │   parameterize, prune, capture locators
                 └────────────┬────────────┘
                              │ draft capability
                              ▼
                 ┌─────────────────────────┐
                 │  Verification Replay    │   must pass before artifact is saved
                 └────────────┬────────────┘
                              │
                              ▼
                 ┌─────────────────────────┐
                 │  Capability Registry    │   versioned JSON on disk
                 └────────────┬────────────┘
                              │
   Capability Agent / CLI ────┤ execute(name, inputs)
                              ▼
                 ┌─────────────────────────┐
                 │  Replay Engine          │   no LLM; locator ladder, waits,
                 │                         │   postconditions, outcome detectors
                 └────────────┬────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   Surface Adapter       Policy Layer        HITL Controller
   (Playwright)          (allowlist, risk)   (control-transfer state machine)
          │
          ▼
   Evidence Sink (JSONL events + screenshots, redacted)
```

All browser actions — from discovery *and* replay — flow through one `SurfaceAdapter`
interface, and every action is checked by the `PolicyLayer` before the adapter executes it.
That single choke point is what makes the safety story credible: the LLM cannot bypass policy
because it never touches Playwright directly.

### 1.4 Two entrypoints, one pipeline

| Entrypoint | Who uses it | What it does |
|---|---|---|
| `pnpm run --goal "..."` | The agent-facing demo; what a calling AI agent would do | LLM router: `find_capabilities(goal)` → if a match with satisfiable inputs, `execute_capability(name, inputs)`; else `discover(goal)` then execute. One tool-calling turn, no UI reasoning. |
| `pnpm discover` / `pnpm replay` | Developers, reviewers, evidence generation | Direct access to each pipeline stage. Required by the brief's README demo path ("run the agent on a goal, then replay the resulting artifact") and needed for fault-injection runs with controlled inputs. |

The router is deliberately thin: it never sees the UI, never chooses locators, never decides
steps. It only maps *goal → capability + typed inputs*. If it picks wrong, the replay engine's
input validation rejects the call before any browser action happens. Its LLM call is a
**routing** decision, not a **UI** decision, so the "no LLM in the production execution path"
property of replay still holds — and the write-up should say so explicitly.

### 1.2 Boundaries (single process, justified)

One Node process, CLI-driven, plus a tiny HTTP server that exists only for the HITL handoff
signal. No queue, no DB, no services. The brief explicitly says not to build scaling
infrastructure; the seams (registry interface, evidence sink interface, adapter interface) are
where a production system would swap in real infrastructure.

### 1.3 Modules

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
  agent/          capability router: find_capabilities / execute_capability / discover tools
  cli/            run (router), discover, replay, list, serve-operator
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
| Browser control | Playwright | Best-in-class locators (`getByRole`), auto-waiting, `ariaSnapshot()`, headed mode for HITL, trace files as rich evidence |
| LLM layer | Vercel AI SDK v5 (pinned) + `@ai-sdk/anthropic` (swappable) | Typed Zod tools, provider-agnostic; thin enough that the loop stays ours (see §2.2) |
| Model | Claude Sonnet 4.x (default), any tool-calling model via env | Strong tool-calling; a single discovery run costs cents |
| Schema / validation | Zod | Runtime validation of artifacts, tool args, results; one source of truth for types + JSON Schema export for reviewers |
| HTTP (HITL only) | Hono (or bare `node:http`) | Two endpoints; anything heavier is noise |
| Logging | Custom JSONL writer with redaction | Structured, greppable, no external platform |
| Tests | Vitest | Unit: schemas, policy, detectors, template binding. Integration: replay against mock app |
| Mock app | Hono/Express, server-rendered HTML, no client framework | Full control over legacy traits and fault injection |

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

- **Flows:** member search → member detail → savings balance (read-only); member detail → open
  sub-account → confirmation (write, risky).
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
  - `unexpected_confirm` — triggers HITL (dialog not in artifact)

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
  "checkpoint": { "type": "text_present", "text": "Savings" },
  "provenance": { "discoveryRunId": "run_01J...", "model": "claude-sonnet-4", "recordedAt": "2026-09-12T10:00:00Z", "verifiedAt": "2026-09-12T10:01:30Z" }
}
```

### 3.3 Design rationale (for REPORT.md)

- **Outcomes and recoverables are in the artifact** because they are properties of the
  *application*, discovered once, not properties of a single run. The replay engine is generic;
  the artifact tells it what "member not found" looks like here.
- **Stable step IDs** make tenant overrides, evidence, and human resume (`retry_step s2`)
  possible without positional coupling.
- **Per-step postconditions** turn "click worked" from an assumption into an assertion, which is
  what makes failures debuggable (expected X, observed Y, at step s2).
- **`status` gate:** only `approved` artifacts replay unattended; `verified` requires a human
  to be reachable; `draft` cannot replay in production. Irreversible steps additionally require
  `approved` + explicit `confirm` flag per invocation.
- **`sensitive` flags** drive redaction in logs and evidence at the schema level, not by
  regex guessing.
- **`schemaVersion` vs `identity.version`**: schema evolution and capability evolution are
  independent concerns.

---

## 4. Discovery agent

### 4.1 Observation model **[REVISED]**

The agent observes a **compact accessibility snapshot** (Playwright `ariaSnapshot()`
post-processed into a ref-addressed list: `[e12] button "Search"`, `[e13] textbox "Member ID"`),
plus current URL and page title. Optionally a screenshot for vision-capable models.

Why accessibility tree, not DOM: it is the representation that (a) survives non-semantic legacy
markup better than CSS, (b) exists on desktop apps via OS accessibility APIs, and (c) yields
role+name locators that are the most stable replay targets. This is the direct answer to the
brief's "bias toward an approach that would still work when the surface has no clean DOM."

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
2. **Prune** actions that errored or were followed by an explicit backtrack (`navigate` back
   to a prior URL with no extraction in between). Keep the successful path.
3. **Parameterize** via `valueFrom.input` references (already symbolic); literals stay literal.
4. **Derive postconditions** from the observed state change after each action (URL change,
   new heading text) — proposed, then a human can edit.
5. **Emit** `CapabilityArtifact` with `status: draft`, validate with Zod.
6. **Verification replay**: run the draft through the replay engine against the live target
   with the same inputs. Pass → `status: verified`, save. Fail → save as draft with the
   failure attached, do not register as invocable.

Step 6 is what makes the claim "the artifact replays deterministically" evidence-backed rather
than asserted.

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

### 5.2 Step execution loop

```text
for step in artifact.steps:
    waitFor(step.waitFor)                      # bounded, explicit
    checkDetectors(recoverable)  → recover, retry step (bounded by maxAttempts)
    checkDetectors(outcomes)     → return BUSINESS_OUTCOME
    policy.check(step)           → block / require confirm / escalate
    locator = resolve(step.target)             # ladder
    act(locator, bind(step.value, inputs))
    assert(step.postcondition)   → else checkDetectors again, then FAILURE / POSTCONDITION_FAILED
verify(artifact.checkpoint)
return SUCCESS with parsed outputs
```

Detectors run **after** each action as well as before the next, because an outcome typically
appears as a result of the action just taken.

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
  action types, per-app.
- **Post-navigation check:** after any action, if the page URL is outside the allowlist (a click
  navigated somewhere unexpected), stop with `POLICY_BLOCKED`.
- **Risk classification:** `read_only | reversible | irreversible`. Assigned at discovery
  (heuristic: form submit to non-search route, button text matching create/submit/transfer/
  delete/confirm → `irreversible` candidate; LLM asked to classify; human confirms at approval).
  Replay behavior: `irreversible` steps require the artifact to be `approved` **and** the
  invocation to carry `confirm: true`; otherwise the run escalates to HITL at that step. In the
  prototype, the mock app's "open sub-account" flow demonstrates this.
- **Redaction:** inputs/outputs flagged `sensitive` are masked in JSONL and screenshots are
  taken only at checkpoints/failures; a redaction pass masks values that equal any sensitive
  input. Credentials come from env, are never in artifacts, and the login capability's password
  input is `sensitive: true` and never logged.
- **Limits (state honestly in report):** regex/equality redaction cannot catch PII that appears
  on screen but was never an input (e.g. a member's SSN on the detail page). Screenshot
  redaction of arbitrary on-screen PII is out of scope; production would need field-level
  masking rules per app.

---

## 7. Human-in-the-loop **[REVISED]**

### 7.1 Control-transfer state machine

```text
AUTOMATION ──stuck/risky/request_human──▶ WAITING_FOR_HUMAN ──claim──▶ HUMAN_CONTROL
     ▲                                                                       │
     └──────────────── resume(retry_step | skip_step | abort) ◀──────────────┘
                              (re-verify postcondition before continuing)
```

`RunContext.controlOwner ∈ { automation, human:<operatorId>, none }`. The replay engine and
discovery loop both check ownership before every action; if not `automation`, they block on a
promise resolved by the resume signal. This is the seam the brief asks about.

### 7.2 Mechanism

- Browser runs **headed**. The operator uses the *same* Chromium window — literally the same
  session, cookies, page state. No second session, no co-browsing infra.
- Intervention record: `{ id, runId, goalOrCapability, stepId, reason, screenshotPath,
  snapshotPath, url, createdAt, controlOwner }` written to disk and printed to console.
- Minimal HTTP: `GET /interventions`, `POST /interventions/:id/claim`,
  `POST /interventions/:id/resume { action: retry_step | skip_step | abort, note }`.
  Operator "UI" is `curl` or a one-page HTML list — deliberately mocked.
- **Recording what the human did:** on `claim`, inject a page-level listener via
  `page.exposeBinding` that reports clicks (role/name/text of target) and input changes
  (field name only, value redacted) as `human_action` evidence events. On `resume`, capture
  URL + screenshot diff. Both are stored under the intervention.
- **Triggers:** discovery `request_human`; replay `FAILURE` on a step whose retry is exhausted;
  replay reaching an `irreversible` step without `confirm`; `UNEXPECTED_DIALOG`.

---

## 8. Evidence and observability

- One JSONL file per run: `evidence/<runId>/events.jsonl`. Event: `{ ts, runId, phase:
  discovery|compile|verify|replay|hitl, stepId?, type, action?, target?, resolvedStrategyIndex?,
  result?, outcome?, failure?, controlOwner, durationMs }`. Discovery events also include the
  model's stated reasoning for the action (from the tool call), redacted.
- Screenshots at: run start, each postcondition failure, each outcome detection, each HITL
  transition, run end. Playwright trace (`trace.zip`) on failure as the "richer signal."
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

The artifact never references Playwright. `role`/`text`/`label` strategies and all `Condition`
types are surface-neutral. `css`/`xpath` are web-only and a desktop adapter would simply report
them unsupported and fall through to `role` or `visual`. A legacy-web adapter differs from the
web adapter only in frame handling (`frameLocator` traversal on resolve) and in preferring
`text`/`visual` strategies when the a11y tree is sparse.

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
router (`run --goal`) as the agent-facing entrypoint; tests where it counts; README + REPORT.

**Mock / declare only:** operator UI (curl + static page), `visual` strategy, desktop adapter,
tenant override merging (schema + one unit test, no second app variant unless time allows),
canonicalization.

**Do not build:** queues, DB, auth, multi-process, dashboards, OpenTelemetry export.

### 10.2 Phases

Each phase ends in something runnable and committed. Do not start the next until the current
one has a passing demo.

| Phase | Deliverable | Definition of done |
|---|---|---|
| **0. Skeleton** (½ day) | repo, tsconfig, pnpm, vitest, Playwright installed, `src/` module folders, `policy.yaml`, `.env.example` | `pnpm test` green (one trivial test), `pnpm lint` |
| **1. Mock app** (½–1 day) | Hono server: login, member search, member detail (iframe accounts panel), open sub-account form + confirm; fault-injection toggles | Manually walk both flows; every fault toggle produces its intended state |
| **2. Artifact schema + policy** (½ day) | Zod schemas for artifact, conditions, targets, results; registry (fs); `PolicyLayer` | Unit tests: valid/invalid artifacts, template binding, allowlist decisions, risk classification |
| **3. Surface adapter + replay engine** (1 day) | `PlaywrightAdapter`, locator ladder, waits, detectors, result contract, evidence sink | Hand-written artifact for `get_member_savings_balance` replays: SUCCESS, MEMBER_NOT_FOUND, SESSION_EXPIRED→recovered, TARGET_NOT_FOUND. Integration tests for each |
| **4. Discovery agent** (1 day) | intent extraction, a11y snapshot with refs, tools, bounded loop, transcript recorder | One real LLM run completes the balance goal against the mock app; transcript + events saved |
| **5. Compiler + verification** (½–1 day) | transcript → draft artifact; verification replay; status transitions | Discovered artifact ≈ hand-written one; verification replay passes; `status: verified` |
| **6. HITL** (½–1 day) | state machine, intervention store, HTTP endpoints, headed handoff, human-action capture, resume semantics | Demo: replay with `unexpected_confirm` fault → NEEDS_HUMAN → operator clicks in the live window → `resume retry_step` → SUCCESS, with human actions in evidence |
| **7. Capability router** (½ day) | `run --goal`: one `generateText` turn with tools `find_capabilities`, `execute_capability`, `discover`; registry search by name/description; input extraction from goal | Cold run (empty registry) discovers then executes; warm run with a new member ID replays directly with no discovery. Both in evidence |
| **8. Evidence set + docs** (½–1 day) | committed `evidence/` runs, `README.md` (setup, demo commands, offline mode), `REPORT.md` (seven exact headings) | A stranger can clone, run `run --goal`, run discovery, run replay, trigger HITL from README alone |
| **9. Stretch** (only if 0–8 solid) | second app variant with tenant overrides *or* multi-run stability score | One shown end-to-end |

Estimated total: **5–7 focused days**. Time-box at 7 and document the remainder as next steps.
Phase 7 is small because it only composes pieces from Phases 3–5; if it threatens the
time-box, it is the first thing to cut back to "explicit commands only."

### 10.3 Demo path (target for README)

```bash
pnpm mock-app                                                   # terminal 1

# Agent-facing path: one goal, the router decides
pnpm run --goal "look up member 12345 and read their current savings balance"
#   cold: no capability → discover → compile → verify → execute → { savingsBalance: 1234.56 }
pnpm run --goal "look up member 67890 and read their current savings balance"
#   warm: routes to get_member_savings_balance → replay only, no discovery, no UI reasoning

# Explicit path: each stage on its own (required by brief; used for evidence + fault injection)
pnpm discover --goal "look up member 12345 and read their current savings balance" \
              --target http://localhost:4000                    # real LLM run → artifact
pnpm replay get_member_savings_balance --input memberId=12345   # SUCCESS
pnpm replay get_member_savings_balance --input memberId=99999   # BUSINESS_OUTCOME MEMBER_NOT_FOUND
pnpm replay get_member_savings_balance --input memberId=12345 --fault session_expired   # recovered
pnpm replay get_member_savings_balance --input memberId=12345 --fault permission_denied # FAILURE
pnpm replay get_member_savings_balance --input memberId=12345 --fault unexpected_confirm # NEEDS_HUMAN
curl -X POST localhost:4100/interventions/<id>/claim
#   ... operator acts in the headed browser ...
curl -X POST localhost:4100/interventions/<id>/resume -d '{"action":"retry_step"}'
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
