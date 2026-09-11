# Project 8 OCR and scan campaign qualification

Review date: 2026-09-11

Source under review: `876be7914` (`origin/project8/integration`)

This receipt continues the requested campaign for tickets #393-399, #402,
#424-450, and #509. The source already contains the repairs for these findings.
This lane records the owning commits and the checks run against the current
integration tip. It does not mark GitHub issues or project items complete.

## Repair inventory

| Tickets | Current repair evidence |
| --- | --- |
| #393, #394 | `32ae16736` keeps scan preference intent and per-document retry work separate. |
| #395 | `dba8a09b2` preserves Recent history after unavailable opens. |
| #396 | `6a8a14a64` fails closed when settings bootstrap cannot load. |
| #397 | `f6734b1a9` retains recovery-owned bytes until adoption succeeds. |
| #398 | `a96e44809` preserves the source witness through linked recovery transitions. |
| #399 | `a0d102812` preserves the authoritative settings baseline across hydration races. |
| #402 | `7b9284bdd`, `bdb3aaaef`, and `4e9e91bcf` retain worker/native ownership until termination or cancellation is proven. |
| #424 | `ea93a1203` maps OCR text through rendered page geometry, including cropped origins. |
| #425 | `212f73d40`, `f086a8068`, and `35c91c3b8` preserve reachable PDF resources while replacing OCR. |
| #426 | `fc06e991b` removes supported foreign hidden OCR text before replacement. |
| #427 | `f456a99c8` inspects DjVu foregrounds before using compact mask fallback. |
| #428 | `d80f159cd` rejects incompatible source MRC geometry instead of emitting unsafe output. |
| #429 | `8089d7702` reuses one stable DjVu source digest for a compact export. |
| #430 | `6e2d2ab9a` records preprocessing geometry acceptance against the OCR mapping path. |
| #431 | `41461d547` rolls back failed DjVu PNG batches before destination replacement. |
| #432, #433 | `362e43090`, `5451eef23`, and `5e9cc6120` validate PNG filters and preserve both density axes through bounded decoding. |
| #434, #435 | `d4975f1b4` preserves OCR generations after publication errors and `847944542` accounts checkpoint bytes incrementally. |
| #436 | `24ed078dd` recovers completed OCR results by document scope; `d4975f1b4` preserves generations after publication failure. |
| #437, #509 | `31e8323e9` restores missing bundled models offline and `041ba2606` verifies pinned model digests before reuse. |
| #438 | `0c80b6dc2` and `7e9756fba` preserve mixed text direction in DOCX exports. |
| #439, #440 | `4e9e91bcf` keeps OCR ownership after unconfirmed cancellation and `bdb3aaaef` retains scan ownership after worker cancellation failure. |
| #441, #450 | `171c874d7` retains completed detection stores across borrows and `2579c8861` admits evicted pages from those stores. |
| #442 | `df08f159cd` preserves published raster batches after scratch cleanup errors. |
| #443 | `ae65f4731` merges legacy scan settings before storage pruning. |
| #444 | `7cdd2e741` budgets uniform scan rasters from physical page geometry. |
| #445 | `dfb83a934` normalizes persisted thickness and `252563382` enforces dewarp bounds at the settings control. |
| #446 | `8de8ff125` validates manual scan split positions within one safe interval. |
| #447 | `f94950703` keeps large preview anchors aligned with export. |
| #448 | `2579c8861` admits selected cleanup from authoritative, possibly evicted detection stores. |
| #449 | `f94950703` recalibrates preview and export against current document-wide ink evidence. |

The exact owner for #430's upstream deskew transform remains separate from
#424's rendered-page mapping. The two paths must stay composed, not duplicated.

## Checks

The focused unit run for the touched OCR and scan-cleanup contracts was:

