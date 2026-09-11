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
