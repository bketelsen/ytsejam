# Security

ytsejam is a single-user personal assistant. The threat model assumes:

- Loopback (`127.0.0.1`) binding by default — only override `YTSEJAM_HOST` behind a reverse proxy you trust (see [README § Security model](README.md#security-model)).
- A single bearer token (`YTSEJAM_AUTH_TOKEN`) authenticates all API calls. Token compromise grants full server-side execution (`bash` tool, file write, scheduler).
- The maintainer is the only operator.

## Reporting a vulnerability

Please use GitHub's [private security advisories](https://github.com/bketelsen/ytsejam/security/advisories/new) rather than opening a public issue. Include reproduction steps and any relevant config.

Public issues for non-security bugs are welcome.
