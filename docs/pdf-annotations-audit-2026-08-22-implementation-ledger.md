# PDF annotations audit implementation ledger

Date: 2026-08-23

Source audit: `docs/pdf-annotations-feature-audit-2026-08-22.md`.

## Verification baseline

- Audit baseline: `26c7b8d6b641f81c501d66dcf239a3ff90d31bcd`. During
  verification `main` advanced to `8438d6686` (navigation ledger, CI runbook
  commit); a path-scoped diff over `app/modules/pdf-viewer` and
  `app/modules/workspace-shell` between the two is empty, so citations hold at
  both revisions.
- Method: six independent read-only verification passes (undo-redo,
  highlight/FreeText, sidebar and H1 trace, store/sync/persistence,
  shapes/serialization, and the audit's open interleaving and orphan-editor
  questions), each instructed to refute claims first and to trace reachability
  through production callers and existing tests. A synthesis pass by the
  session owner set the dispositions below. No files were modified and no
  tests were run during verification.
- Two verification transcripts abbreviated directory names in citations; this
  ledger uses canonical repo paths throughout (for example
  `annotations/bridge/pdfjs-runtime/useAnnotationSync.ts`, not
  `composables/annotations/...`). Paths are relative to
  `app/modules/pdf-viewer/` unless a longer prefix is shown.

## Status and priority vocabulary

| Term | Meaning |
| --- | --- |
| Confirmed | The cited condition exists in a reachable production path. |
| Partial | Part of the claim is true, but scope, mechanism, or impact is overstated. |
| Refuted | The current code prevents or contradicts the reported behavior. |
| P1 | A bounded corrective patch should be scheduled. |
| P2 | Add hardening or parity coverage before changing the area. |
| P3 | Cleanup only. Fold it into nearby work in the same area. |
| No action | Preserve the current behavior or evidence. |

No item is a verified P0. Seven items are P1: H2, M9, H1 (focus half), M6,
L8, M1, and Q1 (the print save-lease bypass, upgraded from the audit's
unverified risk list). The audit's two "High" headliners survive, but one of them (H1) at
half its claimed scope, and two of its Med-High items (M2, M3) fall to Low
because the mechanisms it feared are already guarded.

## Corrections to the audit

The audit's architecture description and most citations verified as written.
The following claims did not survive verification and should not be relied on.

Refuted:

1. **M5, empty selection boxes.** The local guard would accept `[]`
   (`annotations/bridge/pdfjs-runtime/useAnnotationHighlight.ts:324-365`), but
   the pinned pdf.js 5.7.284 never produces one: `getSelectionBoxes` returns
   `null` for collapsed, zero-area, or out-of-layer selections
   (`node_modules/pdfjs-dist/build/pdf.mjs:4189-4254`), and the cached-selection
   path rejects collapsed or out-of-text-layer ranges before restoration
   (`useAnnotationTextSelectionCache.ts:47-98`). No orphan entity is mintable
   through production input.
2. **M11, cross-page selections truncated to the start page.** They are
   rejected whole, not halved: pdf.js refuses a range whose common ancestor is
   outside the start text layer and returns `null`
   (`pdf.mjs:4194-4199,4251-4254`). What remains is only a silent no-op with
   debug-level logging (`useAnnotationHighlight.ts:617-629`).
3. **H1's delete half.** Sidebar shape deletion works. It routes through
   `createPageAnnotationDeleteActions.ts:131-142` into the mutation service,
   which resolves the shape canonically and tombstones it before the broken
   inner shape action's `false` return is ignored
   (`runtime/annotations/useAnnotationMutationService.ts:123-138`). Only shape
   focus is dead. There is also no arbitrary-shape hazard: production id
   misses resolve to `null`, not `undefined`
   (`annotations/domain/externalIdentityIndex.ts:71-82`).
4. **M3's mechanism.** `reconcileEditorPresence` does not require a prior
   external binding; it tombstones any missing, unsaved, non-deleted entity
   (`annotations/domain/annotationStore.ts:554-578`, especially `:567-576`)
   and runs after history replays
   (`runtime/sessions/createPdfAnnotationSession.ts:705-725`). Failed-binding
   orphans are transient, not permanent.
5. **M2's severity.** Normal page operations are shielded: structural ops go
   through a document reload that registers a `source: 'file'` ledger command
   (`app/modules/workspace-shell/composables/document-session/createDocumentHistory.ts:583-592`),
   and the new-document watcher clears annotation history on proxy swap
   (`runtime/sessions/createPdfAnnotationSession.ts:320-332`). The stale-undo
   window exists only for direct store callers during the asynchronous reload.
6. **M8's reachability.** pdf.js always assigns an annotation id, either the
   PDF reference or a generated `annot_...` value
   (`node_modules/pdfjs-dist/build/pdf.worker.mjs:51947-51972`), so the
   positional fallback is reachable only through mocks, alternate adapters, or
   upstream changes.
7. **L2's production impact.** Normal opens retain a working-copy path, which
   the store identity prefers
   (`runtime/sessions/createPdfAnnotationSession.ts:292-295`), and proxy
   replacement recreates the annotation application, so entities do not
   survive a collision in normal workspace flows.
8. **One M9 citation.** `createDocumentPersistence.ts:531-534` does set
   `state.error`; several persistence failures also surface through
   `WorkspaceDocumentAlerts.vue:4-10`. The reporting gap is real but narrower
   than cited (see M9 below).
9. **L1's exposure.** With a workspace sink attached (normal production), the
   raw `undoAnnotation`/`redoAnnotation` exposes read empty local stacks and
   no-op (`runtime/annotations/usePdfAppAnnotationHistory.ts:65-70,308-327`).
   No in-repo caller invokes them.
