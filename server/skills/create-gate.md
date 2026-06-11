---
name: create-gate
description: Create a gate script for a project — reads CI config, proposes a script, writes it, records it in the project's hot memory. Use when the user says "create a gate script", "add a gate", or "set up the gate for <project>".
triggers: [create gate, gate script, add a gate, set up the gate, gate.sh]
---

# Creating Gate Scripts

## Overview

Bootstrap a gate script for a project. Creates the script file, makes it executable, and records the gate in the project's cog hot memory so future sessions know the project has a single quality gate.

**Announce at start:** "I'm using the create-gate skill to create a gate script."

## Trigger

Invoked when the user says "create a gate script", "add a gate for `<project>`", "set up the gate", or similar.

## Process

### Step 1: Read project context

From the project root, read:

- `.github/workflows/ci.yml` (or any CI workflow file) — **authoritative source**: the gate must cover exactly what CI tests
- `package.json` — detect available npm scripts
- `Makefile` — detect make targets if present
- `AGENTS.md` / `CLAUDE.md` — any documented quality requirements

CI is the ground truth. If CI runs `npm test`, the gate runs `npm test`. If CI runs `make check`, the gate runs `make check`. Do not add checks CI doesn't run.

### Step 2: Propose the gate script

Present the proposed script to the user **before writing anything**:

```
I'd create scripts/gate.sh with these steps:

  1. <step name>: <command>
  2. <step name>: <command>
  ...

Looks right?
```

Wait for user confirmation or modification before proceeding.

### Step 3: Write the script

Default path: `scripts/gate.sh`. Accept any relative path the user specifies.

The script template:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== gate: <step name> ==="
<command>

echo "=== gate: <next step name> ==="
<command>

echo ""
echo "=== gate: PASSED ==="
```

**Rules:**
- `set -euo pipefail` always — exits immediately on any failure
- One `echo "=== gate: <name> ==="` banner per step
- Exit code is the only signal — agents check exit code, not output
- End with `echo "=== gate: PASSED ==="` on success

Write the file with the `write` tool (or `cat > <path> << 'GATEEOF' … GATEEOF`), then make it executable:
```bash
chmod +x <path>
```

### Step 4: Record the gate in the project's cog hot memory

The project corresponds to a cog domain. Add (or update) a short line in that domain's `hot-memory.md` so future sessions know the gate exists and what command to run:

```
quality gate: scripts/gate.sh
```

- Use the cog tools, addressing the domain by its **path** (e.g. `projects/ytsejam/hot-memory.md`, `projects/cog-memory-service/hot-memory.md`), never the domain id.
- If a `## Build / Quality` (or similar) section exists, add the line there; otherwise append a one-line note under the most relevant existing heading. Keep it to a single line — hot memory is capped (<50 lines) and injected every turn.
- If a stale `quality gate:` / gate line already exists, update it in place rather than adding a duplicate.
- If the project is not a cog domain, skip this step and instead note the gate path in the project's `AGENTS.md` / `README` quality section.

### Step 5: Run the gate to verify

```bash
bash <path>
```

Expected: exits 0, final line is `=== gate: PASSED ===`.

If it fails, diagnose and fix before declaring done.

### Step 6: Report

```
Gate script created at <path>.
Recorded in <domain>/hot-memory.md: quality gate: <path>
Gate passed. ✅
```

## Red Flags

**Never:**
- Write the script before the user approves the proposal
- Add checks that CI doesn't run
- Skip the verification run
- Forget to `chmod +x`
- Bloat hot memory — the gate note is ONE line
