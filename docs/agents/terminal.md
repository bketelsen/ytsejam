# Terminal (quake-style PTY)

> Sub-doc of [`OVERVIEW.md`](OVERVIEW.md). Read this before touching the interactive terminal.
> Server: `server/src/terminal.ts`, the `/api/terminal/ws` route in `server/src/server.ts`.
> Web: `web/src/components/QuakeTerminal.tsx`, `web/src/lib/terminal-ws.ts`, the open-state/hotkey
> wiring in `web/src/App.tsx`, and the rail button in `web/src/components/Sidebar.tsx`.
> Tests: `server/test/terminal.test.ts`, `web/test/quake-terminal.test.mjs`.

## Purpose

A drop-down ("quake-style") terminal that gives the single user a **real interactive shell on the
server host**, opened over the same web app. It is not an agent tool and not part of any agent loop —
it is a direct human↔shell PTY bridge, useful for poking at the box ytsejam runs on without a
separate SSH session. Because it runs the user's login shell in their home dir with their full
environment, it has the **same blast radius as an SSH session**; treat the auth boundary as
load-bearing.

## Architecture

```
QuakeTerminal (xterm + FitAddon)
   │  terminal-ws.ts  (WebSocket, token in query string)
   ▼
/api/terminal/ws  (server.ts upgradeWebSocket, query-token gate)
   │  createTerminalSession()
   ▼
terminal.ts → node-pty → user's shell in os.homedir()
```

### Server — `server/src/terminal.ts`

`createTerminalSession(opts)` spawns the user's shell through **`node-pty`** (a native addon) and
returns a small `TerminalSession` handle (`write` / `resize` / `kill`):

- **Shell selection** (`defaultShell()`): `$SHELL` if set, else `powershell.exe` on Windows, else
  `bash` if `/bin/bash` or `/usr/bin/bash` exists, else `sh`.
- **CWD**: defaults to `os.homedir()` (a login-shell-like experience), not the server's working dir
  or any session workdir.
- **Env**: inherits `process.env` by default — so the shell sees the systemd unit's `PATH` and
  `NODE_ENV=production` (see the subagent-install gotcha in [`delegation.md`](delegation.md) if you
  run installs in there).
- **Lifecycle**: it wires `onData`/`onExit` disposables, guards `write`/`resize`/`kill` against the
  exited/killed states, disposes the data listener and kills the child on `kill()`, and reaps the
  process when the child exits. There is **one PTY per WebSocket** and no persistence — closing the
  socket kills the shell.

### Route — `/api/terminal/ws` in `server/src/server.ts`

A dedicated WebSocket upgrade, listed in `PUBLIC_API_PATHS` alongside `/api/login` and `/api/ws`
because **the bearer-auth middleware can't read a header off a browser WebSocket handshake**.
Auth instead happens inside the upgrade:

- The client passes the bearer token as a **`?token=` query param**. If it does not equal
  `config.authToken`, `onOpen` immediately closes with code **`4401`** ("unauthorized") and no PTY is
  ever spawned. (`server/test/terminal.test.ts` pins the 4401-on-wrong-token behavior.)
- On a valid open, the route creates a `TerminalSession` (initial `80×24`) and bridges frames:
  - PTY → client: `{ type: "output", data }`; on child exit `{ type: "exit", code }` then `ws.close()`.
  - client → PTY: `{ type: "input", data }` → `session.write`; `{ type: "resize", cols, rows }` →
    `session.resize` (coerced to finite, floored, min 1).
  - Malformed frames are ignored (try/catch), never crash the socket.
  - `onClose` kills the session and drops the reference, so the shell dies with the tab.

### Web — `QuakeTerminal` + `terminal-ws.ts`

- **`QuakeTerminal.tsx`** renders an **`@xterm/xterm`** `Terminal` with the **`@xterm/addon-fit`**
  `FitAddon` inside a top-anchored shadcn `Sheet`. It opens the terminal against a ref-captured host
  div, connects the WS, and pipes `terminal.onData`→`input`, `terminal.onResize`→`resize`, and
  incoming `output` frames back into `terminal.write`. Resize is debounced through a
  `requestAnimationFrame` and driven by a `ResizeObserver` on the host plus the window `resize` event;
  `fitAddon.fit()` is wrapped in try/catch because xterm can throw while the Sheet is still measuring
  during mount/unmount. The effect cleans up every listener/disposable, closes the WS, and disposes
  the terminal on unmount/close.