```text
pnpm exec vitest run \
  tests/unit/electron/ocrPdfAssembler.test.ts \
  tests/unit/electron/ocrLanguageModels.test.ts \
  tests/unit/electron/ocrWorkerPreprocessOcrImage.test.ts \
  tests/unit/electron/ocrRevisionTransitionRecovery.test.ts \
  tests/unit/electron/scanCleanupPreferencesStore.test.ts \
  tests/unit/electron/scanCleanupDetectionResultStoreDescriptor.test.ts \
  tests/unit/electron/scanCleanupRasterBatch.test.ts \
  tests/unit/electron/scanCleanupPlacementAnchors.test.ts \
  tests/unit/electron/scanCleanupPageBatches.test.ts \
  tests/unit/electron/recentFiles.test.ts \
  tests/unit/electron/docxExportStream.test.ts \
  tests/unit/electron/docxExportStreamCommitRace.test.ts \
  tests/unit/electron/djvuPdfExport.test.ts \
  tests/unit/electron/djvuArtifactManifest.test.ts \
  tests/unit/electron/djvuImageExportLimits.test.ts \
  tests/unit/electron/utils/processExit.test.ts \
  tests/unit/electron/utils/processTree.test.ts \
  tests/unit/app/modules/scan-cleanup/scanCleanupPreferencesStore.test.ts \
  tests/unit/app/modules/scan-cleanup/scanCleanupPreviewGeometry.test.ts \
  tests/unit/app/utils/recentFilesPersistence.test.ts \
  tests/unit/app/utils/docxStreaming.test.ts \
  tests/unit/app/modules/workspace-shell/host/recentOpenCommandEligibility.test.ts \
  tests/unit/app/modules/workspace-shell/host/recentOpenGeometryReadiness.test.ts \
  --reporter=dot
```

Result: `22` files passed and `231` tests passed in `11.77s`. The worktree
needed `pnpm install --frozen-lockfile --offline` first because dependencies
were not installed; the lockfile stayed unchanged.

The required oracle command also ran:

```text
pnpm run test:scan-cleanup:affected-oracles
No scan-cleanup oracle inputs changed relative to origin/project8/integration; skipping.
```

The existing source and test ownership are qualified on Linux. A real packaged
OCR run, a 1,025-page cleanup conversion, headed viewer acceptance, and native
process proof were not run in this lane. Hosted macOS and Windows acceptance,
real bundled-model acquisition, and independent PDF render/readback remain
coordinator-owned gaps. The checks do not claim those results.

No fixture, generated native artifact, or temporary output was added by this
qualification.

## Follow-up slot

The branch was fast-forwarded to `7d784ada3`, the current
`origin/project8/integration`, before this follow-up.

Primary acceptance, #509 installed OCR model/native readiness:

```text
pnpm run test:ocr:native-smoke:required
OCR native smoke passed
```

The broader required OCR corpus was also attempted:

```text
pnpm run test:ocr:quality:required
faded-english-receipt: wrapper CER=0.0000 WER=0.0000; searchable PDF CER=0.0000 WER=0.0000; words=10
speckled-russian-notice: wrapper CER=0.0000 WER=0.0000; searchable PDF CER=0.0000 WER=0.0000; words=10
mixed-language-archive-label: wrapper CER=0.0612 WER=0.1250; searchable PDF CER=0.0612 WER=0.1250; words=9
FAIL: Required OCR quality coverage did not exercise successful clean preprocessing
```

That failure is a corpus/preprocessing coverage gap. It is not recorded as a
model-integrity pass, and no threshold or fixture was changed to hide it.

Disjoint fallback acceptance, #430 preprocessing and rendered geometry:

```text
pnpm exec vitest run tests/unit/electron/ocrLanguageModels.test.ts \
  tests/unit/electron/ocrWorkerPreprocessOcrImage.test.ts \
  tests/unit/electron/ocrPdfAssembler.test.ts \
  tests/unit/app/utils/ocr/processing.test.ts --reporter=dot
4 files passed, 49 tests passed
```

The fallback passed on Linux. The remaining artifacts are the checked-in OCR
quality corpus and existing unit fixtures. No new files were generated by the
tests. `node_modules`, Nuxt metadata, and local build cache are ignored setup
state only and were not committed.

## Follow-up slot: detection lifetime and calibration

This slot started from `a00c3fcb2`, the current
`origin/project8/integration` tip. The fixture-backed Electron xlarge run is
not feasible here because it requires an explicit 138,000-page fixture through
`EVB_E2E_SCAN_CLEANUP_XLARGE_FIXTURE`. The bounded acceptance was available and
was run through the real lifecycle and service owners:

```text
pnpm exec vitest run \
  tests/unit/electron/scanCleanupDetectionLifecycle.test.ts \
  tests/unit/electron/scanCleanupDetection.test.ts \
  tests/unit/electron/scanCleanupService.test.ts \
  tests/unit/electron/scanCleanupPreviewGeometry.test.ts \
  tests/unit/electron/scanCleanupPlacementAnchors.test.ts --reporter=dot

4 files passed, 63 tests passed
```

The run covered retained detection-store borrows, bounded xlarge event
payloads, service admission, preview calibration, and persisted placement
anchors. The exact 138,000-page memory, restart, and exported-PDF readback
acceptance remains open for the coordinator's fixture-backed Electron lane.
No new fixture, PDF, screenshot, or telemetry artifact was generated here.

## Follow-up slot: DjVu export publication

This slot started from `dd447a69b`, the current
`origin/project8/integration` tip. The next bounded acceptance covered the
write-before-replace and failed-batch cleanup paths owned by #431 and #442:

```text
pnpm exec vitest run \
  tests/unit/electron/djvuPdfExport.test.ts \
  tests/unit/electron/djvuImageExportLimits.test.ts \
  tests/unit/electron/djvuArtifactManifest.test.ts \
  tests/unit/electron/djvuConversion.test.ts \
  tests/unit/electron/djvuBuildOptimizedPdfNative.test.ts \
  tests/unit/electron/djvuIpcHandlers.test.ts --reporter=dot

6 files passed, 100 tests passed
```

The run covered atomic destination replacement, partial-write completion,
rollback after failed PNG batches, artifact manifest cleanup, cancellation, and
IPC lifecycle handling. The real multi-page DjVu fixture export and headed
viewer readback remain coordinator-owned platform evidence. No new fixture,
PDF, screenshot, or telemetry artifact was generated. Temporary test paths
were test-owned and cleaned up by the existing suites.

## Follow-up slot: OCR source-resource preservation

This slot started from `a73dd77de`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #425
through the OCR PDF assembler's source-resource replacement path:

```text
pnpm exec vitest run \
  tests/unit/electron/ocrPdfAssembler.test.ts \
  -t "assembles OCR output when original page resources are malformed|preserves source image resources whose PDF names contain escapes|preserves mixed-stream invisible text preambles in original page content" \
  --reporter=dot

1 file passed, 3 tests passed, 18 tests skipped by name filter
```

The passing cases covered malformed original resource dictionaries, escaped
PDF resource names, and preservation of invisible-text preambles while OCR
content is replaced. Full packaged PDF resource replacement with independent
renderer readback remains coordinator-owned evidence. No new PDF, fixture,
screenshot, or telemetry artifact was generated. Test-owned PDF state was
cleaned by the suite, and the worktree is clean.

## Follow-up slot: foreign hidden OCR replacement

This slot started from `873c1621d`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #426
through the OCR PDF assembler's replacement path:

```text
pnpm exec vitest run \
  tests/unit/electron/ocrPdfAssembler.test.ts \
  -t "removes foreign hidden text from an image-plus-text stream during replacement" \
  --reporter=dot

1 file passed, 1 test passed, 20 tests skipped by name filter
```

The passing case covered removing a foreign hidden text stream while retaining
the image-plus-text page content during OCR replacement. Full packaged OCR
replacement with independently rendered output remains coordinator-owned
evidence. No new PDF, fixture, screenshot, or telemetry artifact was
generated. Test-owned PDF state was cleaned by the suite, and the worktree is
clean.

## Follow-up slot: contiguous scan split windows

This slot started from `5ca8106cc`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #446
through the contiguous-page-run planner:

```text
pnpm exec vitest run \
  tests/unit/electron/scanCleanupSplitContiguousPageRuns.test.ts \
  --reporter=dot

1 file passed, 3 tests passed
```

The run covered gap-free windows, sorting a window that starts at the
requested page, splitting at page gaps, and empty-window handling. A full
large-document split/export run remains coordinator-owned evidence. No new
fixture, raster, screenshot, or telemetry artifact was generated. Test-owned
state was cleaned by the suite, and the worktree is clean.

