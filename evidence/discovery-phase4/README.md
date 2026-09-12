# Phase 4 Discovery Evidence

These are reviewed copies of genuine LLM-driven discovery runs against fresh local Harbor
sandboxes on 2026-09-12. The model was OpenAI `gpt-4.1` (served as `gpt-4.1-2025-04-14`)
through the Responses API. Every transcript is marked `source: "live"`; the offline test-model
runs in the test suite are marked `source: "test"` and are deliberately not published here.

| Directory | Synthetic input | Turns | Tokens (in / out) | Observed result |
|---|---|---|---|---|
| `success/` | Member `12345` | 9 | 20,028 / 248 | SUCCESS; outputs `savingsBalanceCents: 123456`, `currency: "USD"` returned on stdout |
| `not-found/` | Member `99999` | 3 | 4,440 / 90 | BUSINESS_OUTCOME / MEMBER_NOT_FOUND, verified against the live alert; structural snapshot |

Common command (mock credentials and `OPENAI_API_KEY` from the ignored `.env`):

```bash
pnpm discover --goal "look up member 12345 and read their current savings balance" --sandbox
```

## What the model did

No step order, route, or selector was given to the model. In `success/discovery.json` it:

1. filled the observed **Member ID** field with the declared input (turn 1),
2. clicked **Search** and then **View member** (turns 2-3),
3. extracted the member identity, savings balance, and currency inside the account iframe
   (turns 4-6),
4. claimed success at turn 7 — **rejected** by the engine with `INCOMPLETE_EVIDENCE` because
   the main-document identity had not been read,
5. extracted the main-document **Member ID** cell (turn 8) and completed (turn 9), at which
   point the engine re-read all four fields under one consistent document state.

In `not-found/discovery.json` it filled, searched, and reported `member_not_found` with the ref
of the visible alert, which the engine verified against an actual Search submission for the
declared member before returning the business outcome.

## What is in these files

- `events.jsonl`: lifecycle, model-call, authorization, and network-policy events. No goal
  text, UI text, outputs, credentials, or provider key.
- `discovery.json`: per-call model IDs, opaque provider response IDs, token usage, and each
  decision with its status. Confirmed dispatches carry the captured target and trusted
  `targetKey`; the rejected turn-7 claim carries only its code. Member routes are
  canonicalized to `/members/:memberId` and the member value is `{ "source": "input" }`.
- `snapshot_1.json` (not-found only): structural DOM snapshot with tag/role/visibility and
  boolean text presence, including the `alert` role on the search page. No text content.

Original run IDs and timestamps are preserved. Balances and member IDs were returned to the
invoking caller only. These transcripts are inputs to the Phase 5 compiler, not capability
artifacts, and grant no replay eligibility. Human-handoff evidence remains a future deliverable.