- **`terminal-ws.ts`** (`connectTerminalWs`) builds the `ws(s)://…/api/terminal/ws?token=…` URL
  (token via `getToken()` from `localStorage`, URL-encoded), queues sends until the socket is open,
  parses `output`/`exit` frames, and exposes `send`/`close`. On socket close it disables stdin.

### Open state + hotkey — `App.tsx` / `Sidebar.tsx`

`App.tsx` owns `terminalOpen` state and a global `keydown` listener: **`Ctrl+`` (backtick) or
`Ctrl+~`** toggles the terminal (with `preventDefault`). The `Sidebar` rail also has an "Open
terminal" icon button (`onOpenTerminal`) that opens it. The `<QuakeTerminal>` lives at the App root.

## Key patterns / invariants

- **Auth is the whole security model.** The PTY is a full shell as the service user. The only gate is
  the `?token=` check that mirrors the bearer token; keep it. Never log the token or widen
  `PUBLIC_API_PATHS` without an equivalent in-handler auth check. The wrong-token path must close
  before spawning anything.
- **One PTY per socket; the socket owns the lifecycle.** No reconnect/resume, no shared sessions.
  `onClose` must kill the child — a leaked PTY is a leaked process on the host.
- **Padding must live *outside* the ref-backed xterm fit target** (PR #273). The FitAddon measures
  the element xterm was `open()`ed on; if that element carries padding (`px-/py-/pt-/pb-`), the fit
  math is off by the padding and rows/cols are miscomputed (cropped/blank rows). The fix nests two
  divs: the **outer** wrapper carries the Sheet chrome padding (`px-3 pb-3 pt-12`); the **inner**
  `ref={setContainerElement}` div is padding-free (`h-full min-h-0 overflow-hidden`) and is what xterm
  fits to. `SheetContent` itself is `overflow-hidden` with `p-0`. `web/test/quake-terminal.test.mjs`
  asserts this exact structure **and** asserts the ref'd div has no padding classes — don't collapse
  the two divs back together.
- **`fitAddon.fit()` can throw mid-measure** — keep it in try/catch and keep the rAF debounce; the
  Sheet animates open/closed and xterm dislikes being measured at zero size.
- **node-pty is a native module.** It must be compiled for the deploy host's Node ABI. See the deploy
  note below.

## Deploy / native-module gotcha

`node-pty` ships native bindings, so a release must **rebuild** them after `npm ci`, and a bad build
must fail the deploy *before* the symlink swap:

- `deploy/deploy.sh` runs `npm ci --include=dev --ignore-scripts` (the `--ignore-scripts` that avoids
  the `patch-package` PATH dependency *also* skips native build lifecycles), so it then runs
  **`env -u NODE_ENV npm rebuild`** to build native deps, and a smoke check
  **`node -e 'require("node-pty")'`** that `die`s the deploy if the addon won't load. This was added
  in commit `cb9c2a1` ("Fix deploy native module rebuild") right after the terminal landed. → see
  [`deployment.md`](deployment.md) § Native modules.
- Implication: if you add another native dependency, `--ignore-scripts` means it won't build on its
  own — extend the `npm rebuild` + load-smoke step rather than assuming `npm ci` built it.
- The web side pulls in `@xterm/xterm` + `@xterm/addon-fit` (pure JS, bundled by Vite — no native
  step) and ships xterm's CSS (`@xterm/xterm/css/xterm.css`).

## Tests

- `server/test/terminal.test.ts` — `createTerminalSession` forwards output + exit, defaults to
  `os.homedir()`, `kill()` reaps the child; and the WS route closes with **4401** on a missing/invalid
  token.
- `web/test/quake-terminal.test.mjs` — source-level assertions: App imports/renders `QuakeTerminal`
  with `terminalOpen`; the `Ctrl+`/`Ctrl+~` hotkey with `preventDefault`; the Sidebar button; the
  Sheet/xterm/FitAddon wiring; and the **padding-outside-the-fit-target** structure from PR #273.