## Follow-up slot: detection-store lifetime and ownership

This slot started from `4c53f111a`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #441
and #450 through the detection session cache and main-process service owners:

```text
pnpm exec vitest run \
  tests/unit/app/modules/scan-cleanup/scanCleanupDetectionSessionCache.test.ts \
  tests/unit/electron/scanCleanupService.test.ts --reporter=dot

2 files passed, 33 tests passed
```

The run covered LRU touch behavior, entry and byte budgets, revision fencing,
promotion to authoritative source identity, alias disposal, completed-store
claims across retries, output-grant lifecycle replacement, cancellation
idempotence, and main-owned output pruning. Packaged multi-window lifecycle
and long-running detection evidence remain coordinator-owned. No new fixture,
raster, screenshot, or telemetry artifact was generated. Test-owned stores and
temporary state were cleaned by the suites, and the worktree is clean.

## Follow-up slot: scan thickness and dewarp bounds

This slot started from `04ea22da6`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #445
through the persisted-settings contract and effective native-option mapping:

```text
pnpm exec vitest run \
  tests/unit/contracts/scanCleanupSettings.test.ts \
  tests/unit/electron/scanCleanupEffectiveOptions.test.ts --reporter=dot

2 files passed, 18 tests passed
```

The run covered migration into the executable thickness range, preservation
of valid document entries, physical-geometry raster budgeting, dewarp and
margin composition, explicit page-option precedence, and native raster
controls. A packaged settings upgrade and large anisotropic-document run
remain coordinator-owned evidence. No new fixture, raster, screenshot, or
telemetry artifact was generated. Test-owned state was cleaned by the suites,
and the worktree is clean.

## Follow-up slot: authoritative detection-store eviction

This slot started from `2efcebc01`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #448
through the workspace-session detection-store handoff:

```text
pnpm exec vitest run \
  tests/unit/app/modules/scan-cleanup/scanCleanupWorkspaceSession.test.ts \
  -t "refuses an ink run for a selected page whose bounded detection record was evicted|reuses completed detection after authoritative reopen but invalidates it on settings change" \
  --reporter=dot

1 file passed, 2 tests passed, 79 tests skipped by name filter
```

The passing cases covered refusing an ink-aligned run when the selected page
was evicted from the bounded detection record, and reusing completed detection
after an authoritative reopen while invalidating it after a settings change.
A full large-document detection and cleanup run remains coordinator-owned
evidence. No new fixture, raster, screenshot, or telemetry artifact was
generated. Test-owned session and temporary state were cleaned by the suite,
and the worktree is clean.

## Follow-up slot: original witness recovery

This slot started from `2a1737bd5`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #398
through the original-witness and dirty working-copy recovery scenarios:

```text
pnpm exec vitest run \
  tests/unit/electron/transitionOriginalAndWorkingCopyRevision.test.ts \
  -t "refreshes the original witness|restores a witnessed publication|publishes a second witnessed save|restores the app-published original witness|rejects a same-inode external edit|rejects a distinct-inode external replacement|rejects Save after recovering a dirty materialized checkpoint" \
  --reporter=dot

1 file passed, 7 tests passed, 7 tests skipped by name filter
```

The passing cases covered witness refresh after managed replacement, witnessed
publication recovery, a second witnessed save, hard-reopen recovery, same- and
distinct-inode external replacement rejection, and Save rejection after dirty
checkpoint recovery. The full source file still has a timeout in the separate
reflink-unavailable setup case, so a complete file-wide green run remains a
gap for coordinator follow-up. No new fixture, source document, screenshot, or
telemetry artifact was generated. Test-owned temporary files were cleaned by
the suite, and the worktree is clean.

## Follow-up slot: legacy scan-settings migration and pruning

This slot started from `1878052f0`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #443
through the dedicated scan-preferences persistence suite:

```text
pnpm exec vitest run \
  tests/unit/app/modules/scan-cleanup/scanCleanupPreferences.test.ts \
  --reporter=dot

1 file passed, 22 tests passed
```

