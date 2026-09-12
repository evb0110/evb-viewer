# Windows print and rotation failure ledger

Date: 2026-09-02

Baseline: `830f7ef81e89c0f74d314da8ddb2548ff108ae1b`, EVB Viewer `0.1.446`

## Incident evidence

The Windows report contains two separate failures:

1. Printing all 486 pages in facing mode fails before the print dialog with `RangeError: Job pdf-print-layout exceeds broker capacity`.
2. Rotating one page fails through `page-ops:rotate` with `NativeToolError: Access is denied. (os error 5)`.

The first error is deterministic from the source. The facing compositor added in `21f408b8f` requests a fixed 7 GiB broker lease. An 8 GiB host has a 6.8 GiB bulk memory capacity after the broker's 15 percent reserve, so `JobBroker.acquire()` rejects the request before it starts the layout child.

The second error is a native IO error, not a qpdf process error. Rotation publishes qpdf output, then `applyPageMetadataRemap()` calls `evb-pdf-page-ops save-mutations` with the working copy as both input and output. Plain `--append` creates another sibling file and publishes it with `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`. A Windows handle that permits reads and writes but denies delete sharing makes that second publication fail with OS error 5. Because qpdf's earlier publication also needs delete sharing, the evidence supports a handle acquired after qpdf published the new inode, for example a scanner or reader reacting to the changed file. The native tool already has `--append-in-place` for files covered by an outer transaction, but metadata remapping does not select it.

The earlier fixes do not cover these failures. `e74671e00` fixes Windows path aliases, `d0d63ff88` fixes JavaScript immutable publication, and `848cbf305` fixes facing-sheet geometry. None changes the fixed print reservation or the metadata-remap publication mode.

## Independent review reconciliation

Fable 5.1 medium and Opus 5 high both returned `REVISE`. The local Claude bridge does not support `xhigh`, so Opus used its highest supported effort. The corrected ledger adopts every shared blocking finding. Where emphasis differed, Fable's judgment controls as requested:

- keep the existing 7 GiB preferred budget, but make reservation and heap arithmetic coherent and reject capacities below the proven 2 GiB floor;
- accept that print preparation can occupy all bulk memory capacity on an 8 GiB host. The broker's separate 512 MiB interactive reserve remains available, while other bulk work waits. This avoids claiming memory headroom that the child may need;
- allow direct incremental append only inside the page-operation transaction, with a copy-on-write backup and an exclusively owned working-copy inode;
- run the delete-sharing proof in hosted Windows x64 CI instead of leaving a platform-gated test dormant.

The 7 GiB budget is a conservative ceiling inherited from the compositor, not a measured guarantee that every 768 MiB encoded input will fit. Child termination therefore needs a useful resource message, and the hosted 486-page journey remains the release proof for this report.

## Required corrections

### WIN-PRINT-001: keep broker admission and the child heap consistent

Status: implemented; hosted Windows proof delegated to the release thread

Change the print-layout reservation and V8 heap ceiling together:

- retain the preferred 7 GiB resident budget and 6 GiB heap on large hosts;
- cap both values to the configured broker capacity on smaller hosts;
- require enough capacity for the 1 GiB minimum child heap plus the 1 GiB non-heap allowance;
- reject a smaller capacity with a specific resource error instead of reserving less memory than the declared child ceiling;
- report an actionable resource message if the child exits before returning a protocol result;
- release the lease on success, child failure, abort, timeout, and invalid child output.

Acceptance:

- a 32 GiB profile uses 7 GiB and 6144 MiB;
- an 8 GiB profile requests 6.8 GiB and starts with the derived heap ceiling;
- the exact 2 GiB minimum is admitted;
- a capacity below 2 GiB is refused before broker acquisition;
- integration coverage checks the broker request, child `execArgv`, the child-exit message, and lease release on every terminal path.

### WIN-PRINT-002: verify composition correctness at the reported scale

Status: implemented; hosted Windows proof delegated to the release thread

Add a deterministic 486-page facing-layout regression. The fixture must be generated during the test and must not add a large binary to the repository.

Acceptance:

- 486 source pages produce 243 output sheets in `facing` mode;
- the first, middle, and last page pairs stay in order;
- the same selection produces 244 sheets in `facing-first-single` mode;
- output sheets use the expected landscape geometry;
- the source PDF remains unchanged and the result reopens successfully.

### WIN-ROTATE-001: avoid a second Windows replacement for metadata remapping

Status: implemented; hosted Windows proof delegated to the release thread

Run metadata-remap chunks with `--append-in-place`. The serialized page-operation queue and `transitionWorkingCopyContentRevision()` own the outer transaction. Page operations retain the default copy-on-write backup, never a hard link, and the existing exclusive-inode guard prevents an in-place append from reaching the original PDF through a shared inode. The durable backup and prepared journal restore the old PDF and sidecars if the append or a later verification fails, and recover the old revision after a crash before the revision sidecar commits.

