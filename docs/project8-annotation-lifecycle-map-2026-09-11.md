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
