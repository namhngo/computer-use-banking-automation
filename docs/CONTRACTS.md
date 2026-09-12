# Phase 2 Contracts

These contracts are implemented and tested. They do not execute browser actions or prove that
an artifact has been discovered or replayed. The source of truth is the Zod schemas under
`src/artifact/` and `src/policy/`, plus the semantic checks around them.

## Artifact

The full [authored example](../examples/get-member-savings-balance.json) describes the actual
Harbor UI: open search, fill member ID, submit search, click View member, and extract savings
and currency from the iframe. It is **draft**, not discovery evidence or a verified capability.

| Field | Contract |
|---|---|
| `schemaVersion` | Exactly `1`; reject unsupported formats rather than guessing |
| `identity` | Name, positive immutable revision, description, `draft` or `verified` status |
| `app` | `appId`, numeric dotted `appVersion`, `surface: web`, fixed `entryPath`, `requiresSession` |
| `inputs`, `outputs` | Named string/number/boolean definitions, description and sensitivity flags |
| `risk` | Maximum declared business-step risk; not permission to act |
| `steps` | Ordered, unique IDs; navigate, fill, click, select, extract, or wait |
| `outcomes` | Expected business outcomes, each with a condition and authored/observed provenance |
| `failures` | Known UI hard failures, including conditions scoped to the account iframe |
| `recoveries` | Bounded known-notice dismissal or reauthentication back to the entry navigation |
| `limits` | Step/run deadlines and a total recovery-attempt budget |
| `checkpoint` | Final UI assertions, independent of output type validation |
| `provenance` | Authored timestamp, or discovery timestamp/run/model reference |
| `verification` | Required for `verified` status; references a verification run, not its raw transcript |

All declared input and output keys are required. Extra keys and unknown properties at every
schema level are rejected. Optional/default values and arbitrary object-shaped business data
are deliberately not part of v1. Strings support bounded length and `text` or ASCII `digits`
formats; numbers are finite, with optional bounds and safe-integer enforcement when requested.
There is no model-supplied regex or executable expression language.

Semantic validation rejects duplicate step/handler IDs, references to undeclared inputs,
missing or multiply extracted outputs, incompatible parsers, inconsistent aggregate risk,
invalid recovery references, and impossible timeout/recovery budgets. Each click/navigation/
selection has a postcondition. A wait action carries its own condition.

## Values And Targets

Values use explicit references, not string interpolation:

```json
{ "source": "input", "name": "memberId" }
```

```json
{ "source": "literal", "value": "Member ID" }
```

`validateValues(definitions, values)` validates exact keys and types before binding.
`bindText(reference, validatedInputs)` returns plain data, never code. It preserves leading
zeroes and refuses inherited or missing inputs. References work in values, role/label/text
selectors, table rows/columns, scoped selectors, and equality checkpoints.

Navigation paths and CSS selectors are fixed literals in v1. Dynamic navigation is performed
by clicking the observed link, not by injecting an input into CSS or a URL template. More
general URL parameterization would need its own encoding and policy contract.

Targets have ordered `strategies` and optional `scope`:

- `role`: exact accessibility role and exact accessible name, including empty names where valid.
- `label` and `text`: exact semantic matches.
- `css`: literal selector, with uniqueness checked by the future adapter.
- `table_cell`: find the unique table/row by exact first-cell text; choose the column by exact
  header text or a one-based numeric index. Numeric columns support the member identity table,
  which has no header row. Row/header/table ambiguity must stop, not choose the first match.
- `scope.frames`: an ordered frame chain from the top-level page; each selector must identify
  an actual frame uniquely. `scope.container` narrows within the final frame/document.

Conditions are `visible`, `text_equals`, or `path_equals`, optionally grouped in a single-level
`all`/`any`. `path_equals` compares the pathname; network policy independently validates query
strings. Missing frames make a detector false rather than hiding other eligible detectors;
an action target with a missing frame must fail. These execution semantics are Phase 3 work.

The example checks the member identity in both the outer page and account iframe, locates the
Savings row explicitly, and verifies USD. It must not return a balance from a stale/wrong frame.

## Outputs And Money

`parseExtraction(text, parser)` supports `text`, `integer`, `boolean`, and `usd_cents`.
Numeric parsing is strict: no partial `parseFloat`, expression evaluation, scientific notation,
or silently rounded currency. Money is parsed through integer arithmetic and bounded to safe
JSON numbers. For example, `$1,234.56` becomes `123456` cents and `$0.29` becomes `29`.

The example returns:

```json
{ "savingsBalanceCents": 123456, "currency": "USD" }
```

These are illustrative synthetic values, not a stored invocation result. Binding and results
may contain sensitive runtime data; they are not artifact files or automatically safe log data.

## Invocation And Recovery

