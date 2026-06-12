# Memory test parity

## Store (PR-1a)

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
| TestMoveFile | `move rename rejects existing/traversal and enforces destination allow-list`; intentional divergence from Go: destination is also allow-listed |
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
| TestL0Index | PR-1a smoke in `TestReadL0INDEX and TestReadLIST`; full public parity in PR-2c `l0index.test.ts` |
| TestL0IndexFiltersByDomain | PR-2c `l0index.test.ts` |
| TestL0IndexMissingDomainReturnsEmpty | PR-2c `l0index.test.ts` |
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

## Domain (PR-1b)

| Go test | Vitest equivalent | Status |
|---|---|---|
| TestControllerLoadAndList | ControllerLoadAndList | Ported |
| TestControllerGetIncludesSubdomains | ControllerGetIncludesSubdomains | Ported |
| TestControllerObservationsResolves | ControllerObservationsResolves | Ported |
| TestControllerActionItemsResolves | ControllerActionItemsResolves | Ported |
| TestControllerResolveFile | ControllerResolveFile | Ported |
| TestControllerValidateWriteWarnsUnknown | ControllerValidateWriteWarnsUnknown | Ported |
| TestControllerHotReloadOnMtimeChange | ControllerHotReloadOnMtimeChange | Ported |
| TestControllerMalformedYAMLRejected | ControllerMalformedYAMLRejected | Ported |
| TestControllerInvalidSchemaRejected | ControllerInvalidSchemaRejected | Ported; includes bad-file and slash-file |
| TestControllerMissingManifestEmpty | ControllerMissingManifestEmpty | Ported |
| TestControllerEntitiesResolves | ControllerEntitiesResolves | Ported |
| TestControllerValidateWriteFlagsIDAsPath | ControllerValidateWriteFlagsIDAsPath | Ported |
| TestControllerValidateWriteAllowsIDPrefixedPath | ControllerValidateWriteAllowsIDPrefixedPath | Ported |

Additional PR-1b coverage required by plan: `loadManifest` happy path, `domainForPath`, optional domain filters for action-items/observations/entities, hot-reload stale-but-served error path, I1 null-domains regression, I2 `..` resolution + escape rejection, I5 recovery after parse error.

## Consolidated — Index+Wiki (PR-2c)

Scope: in-process consolidated replacements for `glacier_index_compute`, `wiki_index_compute`, and public `l0index`. RBAC/role-required RPC cases are intentionally obsolete per fold-plan D6 (single-user, no role/RBAC); coverage notes assert unfiltered in-process behavior where useful.

| Go test | Vitest equivalent | Status |
|---|---|---|
| rpc/glacier_test.go TestGlacierIndexComputeMethod | `glacier-index-compute.test.ts` `TestGlacierIndexParsesFrontmatter / TestGlacierIndexComputeMethod` | Ported |
| TestGlacierIndexComputeRBACFilters | `glacier-index-compute.test.ts` `TestGlacierIndexComputeRBACFilters is obsolete after RBAC removal` | Obsolete semantics documented; unfiltered result tested |
| TestGlacierIndexComputeMissingRole | N/A | Obsolete per D6; public TS function takes no role |
| store/glacier_test.go TestGlacierIndexEmpty | `glacier-index-compute.test.ts` `TestGlacierIndexEmpty` | Ported |
| TestGlacierIndexParsesFrontmatter | `glacier-index-compute.test.ts` `TestGlacierIndexParsesFrontmatter / TestGlacierIndexComputeMethod` | Ported |
| TestGlacierIndexSkipsTmp | `glacier-index-compute.test.ts` `TestGlacierIndexSkipsTmp` | Ported |
| rpc/wiki_test.go TestWikiIndexComputeMethod | `wiki-index-compute.test.ts` `TestWikiIndexComputeMethod` | Ported |
| TestWikiIndexComputeRBACFilters | `wiki-index-compute.test.ts` `TestWikiIndexComputeRBACFilters is obsolete after RBAC removal` | Obsolete semantics documented; unfiltered result tested |
| TestWikiIndexComputeMissingRole | N/A | Obsolete per D6; public TS function takes no role |
| store/store_test.go TestL0Index | `l0index.test.ts` `TestL0Index` | Ported |
| TestL0IndexFiltersByDomain | `l0index.test.ts` `TestL0IndexFiltersByDomain` | Ported |
| TestL0IndexMissingDomainReturnsEmpty | `l0index.test.ts` `TestL0IndexMissingDomainReturnsEmpty` | Ported |

Additional PR-2c coverage: `l0index` strict-param rejection for unknown keys; wiki `category` alias accepted alongside Go's `entity_type` for the tightened TS type/spec wording.