Do not add unconditional retries or clear file attributes. This correction removes the unnecessary second delete-share requirement from the native metadata append while retaining the existing qpdf publication and transaction recovery. NTFS cannot reflink the staged path, so in-place chunks also avoid one full-PDF copy per metadata chunk. Update the native contract to permit a journal-backed, exclusively owned working copy. A concurrent reader may observe the prior complete PDF revision until the new incremental revision finishes; app-owned mutations stay serialized.

Acceptance:

- every metadata-remap chunk passes both `--append` and `--append-in-place`;
- native append validation rolls back a partial revision after a mid-write or postcondition failure;
- rotation, one page-count-changing operation, and a multi-chunk remap retain page count and metadata semantics;
- a remap failure restores the pre-operation bytes and publishes no new revision when the destination is writable;
- if an external handle also blocks rollback publication, the prepared journal and backup remain for recovery after that handle closes;
- page-operation transitions keep copy-on-write backups and the hard-link guard remains covered;
- a real Windows test holds the PDF with read and write sharing but without delete sharing, proves staged same-file publication fails with error 5, and proves in-place append succeeds;
- successful rotation still preserves page labels, bookmarks, PDF validity, page count, and the final rotation.

### WIN-ROTATE-002: exercise metadata remapping in the packaged Windows journey

Status: implemented; hosted Windows proof delegated to the release thread

The current packaged smoke rotates without a metadata snapshot, so it skips `applyPageMetadataRemap()`. Make the smoke pass a bounded page-label and bookmark snapshot through the public page-ops API, then verify the rotated working copy and preserved metadata.

Acceptance:

- the unpacked and installed Windows x64 release jobs run the real native metadata-remap path;
- the smoke reads metadata back from the produced PDF rather than trusting the renderer snapshot;
- the rotated PDF reopens, page 1 has `/Rotate 90`, labels and bookmark destinations remain correct, and the original file hash does not change between rotation and the next explicit Save;
- no unexpected dot-prefixed sibling remains after success, including `.evb-tmp-*`, `.bak-*`, `*.evb-content-*.bak`, `*.evb-sidecar-*.bak`, or `*.evb-content-transition.json`;
- the hosted release job is green on the exact release SHA.

## Required verification

- Focused TypeScript unit tests for print admission, build-path integration, 486-page composition, page metadata remap, and page-operation rollback.
- Native `pdf-page-ops` tests, including the mid-write rollback case and the Windows no-delete-share case.
- A blocking Windows x64 `cargo test` step executes the platform-gated sharing test in hosted release CI.
- Electron and test TypeScript checks, ESLint on changed files, and `git diff --check`.
- The repository's complete local gate for release-affecting changes.
- CodeRabbit CLI review against `main`, with every actionable finding resolved.
- Hosted CI and the Windows x64 packaged and installed journeys on the pushed SHA.

## Implementation evidence

- The focused TypeScript runs passed 68 tests across print admission, print orchestration, 486-page composition, metadata remapping, and page-operation handlers.
- Electron, test, and script TypeScript checks passed. ESLint on the changed source and tests, `cargo fmt --check`, and `git diff --check` passed.
- Native rollback coverage passed on macOS. The complete `pdf-page-ops` test suite also cross-compiled for `x86_64-pc-windows-msvc`.
- The second consolidated validation run passed strict build, native tests, the coverage ratchet, and blocking Electron smoke. Its only failure was the changed-file zero-execution tripwire for the unrelated pre-existing edit to `scripts/diagnostics/generate-scan-cleanup-mrc-ownership-fixture.mjs`. See `.devkit/gates/2026-09-02T144947Z/01-validate.log`.
- The exhaustive local release verification and macOS package checks passed. See `.devkit/gates/2026-09-02T145335Z/02-release-verify.log`.
- CodeRabbit CLI was attempted four times, including an exact committed-diff pass. Authentication, repository, backend, and WebSocket diagnostics all passed, but every review connection closed before analysis. This is the repository's documented fail-open service-failure case. No review finding was omitted or declined.
- Hosted Windows execution remains intentionally pending. The workflow now runs the no-delete-share native regression as a blocking x64 step, and the packaged smoke reaches metadata remapping and verifies the resulting PDF. The detached release thread owns the final CI, tag, asset, and packaged/installed Windows audit.

## Evidence-bound follow-ups, not release blockers

These hypotheses are worth instrumenting if error 5 recurs, but the report does not prove them:

- a third-party PDF viewer, antivirus scanner, indexer, or cloud-sync client may hold the working copy without delete sharing;
- a retained Chromium print window may hold a directly printed working copy, but the reported facing print failed before it created that window;
- the broker has no independent queue-wait deadline, but the reported error is an immediate oversize rejection;
- print-layout cleanup is best effort, but no stale or partial file appears in the report.

Do not broaden this patch into generic Windows retry, ACL, cleanup, or queue scheduling changes without a deterministic failing case.

## Primary platform references

- Microsoft `CreateFile` sharing rules: <https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew>
- Microsoft `MoveFileExW`: <https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw>
- Node.js filesystem API: <https://nodejs.org/api/fs.html>
