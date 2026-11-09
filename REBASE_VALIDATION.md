# Rebase history and validation

## Branch refresh on 2026-11-10

The remote branch `zhuj/review/security-performance-20261109` was fetched at
`533354c8df571a73c49767a0cc55cc0c510fa297`. Its parent was the older
`12f28c60be3876ac9e52eb9ecf96d2e3dc73fb39`, although its source already contained
the reviewed 0.17.5 integration. Both repository masters were freshly fetched at
`5a93df87fc1bd4219205914eceb51876137aeb12`.

The remote commit was rebased onto that master. Conflicts in
`src/indexing/indexer.ts` and `test/index-source-snapshot.test.ts` were resolved
using the remote branch's already-integrated secure reader and snapshot tests.
The resulting source, tests, dependency manifests, configuration, and UI pin are
byte-for-byte identical to the fetched remote branch. This report was restored
because `REVIEW.md` and `REVIEW_VALIDATION.md` link to it.

The verification results below were produced on **2026-11-09**. This history
refresh does not redate those results or claim a fresh complete-gate pass.

## Validation performed on 2026-11-09

Date: **2026-11-09 (Europe/Moscow)**.

The review branch was rebased onto
`5a93df87fc1bd4219205914eceb51876137aeb12`, the revision fetched from both
`zhuj/master` and `flowing-abyss/master`. The package and MCP metadata retain
upstream version **0.17.5**. The original reviewed commit,
`292b9e0ce16bb25b0c4f64a0629263257d58bd48`, is preserved locally on
`review/security-performance-backup-292b9e0`.

### Integration decisions

The only textual rebase conflict was in `src/indexing/indexer.ts`. The resolution
retains both the review's confined descriptor-based vault reader and upstream
commit `524cbd5`'s stable-source failure tracking:

- Source reads use the shared vault reader, including traversal, symlink,
  regular-file, and containment checks.
- At most two read attempts compare the descriptor snapshot with a subsequent
  safe path stat before trusting an unchanged content hash. The comparison
  includes modification time, size, device, and inode.
- The content hash is computed once and passed into preparation.
- Preparation failures retain the fingerprint of the source actually consumed.
  Publication failures use the prepared snapshot's fingerprint.
- The public preparation API preserves the original error identity and diagnostic
  code for full rebuilds.
- The queue optimization and graph-reference repair behavior remain intact.

The upstream snapshot tests now inject edits around the real `readWithStat`
method. Additional cases cover an atomic inode replacement with identical
modification time and size, and an external symlink replacement after a pinned
read. The latter skips only when Windows reports that symlink creation is not
permitted; other errors remain failures.

The later publication comparison and failure-backoff fingerprint still use
modification time and size. Equal-metadata replacement after stable-read
validation remains a pre-existing limitation; this rebase does not establish an
atomic filesystem sandbox.

### Dependencies

The automatically merged manifest and lockfile preserve all **48 upstream
dependency-record updates**, including Knip 6.44.2. Their only dependency-record
differences from fresh master are the review's existing six minimatch override
records. No manual dependency-file edit was needed.

The installed dependencies were synchronized with npm 12.2.0 using
`npm install --ignore-scripts --no-audit --no-fund`. The manifest and lockfile
remained byte-for-byte unchanged. All **531 present installed records** matched
the lockfile. Local inference loading, native SQLite/sqlite-vec, native OXC
parsing, and the four scoped minimatch resolutions passed. Lifecycle-script
policy was unchanged. No dependency audit was performed during this rebase.

See `review-evidence/rebase/dependencies.json` in the updated archive.

### Verification record

Fresh checks used Linux x64, Node 24.22.1, npm 12.2.0, and Vitest 4.1.12.

#### Static and unit checks

The initial focused indexing run passed **44 tests across 5 files**. The edited
source and snapshot tests passed formatting, TypeScript checking, and whitespace
checks. An independent review found no blocking integration defect.

The aggregate `npm run verify:task` reached the unit stage after its preceding
checks completed: inference-install validation, formatting, lint, build, Knip,
AI configuration tests, and tooling tests. The unit stage did not emit a completion
report before interruption. Its buffered partial log was not retained. The
interruption is recorded in `verify-task-interrupted.json`; no complete-gate pass
is inferred from it.