10. **L6's granularity.** The 220 ms debounce coalesces fast typing
    (`app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts:339-363`);
    history gets one entry per quiet-period commit, not per keystroke. The
    eviction pressure on the 128-deep ledger remains for slow typing.

Audit open questions closed by verification:

- **Embedded-shape cache revision tokens.** Every page mutation bumps the
  token. Electron delete, reorder, insert, insert-file, rotate, crop, and
  remove-crop route through `transitionPageMutation`
  (`electron/features/page-ops/main/pageOpsMainBindings.ts:143-180,677-688`);
  browser mutations finish through `writePageMutationResult`
  (`app/platform/browser-api/createBrowserPageOpsCapability.ts:258-271`).
  Extract writes a new destination and workspace split is pane handling, not a
  page mutation. Refuted as a missing bump; a narrower in-flight fencing note
  is V3 below.
- **Deferred-delete undoability.** Confirmed undoable. The unwrapped
  `deleteCanonicalAnnotation` call still registers a before/after history
  entry through the store's own commit
  (`annotations/domain/annotationStore.ts:426-430,844-880`), pushed
  immediately when no transaction is active
  (`runtime/annotations/usePdfAppAnnotationHistory.ts:123-129`). What it lacks
  is atomicity with the pdf.js/DOM effects (V6 below).
- **Overlapping save transactions (Q1)** and **orphan editor after undoing a
  create (Q2)**: see "Resolved open questions" below.

Found during verification, not in the audit:

- **V1.** Per-page parse failures are worse than the audit's footnote: the
  failed page is counted as completed
  (`annotations/bridge/pdfjs-runtime/useAnnotationSync.ts:526-539`), the
  partial snapshot carries no failure field and is cached (`:553-559`,
  `:647-678`), and debug logging sits below the default threshold
  (`app/utils/browserLogger.ts:35,253-276`). Cache reuse preserves the
  omission beyond "the next sync".
- **V2.** The status bar has no failure state (idle, saving, dirty, clean
  only: `usePageStatusBar.ts:234-275`), so a failed save of an
  already-clean-looking document can present as clean.
- **V3.** In-flight embedded-shape imports are fenced by import token and
  path, not document revision
  (`runtime/annotations/useManagedEmbeddedPdfShapes.ts:414-418,631-638`).
  Completed cache entries are revision-safe; an in-flight old scan is not.
- **V4.** L8 is reachable through a first-class setting: root font size
  follows `--app-ui-scale` with presets 0.9/1.1/1.25
  (`app/assets/css/main.css:1085-1087`, `app/composables/useUiScale.ts:21-25`,
  `SettingsGeneralPanel.vue:55-67`). Row stride becomes ~100.8/123.2/140 px
  against a fixed 112 px virtual height.
- **V5.** The direct parser used at save finalize has no size assertion; the
  96 MiB guard lives only in the worker client
  (`engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient.ts:96-105`).
- **V6.** Deferred delete's tombstone, DOM removal, cache removal, and page
  invalidation are separate operations with no spanning transaction; visual
  effect failures are logged without rollback
  (`createPageAnnotationDeleteActions.ts:66-85`,
  `useAnnotationMutationVisualEffects.ts:110-125`).

## Disposition summary

