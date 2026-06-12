# Memory test parity

## Store (PR-1a)

Scope: primitive store functions and write-path RPC cases from cogmemory. Consolidated/domain tests in the same large Go files are intentionally owned by later PRs.

| Go test | Vitest mapping |
|---|---|
| store/store_test.go TestRead | store.test.ts `TestRead / TestReadMissing / extraction` |
| TestReadMissing | same |
| TestReadL0INDEX | `TestReadL0INDEX and TestReadLIST` |
| TestReadLIST | same; includes empty-store `LIST` returning empty content / found=false parity |
| TestReadFullContentWithNoExtractionParams | `TestRead / TestReadMissing / extraction` |
| TestReadSectionByHeading | same; includes abutting-heading/EOF case with no forced trailing newline |
| TestReadSectionNotFoundReturnsError | same |
| TestReadLineRangeStartAndEnd | same |
| TestReadLineRangeDefaultStart | same |
| TestReadLineRangeDefaultEnd | same |
| TestWrite | `write allow-list, overwrite, subdir, id-as-path rejection` |
| TestWriteOverwrite | same |
| TestWriteCreatesSubdir | same |
| TestWriteAtomic | covered by atomic-write implementation sanity; temp-file cleanup on write/fsync failure mirrors Go remove paths (rare failure path, no race-specific TS case) |
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
| TestOutlineReturnsMarkdownHeadingsInOrder | `outline includes L0 and markdown headings, missing errors`; plus spec-tightening regression that mid-file L0-shaped comments are ignored (intentional divergence from Go naive regex) |
| TestOutlineMissingFileReturnsError | same |
| TestMoveFile | `move rename rejects existing/traversal and enforces destination allow-list`; intentional divergence from Go: destination is also allow-listed |
| TestMoveExistingDestinationReturnsError | same |
| TestMovePathTraversalRejected | same |
| TestSearch | `search/list/stats skip git and sort/filter`; `search matches regex metacharacters literally` locks Go-faithful literal substring semantics |
| TestSearchCaseInsensitive | `search/list/stats skip git and sort/filter` and `search is case-insensitive literal substring`, matching Go's `strings.Contains(strings.ToLower(line), strings.ToLower(query))` |
| TestPathTraversal | `write allow-list...` and move traversal case |
| TestPathTraversalWrite | `write allow-list...` |
| TestStats | `search/list/stats skip git and sort/filter` |
| TestStatsPrefix | same; includes `/` prefix trimming to match Go `strings.Trim(prefix, "/")` |
| TestList | same; includes Go byte-wise path ordering regression (`Zeta.md` before `alpha.md`) |
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

Additional PR-2c coverage: `l0index` strict-param rejection for unknown keys; wiki `category` alias accepted alongside Go's `entity_type` for the tightened TS type/spec wording. Pre-PR-3 cleanup adds omitempty parity for glacier `entries: 0` and wiki `related: []`, Go-int truncation for fractional glacier `entries`, and an empty-frontmatter regression ensuring only defined keys are present on in-process entry objects.
||||||| parent of ad25dd0 (Add PR-2a consolidated memory test parity)

## Consolidated — Session + Housekeeping (PR-2a)

Scope: `sessionBrief`, `housekeepingScan`, `openActions`, `domainSummary`, and `recentObservations`. RBAC/role-required Go cases are mapped as "N/A" because fold plan D6 drops RBAC and role params from the TypeScript public surface; deprecated `by_domain` alias cases are intentionally inverted per D12 (alias not ported; strict unknown-key rejection is tested).

