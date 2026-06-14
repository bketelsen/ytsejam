# Security — Project Lessons

Rules learned from security-related fix cycles. Cap: 30 entries — prune oldest if exceeded.

## Freeze Security Registries And Pin Judgment Calls

When exporting a security-adjacent registry like `GATED_TOOL_NAMES` in `server/src/approval/gated-tools.ts`, type the export as `ReadonlySet<string>` rather than relying on `const`, since `const` only freezes the binding and still lets any importer call `.add()`/`.delete()` to silently disable approval gates process-wide; the cast preserves `.has()`/`.size` while turning mutations into compile errors. In the matching test (`server/test/approval-gated-tools.test.ts`), enumerate the full set of registered tools rather than a hand-picked subset, and explicitly pin deliberate judgment calls — e.g. mutating-but-ungated tools like `cog_move` and `cog_rpc` that fall under the "all `cog_*` memory tools are ungated, low blast radius" rule — so future readers don't "fix" them into gated. Add a source comment documenting that the blanket `cog_*` exemption intentionally covers the mutating tools. Finally, keep JSDoc consistent across a feature directory: give every exported function (including `isGatedTool`) a doc comment when its siblings already have one.

_Added: 2026-06-14 | Task: Task 4 — gated-tools registry (approval-mode)_
