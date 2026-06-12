# Security — Project Lessons

Lessons learned from failures and fix cycles.
Auto-appended by the lessons skill.

## Derive Interface Warning From Bound Address

When deciding whether the HTTP listener in `server/src/index.ts` is exposed on all interfaces, base the check on `info.address` from the `serve()` callback rather than the raw `config.host`/`YTSEJAM_HOST` string. Node normalizes equivalent all-interface spellings before binding (`0` → `0.0.0.0`, `::0` → `::`), so a string-equality check against `config.host` misses non-canonical forms and silently shows the friendly localhost label with no warning while actually binding every interface. Compare `info.address === "0.0.0.0" || info.address === "::"` once, store it in a single `allInterfaces` variable, and use it for both the display host and the security warning. This matters because this task is the public-exposure security fix, and any silent-exposure path (binding all interfaces without warning) defeats its entire purpose.

_Added: 2026-06-12 | Task: Task 1 of release-public-prep: Make ytsejam's HTTP listener bind 127_