| Go test | Vitest mapping |
|---|---|
| rpc/session_brief_test.go TestSessionBriefReturnsEnvelope | consolidated.test.ts `sessionBrief returns hot memory...` |
| TestSessionBriefRBACFiltersDomainsAndCounts | N/A — RBAC dropped per D6 |
| TestSessionBriefDomainsIncludePath | `sessionBrief returns hot memory...` |
| TestSessionBriefMissingRoleErrors | N/A — role param dropped per D6 |
| store/session_brief_test.go TestSessionBriefReadsHotMemoryAndPatterns | `sessionBrief returns hot memory...` |
| TestSessionBriefMissingFilesReturnEmpty | `sessionBrief missing canonical files...` |
| TestSessionBriefCountsOpenActionsPerDomain | `sessionBrief counts ignore completed...` |
| rpc/server_test.go TestOpenActionsMethodReturnsReadableUncheckedItems | `openActions returns unchecked items...` |
| TestOpenActionsMethodEmptyResultIsArray | `openActions returns an empty array...` |
| TestOpenActionsMethodBroadRoleSeesAllItems | `openActions returns unchecked items...` |
| TestOpenActionsMethodInvalidParams | strict public validation coverage (`strict params reject...`) |
| TestOpenActionsMethodMissingRole | N/A — role param dropped per D6 |
| TestOpenActionsDomainFilter | `openActions returns an empty array... supports domain filter` |
| TestOpenActionsDomainFilterUnknownErrors | same |
| TestOpenActionsDomainComesFromController | `openActions domain comes from controller path...` |
| store/store_test.go TestOpenActionsReturnsUncheckedItemsFromActionFiles | `openActions returns unchecked items...` |
| TestOpenActionsEmptyResultIsNonNil | `openActions returns an empty array...` |
| rpc/server_test.go TestRecentObservationsHappyPath | `recentObservations happy path...` |
| TestRecentObservationsByTagFilter | `recentObservations filters by tag...` |
| TestRecentObservationsDomainParamWorks | `recentObservations filters by tag and by canonical domain param` |
| TestRecentObservationsByDomainAliasStillWorks | D12 inversion: alias not ported; `recentObservations rejects by_domain alias...` |
| TestRecentObservationsBothDomainAndByDomainSameValueAllowed | D12 inversion: alias rejected by strict params |
| TestRecentObservationsBothDomainAndByDomainDifferRejected | D12 inversion: alias rejected by strict params |
| TestRecentObservationsByDomainUnknownErrors | canonical unknown-domain half in `recentObservations rejects...`; alias half rejected as unknown key |
| TestRecentObservationsWrongParamNamesAreSilentlyIgnored | superseded by strict rejection; `strict params reject...` |
| TestRecentObservationsInvalidSinceRejected | `recentObservations rejects by_domain alias, invalid since...` |
| TestRecentObservationsMissingRole | N/A — role param dropped per D6 |
| TestRecentObservationsRBACFiltersUnreadablePaths | N/A — RBAC dropped per D6 |
| TestRecentObservationsEmptyResultShapesAreNotNull | `recentObservations default since... empty shapes...` |
| TestRecentObservationsDefaultSinceIs7Days | same |
| TestRecentObservationsSkipsFencedBlocks | `recentObservations rejects by_domain alias... skips fences` |
| TestRecentObservationsDurationSince | `recentObservations accepts duration since forms` |
| PR-2a intentional divergence from Go duration parsing | `resolveSince rejects composite Go durations (intentional divergence)` |
| store/domain_summary_helpers_test.go TestRecentObservationsFiltersAndParses | `domainSummary happy path` and `recentObservations happy path...` |
| TestCountActionsHandlesFencesAndDates | `domainSummary happy path` (dated completed count) and session/action skip tests |
| rpc/domain_summary_test.go TestDomainSummaryHappyPath | `domainSummary happy path` |
| TestDomainSummaryDefaultSinceIs7Days | `domainSummary default/duration since...` |
| TestDomainSummarySinceDurationForms | same |
| TestDomainSummaryRBACDenied | N/A — RBAC dropped per D6 |
| TestDomainSummaryUnknownDomain | `domainSummary default/duration since...` |
| TestDomainSummaryMissingFilesAreOmitted | same |
| TestDomainSummaryRoleRequired | N/A — role param dropped per D6 |
| TestDomainSummaryHotReloadsManifest | `domainSummary default/duration since... hot-reloaded manifest` |
| TestDomainSummaryIncludesPath | `domainSummary happy path` |
| rpc/housekeeping_test.go TestHousekeepingScanMissingRole | N/A — role param dropped per D6 |
| TestHousekeepingScanEmptyEnvelope | `housekeepingScan empty envelope` |
| TestHousekeepingScanObservationsOverCapAggregatesPrimaryTag | `housekeepingScan observations over cap...` |
| TestHousekeepingScanActionItemsCompletedAndStale | `housekeepingScan action completed cap...` |
| TestHousekeepingScanHotMemoryOverCap | same |
| TestHousekeepingScanPatternsOverCapByBytes | same |
| TestHousekeepingScanDormantDomain | `housekeepingScan observations over cap... detects dormancy` |
| TestHousekeepingScanRBACFilters | N/A — RBAC dropped per D6 |
| TestHousekeepingScanImprovementsOverCap | `housekeepingScan action completed cap...` |
| TestHousekeepingScanChangedRecentlyHonorsMarker | `housekeepingScan changed_recently honors marker` |
| rpc/strict_params_test.go TestStrictParamsRecentObservations | `strict params reject unknown keys...` plus `recentObservations rejects by_domain alias...` |
| TestRecentObservationsWrongParamNamesAreRejected | same |
| PR-2a added strict cases for session_brief/housekeeping_scan/open_actions/domain_summary | `strict params reject unknown keys for all PR-2a public functions` |