`prepareInvocation(artifact, values, { appId, appVersion, mode })` validates the artifact,
exact app compatibility, inputs, and eligibility. `mode: verification` permits a read-only
draft for the trusted sandbox runner. `mode: replay` requires a verified read-only artifact.
Mutating flows are rejected in both modes. Neither a caller's mode nor a metadata risk label
substitutes for browser policy enforcement or proving a real verification run took place.

Authentication is an environment-owned prerequisite. Credentials are not artifact inputs,
literals, or nested login capabilities. The future session manager obtains them at runtime.
Reauthentication must restart at the first read-only navigation matching `entryPath`, so it
refills the member ID rather than retrying a Search click against a blank form.

A known-notice dismissal declares a scoped control and postcondition. Every recovery action
will pass through the same policy checks as ordinary actions. Per-handler and total attempt
budgets are separate. Unknown notices do not gain permission just because their route matches.

## Replay Results

`parseReplayResult(value, artifact?)` validates:

- `SUCCESS`: exact typed outputs, final step reached, no exhausted recoveries.
- `BUSINESS_OUTCOME`: a code declared in this artifact, not an arbitrary failure/recovery code.
- `FAILURE`: a structured uppercase code, sanitized message, optional expected/observed detail.
- `NEEDS_HUMAN`: a reason code and intervention ID, not an implementation of handoff itself.

Every result carries a run ID, step reference, evidence filenames, and recovery records.
`atStep: null` is allowed only for failures before any step, with no recovery history; those
failures can be validated without a valid artifact. Other results need a known step/artifact.
Recovery attempts must increment per handler, stay inside both budgets, and never continue
after exhaustion. Result-shape validation does not prove the UI checkpoint actually passed.

Evidence references are simple filenames under the run's directory, never arbitrary paths or
URLs. Diagnostic strings must already be sanitized by the evidence layer. Phase 6 must define
how a manually resolved exhausted recovery is represented before accepting resumed success;
do not erase an exhaustion record merely to make a result pass validation.

## Filesystem Registry

`FileCapabilityRegistry` defaults to ignored `artifacts/capabilities/` and exposes:

- `save(artifact, knownSensitiveValues)` validates and publishes an immutable revision.
- `load({ appId, appVersion, name, version })` loads and revalidates one exact revision.
- `list({ appId, appVersion })` lists exact-compatible artifacts in deterministic filename order.

The complete key forms a flat filename. Traversal, mismatched file identities, symlinks,
nonregular files, malformed data, and artifacts larger than 1 MiB are rejected. Writes use a
private temporary file and an atomic, no-overwrite hard link; readers never see a partial write.
Files use mode 0600; newly created registry directories use 0700. The configured root is trusted
local infrastructure, not a general secure-filesystem sandbox.

Revisions are immutable **including status**. A verification workflow publishes a new revision
with verification metadata rather than overwriting the saved draft. There is no implicit
"latest" selection or migration. Listing includes drafts; the calling layer must use eligibility
checks rather than assume that being in the catalog means being executable.

Before saving, the caller supplies known secrets and sensitive invocation values; persistence
rejects their raw/common JSON-escaped/URL-encoded representations rather than redacting an
executable selector into something different. This guard is conservative, not arbitrary PII
detection or protection against every encoding. Unknown sensitive UI text still requires
compiler/evidence review. Exceptions deliberately omit payloads, private paths, and causes.

## Policy Decisions

`loadPolicy(path)` parses strict YAML without aliases, tags, duplicate keys, or merge keys.
`parsePolicy(value)` validates and freezes trusted app-owned configuration. Authorization only
accepts objects produced by these functions, not shape-compatible model-provided policies.

`authorizeRequest(policy, { url, method })` requires an exact listed HTTP origin, method, path,
and allowed query values. The only path placeholder is `:memberId`, matching five digits.
Only explicitly configured queries are allowed; duplicate keys, userinfo, fragments, encoded
paths, traversal, and ambiguous URL spellings fail closed. Unsupported protocols also fail.

`authorizeAction(policy, { appId, appVersion, url, action, targetKey? })` separately checks app
identity and a specific action rule. Navigate/wait have no target key. Other keys must be
derived by the **trusted adapter/app profile after resolving the actual control**, never copied
from a model call. The URL is the navigation destination or the target's document/frame URL.
Risk comes from the policy, not the artifact. Overlapping rules cannot return conflicting risks.

The shipped policy permits read-only member work and explicit session operations. It excludes
sub-account creation and unknown-notice acknowledgment. Both notices POST to `/notice`, but
only `system_notice_ok` has an action grant. Tests prove that permitting a route alone does not
grant permission to every button on it.

These are pure decisions only. Phase 3 must connect them to request interception, redirects,
frames/popups, trusted target classification, and every browser action. The mock server's own
403 response is not proof that the automation system enforced its policy.