The run covered legacy scalar and pixel-geometry migration, per-document
override isolation, pruning of automatic page overrides, manual split
migration, numeric validation, and safe handling of malformed persisted
values. The migration warning for unavailable legacy raster dimensions was
expected and the test passed. A packaged upgrade with real user preference
files remains coordinator-owned evidence. No new preference file, fixture,
screenshot, or telemetry artifact was generated. Test-owned storage was
cleaned by the suite, and the worktree is clean.

## Follow-up slot: DOCX text direction and commit

This slot started from `fc251b855`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #438's
direction derivation and its existing streamed-export commit boundary:

```text
pnpm exec vitest run \
  tests/unit/app/utils/docxStreaming.test.ts \
  tests/unit/electron/docxExportStream.test.ts \
  tests/unit/electron/docxExportStreamCommitRace.test.ts \
  tests/unit/electron/docxExportPaths.test.ts --reporter=dot

4 files passed, 19 tests passed
```

The run covered mixed paragraph direction, neutral numeric paragraphs, RTL
language hints, bounded stream chunks, atomic DOCX commit, and cancellation
races before and after replacement. A real packaged DOCX export on macOS and
Windows remains coordinator-owned platform evidence. No new fixture, DOCX,
screenshot, or telemetry artifact was generated. Temporary test paths were
cleaned up by the existing suites.

## Follow-up slot: OCR resource preservation and replacement

This slot started from `892cdf248`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #425
and #426 through the PDF assembler, classifier, streaming assembler, and index
owners:

```text
pnpm exec vitest run \
  tests/unit/electron/ocrPdfAssembler.test.ts \
  tests/unit/electron/ocrStreamingPdfAssembler.test.ts \
  tests/unit/electron/ocrPageTextClassifier.test.ts \
  tests/unit/electron/ocrIndexWriterSidecar.test.ts \
  tests/unit/electron/ocrIndexWriterPath.test.ts \
  tests/unit/electron/ocrMixedDocumentCorpus.test.ts --reporter=dot

6 files passed, 49 tests passed
```

The run covered foreign hidden-text classification, replacement without old
words, visible-content preservation, escaped resource names, nested and
streaming resource reachability, and partial index preservation. Packaged OCR
replacement with an independently rendered real-world PDF remains
coordinator-owned evidence. No new fixture, PDF, screenshot, or telemetry
artifact was generated. Temporary test paths were cleaned up by the existing
suites.

## Follow-up slot: PNG validation and density

This slot started from `920001a91`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #432
and #433 in the native raster reader:

```text
cargo test --manifest-path native/Cargo.toml -p evb-raster-io --test png --locked

test result: ok. 13 passed; 0 failed; 0 ignored
```

The run covered invalid scanline filters across stream boundaries, trusted
chunk CRC failures, truncation and inflated-payload bounds, standard PNG
variants, alpha compositing, and independent horizontal and vertical pHYs
density preservation. A packaged image-combine run and cross-platform PNG
readback remain coordinator-owned evidence. Cargo's ignored target cache was
updated; no source fixture or generated artifact was added, and the worktree
remains clean.

## Follow-up slot: scan numeric limits and split planning

This slot started from `3e6af870f`, the current
`origin/project8/integration` tip. The next bounded acceptance covered the
persisted numeric limits, raster budgeting, and split planning owned by
#444-#446:

```text
pnpm exec vitest run \
  tests/unit/contracts/scanCleanupSettings.test.ts \
  tests/unit/electron/scanCleanupNativeManifestBuilder.test.ts \
  tests/unit/electron/scanCleanupPageBatches.test.ts \
  tests/unit/electron/scanCleanupEffectiveOptions.test.ts \
  tests/unit/electron/scanCleanupDetectionPlan.test.ts --reporter=dot

5 files passed, 82 tests passed
```

The run covered persisted thickness normalization, native pixel guardrails,
1,024-page batching, effective option limits, and split retry/planning
boundaries. A real large-document conversion and cross-platform native
readback remain coordinator-owned evidence. No new fixture or generated
artifact was added. Temporary test state was cleaned by the existing suites,
and the worktree remains clean.

## Follow-up slot: non-destructive Recent opens

This slot started from `800ea56d4`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #395
through the main Recent owner, renderer persistence, and open-command owners:

```text
pnpm exec vitest run \
  tests/unit/electron/recentFiles.test.ts \
  tests/unit/app/utils/recentFilesPersistence.test.ts \
  tests/unit/app/modules/workspace-shell/host/recentOpenCommandEligibility.test.ts \
  tests/unit/app/modules/workspace-shell/host/recentOpenGeometryReadiness.test.ts --reporter=dot

4 files passed, 41 tests passed
```

The run covered missing entries, ENOTDIR/EIO/permission failures, transient
ENOENT retry, explicit-only removal, persistence migration, and open-command
eligibility. A headed row-action run against a restored file remains
coordinator-owned desktop evidence. No new fixture, screenshot, or telemetry
artifact was generated. Test-owned temporary paths were cleaned by the
existing suites, and the worktree remains clean.

## Follow-up slot: settings bootstrap failure handling

This slot started from `8652fce83`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #396
through the Electron bootstrap, binding, and renderer settings owners:

```text
pnpm exec vitest run \
  tests/unit/electron/settingsQuarantine.test.ts \
  tests/unit/electron/settingsSingleFlight.test.ts \
  tests/unit/electron/settingsMainBindingsDiagnostics.test.ts \
  tests/unit/app/shared/settingsSanitizer.test.ts \
  tests/unit/app/platform/settingsCapability.test.ts --reporter=dot

5 files passed, 43 tests passed
```

The run covered malformed-settings quarantine, future-schema fail-closed
behavior, single-flight loading, concurrent updates, diagnostics binding, and
default sanitization. A headed startup run showing the app withholds readiness
after a real settings I/O failure remains coordinator-owned evidence. No new
fixture, settings file, screenshot, or telemetry artifact was generated.
Test-owned temporary directories were cleaned by the existing suites, and the
worktree remains clean.

## Follow-up slot: OCR worker and native-child shutdown

This slot started from `cd04be264`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #402
through the OCR worker lifecycle, abort, and process-tree owners:

```text
pnpm exec vitest run \
  tests/unit/electron/ocrJobWorkerLifecycle.test.ts \
  tests/unit/electron/ocrRunOcrAbortWindow.test.ts \
  tests/unit/electron/ocrWorkerTesseractRunnerAbort.test.ts \
  tests/unit/electron/utils/processExit.test.ts \
  tests/unit/electron/utils/processTree.test.ts --reporter=dot

5 files passed, 16 tests passed
```

The run covered abort races, delayed native-child cleanup, child identity
fencing, exactly-once release, process-tree termination, and unproven
termination reporting. A real packaged worker shutdown and cross-platform
native process run remain coordinator-owned evidence. No new fixture,
screenshot, or telemetry artifact was generated. Temporary child processes
and test-owned state were cleaned by the existing suites, and the worktree
remains clean.

## Follow-up slot: recovery adoption and hydration fallback

This slot started from `3486f2fbd`, the current
`origin/project8/integration` tip. The primary #397 recovery-owned-bytes
acceptance was attempted with the working-copy and checkpoint suites:

```text
pnpm exec vitest run \
  tests/unit/electron/scanCleanupWorkingCopyClose.test.ts \
  tests/unit/electron/workingCopyMaterialization.test.ts \
  tests/unit/electron/workingCopyCleanup.test.ts \
  tests/unit/app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint.test.ts \
  tests/unit/electron/transitionOriginalAndWorkingCopyRevision.test.ts --reporter=dot

4 files passed; 60 tests passed, 1 failed
FAIL: transitionOriginalAndWorkingCopyRevision.test.ts > links an immutable original into the working-copy path when reflinks are unavailable
Error: Test timed out in 5000ms
```

The timeout is recorded as a gap. No timeout or retry setting was changed.

Disjoint fallback #399, late scan-settings hydration rebasing, passed:

```text
pnpm exec vitest run tests/unit/app/modules/scan-cleanup/scanCleanupPreferencesStore.test.ts \
  -t "rebases a later global edit|retains binding edits made while document hydration is pending|retains an edit made while initial file-backed hydration is unavailable|does not enqueue a pending global snapshot" --reporter=dot

1 file passed; 4 tests passed, 10 skipped by the name filter
```

