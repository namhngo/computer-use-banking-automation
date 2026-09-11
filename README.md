# Computer-Use Banking Automation

A take-home prototype for LLM-driven UI discovery followed by deterministic capability replay.
The implementation is deliberately incremental and targets one synthetic local web app.

## Current Status

Phase 0 provides tooling, validated environment configuration, and a real Chromium smoke test.
Verified on Node 22.22.1: lint, strict typechecking, 19 unit tests, and one browser test pass.
It does **not** yet implement the banking mock app, agent, artifact compiler, replay engine,
policy enforcement, or human handoff. The smoke test is not evidence of LLM discovery.

See [the proposal](docs/PROPOSAL.md) for the architecture, review decisions, and phase gates.
Phase 1 builds the synthetic member-search and savings-balance application.

## Setup

Use Node.js 22.13+ within the 22.x line (`.nvmrc` pins 22.22.1) and pnpm 11.13.0.
With Corepack available, `corepack enable` enables the package manager pinned in `package.json`.
Alternatively, install the exact version with `npm install --global pnpm@11.13.0`.

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm config:check
pnpm check
```

On Linux, install browser system dependencies if needed:

```bash
pnpm exec playwright install --with-deps chromium
```

Dependency and browser installation require internet access. After installation, all Phase 0
checks run without model keys, an app server, or live services. The smoke test uses an offline
browser context and in-memory synthetic HTML; it persists no screenshot, video, or trace.

## Commands

| Command | Purpose |
|---|---|
| `pnpm lint` | ESLint with type-aware TypeScript rules and no warnings |
| `pnpm typecheck` | Strict TypeScript checking without emitting files |
| `pnpm test` | Configuration unit tests; browser not required |
| `pnpm test:browser` | Launch Chromium, fill/click a form, and assert rendered output |
| `pnpm browser:install` | Install the Chromium build matching the pinned Playwright version |
| `pnpm config:check` | Validate optional `.env` configuration without printing values |
| `pnpm check` | Lint, typecheck, unit tests, and browser smoke test |

## Configuration

No `.env` file is required. `.env.example` documents the defaults:

| Variable | Default | Accepted values |
|---|---|---|
| `TARGET_URL` | `http://localhost:4000/` | HTTP URL on `localhost`, `127.0.0.1`, or `[::1]`, without credentials/query/fragment |
| `HEADLESS` | `true` | Exactly `true` or `false` |

`pnpm config:check` loads `.env` if present; existing shell variables take precedence.
The smoke test intentionally ignores these settings and always runs headless and offline.
No model/provider credentials are read in Phase 0. Configuration validation is not browser
policy enforcement. `policy.yaml` is a deny-by-default design template only; its parser and
enforcement will be implemented in Phases 2 and 3.

Dependencies are pinned exactly with a committed lockfile. TypeScript 5.9.3 stays within the
supported range of the pinned TypeScript ESLint parser; the latest compiler is not assumed
compatible. pnpm's release-age checks are strict, and only esbuild's required install script
is allowed. AI SDK/provider packages will be selected and installed in Phase 4, not unused now.

## Data Handling

- Use synthetic member data only. Never add real credentials or financial/PII records.
- `.env` files, generated `artifacts/`, browser state, and raw traces/videos are ignored.
- Future run outputs go into `artifacts/`, not directly into committed `evidence/`.
- Publish only explicitly reviewed and sanitized examples in `evidence/`.
- Ignore rules reduce accidental commits; they are not a substitute for a secrets review.

## Planned Demo

These commands are planned, **not implemented in Phase 0**:

```bash
pnpm agent --goal "look up member 12345 and read their current savings balance"
pnpm discover --goal "look up member 12345 and read their current savings balance" --target http://localhost:4000
pnpm replay get_member_savings_balance --input memberId=67890
```

The default agent entrypoint will choose an existing compatible capability or discover one.
Direct replay remains model-free and independently testable. A successful cold discovery
will not trigger another execution after sandbox verification. Actual live discovery evidence
and the assignment's `REPORT.md` will be added when those phases are implemented.
