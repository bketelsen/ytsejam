# Web UI conventions

## Use semantic theme colors — never raw Tailwind palette classes

All styling MUST use the shadcn semantic theme tokens defined in `src/index.css`.
Raw palette utilities (`bg-neutral-900`, `text-red-400`, `border-slate-700`,
`bg-blue-900/60`, …) are FORBIDDEN in app components. They break theming: the
app has light and dark themes driven entirely by CSS variables, and hardcoded
palette colors render wrong in one or both.

This is enforced by `test/theme.test.mjs` (runs via `npm test` in this
workspace and as part of the root `npm test`). The test fails the build on any
raw palette class in `src/**/*.tsx` and checks WCAG AA contrast for every
token pair in both themes.

### Which token to use

| Instead of… | Use |
| --- | --- |
| `bg-neutral-950` page backgrounds | `bg-background text-foreground` |
| `bg-neutral-900` panels/cards | `bg-card text-card-foreground` (+ `border-border`) |
| `border-neutral-700/800` | `border-border` |
| `text-neutral-400/500/600` secondary text | `text-muted-foreground` |
| `text-neutral-100/300` primary text | `text-foreground` |
| `bg-blue-*` user/highlight surfaces | `bg-primary text-primary-foreground` |
| `text-red-*` / `bg-red-950` errors | `text-destructive` / `bg-destructive/15` |
| `text-green-400` success states | `text-success` / `bg-success` |
| `text-yellow-400` / `text-orange-400` in-progress or attention states | `text-warning` |
| sidebar styling | `bg-sidebar text-sidebar-foreground`, `border-sidebar-border`, `bg-sidebar-accent text-sidebar-accent-foreground` |

Hover/selected surfaces: `hover:bg-accent`, `bg-accent text-accent-foreground`
(or the sidebar variants inside the sidebar).

### Rules

- Never assume the dark theme. Both themes come from the same classes; if a
  color only looks right in one theme, you used the wrong token.
- Adding a new semantic color: define the CSS variable in BOTH `:root` and
  `.dark` in `src/index.css`, register it under `@theme inline`
  (`--color-<name>: var(--<name>)`), and add its foreground/background pair to
  `contrastPairs` in `test/theme.test.mjs`.
- Generated shadcn components in `src/components/ui/` are exempt from the
  raw-palette check (the test skips them). Don't hand-edit them to add raw
  colors either.
- Before committing UI changes, run `npm test` (theme + UI tests) and
  `npm run build` in this workspace.