**Intentional divergence from Go (PR-2a):** `resolveSince` accepts single-unit durations only (`Nd`/`Nh`/`Nm`/`Ns` ± decimal); Go's `time.ParseDuration` also accepts composites (`1h30m`, `100ms`). TS port rejects composites with `unrecognized since value`. Documented in `common.ts:resolveSince` JSDoc; locked by `resolveSince rejects composite Go durations (intentional divergence)`.
||||||| parent of 53da72b (Implement memory analysis consolidated RPCs)

## Consolidated — Analysis (PR-2b)

Scope: cluster_check, entity_audit, link_audit, link_index_compute, and scenario_check. RBAC/role-required Go RPC assertions are intentionally not ported because D6 removes roles; strict-params rejection is covered instead.

| Go test | Vitest equivalent | Status |
|---|---|---|
| rpc/cluster_check_test.go TestClusterCheckMethodReturnsTagClusters | analysis.test.ts `TestClusterCheckMethodReturnsTagClusters / TestClusterByTag` | Ported |
| TestClusterCheckMethodRequiresRole | superseded by D6; strict params rejects `role` | Covered by strict-param cases |
| TestClusterCheckMethodInvalidSince | `TestClusterMinSizeRespected / MissingFileSkipped / invalid since / unknown domain / strict params` | Ported |
| TestClusterCheckMethodRBACFiltersTargets | superseded by D6 role removal | N/A |
| store/cluster_test.go TestClusterByTag | `TestClusterCheckMethodReturnsTagClusters / TestClusterByTag` | Ported |
| TestClusterSinceFilters | `TestClusterSinceFilters` | Ported |
| TestClusterByKeyword | `TestClusterByKeyword` | Ported |
| TestClusterThreadCandidates | `TestClusterThreadCandidates` | Ported |
| TestClusterMinSizeRespected | combined min-size test | Ported |
| TestClusterMissingFileSkipped | combined missing-file test | Ported |
| rpc/entity_audit_test.go TestEntityAuditAllDomains | `TestEntityAuditFormatViolation / RPC all domains` | Ported |
| TestEntityAuditScopedToDomain | `TestEntityAuditScopedToDomain / MissingMetadata` | Ported |
| TestEntityAuditRequiresRole | superseded by D6; strict params rejects `role` | Covered |
| TestEntityAuditUnknownDomain | `TestEntityAuditTotals / UnknownDomain / strict params` | Ported |
| store/entity_audit_test.go TestEntityAuditEmpty | `TestEntityAuditEmpty / MissingFileSkipped` | Ported |
| TestEntityAuditMissingFileSkipped | same | Ported |
| TestEntityAuditCompactBlockClean | `TestEntityAuditCompactBlockClean` | Ported |
| TestEntityAuditFormatViolation | format violation tests | Ported |
| TestEntityAuditMissingMetadata | scoped/missing metadata test | Ported |
| TestEntityAuditGlacierByInactive | glacier inactive/age test | Ported |
| TestEntityAuditGlacierByAge | glacier inactive/age test | Ported |
| TestEntityAuditTemporalViolation | temporal violation test | Ported |
| TestEntityAuditMultipleFilesSorted | all-domain/sorted target behavior covered by deterministic outputs | Ported |
| TestEntityAuditTotals | totals test | Ported |
| TestEntityAuditTotalsEmptyStore | empty test | Ported |
| rpc/link_test.go TestLinkIndexCompute | `TestLinkIndexCompute` | Ported; intentional divergence from Go: glacier files excluded per PR-2b spec ("outside glacier"); Go includes them. |
| TestLinkIndexComputeRBACFilters | superseded by D6 role removal | N/A |
| TestLinkIndexComputeMissingRole | superseded by D6; strict params rejects `role` | Covered |
| TestLinkAudit | `TestLinkAudit / WholeWordBoundary` | Ported |
| TestLinkAuditWholeWordBoundary | same | Ported |
| TestLinkAuditMissingRole | superseded by D6; strict params rejects `role` | Covered |
| TestLinkIndexComputeRelatedFrontmatter | related-frontmatter test | Ported |
| store/store_test.go TestScenarioCheckClassifiesByDate | `TestScenarioCheckClassifiesByDate / ReturnsScheduledEntries / EmptyArray` | Ported |
| TestScenarioCheckMissingDirReturnsEmpty | missing-dir scenario test | Ported |
| rpc/server_test.go TestScenarioCheckReturnsScheduledEntries | scenario scheduled entries test | Ported |
| TestScenarioCheckEmptyResultIsArray | empty array assertion | Ported |
| TestScenarioCheckMissingRole | superseded by D6; strict params rejects `role` | Covered |
| TestScenarioCheckRBACFiltersUnreadable | superseded by D6 role removal | N/A |