All **124 configured unit files** were subsequently exercised through Vitest's
native shards. The final per-file results, after the isolated retry below, are
**2,129 passed, 3 skipped, and 0 remaining failures** out of 2,132 tests. The
aggregation checks that no file is missing or duplicated and that the retried
files contain exactly the original testcase lists.

| Run                                   | Files | Passed | Failed | Skipped | Exit code |
| ------------------------------------- | ----: | -----: | -----: | ------: | --------: |
| Initial shard 1                       |    42 |    797 |     14 |       0 |         1 |
| Initial shard 2                       |    41 |    818 |      0 |       3 |         0 |
| Initial shard 3                       |    41 |    500 |      0 |       0 |         0 |
| Isolated retry of four affected files |     4 |     96 |      0 |       0 |         0 |

Shard 1 ran while local-model evaluation was consuming resources. Its failures
in `cli-cpu-threads`, `content-filter-worker`, `serve-cli`, and
`vault-config-process` involved process deadlines, empty child-process output,
or worker dispatch. An unhandled rejection during worker cleanup also remains
recorded in that failed run. After stopping inference and waiting for the shards
to finish, all 96 tests in those four files passed without source, assertion,
configuration, or deadline changes. Resource contention is a supported explanation
for the initial failures; the retry does not establish that these tests can never
be flaky.

The final runs include **8/8 source-snapshot tests**, **27/27 architecture tests**,
and **13/13 modern MCP protocol tests**. The three skips are existing
permission-dependent cases. These results are evidence across shards and a retry,
not one clean aggregate command. Raw logs, JSON reports, and
`unit-summary.json` are preserved under `review-evidence/rebase/`.

#### Search-quality comparison with fresh master

Both fresh master and the rebased branch were evaluated with the primary
`eval/evaluate.ts` entry point, in normal and reranked modes. Each evaluation
rebuilt the pinned Obsidian Help corpus: **171 notes, 1,347 chunks, and 58 golden
queries**, at corpus revision
`3185af0e41523aaccdc3d553f184f9bafe7ad079`. The models were
`Xenova/multilingual-e5-small` and, for reranking,
`onnx-community/gte-multilingual-reranker-base`.

The complete `per_query` arrays are **identical before and after the rebase in
both modes**. The summary results are:

| Mode and revision        | nDCG@5 |   MRR | Hit@3 | Hit@5 | Recall@10 |
| ------------------------ | -----: | ----: | ----: | ----: | --------: |
| Normal, fresh master     |  0.728 | 0.783 | 0.828 | 0.862 |     0.931 |
| Normal, rebased review   |  0.728 | 0.783 | 0.828 | 0.862 |     0.931 |
| Reranked, fresh master   |  0.742 | 0.803 | 0.845 | 0.879 |     0.966 |
| Reranked, rebased review |  0.742 | 0.803 | 0.845 | 0.879 |     0.966 |

Normal mode passes the configured quality floors. Reranked mode fails the same
two unchanged floors on both revisions: **Hit@3 0.845 < 0.855** and
**Hit@5 0.879 < 0.905**. The comparison command's successful exit indicates
identical results, not a complete quality-gate pass. No ranking regression was
observed on this corpus; these results do not establish quality for other vaults.

All four complete evaluation JSON files and `quality-comparison.json` are
included. The first controller was interrupted after both fresh-master evaluations
completed, to isolate the process-deadline tests from inference work. Its partial
log and annotated metadata are retained as `quality-master-controller.*`.
Both rebased evaluations then completed in a separate controller run recorded
in `quality-rebased.*`.

#### Scope of this validation

Coverage thresholds and search-quality floors were unchanged. Fresh coverage,
the complete `npm run verify` release gate, and standalone watcher/native-recovery
release smoke tests are not asserted for this rebase.

`REVIEW_VALIDATION.md` remains the historical evidence for the original 0.17.4
review. Those results, including its coverage measurements and dependency audits,
are not fresh validation of this rebased code.

### Publication

On 2026-11-09, the GitHub write attempt was rejected with HTTP 403, `Resource
not accessible by integration`; direct Git access had no authenticated push
credential. That turn delivered a local rebased branch, a portable bundle, and a
ZIP. This records the earlier attempt and does not describe the current remote
branch or current access permissions.