| ID | Audit rating | Verified status | Corrected rating | Priority | Decision |
| --- | --- | --- | --- | --- | --- |
| H1 | High | Partial: focus dead, delete works | Medium | P1 | Match sidebar shape rows on `annotationId`; regression test first. |
| H2 | High | Confirmed | High | P1 | Propagate real creation success to callers; surface failures. |
| M1 | Med-High | Partial | Medium | P1 | Rebase outstanding history snapshots at `acknowledgeSave`; failing test first. |
| M2 | Med-High | Partial: shielded in production | Low | P3 | Pin the shield (page op clears annotation history) with a test; no code change. |
| M3 | Medium | Partial: orphans transient | Low | P3 | Add direct test: `reconcileEditorPresence` tombstones unbound transients. |
| M4 | Medium | Partial | Medium | P2 | Landed (#101): unedited Square/Circle rects are preserved, not rewritten. |
| M5 | Medium | Refuted | None | No action | pdf.js never yields `[]`; optional one-line guard if touching the file. |
| M6 | Medium | Confirmed | Medium | P1 | Filter sink-mode forget by annotation ids instead of source-wide reset. |
| M7 | Medium | Confirmed | Medium | P2 | Truncation flag + warning + completeness metadata on snapshots. |
| M8 | Medium | Partial: not reachable via pdf.js | Low | No action | Record reachability; revisit only if a non-pdf.js source appears. |
| M9 | Medium | Partial | Medium | P1 | Report `not-saved` outcomes through the same surfacing as thrown saves. |
| M10 | Medium | Partial: conditional, unguarded | Medium | P2 | Landed (#103): save priming runs in the worker client under its size guard. |
| M11 | Low-Med | Refuted as truncation | Low | P3 | Fold a user-visible rejection signal into the H2/M9 surfacing work. |
| L1 | Low | Partial: near no-op in workspace mode | Low | P3 | Delete or gate the raw undo/redo exposes. |
| L2 | Low | Partial: impact refuted | Low | P3 | Key store identity by Blob instance (WeakMap) like the snapshot side. |
| L3 | Low | Partial | Low | P3 | Reschedule the debounced persist when `saving` clears. |
| L4 | Low | Confirmed | Low | P3 | Surface note-window delete misses like the instrumented sibling path. |
| L5 | Low | Partial | Low | P3 | Set `estimatedBytes` on canonical snapshot commands when touching history. |
| L6 | Low | Partial | Low | P3 | Coalesce successive note-text commands per annotation, or accept. |
| L7 | Low | Confirmed | Low | P3 | Landed (#101): stale `/IC` deleted when updating Line dicts; `/LE` unchanged. |
| L8 | Low | Confirmed, reachability understated | Medium | P1 | Derive virtual row stride from the effective root font size. |
| V1 | — | Confirmed | Medium | P2 | Bundle inventory-completeness status with M7. |
| V2 | — | Confirmed | Medium | P1 | Fold a failure state into the M9 surfacing slice. |
| V3 | — | Confirmed, narrow | Low | P3 | Landed (#103): the in-flight import fence compares the document revision. |
| V4 | — | Confirmed | — | — | Evidence for L8's P1; no separate item. |
| V5 | — | Confirmed | Low | P2 | Landed (#103) as part of the M10 slice. |
| V6 | — | Confirmed | Low | P3 | Closed in #100: e2e asserts undo of a deferred delete restores editor/DOM state. |
| Q1 | Risk (unverified) | Proven: print bypasses the save lease | Medium | P1 | Route dirty print through the document operation lease; add a race test. |
| Q2 | Risk (unverified) | Refuted by experiment: editor removal precedes the canonical delete | Low | P2 | Closed in #100: removal mechanism recorded, boundary regression tests added, in-flight sync fenced. |
| V7 | — | Confirmed (#100) | Medium | P2 | One authored create leaves two undo steps; the first leaves the document dirty with nothing visible left. Needs the store-side fix, not a history transaction. |

## P1 items

### H2, creation success is reported unconditionally

`useAnnotationHighlight.ts:356-367` hard-codes `createdAnnotation = true`
after submitting the canonical intent; mode-switch and editor failures are
caught, logged at debug level, and still return success (`:565-601`).
`createTextMarkupFromText` exposes the value as `created` (`:763-768`), and it
is consumed by the workspace automation expose
(`app/modules/workspace-shell/expose/createWorkspaceExpose.ts:460-465`) and
the document agent (`agent/useDocumentWorkspaceAgent.ts:763-777`). A point
comment also treats `true` as success and skips its fallback
(`useAnnotationHighlight.ts:940-949`).

Acceptance checks:

1. The function returns the actual outcome: intent submitted, editor bound, or
   failed with a reason.
2. Automation and agent callers receive the failure.
3. Unit tests cover mode-switch throw, retry exhaustion, and null editor
   results; all currently pass against the hard-coded flag and must fail
   against it after the change.

### M9 and V2, not-saved outcomes bypass reporting

`useWorkspaceSaveService.ts:931-955` returns `false` for `status:
'not-saved'` without setting an error or showing a toast; the toast lives only
in the exception handler (`:1080-1111`). Reachable producers include failed
open-note persistence (`:1030-1042`), validation rejection (`:292-317`), and
optional capability failures
(`createDocumentPersistence.ts:609-611,659-661`). The status bar has no
failure state (`usePageStatusBar.ts:234-275`), so a failed clean-looking save
presents as clean.

Acceptance checks:

1. Every `not-saved` return sets state or user-visible feedback equivalent to
   the thrown-save path.
2. A service-level test asserts the surfacing for at least validation
   rejection and note-persistence failure.
3. The M11 silent rejection (cross-page selection) reuses whatever surfacing
   primitive this slice introduces, or documents why not.

### H1, sidebar shape focus matches a field that is never set

`tools/usePdfShapeTool.ts:110-121` matches shapes against
`comment.appAnnotationId`; shape summaries never carry it
(`engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary.ts:30-49`),
and no enrichment site exists (decisive repo-wide trace; the only
sidebar-capable enrichment, `annotationApplication.ts:370-418`, has no call
site). Row click opens the sidebar and sets the active key, then returns
before focusing (`usePdfAnnotationCommentActions.ts:54-57`).

Acceptance checks:

1. A regression test drives a shape summary through
   `findShapeForAnnotationComment` and fails before the fix.
2. Fix by matching on `annotationId` (or by setting `appAnnotationId` in the
   summary factory); pick one and delete the dead alternative.
3. Fold L4 in: the note-window `deleteAnnotationById` miss logs or surfaces
   like `createPageAnnotationDeleteActions.ts:88-97`.

### M6, sink-mode forget wipes unrelated annotation history

Local mode filters forgotten commands by id; sink mode resets the entire
`annotation` source (`runtime/annotations/usePdfAppAnnotationHistory.ts:131-145`,
`app/modules/workspace-shell/composables/useWorkspaceCommandLedger.ts:62-99`).
The sink is attached in normal production
(`useWorkspaceOrchestration.ts:228-249`), and forget runs on deleted-shape
cleanup, shape replacement, and unmatched-import cleanup
(`annotations/domain/annotationStore.ts:417-424,936-945,972-994`).

Acceptance checks:

1. Ledger gains id-scoped removal within a source; sink-mode forget uses it.
2. A test registers two annotation commands, forgets one id, and asserts the
   other remains undoable (the current suite cannot detect this).

### L8, fixed 112 px virtual stride under UI scaling

`PdfAnnotationCommentsList.vue:216-223` fixes `itemHeight: 112`; rows are
rem-based (`:515-531`, `app/assets/css/main.css:260-262`) and root font size
follows the UI scale presets 0.9/1.1/1.25 (V4). At non-default scale the list
overlaps or gaps.

Acceptance checks:

1. Row stride derives from the effective root font size (or the row height
   moves to pixels; pick one and state why).
2. A test covers at least one non-default scale.

### M1, history snapshots go stale across save acknowledgement

`acknowledgeSave` adds `persistedRevision`, binds `pdfRef`, and rebases the
semantic baseline without touching history
(`annotations/domain/annotationStore.ts:721-751`); commands hold absolute
before/after clones and replay them wholesale (`:844-880,901-928`). Redo of a
pre-save create restores `persistedRevision: -1` without `pdfRef`, flipping
the entity dirty. The audit's duplicate-on-next-save consequence is
conditional: save verification also matches canonical id, `pdfName`,
`pdfjsUid`, `elementId`, and sticky-note semantic fallback
(`annotationApplication.ts:642-709`), but some delete serialization does key
off `pdfRef` (`engine/pdf-serialization-operations/serializePdfEdits.ts:16-55`).

Acceptance checks:

1. A failing unit test first: edit, save, undo, redo, then assert
   `persistedRevision` and `pdfRef` survive redo.
2. Preferred fix is rebasing identity fields into outstanding snapshots at
   `acknowledgeSave` (the audit's rebase option); wholesale replay stays.
3. The M2 shield gets pinned in the same slice: a test asserting a structural
   page op clears annotation history via the proxy-swap watcher.
4. An e2e extends `annotationLifecycle` to assert identity fields, not just
   counts and dirty bits.

### Q1, dirty print runs a save transaction outside the document lease

Evidence and mechanism in "Resolved open questions" below.

Acceptance checks:

1. The dirty-print path acquires the same document operation lease as saves,
   split capture, page mutations, and shutdown flush before calling
   `runSaveTransaction`.
2. A test holds two transaction commits open and asserts the second waits (or
   fails) instead of both passing `assertAnnotationSaveCurrent()` across one
   acknowledgement.

## P2 items

### Q2, orphan editor and entity resurrection after undoing a create

Closed in #100 without the conditional fix: the experiment refuted the orphan.
See "Resolved open questions" below for the recorded removal mechanism, the
regression tests that pin it, and V7, the defect the experiment did surface.

### M4, import clamping rewrites off-page geometry

Clamping happens twice on import
(`engine/annotation-geometry/toMarkerRectFromPdfRect.ts:124-129`,
`normalizeMarkerRect.ts:16-30`) and the clamped rect is written back when
shape state is dirty (`useWorkspaceSaveService.ts:458-467`,
`applyShapeAnnotations.ts:206-221`). Left/top crossings shift the rectangle
rather than intersecting it. Ink and polyline points are not clamped, so
behavior is type-dependent. Requires editing any shape in the document, then
saving, to damage an untouched off-page shape.

Order: fixture first (an embedded Square straddling the trim box through
open, unrelated shape edit, save, reopen), then either stop clamping imported
geometry or only serialize rects whose marker geometry actually changed.

**Landed (#101), with L7.** The second option: import still clamps, because
the overlay renders in the unit page box, but a Square or Circle whose marker
geometry is unchanged keeps the rect the file already carries. Both writers
decide this the same way: replay the import projection over the annotation's
own rect and compare it with the live marker rect
(`engine/serialization/pdf-serialization-shape-annotations/isImportedShapeRectUnchanged.ts`,
`native/pdf-page-ops/src/shapes.rs`, `is_imported_shape_rect_unchanged`). An
edit of any size a pointer can produce fails that comparison and serializes
normally. The native reader resolves `/Rect` through the document, so an
indirect array, or indirect numbers inside it, reads as an unchanged rect
instead of as no rect at all; without that, the preservation branch would be
skipped exactly where it matters. Coverage:
`tests/unit/app/modules/pdf-viewer/serialization/embeddedShapeRectPreservation.test.ts`
(serialized route, Square and Circle, including repeated open-save cycles) and
the shape cases in `native/pdf-page-ops/src/tests/markup_shapes.rs` (full
rewrite, incremental append, and indirect rects). L7 rode along: both writers
now delete `/IC` when updating a Line, and the tests pin that a Polygon fill
survives.

### M7 and V1, inventory completeness is silent

Global caps break silently and the truncated snapshot is cached beyond
revision changes (`useAnnotationSync.ts:125-129,500-511,553-559,590-661`);
failed pages count as completed (`:526-539`). Add a completeness field to the
snapshot, warn on truncation or page failure, and surface it wherever the
sidebar shows loading state. Tests: a capped scan and a failing page both
produce the flag and the warning.

### M10 and V5, save-finalize parses on the UI thread without a size guard

`useManagedEmbeddedPdfShapes.ts:700-714` imports the direct parser at save
priming; runs only for serialized saves with dirty shape state or native saves
with shape mutations (`useWorkspaceSaveService.ts:550-560,739-748`), so it is
conditional, but the direct call has no 96 MiB assertion and the 64 MiB
working-copy guard does not cover automation or native paths. Route priming
through the worker client and inherit its guard; test that priming uses the
worker.

**Landed (#103), with V3.** Priming calls
`importEmbeddedShapeAnnotationsUsingWorker`, so the whole-document scan leaves
the renderer thread and inherits the 96 MiB assertion. It keeps ownership of
the bytes, which are still on their way to disk, so the worker receives a
copy. A refusal is the point of the change: priming then returns no
preparation token, and a serialized save persists the file but leaves shape
state dirty instead of declaring clean a baseline nothing established. The
token is bound to the store and save frontier that started the save, and the
clean mark now goes through it, so a save of a document the viewer has since
replaced cannot mark the current one's shapes saved. In-flight priming is
registered and aborted when the viewer adopts a different working copy or the
composable is disposed; a save that republishes the same working copy under a
new revision is not cancellation and survives. V3 rode along:
`isStaleEmbeddedShapeImport` now also compares the document revision token, so
an in-flight scan started before a page mutation is fenced, not only a
completed cache entry. Coverage:
`tests/unit/app/modules/pdf-viewer/runtime/annotations/managedEmbeddedShapeSavePriming.test.ts`
and the shape-priming cases in
`tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceNativePersistence.test.ts`.

## P3 batch

Fold these into work that already touches their area; none justifies a
standalone change:

- M2 pin test and M3 reconciliation test (with the M1 slice).
- M11 rejection signal (with the H2/M9 surfacing slice).
- L1: delete the raw `undoAnnotation`/`redoAnnotation` exposes
  (`createPdfAnnotationSession.ts:1015-1021`,
  `usePdfViewerPublicApiController.ts:251-255`); they are a no-op with a sink
  attached and have no in-repo caller. Prefer deletion per the design charter.
- L2: WeakMap-keyed store identity for pathless blobs, mirroring
  `createPdfAnnotationSession.ts:119-141`.
- L3: reschedule the note persist when `metadata.saving` clears
  (`useAnnotationNoteWindows.ts:379-388,417-422`).
- L4 (with H1). L5, L6 (with any history work). L7: landed with #101, in both
  the pdf-lib and the native shape writers.
- V3: landed with #103; the in-flight import fence now compares the document
  revision token as well as the import token and working copy path.
- V6 (done, #100): `annotationLifecycle.e2e.test.ts` asserts that undoing a
  deferred delete of a persisted highlight restores the editor node and the
  canonical entity under its persisted identity, with no save in between.

### L6 decision, taken with the M1 slice (#98): accept per-commit entries

Successive note-text commands stay separate undo steps. The note window
debounces keystrokes into one commit per quiet period
(`app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts:339-363`),
so each entry already marks a pause the user can recognise, and merging them
would let one undo swallow a whole typing session. Merging would also have to
rewrite the top of the shared workspace timeline, where the previous entry may
belong to another producer, weakening the ordering that timeline exists to
keep. The eviction pressure the audit worried about is answered by L5 instead:
canonical snapshot commands now carry the bytes they retain
(`annotations/domain/annotationStore.ts`, `estimateRetainedAnnotationBytes`), so
the ledger's byte cap prices note edits honestly rather than at the flat 1 KiB
default. The boundary is pinned by
`tests/unit/app/modules/pdf-viewer/annotations/annotationStoreSaveIdentityRebase.test.ts`.

## Resolved open questions

### Q1, overlapping save transactions: proven, print bypasses the lease

Normal saves, split capture, page mutations, and shutdown flush all serialize
through the document-wide FIFO lease
(`app/modules/workspace-shell/document-sessions/workspaceDocumentController.ts:403-430`;
save entry at `useWorkspaceSaveService.ts:1001-1026`; split at
`useWorkspaceSplitPayload.ts:111-155`; page ops at
`runtime/composables/pdf/usePageOperations.ts:262-275`; shutdown via
`usePageSaveOrchestration.ts:347-349`). Dirty print calls
`pdfViewerRef.runSaveTransaction` directly with no lease
(`useWorkspaceOrchestration.ts:722-741,817-835`), and `runSaveTransaction`
itself has no single-flight guard and awaits several interleaving points
(`runtime/save/usePdfViewerSaveTransaction.ts:451-520,631-665`).

The CAS race the audit feared is real: the frontier baseline hashes only
`{id, revision, deleted, pageIndex}`
(`engine/annotations/domain/annotationEntity.ts:164-171`), and
`acknowledgeSave` leaves `revision` unchanged, so a second frontier can pass
after the first acknowledgement (`annotationStore.ts:721-751,781-815`).
Mitigations: print returns bytes without `commitAnnotationSave`, and backend
writes carry document-revision checks and are serialized per document
reference. Whether the race can produce duplicate durable bytes is still
open; the guard hole itself is proven. Disposition: P1, route dirty print
through the same lease.

### Q2, orphan editor after undoing a create: refuted by the experiment (#100)

The closing experiment ran as specified: an e2e MutationObserver records the
highlight nodes a replay removes, the editor-layer identity, the DOM counts,
and the canonical projection at the synchronous undo, after two animation
frames, and in a following macrotask
(`tests/e2e/electron/helpers/viewerAnnotations.ts`,
`clickHistoryActionAcrossAnimationBoundaries`). No orphan reproduces, for
either authored creation path.

Removal mechanism, recorded so the next reader does not re-derive it:

- **Highlight and drawings.** `AnnotationEditorLayer.add` calls
  `editor.onceAdded`, and `HighlightEditor.onceAdded` / `DrawingEditor
  .onceAdded` call `layer.addUndoableEditor(this)` when the editor is not an
  existing annotation, which reaches `uiManager.addCommands({cmd: rebuild, undo:
  remove})`. That command carries no `__evbSkipAppHistory` marker, so the
  bridge records it as an app executor command
  (`annotations/bridge/pdfjs-runtime/useAnnotationEditorBridge.ts`, `addCommands`
  interception). It sits above the canonical create in the same stack, so the
  first undo runs PDF.js' own removal synchronously and the editor node is gone
  in the same task. The replay effect's presence reconciliation then sees the
  editor absent and tombstones the still-transient entity
  (`runtime/sessions/createPdfAnnotationSession.ts` replay effect →
  `annotationStore.reconcileEditorPresence`), so the canonical entity leaves
  the projection in that same task too. The `skipAppHistory` pair the bridge
  installs from the storage hook is a redundant second PDF.js entry for this
  path and is never replayed.
- **FreeText sticky notes.** `FreeTextEditor.onceAdded` installs no PDF.js
  undo command, so the canonical entry is the only app history entry. The
  anchor editor is not orphaned because it is projected from canonical state
  rather than owned by PDF.js history: the canonical delete takes the anchor
  with it inside the same task. The experiment pins this by counting
  `.freeTextEditor` nodes at every boundary.

Regression tests (`tests/e2e/electron/annotationLifecycle.e2e.test.ts`):
"keeps an undone toolbar highlight create removed across frames and the
deferred sync", "keeps an undone sticky note removed across frames and the
deferred sync", and V6's "restores the editor, DOM, and canonical entity when a
deferred delete is undone". Each drives a real comment sync to completion after
the undo and asserts that nothing the observer recorded as removed comes back.
"To completion" is measured, not waited out: the renderer publishes an
automation-only sync ledger (`app/utils/createAnnotationSyncAutomationBarrier.ts`,
inert without the renderer automation grant) counting requested, running, and
serviced comment syncs, and the two undo scenarios block on
`waitForAnnotationSyncIdle` until a sync requested after their mutation has
finished its awaited PDF snapshot with nothing left queued or debounced. The
observer and every count it is compared against are scoped to the active
workspace host, so an inactive tab's mounted viewer cannot answer for the one
under test.

One hole was real and is closed: a comment sync reads the editor layer
synchronously and then awaits the PDF snapshot, so a replay landing inside that
await could apply a pre-replay editor scan on top of the result. Because an
editor summary carries `appAnnotationId` from the editor's facade state,
`ingestLegacySummaries` would mint the undone annotation back under its own
canonical id. The replay effect now retires such a scan
(`useAnnotationSync.discardInFlightSync`), keeping the parsed PDF snapshot,
which a replay does not invalidate. Pinned by
`tests/unit/app/modules/pdf-viewer/runtime/annotations/useAnnotationSync.test.ts`,
"does not apply an editor scan collected before an annotation history replay".

### V7, one authored create leaves two undo steps

Found while running the Q2 experiment. A toolbar highlight registers the
canonical create and PDF.js' own `addUndoableEditor` command as two independent
app history entries. The first undo pops the PDF.js entry and removes the
editor; the presence reconciliation tombstones the entity, so nothing is
visible any more, but the document stays dirty and a second undo is still
queued for the canonical entry. Sticky notes show the same two-step shape.
Evidence: with the fixture freshly opened and one highlight created, the
toolbar reports `canUndo: true, canSave: true` after the first undo with
`annotationComments: []`, and only the second undo reports `canSave: false`.

A history transaction around the authored creation is *not* the fix. It was
tried and reverted in #100: merging the two entries makes one undo reach the
canonical hard delete, and hard-deleting an entity the file already holds drops
the persistence identity that survives an undo only while the save
acknowledgement has not cleared it
(`annotations/domain/annotationPersistenceIdentityLedger.ts`, `clear`). The
"keeps highlight undo and redo coherent after saving" e2e fails deterministically
under that change: after undo, save, redo, save the file holds the highlight but
the canonical projection holds nothing. The fix belongs in the store, where undo
of a create must tombstone rather than hard-delete an entity whose persistence
record says the file holds it. Sequence it with the M1/#98 history work.

## Suggested implementation order

1. **Surfacing slice** (#91): H2 + M9 + V2, with M11's signal riding along.
   One shared failure-surfacing primitive covers the audit's "silent failure
   is a pattern" synthesis without inventing per-site toasts.
2. **Sidebar shape slice** (#92): H1 focus fix + L4, regression tests first.
3. **Save integrity slice** (#93): Q1's print lease. Small, isolated, and it
   closes the only proven overlap path before any history work changes
   timing.
4. **History integrity slice** (#97, #98): M6, then M1 with the M2/M3 pin
   tests and the L1/L5/L6 fold, then the Q2 diagnostic (#100, blocked by #98),
   which refuted the orphan and left V7 for a later store-side step. M1 is the
   deepest change; its failing tests define the contract before the rebase
   lands.
5. **Layout slice** (#99): L8.
6. **P2 hardening**: M4 fixture then fix (#101, with L7); M7+V1 completeness
   (#102); M10+V5 worker routing (#103, with V3).
7. **P3 batch**: homeless leftovers L2 + L3 in #104; the rest ride their host
   slices above.

A finding closes when the corrective change and its regression test land and
this ledger's row is updated with the commit. Verification transcripts for
this ledger live outside the repo (`/tmp/codex-skill/annot-*-last.md`,
session artifacts); the evidence that matters is re-derivable from the
citations above.

## Acceptance entries

### 2026-09-05, #350 legacy saved-note compatibility

Status: In progress. Claimed by `evb0110` in Project 4. The issue is a child
of #170 and is assigned to the Editor lane and Other box. It remains open until
candidate and integrated-main verification pass.

The supplied recording and logs reproduce deletion failures for saved legacy
EVB notes on main at `25c6c974fd2eee8d3cb23c35abf49ecc33520642`. A real
Electron pointer reproduction also fails on
`2aecf52284ee29fdc818e03e45509705731314b6`. Both the sidebar Delete action
and the note-window Delete action leave the note count unchanged. The warnings
report `source=pdf`, `uid=null`, stable keys `ann:0:10909R` and
`ann:0:10916R`, and no resolvable editor.

The minimized fixture is
`/home/ubuntu/rescue-research/annotation-audit-20260905/legacy-notes-minimal.pdf`
(3,153 bytes, SHA-256
`f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`). It
contains two `/FreeText` plus `/Popup` legacy notes with `evb-note:` `/NM`
values, tiny marker rectangles, and blank zero-BBox appearances. The reported
book and recording were transferred privately to this VPS for the audit and
were not uploaded publicly.

Acceptance must prove canonical import and one durable identity across the
selection, sidebar, overlay, and history; sidebar and popup deletion with the
neighbor preserved; undo and redo; popup and reply cleanup; two save/reopen
cycles without resurrection; ADR 0003 migration of an edited legacy note to
`/Text`; preservation of an untouched legacy note; and comparison with a native
`/Text` note. The first implementation check runs this minimized fixture on
candidate `7466fc613f38460e08fe04beff54b46786cd6ba5` before any fallback is
added. Candidate and integrated-main SHAs and red/green results will be added
here when the gate closes.

The candidate source comparison confirms that the cutover already recognizes
legacy FreeText plus Popup plus blank AP notes, preserves their NM and PDF
object reference, projects them into the canonical persisted Text-note view,
and uses the embedded/native delete route. This is source evidence only. The
old editor bridge must not return to this path.

An early candidate pointer smoke run used the private source paths directly.
It passed against the two-note reported file, but the app wrote incremental
updates into both source files. The original files were recovered by proving
that the expected byte-length prefixes still matched their supplied SHA-256
values, then restoring those exact prefixes. No result from that contaminated
run counts as acceptance. Every later mutating case must open a fresh working
copy.

The restored fixture checks are now:

- `legacy-notes-minimal.pdf`: 3,153 bytes, SHA-256
  `f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`.
- `reported-notes.pdf`: 2,833,504 bytes, SHA-256
  `8398f0bce24e1d229810f29dc7844aff68c1bbebb2d9e0527df0a801d1ccbd36`.

The first clean minimal-file run also exposed a fixture-routing question. The
original file and its object graph must be checked before calling a second
note reachable or orphaned. That check remains part of worker 1's result.

## Parallel acceptance workstreams

On 2026-09-05 the coordinator reused four completed Luna read-only lanes and
reassigned them under this thread. Two other completed lanes were retired.
Each worker was told to preserve concurrent edits, avoid shared helpers and
fixtures, and leave commits and GitHub state to the coordinator.

| Worker | Scope and exact write ownership | Shared dependency | Current result |
| --- | --- | --- | --- |
| Peirce | Test environment and session readiness. `tests/e2e/electron/performanceProfileVisuals.e2e.test.ts`, `tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts` for the cancellation case, `app/utils/performanceProfile.ts`, `app/plugins/performance-profile.client.ts`. | Must report changes needed in shared Electron helpers, runner, or pressure configuration. | Complete. The cancellation reproduction was a collected `page.evaluate` promise and the synchronous dispatch rewrite plus pre-deactivation image filter passed at `2026-09-06T00-13-48-965Z-3085920-d24dbce3`. The profile failure was traced to sandboxed preload decoding and fixed by the coordinator in the preload decoder. |
| Euler | Annotation lifecycle and #350. `tests/e2e/electron/legacyNote350.e2e.test.ts`, `tests/e2e/electron/annotationLifecycle.e2e.test.ts`; product edits only if a focused proof requires `useAnnotationMutationService.ts` or `createPageAnnotationDeleteActions.ts`. | Coordinator owns shared helpers, fixture generators, save/session files, ledger, and GitHub state. | Complete. Clean fresh-copy legacy coverage passed for the minimized and supplied 383-page fixtures, with the virtualized hidden-sidebar-row failure classified and corrected in the test helper. |
| Avicenna | Document opening and native services. `tests/e2e/electron/viewerSmoke.e2e.test.ts`, `tests/e2e/electron/djvuPrintHandoff.e2e.test.ts`, `tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts`; product edits only in `app/modules/djvu-viewer/**`, `app/platform/browser-api/djvujsLoader.ts`, or `app/modules/workspace-shell/composables/document-session/nativePdfMutationCommit.ts` after proof. | Shared helper or runner changes return to the coordinator. | Complete. Added a settled sidebar-wrapper geometry wait in `viewerSmoke.e2e.test.ts`; the focused candidate passed. PNG, scan-cleanup, and print passed after native-tool provisioning. Cancellation remains with Peirce. |
| Mendel | Viewport and navigation. `tests/e2e/electron/inactivePdfTabs.e2e.test.ts`, `tests/e2e/electron/prBlockingSmoke.e2e.test.ts`, `tests/e2e/electron/squigglyMarkup.e2e.test.ts`; product edits only in the assigned navigation, viewport, document-viewport, anchor-retention, and text-markup model directories. | Annotation-layer overlap is reported to the coordinator and worker 1. Shared helpers remain coordinator-owned. | Complete. No candidate-only split-pane regression was established. The squiggly failure was an obsolete absolute-zoom expectation, corrected to use the rendered CSS scale factor, and passed at `2026-09-05T21-28-37-686Z-2713498-6cd81665`. The page-7 reset passed its focused late-page check at `2026-09-05T20-40-02-811Z-2627764-2cf3b15c` and again under the final candidate at `2026-09-06T00-17-29-266Z-3096073-b93a3546`. |

The coordinator queues expensive Electron and large-document runs centrally.
Workers begin with source analysis and lightweight checks and return each
failure's trigger, assertion, baseline/candidate distinction, root cause,
smallest justified change, focused output, touched files, and remaining risk.

Mendel's source comparison found the three owned E2E failures unchanged between
baseline `3924b6a92` and candidate `7466fc613`; the relevant viewport unit checks
passed. The split-pane run had no blank, loading, disconnect, page-change, or
thumbnail-reset signals despite `maxAnchorDrift=0.379`. The page-7 reset trace
showed the viewport authority at page 12 while page 7 was evicted. The
squiggly timeout did not capture settled width or mounted-page evidence. No
test assertion was weakened and no product edit was justified.

Avicenna's completed audit found that the candidate and evidence roots lack the
native image-combine and scan-cleanup binaries required by the PNG and scan
cleanup tests. Those tests correctly reject the JavaScript fallback. The DjVu
print run reached native page reading and then logged `TypeError: Object has
been destroyed`; its retained artifact did not prove the reported combiner
failure. The inactive-DjVu logs do not contain the asserted trusted-scroll
count or the `Promise was collected` error. These failures need a centrally
queued focused run or native-tool provisioning before any test assertion is
changed.

The coordinator then staged the native E2E tools with gate
`2026-09-05T20-19-37-267Z-2591018-11d091c9.ndjson`. On the provisioned
candidate, the PNG entry test passed at gate
`2026-09-05T20-22-12-107Z-2595476-fb916845`, the Scan Cleanup skeleton and
detection test passed at `2026-09-05T20-23-26-717Z-2597030-25c61c8c`, the
native detail-tile test passed at `2026-09-05T20-24-44-030Z-2598375-bccecaad`,
and the DjVu print handoff passed at
`2026-09-05T20-25-50-368Z-2599601-b90a896b`. The cancellation test still
fails with `Promise was collected` at
`2026-09-05T20-27-47-100Z-2602475-ecb706a4` and is now owned by Peirce for
session-lifetime diagnosis.

After Avicenna's audit, the focused DjVu sidebar run reproduced the documented
opening transition race at gate `2026-09-05T20-30-18-988Z-2606365-eb744b4d`:
the inner sidebar was open while its outer wrapper still reported zero width.
The worker added a local settled-boundary wait in the owned test, retaining
the existing one-pixel geometry assertions. The corrected candidate passed at
`2026-09-05T20-35-40-068Z-2617122-04dccbb4`.

The focused squiggly-markup run remains red at
`2026-09-05T20-31-58-222Z-2609410-5b63ac2e`. It times out at the existing
`waitForPageWidthAtZoom` assertion after the 50% transition. Mendel is
diagnosing the settled page width and effective zoom without weakening that
assertion.

### 2026-09-05, candidate acceptance follow-up

The private source fixtures were rechecked after all mutating runs. The
3,153-byte minimized fixture still hashes to
`f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`, and the
2,833,504-byte supplied fixture still hashes to
`8398f0bce24e1d229810f29dc7844aff68c1bbebb2d9e0527df0a801d1ccbd36`.
Every mutating test used a fresh temporary copy. The book and recording were
transferred privately to this VPS for audit and were not uploaded publicly.

Candidate `7466fc613f38460e08fe04beff54b46786cd6ba5` passed the complete #350
suite, four tests, at gate
`2026-09-05T21-27-05-508Z-2710062-417ebce7`. The minimized lifecycle test
proved real pointer selection, sidebar selection and deletion, note-window
deletion, undo and redo, editing with stable legacy identity, migration of the
edited note to `/Text`, preservation of the untouched `/FreeText` neighbor,
save and two reopen cycles without resurrection, and cleanup of the parent and
`/Popup`. The reply fixture also passed with the reply removed and the neighbor
intact. The supplied 383-page file passed its focused acceptance at
`2026-09-05T21-26-02-447Z-2708424-400c26af` and the full candidate suite.

The first clean minimal run initially failed because the test selected a hidden
zero-sized virtualized sidebar row. The helper now selects only an onscreen
row with a nonzero button rectangle. That was a fixture-routing failure, not a
legacy-note product failure. The candidate source comparison and the green
real-pointer run also confirm that the annotation layer's captured click keeps
the canonical legacy identity through selection and note-window opening. The
retiring PDF.js editor bridge was not restored.

The remaining performance-profile failure had a separate environment cause.
The sandboxed preload could not use Node `Buffer`, so it discarded the valid
host-profile argument and the renderer detected the VPS as high tier. The
browser-safe decoder fix covers both the host-profile and diagnostics-policy
arguments. Unit coverage passed 25 tests, and all low, medium, and high visual
profile checks passed at gate
`2026-09-05T21-53-43-169Z-2769520-30f305a2`.

Integrated-main verification, PR integration, and the remaining #196, #168,
#167, and Project 4 closure checks remain open.

### 2026-09-06, broad regression classification and candidate follow-up

The exact private legacy-note fixture remains unchanged at 3,153 bytes with
SHA-256 `f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`.
The supplied reported-notes fixture remains unchanged at 2,833,504 bytes with
SHA-256 `8398f0bce24e1d229810f29dc7844aff68c1bbebb2d9e0527df0a801d1ccbd36`.
The source book and recording stayed private on the VPS and were not uploaded
publicly.

The candidate broad regression run at gate
`2026-09-05T23-43-55-184Z-3030339-c030f60c` reported 65 passing tests, 18
intentional skips, and four failures across three files. Focused reruns
separated those failures. The inactive-DjVu cancellation failure was a probe
bookkeeping defect: the observer counted image elements committed before tab
deactivation. The probe now snapshots those elements and counts only new
commits. Its focused rerun passed at
`2026-09-06T00-13-48-965Z-3085920-d24dbce3`.

The inactive-PDF split-close, inactive-DjVu split-close, and PR-blocking page-7
reset failures reproduced only under the broad suite's concurrent load. Their
existing assertions remain unchanged. Each focused rerun passed with the same
candidate behavior at gates `2026-09-06T00-15-28-913Z-3093020-12bb1a6d`,
`2026-09-06T00-16-28-012Z-3094780-fa27f541`, and
`2026-09-06T00-17-29-266Z-3096073-b93a3546`, respectively. The broad failures
remain recorded as load-sensitive risks and require a post-integration broad
run. No failure was waived, no deadline was widened, and no fixture was
substituted.

The sticky-note context-menu fix and canonical-layer test corrections were
focused-green before this follow-up. The candidate also retains the browser
safe preload decoder, native managed-shape save projection, exact large-PDF
fixture routing, and the complete #350 evidence recorded above. Candidate
commit, PR integration, integrated-main verification, and the remaining #196,
#168, #167, and Project 4 closure checks remain open.
