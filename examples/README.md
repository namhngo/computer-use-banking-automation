# Authored Examples

`get-member-savings-balance.json` is a hand-written capability artifact for the Harbor mock app,
kept as an immutable **draft**. It is not an LLM recording and is never promoted to a verified
registry revision. It exists so that model-free replay, recovery handlers and the replay-side
human handoff can be demonstrated and tested without a model key:

```bash
pnpm replay --artifact examples/get-member-savings-balance.json --inputs '{"memberId":"12345"}' \
  --sandbox --mode verification [--fault session_expired]
```

The artifacts the agent actually produces are under `evidence/capabilities/`; note they name
their input `member_id` because the model declared that contract. See
[the contract guide](../docs/CONTRACTS.md) for the schema.