The fallback covered late global rebasing, edits during hydration, unavailable
file-backed hydration recovery, and suppression of redundant global patches.
No new fixture, checkpoint, screenshot, or telemetry artifact was generated.
Test-owned temporary state was cleaned by the existing suites. Recovery
adoption timeout diagnosis and the full checkpoint acceptance remain open for
the coordinator.

## Follow-up slot: scan preference rebase and retry

This slot started from `402d5371b`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #393
and #394 through the renderer preference store and file-backed settings owner:

```text
pnpm exec vitest run \
  tests/unit/app/modules/scan-cleanup/scanCleanupPreferencesStore.test.ts \
  tests/unit/electron/scanCleanupSettingsStore.test.ts \
  tests/unit/app/modules/scan-cleanup/scanCleanupScopedSettings.test.ts \
  tests/unit/electron/settingsSingleFlight.test.ts --reporter=dot

4 files passed, 48 tests passed
```

The run covered cross-window baseline rebasing, failed document A draining
after document B succeeds, hydration races, discard fencing, legacy migration,
and durable settings updates. A two-window headed desktop run remains
coordinator-owned evidence. No new fixture, settings file, screenshot, or
telemetry artifact was generated. Test-owned temporary state was cleaned by
the existing suites, and the worktree remains clean.

## Follow-up slot: preview frame and ink calibration

This slot started from `d4e490d8d`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #447
and #449 through the displayed-frame, preview lifecycle, rendering, and
placement-summary owners:

```text
pnpm exec vitest run \
  tests/unit/app/modules/scan-cleanup/scanCleanupPreviewGeometry.test.ts \
  tests/unit/electron/scanCleanupPreviewComposition.test.ts \
  tests/unit/electron/scanCleanupPreviewRendering.test.ts \
  tests/unit/electron/scanCleanupPlacementAnchors.test.ts --reporter=dot

4 files passed, 86 tests passed
```

The run covered the displayed native canvas frame, stale-generation fencing,
preview option invalidation, matched preview rendering, rotated cutter
coordinates, and bounded early/middle/late placement anchors. A full
fixture-backed preview/export comparison on a large document remains
coordinator-owned evidence. No new fixture, PDF, screenshot, or telemetry
artifact was generated. Temporary test state was cleaned by the existing
suites, and the worktree remains clean.

## Follow-up slot: OCR rendered-page geometry

This slot started from `2457060e5`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #424
and #430 through real generated PDF fixtures and the preprocessing geometry
owner:

```text
pnpm exec vitest run \
  tests/unit/electron/ocrPdfAssembler.test.ts \
  tests/unit/electron/ocrWorkerPreprocessOcrImage.test.ts --reporter=dot

2 files passed, 32 tests passed
```

The run covered OCR word geometry at 0, 90, 180, and 270 degrees, a nonzero
CropBox, a nonzero MediaBox origin, and composition of a preprocessing inverse
transform with CropBox mapping. The full packaged save/reopen and independent
renderer readback remain coordinator-owned evidence. No new fixture, PDF,
screenshot, or telemetry artifact was generated. Temporary PDF paths were
test-owned and cleaned up by the existing suites.

## Follow-up slot: bundled OCR model integrity

This slot started from `6fad2304d`, the current
`origin/project8/integration` tip. The next bounded acceptance covered #437
and #509 through the bundled-model and resource-path owners:

```text
pnpm exec vitest run \
  tests/unit/electron/ocrLanguageModels.test.ts \
  tests/unit/electron/ocrResourceBase.test.ts \
  tests/unit/electron/ocrPaths.test.ts \
  tests/unit/electron/ocrWorkerPaths.test.ts --reporter=dot

4 files passed, 31 tests passed
```

The run covered offline bundled-model restoration, concurrent seeding,
same-size in-place mutation invalidation, incremental SHA-256 verification,
aborted verification, and retryable offline download behavior. A real
installed-model repair against a packaged application and a fresh process
reopen remain coordinator-owned platform evidence. No new model, fixture,
screenshot, or telemetry artifact was generated. Temporary model directories
were test-owned and cleaned up by the existing suites.
