# Phase 3: Deterministic Replay

Phase 3 executes saved artifacts through a real browser without a model. Discovery, compilation,
artifact promotion, and real human control transfer remain later phases. The checked-in artifact
is still an authored draft; running it does not silently approve or overwrite that revision.

## Run The Draft

Set the local mock credentials in `.env`, install dependencies/Chromium as described in the
README, then run:

```bash
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification
```

There is no need to start `pnpm mock-app` for this command. `--sandbox` creates a fresh mock
instance on an ephemeral loopback port and a fresh browser session, and closes both afterward.
Only this explicitly owned sandbox may use `--mode verification` through the CLI. The harness
does not reset an independently running server or give the browser a fixture/reset API.

The command prints a structured result with `SUCCESS`, a run ID, evidence filenames, and:

```json
{ "savingsBalanceCents": 123456, "currency": "USD" }
```

Use another member or a fault to exercise the same artifact:

```bash
pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"99999"}' --sandbox --mode verification

pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"67890"}' --sandbox --mode verification --fault session_expired

pnpm replay --artifact examples/get-member-savings-balance.json \
  --inputs '{"memberId":"12345"}' --sandbox --mode verification --fault permission_denied
```

The results are respectively `BUSINESS_OUTCOME / MEMBER_NOT_FOUND`, success after one recorded
reauthentication, and `FAILURE / PERMISSION_DENIED`. Failure exits with status 1; success and
business outcomes exit with status 0. Other mock fault names from the README also work.
`unexpected_confirm` stops with `UNEXPECTED_DIALOG`; with `--hitl` (headed only) it instead
pauses for a real operator in the same browser session, see [HITL.md](HITL.md).

## CLI Boundary

`--inputs` is JSON, preserving types and leading-zero string IDs. Malformed JSON and unknown or
duplicate flags fail closed. `--fault` is restricted to owned sandboxes. `.env` supplies mock
credentials and `HEADLESS`; the CLI does not print credentials. `HEADLESS=false` shows Chromium.

Default mode is `replay`, which rejects drafts. A previously verified artifact may be loaded
with `--artifact`, or by an exact registry name/version:

```bash
pnpm replay get_member_savings_balance --version 2 --inputs '{"memberId":"67890"}'
```

That latter command requires an existing verified revision in `artifacts/capabilities/` and a
running target at `TARGET_URL`. Phase 3 does not create that revision automatically; the later
verification/publication workflow will do so. `TARGET_URL` supplies the origin; the artifact
supplies its entry path. Standalone execution never rewrites the configured policy origins.
Explicit sandbox execution changes the policy origin only to the newly owned mock instance.

Optional `--registry`, `--policy`, and `--evidence-root` paths are trusted local operator
configuration. Artifact files are bounded to 1 MiB and must be regular, nonsymlink files.
There is no network API accepting arbitrary artifact paths or policies from an agent.

## Execution Path

```text
artifact + typed inputs
    -> validate eligibility and app compatibility
    -> create private evidence, browser, and enforced network boundary
    -> authenticate through permitted UI controls
    -> resolve step target -> classify actual control -> authorize -> dispatch
    -> check UI failures/outcomes/recoveries and postconditions
    -> verify final checkpoint and output types
    -> return result and close owned resources
```

`src/replay/engine.ts` owns this sequence. `src/surface/playwright-adapter.ts` owns perception,
target resolution, browser/session control, and condition evaluation. The Harbor profile maps
actual elements to trusted control identities; a model or artifact cannot supply its own
`targetKey`. For example, naming a different submitter "Search" does not make it the permitted
member-search control.

Resolution supports exact roles, labels, text, table cells, CSS, frame chains, and containers.
Fallbacks are ordered; ambiguity stops rather than selecting the first match. Table matching
uses a unique row and column. Wrong-member account frames cannot be extracted through the
profile. Observation refs bind to actual nodes and are invalidated by a new observation,
navigation, action, or relevant DOM change. Captured table targets use labels/columns rather
than hardcoding the balance currently displayed.

`observe()` returns bounded semantic DOM observations in memory for the future discovery loop.
It is not a full browser accessibility-tree implementation or desktop abstraction. It omits
input values, including login credentials. Observations are not written into normal evidence.

## Guarded UI Dispatch

Authorization cannot safely precede a long, automatically retried click: the same button can
change form action or dialog ancestry while Playwright waits for it. This prototype therefore
resolves visible/enabled controls, rechecks classification after evidence writes, and performs
a final state check and DOM dispatch in a single browser task. DOM fingerprints include the
document and relevant form values and remain private, in-memory data.

Click/fill/select use fixed application-owned browser functions, not model-supplied JavaScript.
They operate real DOM controls and native form submission. This intentionally does not promise
physical mouse/keyboard events or `isTrusted` compatibility. Apps requiring those semantics
need an extended dispatch adapter; the server-rendered Harbor target does not.

