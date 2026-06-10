# ytsejam — GitHub Copilot & OpenAI Codex Subscription Support

**Date:** 2026-06-09
**Status:** Approved design

## Summary

Make models from GitHub Copilot and OpenAI Codex (ChatGPT) subscriptions
available in ytsejam by reusing the pi CLI's existing OAuth credentials.
ytsejam reads `~/.pi/agent/auth.json`, refreshes expired tokens via pi-ai's
OAuth helpers, and writes refreshed tokens back so pi and ytsejam share one
credential store. ytsejam does NOT implement OAuth login flows — when a
refresh token dies, the user re-authenticates with the pi CLI.

## Verified facts (pi v0.79.1)

- pi stores OAuth credentials at `~/.pi/agent/auth.json` (mode 0600), keyed
  by provider id (`openai-codex`, `github-copilot`), each entry
  `{ type: "oauth", access, refresh, expires, accountId? }`.
- `@earendil-works/pi-ai/oauth` (subpath export, already installed) provides:
  - `getOAuthApiKey(providerId, credentials)` — returns
    `{ apiKey, newCredentials }`, auto-refreshing when `Date.now() >= expires`;
    returns null when no credentials; throws when refresh fails.
  - `getOAuthProvider(id)` — provider interface; Copilot's has
    `modifyModels(models, credentials)` which rewrites model `baseUrl`
    (individual vs. business endpoint, derived from the access token).
- The openai-codex provider extracts the ChatGPT account id from the access
  token itself; no extra headers needed beyond `apiKey`.
- The pi-ai model catalog already contains `github-copilot/*` and
  `openai-codex/*` models; ytsejam currently filters them out because
  availability is gated on `getEnvApiKey` only.

## Components

### `server/src/pi-auth.ts` — `PiAuthStore` (new)

- Constructor: `new PiAuthStore(authPath)`. Default path
  `~/.pi/agent/auth.json`; env override `YTSEJAM_PI_AUTH`.
- `hasCredentials(provider): boolean` — an `oauth`-type entry exists.
- `getCredentials(provider)` — raw entry (for `modifyModels`).
- `getApiKey(provider): Promise<string | undefined>` — reads the file fresh,
  calls `getOAuthApiKey`; when the token was refreshed, persists the updated
  entry back to the file (whole-file write, mode 0600). Refresh failure or
  unknown provider logs a warning (mentioning pi CLI re-auth) and returns
  undefined — never throws into the request path.
- Missing file / unparseable JSON / non-oauth entries ⇒ "no credentials",
  not an error. Machines without pi keep working purely on env keys.

### `server/src/models.ts` (modified)

- `listAvailableModels(opts?)` gains `oauth?: PiAuthStore`. A provider is
  available when it has an env key OR `oauth.hasCredentials(provider)`.
  For OAuth-credentialed providers whose pi-ai OAuth provider implements
  `modifyModels`, apply it to the listed models (correct Copilot baseUrl).
- `resolveModel(ref, oauth?)` applies the same `modifyModels` adjustment so
  sessions get models with the right baseUrl.
- With no `oauth` argument, behavior is exactly as today (existing tests
  unchanged).

### `server/src/manager.ts` (modified)

- `AgentManagerOptions` gains `authStore: PiAuthStore`.
- `getApiKeyAndHeaders` becomes: env key via `getEnvApiKey(provider)`,
  else `await authStore.getApiKey(provider)`. pi-ai resolves credentials per
  provider request, so short-lived Copilot tokens refresh mid-session.

### `server/src/config.ts` / `server/src/index.ts` (modified)

- Config gains `piAuthPath` (default `<home>/.pi/agent/auth.json`, env
  `YTSEJAM_PI_AUTH`).
- Boot constructs one `PiAuthStore`, passes it to `AgentManager` and to the
  `/api/models` route (via `createApp` deps → `listAvailableModels`).

### Web UI

No changes. Copilot/Codex models simply appear in the existing model picker.

## Error handling

- Dead refresh token: models remain listed (credentials exist), the turn
  fails, and pi-ai's failure surfaces as the existing assistant error block
  in chat; server log instructs re-authenticating with the pi CLI.
- auth.json concurrent writes (pi CLI vs ytsejam): last-writer-wins on the
  whole file — same exposure as two concurrent pi instances. Accepted;
  recovery is re-running pi's login flow.

## Testing

- `PiAuthStore` unit tests against a temp auth.json and a fake OAuth provider
  registered via pi-ai's `registerOAuthProvider`/`unregisterOAuthProvider`:
  valid token returned; expired token refreshed AND persisted to disk;
  missing file → undefined; unknown provider → undefined; refresh failure →
  undefined (no throw).
- `models.ts`: OAuth-only provider appears in `listAvailableModels`;
  `modifyModels` hook applied to listed/resolved models.
- `manager.ts`: with no env key, `getApiKeyAndHeaders` consults the auth
  store (fake OAuth provider; faux model path otherwise unchanged).

## Decisions log

- Reuse pi's auth only; no in-app OAuth login flows.
- Implement a small `PiAuthStore`; do not depend on `pi-coding-agent`.
- Write refreshed tokens back to pi's auth.json (shared store, 0600).
