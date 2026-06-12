# Contributing

ytsejam is a personal-assistant project that happens to be open source. PRs and issues are welcome with a few ground rules.

## Before submitting a PR

1. Install dependencies: `NODE_ENV= npm install` (the `NODE_ENV=` prefix matters if your shell has `NODE_ENV=production` set — see README § Run).
2. Run the gate: `NODE_ENV= bash scripts/gate.sh` (server typecheck + tests + web build/typecheck + tests). It must pass.
3. Follow the conventions in [`AGENTS.md`](AGENTS.md) — they apply to humans and AI coding assistants alike.
4. Keep PRs scoped. One concern per PR; one fix or one feature.

## What to expect

- The maintainer reviews PRs when time allows; small, well-scoped, gate-passing PRs land fastest.
- Architectural changes should open an issue first to discuss.
- Documentation PRs (typos, clarifications, missing env vars in tables) are especially appreciated.