Disabled controls are not queued for a later click. State changes require fresh resolution,
or the action fails with `STALE_REF`. Signatures are checked again atomically at dispatch, so
changes to surrounding dialog labels, table headers, form destinations, or values cannot reuse
an earlier authorization. POST forwarding adds an independent guard described below.

## Network Enforcement

An actual experiment showed that a Playwright `context.route()` handler can miss later hops
in a redirect chain, even when the first response is fetched without redirects and fulfilled.
Checking only that first request is insufficient for an allowlist.

Chromium therefore uses a small loopback HTTP proxy from `src/surface/network.ts`, with its
implicit loopback bypass explicitly disabled. Each HTTP hop is checked against the exact
configured origin and request policy before an upstream connection is opened. The proxy does
not call banking APIs or inspect account data; it forwards browser traffic without following
redirects itself. Tests assert that forbidden endpoints receive zero requests.

The controlled context adds a private per-run transport marker that the proxy strips before
forwarding. Chromium's unmarked background update/sign-in requests remain blocked, but cannot
consume POST grants or abort an otherwise valid headed run. Page-scoped request monitoring
still makes denied requests from the controlled page fatal, including HTTPS attempts whose
CONNECT handshake cannot carry that marker. Wrong/missing-marker page responses also stop it.

Every POST additionally needs a one-use grant from the trusted adapter for the exact destination
and serialized form body. The proxy bounds and buffers the body before forwarding anything.
A changed form, extra request, different body, revoked grant, or ungranted 307 POST redirect
is denied. Known Harbor forms use 303 redirects to GET, which continue through normal policy.

Policy failure immediately revokes forwarding and closes the browser context, cancelling
pending operations. It is not merely a flag checked after a waiting action eventually finishes.
CONNECT tunnels and WebSockets are blocked, service workers are disabled, non-network
navigation is restricted, and unsupported popups/downloads terminate the run.

This is deliberately **HTTP-only, one-origin, trusted-local-app automation**, not a general
browser/OS security sandbox. HTTPS tunneling, desktop control, arbitrary hostile scripts,
downloads, and multi-tenant browsers are not claimed as supported. Script-free server-rendered
forms are the implemented surface; CSS/query/template support stays within the Phase 2 contract.

## Recovery And Deadlines

Failures and expected business outcomes are inspected before actions, while waiting, afterward,
and before success. Nonfatal action errors may trigger one bounded inspection for a declared
outcome or recovery; an unrecognized error is not an excuse to repeat the action. Sticky
network, policy, evidence, and deadline failures always stop.

Both reauthentication and known-notice dismissal clear all partial outputs and restart the
read-only flow at entry. This prevents returning a value read before recovery changed the UI.
Per-handler and total budgets remain in effect across restarts. Failed recovery attempts emit
terminal recovery events; recurrence beyond a spent budget does not invent another attempt.

Each artifact step and the whole run have deadlines. Initial authentication has a bounded
multi-action setup window (at least 5 seconds, still inside the overall deadline). Timed-out
dispatches are cancelled before evidence is collected. Context/browser/proxy cleanup runs on
every terminal path. No automatic irreversible operation is supported.

## Evidence And Limits

Normal runs write to ignored `artifacts/runs/<runId>/` with private directory/file permissions:

- `events.jsonl`: structural action, policy, step, recovery, and terminal events; no raw inputs,
  outputs, URLs, selectors, browser errors, or DOM text.
- `snapshot_N.json`: on failure, a bounded structural DOM snapshot with normalized routes,
  tag/role vocabulary, visibility, child counts, and boolean text/value presence. No raw text
  or attribute values are accepted. A closed/unavailable surface gets an explicit marker.

Known secrets are additionally redacted from metadata. Arbitrary unknown PII detection is not
claimed; instead the persisted snapshot format excludes content by construction. Raw traces,
screenshots, video, browser storage, and DOM fingerprints are not persisted. A failed evidence
write stops the run rather than silently executing without logs.

Structured business outputs are returned to the caller on stdout, not stored in the evidence
log. Do not redirect that output into public submission evidence without review. Reviewed
examples are under [evidence/replay-phase3](../evidence/replay-phase3/README.md).

Without a handoff broker, unknown dialogs and exhausted recovery return failures and close the
session; no intervention ID is invented. With `--hitl`, an unknown dialog opens a real
intervention: the operator claims the same headed browser, their form submissions are authorized
through the proxy by `policy.yaml › humanActions` (disabling the proxy is not a handoff), and
automation resumes only after validation. Exhausted recovery remains terminal. See [HITL.md](HITL.md).
Phase 4 builds LLM-driven discovery on these same bounded surface operations; see
[DISCOVERY.md](DISCOVERY.md).
