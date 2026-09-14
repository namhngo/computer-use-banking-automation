# Policy: Risk From Structural Effects

`policy.yaml` is the only place that knows the application. It is data, it is small, and nothing
in it is about a goal. Automation code never contains a label, a selector, a route or a field
name of the target app; it asks the policy.

## What the policy decides

| Question | Decided by | Rule |
|---|---|---|
| May this page be loaded? | `pages` | GET path must match a listed pattern; `:id` matches one opaque identifier segment; query keys/values must be listed |
| May this form be submitted? | `forms` | POST path **and the exact set of field names** the real form would send must match a rule; the rule carries the risk |
| May text be read here? | `pages` | Reading visible text on an allowed page is always `read_only` |
| May a link be followed? | `pages` | A same-origin, same-window, non-download link is a page load of its destination |
| May a field be typed into? | `forms` | Only inside a form that a rule lists |
| How is a session opened? | `session` | Login path, field labels, submit label, optional visible banner |
| Which dialogs are benign? | `knownDialogs` | Any other dialog stops automation and, with `--hitl`, hands the browser to a person |
| What may an operator submit during a handoff? | `forms` + `humanForms` | Handoff widens who acts, never what the app permits |

Everything else is denied: script-only buttons, forms the page grows later (the sandbox's
"Open sub-account" is the canonical example), downloads, popups, WebSockets, other origins,
percent-escapes, credentials in URLs.

## How an effect is measured

`src/surface/effects.ts` inspects the actual DOM node the model selected (never a label or a
model-supplied key) and reports one of:

| Effect | Measured when | Policy input |
|---|---|---|
| `read` | the action is `extract` | page only |
| `navigate` | `<a href>` same origin, target `_self`, no `download` | destination URL |
| `input` | text-like `<input>`, `<select>`, `<textarea>` inside a form | the form's action, method and `FormData` field names |
| `submit` | submit button/input, or a `<form>` | the form's action, method and `FormData` field names, including a named submitter |
| `unknown` | disconnected, disabled, cross-window, formless controls | denied |

The measurement is repeated immediately before dispatch; if it changed, the action is `STALE_REF`
and nothing is sent. Form submissions are additionally granted to the egress proxy one exact
URL+body at a time, so the browser cannot post anything the policy did not just approve.

## Evidence spelling

Paths in evidence are `canonicalPagePath(policy, url)`: segments a page pattern marks as `:id`,
digit-only segments, and any declared sensitive value become `:id`; routes no page matches are
`[unavailable]`. The evidence sink refuses digit-only segments as a last line of defence.

## Adding an application

Write a new `policy.yaml`: origins, pages, forms with their field sets, the session block, and
any benign dialog names. No TypeScript changes. If the app needs actions this model cannot
express (a script-driven control, a GET form, a multi-step wizard with client-side state), that
is a policy-schema extension, reviewed once for everyone, not a per-goal patch.
