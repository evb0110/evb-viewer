# Project 8 annotation lifecycle replacement map

Review date: 2026-09-11

Source under review: `origin/project8/integration` at `876be7914`

Ticket: [#539](https://github.com/evb0110/evb-viewer/issues/539)

The nine retired lifecycle categories from the DG4/HR05 audit are represented
by active canonical tests in `tests/e2e/electron/annotationLifecycle.e2e.test.ts`.
The map names the replacement and keeps source presence separate from executed
evidence. The smoke cases in #540 and the configured-author case in #541 are
listed separately because they exercise blocking-save and settings-to-writer
boundaries, not the lifecycle replacement matrix.

| Retired category | Current active replacement | Disposition | Gate | Exact evidence in this slot |
| --- | --- | --- | --- | --- |
| Shape, draw-preset and markup style/history round trip | `creates every shape, draw preset and markup with matching styles, undo, save and hard reopen` (`annotationLifecycle.e2e.test.ts:1109`) | Active equivalent | `e2e-regression` or the annotation lifecycle selection | Source present; real native-save execution remains unavailable in this slot |
| Keyboard editing and mixed-selection history | `supports keyboard editing for every canonical kind and atomic mixed selection history` (`:1528`) | Active equivalent | `e2e-regression` | Source present; no fresh Electron run in this slot |
| Stamp creation and geometry round trip | `places a stamp through the editor layer and round-trips its edited geometry` (`:1816`) | Active equivalent | `e2e-regression` | Source present; no fresh Electron run in this slot |
| Pointer text-box creation | `creates and edits a text box through the active workspace pointer path` (`:2008`) | Active equivalent | `e2e-regression` | Source present; no fresh Electron run in this slot |
| Focused text-box draft persistence | `saves focused canonical text-box drafts across two saves and reopen` (`:2123`) | Active equivalent | `e2e-regression` | Source present; no fresh Electron run in this slot |
| Sidebar projection and writer-annotation filtering | `opens writer annotations in the canonical sidebar and excludes link annotations` (`:2228`) | Active equivalent | `e2e-regression` | Source present; no fresh Electron run in this slot |
| Empty and edited sticky-note lifecycle | `shows a placed empty sticky note in the sidebar before text is entered` (`:2359`) and `round-trips a canonical sticky note after editing, recoloring, and moving it` (`:2389`) | Active equivalent, split across the two canonical note cases | `e2e-regression` | Source present; no fresh Electron run in this slot |
| Foreign reply read-only and parent deletion | `shows foreign note replies as read-only and deletes them with their parent` (`:2512`) | Active equivalent | `e2e-regression` | Source present; no fresh Electron run in this slot |
| Persisted identity and post-save deletion/undo behavior | `persists a restored note after undo before saving a second note` (`:2581`), plus the saved highlight identity and deletion/undo cases (`:2710`, `:2743`) | Active equivalent, represented by canonical identity and saved-history cases | `e2e-regression` | Source present; no fresh Electron run in this slot |

The two blocking-save cases in `tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts`
are active, but both currently stop at the native mutation boundary on this Mac
lane. The settings-to-author case in `tests/e2e/electron/savePipeline.e2e.test.ts`
is also active, but its real run reaches `handleSave: false` with
`annotationDirty: true` when the native page tool is unavailable. Those are
acceptance gaps for #540 and #541, not reasons to mark the nine lifecycle
replacements failed.

## Evidence run

The bounded renderer/OCR unit selection passed on this SHA:

```text
pnpm exec vitest run --project unit-app \
  tests/unit/app/modules/pdf-viewer/components/annotationGeometryRendering.test.ts \
  tests/unit/app/modules/pdf-viewer/composables/usePdfTextLayerRenderer.test.ts \
  tests/unit/app/composables/pdfWordBoxGeometry.test.ts \
  tests/unit/app/composables/pdfSearchMatchScroller.test.ts \
  tests/unit/app/modules/pdf-viewer/runtime/usePdfRendererTextLayerController.test.ts \
  tests/unit/app/modules/pdf-viewer/engine/annotationHighlightGeometry.test.ts \
  --reporter=dot
```

Result: 6 files passed, 87 tests passed. This is supporting renderer evidence,
not execution of the nine Electron lifecycle journeys. No historical ledger
counts were rewritten.

## V5b continuation evidence

After reconciling this branch with `origin/project8/integration` at
`7d784ada3`, the disjoint fallback selection passed on the owned branch:

```text
pnpm exec vitest run --project unit-app --project unit-electron \
  tests/unit/app/modules/pdf-viewer/annotations/annotationStoreSaveIdentityRebase.test.ts \
  tests/unit/app/modules/pdf-viewer/annotations/annotationSavedHistoryLifecycle.test.ts \
  tests/unit/app/modules/pdf-viewer/annotations/annotationStoreDirtyAndPersisted.test.ts \
  tests/unit/app/modules/pdf-viewer/annotations/annotationStoreSaveFrontierRollback.test.ts \
  tests/unit/app/modules/pdf-viewer/runtime/sessions/annotationHistoryDocumentSwap.test.ts \
  tests/unit/app/modules/pdf-viewer/composables/usePdfTextLayerRenderer.test.ts \
  tests/unit/app/composables/pdfWordBoxGeometry.test.ts \
  tests/unit/app/composables/pdfSearchMatchScroller.test.ts \
  tests/unit/electron/ocrDocumentTextCatalogV4Consumer.test.ts \
  tests/unit/electron/searchMatch.test.ts --reporter=dot
```

Result: 10 files passed, 133 tests passed. This covers annotation identity,
dirty frontiers, history replay/document swaps, OCR catalog consumption and
search/renderer behavior. It does not replace the blocked real Electron
rotated-OCR or native annotation-save journeys.

## V5b primary acceptance evidence

The reserved #470 search-match Electron gate was rerun after the branch was
fast-forwarded to `origin/project8/integration` at `a00c3fcb2`:

```text
pnpm run test:e2e:electron:search-match-scroll
```

The native `evb-pdf-search` build passed and the real macOS Electron journey
passed 1 file and 2 tests. The tests kept the final high-zoom result visible
and centered, then kept repeated match selections visible after navigation
settled. Gate evidence is retained at
`.devkit/analysis/gates/2026-09-11T17-45-50-580Z-57289-a920f567.ndjson`.

This proves the current search-match scrolling path with the native search
tool. It does not prove all four rotated OCR overlay orientations, CropBox
projection, or native annotation save. Those remain separate gaps.

## V5b follow-up acceptance

The next native viewer acceptance was attempted from integration context
`61981ea3d` with:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 EVB_PDF_SEARCH_ENABLE=1 \
  pnpm exec vitest run --project e2e-regression \
  tests/e2e/electron/viewerSmoke.e2e.test.ts \
  -t 'searches deterministic late-page native DjVu text through the common sidebar with visible result geometry' \
  --reporter verbose
```

The native build passed and Electron reached a ready session. The test then
failed before search began because `openDocumentSidebarTab` timed out after
30 seconds waiting for the common sidebar tab to become active. The first
failure is retained in
`.devkit/sessions/e2e-run-mtx9783h-86772a-djvu-viewer-smoke-1789149152269/session.log`.
This is a renderer/sidebar acceptance gap, not a native build or Electron
startup failure.

The disjoint fallback passed on the same current integration context:

```text
pnpm exec vitest run --project unit-app --project unit-electron \
  tests/unit/app/composables/pdfWordBoxGeometry.test.ts \
  tests/unit/app/composables/pdfSearchMatchScroller.test.ts \
  tests/unit/app/modules/pdf-viewer/composables/usePdfTextLayerRenderer.test.ts \
  tests/unit/app/modules/pdf-viewer/components/annotationGeometryRendering.test.ts \
  tests/unit/electron/ocrDocumentTextCatalogV4Consumer.test.ts \
  tests/unit/electron/searchMatch.test.ts --reporter=dot
```

Result: 6 files passed, 96 tests passed. The fallback does not hide or replace
the failed real viewer acceptance.

The same primary journey was retried after the branch advanced to integration
`26c37a9ef`. It reproduced the identical 30-second timeout in
`openDocumentSidebarTab` at `tests/e2e/electron/helpers/viewerCore.ts:1051`,
before search began. The second session log is retained at
`.devkit/sessions/e2e-run-mtx9bkgu-f734da-djvu-viewer-smoke-1789149354849/session.log`.
The six-file fallback was rerun on that tip and passed 96/96 tests again.

## V5b draw-shapes acceptance

The next reserved #459 gate ran from integration context `e6a7c692d`:

```text
pnpm run test:e2e:electron:draw-shapes
```

The native page-ops build passed. The real Electron draw lifecycle selection
passed 16 tests covering repeated draw/save/delete/redraw, undo/redo, popup
deletion, and saved-stroke survivor handling. The cross-runtime Ink parity
case reached both Electron and Playwright and reported matching managed-shape
and stroke metrics, but its independent pixel assertion failed with 46 blue
pixel differences against an allowed maximum of 28. Gate evidence is retained
at `.devkit/analysis/gates/2026-09-11T17-58-32-973Z-50005-5dc6b5e6.ndjson`.

The disjoint six-file renderer/OCR fallback passed 96/96 tests again. No
threshold or source change was made to hide the parity mismatch. The saved
parity artifacts and session logs remain owned by this run for coordinator
review.
