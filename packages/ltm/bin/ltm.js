#!/usr/bin/env node
// Thin launcher: Node ≥22.6 strips the library's TypeScript natively.
const { runCli } = await import("../src/cli/main.ts");
process.exit(await runCli(process.argv.slice(2)));
