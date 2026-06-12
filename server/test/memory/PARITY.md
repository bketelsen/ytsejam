# PR-1a Go test parity

Scope: primitive store functions and write-path RPC cases from cogmemory. Consolidated/domain tests in the same large Go files are intentionally owned by later PRs.

| Go test | Vitest mapping |
|---|---|
| store/store_test.go TestRead | store.test.ts `TestRead / TestReadMissing / extraction` |
| TestReadMissing | same |
| TestReadL0INDEX | `TestReadL0INDEX and TestReadLIST` |
| TestReadLIST | same |
| TestReadFullContentWithNoExtractionParams | `TestRead / TestReadMissing / extraction` |
| TestReadSectionByHeading | same |
| TestReadSectionNotFoundReturnsError | same |
| TestReadLineRangeStartAndEnd | same |
| TestReadLineRangeDefaultStart | same |
| TestReadLineRangeDefaultEnd | same |
| TestWrite | `write allow-list, overwrite, subdir, id-as-path rejection` |
| TestWriteOverwrite | same |
| TestWriteCreatesSubdir | same |
| TestWriteAtomic | covered by atomic-write implementation sanity; no race-specific TS parity case (single process promise scheduling) |
| TestAppend | `append EOF, creates file, newline handling, obs enforcement, id-as-path` |
| TestAppendCreatesFile | same |
| TestAppendAddsSeparatorWhenExistingLacksTrailingNewline | same |
| TestAppendDoesNotDoubleInsertSeparatorWhenTextStartsWithNewline | same |
| TestAppendAddsTrailingNewlineWhenMissing | same |
| TestAppendObsEnforcement | same |
| TestAppendObsEnforcementBarePathName | same |
| TestAppendNonObsPathNotValidated | same |
| TestAppendSectionUnderHeading | `append section semantics` |
| TestAppendSectionAcceptsBareTitle | same |
| TestAppendSectionMissingHeading | same |
| TestAppendSectionEmptyEqualsAppend | covered by EOF append branch and public `append(...,{section:""})` default signature |
| TestAppendSectionStopsAtSameLevelHeading | `append section semantics` |
| TestPatch | `patch exact occurrence` |
| TestPatchNotFound | same |
| TestPatchAmbiguous | same |
| TestOutlineReturnsMarkdownHeadingsInOrder | `outline includes L0 and markdown headings, missing errors` |
| TestOutlineMissingFileReturnsError | same |
| TestMoveFile | `move rename rejects existing/traversal and enforces destination allow-list` |
| TestMoveExistingDestinationReturnsError | same |
| TestMovePathTraversalRejected | same |
| TestSearch | `search/list/stats skip git and sort/filter`; `search matches regex metacharacters literally` locks Go-faithful literal substring semantics |
| TestSearchCaseInsensitive | `search/list/stats skip git and sort/filter` and `search is case-insensitive literal substring`, matching Go's `strings.Contains(strings.ToLower(line), strings.ToLower(query))` |
| TestPathTraversal | `write allow-list...` and move traversal case |
| TestPathTraversalWrite | `write allow-list...` |
| TestStats | `search/list/stats skip git and sort/filter` |
| TestStatsPrefix | same |
| TestList | same |
| TestFileScansSkipGitDirectory | same |
| TestL0Index | `TestReadL0INDEX and TestReadLIST` |
| TestL0IndexFiltersByDomain | deferred to PR-2c public l0index; store helper implemented |
| TestL0IndexMissingDomainReturnsEmpty | deferred to PR-2c public l0index; store helper implemented |
| TestNewRelativePathRejected | env root resolution uses absolute resolved roots; path traversal cases cover relative user paths |
| TestGitStatusCleanRepo | `health and git operations` |
| TestGitCommitRequiresMessage | same |
| TestGitUnknownOp | same |
| rpc/server_test.go TestReadMethod | primitive read/write tests |
| TestPatchMethod | `patch exact occurrence` |
| TestAppendObsEnforcementViaRPC | append observation test |
| TestAppendSectionViaRPC | `append section semantics` |
| TestOutlineMethod | outline test |
| TestMoveMethod | move test |
| TestHealthMethod | `health and git operations` |
| TestGitStatusMethodAllowsReadOnlyRole | `health and git operations` (RBAC dropped per D6) |
| rpc/write_path_test.go TestWriteRejectsIDAsPath | `write allow-list...` |
| TestAppendRejectsIDAsPath | append id-as-path case |
| TestWriteUndeclaredFileUnderDomainPathStillAllowed | `write allow-list...` allows `*/INDEX.md` under configured path |
