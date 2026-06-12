# ytsejam web client

React 19 + Vite + Tailwind + shadcn UI for the ytsejam server. Built and served by the ytsejam server in production; dev-mode runs against the local server via the Vite proxy.

## Build

```bash
npm run build
```

## Styling rule

UI uses shadcn-only tokens — no raw Tailwind color classes. See [`CLAUDE.md`](CLAUDE.md) for the rule and [`../docs/agents/OVERVIEW.md`](../docs/agents/OVERVIEW.md) for full architecture.
