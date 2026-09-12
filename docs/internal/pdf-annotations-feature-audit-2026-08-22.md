# PDF Annotation Feature Audit — 2026-08-22

Read-only audit of the editing/annotation/drawing/removal features: the
undo–redo stack, drawing and shape annotations, text markup and FreeText
editing, deletion pipelines, persistence/session lifecycle, and the
left-sidebar annotations panel with its markers and note windows.

Method: five parallel deep-read passes over disjoint slices of the subsystem,
each citing every claim as `path:line`.

| Slice | Primary locations |
|---|---|
| Store / persistence / session | `annotations/domain/`, `annotationApplication.ts`, `bridge/`, `runtime/sessions/`, save pipeline (`runtime/save/`, workspace save service) |
| Undo–redo | `domain/annotationStore.ts` history authority, `engine/annotations/annotation-history/`, `usePdfAppAnnotationHistory.ts`, `useAnnotationMutationService.ts`, keyboard routing in workspace shell |
| Shapes / drawing / removal | `engine/pdf-embedded-shape-annotations/`, `engine/annotations/{shape-annotation-identity,annotation-delete-resolver,annotation-dom-removal,annotation-marker-geometry,shape-annotation-comments}/`, `engine/serialization/pdf-serialization-*`, `tools/usePdfShapeTool.ts` and friends |
| Text markup / FreeText | `bridge/pdfjs-runtime/{useAnnotationHighlight,useFreeTextResize,useAnnotationEditorBridge}.ts`, `edited-text-markup-canvas-suppression/`, `engine/text-markup-*/`, checked against `docs/architecture/freetext-note-persistence.md` |
| Sidebar / markers / note windows | `workspace-shell/annotations/`, `components/annotations/*.vue`, `usePdfAnnotationCommentModel.ts`, `usePdfAnnotationCommentActions.ts`, `useAnnotationMarkerViewModel.ts`, sidebar list component |

Three headline findings were re-verified directly against source during
synthesis (marked **[verified]**). Items an auditor could not fully close from
code are marked "verify". Nothing was fixed; this records state as of commit
`ab53d0a8f`. Paths below are relative to `app/modules/pdf-viewer/` unless a
longer prefix is shown.

---

## Executive summary

The architecture is unusually disciplined: one canonical `AnnotationStore`
owns all annotation state, persistence targets the PDF file itself (no sidecar
database, no migration problem), saves are frontier-fenced with CAS tokens and
byte-level verification, and undo history flows through a single injected
authority into one workspace-wide command ledger. Many classic failure modes —
duplicate shapes after save, deleted-shape resurrection, torn writes,
cross-pane clobbering — have explicit guards.

The real defects cluster in four places:

1. **Sidebar shape rows are broken end-to-end** — shape summaries never carry
   the field shape lookup matches on, so focusing/deleting a shape from the
   sidebar silently no-ops (**verified**).
2. **Undo interacts badly with save acknowledgement and page remapping** —
   redo after a save regresses materialized identity; page remaps are
   invisible to the stack, so undo can restore stale page indices
   (**verified**).
3. **Highlight creation reports success unconditionally** — `createdAnnotation`
   is hard-coded `true`; failures still tell callers an annotation was created
   (**verified**).
4. **A family of silent no-op paths**: empty-selection highlights, stale
   sidebar deletes, ghost shape rows, truncated background inventories — all
   fail without user-visible signal.

### Findings by severity

| # | Sev | Finding | Where |
|---|---|---|---|
| H1 | High | Sidebar shape focus/delete compares `comment.appAnnotationId`, which shape summaries never set → always misses | `tools/usePdfShapeTool.ts:118`; `engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary.ts:30-57` **[verified]** |
| H2 | High | Highlight creation success flag hard-coded `true`; failure paths still report "created" | `bridge/pdfjs-runtime/useAnnotationHighlight.ts:367,587-601` **[verified]** |
| M1 | Med-High | Redo after save replays pre-save snapshots, regressing `persistedRevision`/`pdfRef` → annotation flips back to dirty; next save can duplicate it | `domain/annotationStore.ts:721-748` (no history registration) vs `:870-880` **[verified]** |
| M2 | Med-High | `remapPages` writes no history entry; undo restores pre-remap `pageIndex`, can resurrect entities onto deleted pages | `domain/annotationStore.ts:618-657` vs replay at `:901-928` |
| M3 | Medium | Transient entities whose editor binding failed (12 retries ≈ 1 s) can never be tombstoned → permanent orphans in lists/saves | `domain/annotationStore.ts:583-601`; `bridge/pdfjs-runtime/useAnnotationHighlight.ts:565-584` |
| M4 | Medium | Import clamps off-page rect/circle geometry into `[0,1]`; with `rewriteShapeState` the clipped rect is written back → bounds destroyed across open→save | `engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.ts:307-309`; `normalizeMarkerRect.ts:16-21`; serialization applies clipped rect at `applyShapeAnnotations.ts:213-218` |
| M5 | Medium | Empty selection boxes (`[]`) pass the `!boxes` check → orphan zero-geometry entity, no feedback | `bridge/pdfjs-runtime/useAnnotationHighlight.ts:329-365` |
| M6 | Medium | Sink-mode `forgetCommands` wipes the whole `annotation` ledger source instead of filtering by id (local mode filters precisely) | `runtime/annotations/usePdfAppAnnotationHistory.ts:136-141` |
| M7 | Medium | Background inventory silently stops at 5 000 pages / 25 000 records; truncated snapshot gets cached with no log/status | `bridge/pdfjs-runtime/useAnnotationSync.ts:126-127,504-511,650-661` |
| M8 | Medium | Positional fallback ids (`pdf-{page}-{index}`) shift when earlier annotations change → duplicate sidebar entries, phantom entities | `engine/annotations/buildPdfAnnotationCommentSummary.ts:53-63` (via comment pipeline) |
| M9 | Medium | `status:'not-saved'` outcomes return `false` with no toast; some paths never set `state.error` either | `workspace-shell/composables/file-operations/useWorkspaceSaveService.ts:603-608,1080-1111`; `createDocumentPersistence.ts:531-534` |
| M10 | Medium | Save-finalize parses the entire saved PDF on the main thread (worker used everywhere else) — stalls renderer near the 96 MiB cap | `runtime/annotations/useManagedEmbeddedPdfShapes.ts:710-713` |
| M11 | Low-Med | Selection spanning two pages keeps only the start-page half, silently | `bridge/pdfjs-runtime/useAnnotationHighlight.ts:324-335`; `useAnnotationTextSelectionCache.ts:111-117` |
| L1 | Low | Session-exposed `undoAnnotation`/`redoAnnotation` bypass save/busy guards; mid-save undo trips CAS → spurious failed save | `runtime/sessions/createPdfAnnotationSession.ts:1019-1020`; `domain/annotationStore.ts:805-814` |
| L2 | Low | Blob documents with equal name+size share one store identity → previous entities survive into the new document | `runtime/sessions/createPdfAnnotationSession.ts:109-117` |
| L3 | Low | Dirty note-window draft edited during an in-flight save is never re-persisted | `useAnnotationNoteWindows.ts:386-388` |
| L4 | Low | `deleteAnnotationById` silently no-ops on stale ids | `app/modules/workspace-shell/annotations/deleteAnnotationById.ts:9-10` |
| L5 | Low | History byte budgets default 1 KiB per snapshot-heavy command; memory bounded by depth cap, not budget | `runtime/annotations/usePdfAppAnnotationHistory.ts:20,79-85` |
| L6 | Low | One history entry per committed keystroke floods the 128-deep stack | `createPdfAnnotationSession.ts:774-779` |
| L7 | Low | Exotic line-end styles degrade to none on import→save round-trip; stale `/IC` on updated Line dicts | `importEmbeddedShapeAnnotations.ts:213-225`; `applyShapeAnnotations.ts:71-83,156-163` |
| L8 | Low | Virtual list height contract (112 px) breaks under non-default root font scaling | sidebar `PdfAnnotationCommentsList.vue:216-223` vs `main.css:260-262` |

---

## Architecture overview

Single-authority design. `AnnotationStore`
(`annotations/domain/annotationStore.ts:98-1196`) holds private
`#entities: Map<AnnotationId, AnnotationEntity>` (line 99), an external-id
index (`externalIdentityIndex.ts:10-88`), a semantic saved baseline for dirty
tracking (lines 106, 768-773), and save frontiers used as CAS tokens
(659-816). Undo history is delegated to an injected authority (115-117). All
reads clone; every mutation emits cloned snapshots to subscribers
(1192-1195).

```
                ┌────────────────────────────────────────────────────┐
                │  AnnotationStore (#entities Map)  ← SOLE AUTHORITY │
                │  + ExternalIdentityIndex + savedSemanticSnapshot   │
                └───┬───────────────┬────────────────┬───────────────┘
    subscribe/project│               │frontier CAS    │ingest/reconcile
         (store.subscribe → projectCanonicalAnnotations,
          createPdfAnnotationSession.ts:291, 261-290)
            ▼                        ▼                 ▲
  annotationProjection      SaveFrontier+plan      useAnnotationSync
  (sidebar comment DTOs)    usePdfViewerSave       (pdf snapshot scan +
        │                   Transaction.ts:520     live editors) :907-963
        ▼                        ▼
  sidebar comments         bytes → verifySaveBytes/Path → atomicReplace
  (workspace shell)

Parallel live copies (synchronized, non-authoritative):
• pdf.js AnnotationStorage + editors ←→ facade onSetModified hook
  (bridge/pdfjsAnnotationFacade.ts:244-262 → notifyModified → scheduleSync)
• sharedPdfAnnotationSnapshots LRU ≤ 8 (module-global, useAnnotationSync.ts:128)
• sourcePdfAnnotationSnapshots WeakMap (useAnnotationSync.ts:129)
```

Persistence timing: **no periodic disk autosave**. The only debounce (140 ms,
`useAnnotationSync.ts:177`) synchronizes pdf.js → store in memory. Disk writes
happen via explicit save/save-as, implicit materialization saves (print at
`useWorkspaceOrchestration.ts:727-741`, split capture, page mutations,
page ops), shutdown flush (`useShutdownSaveFlushReporting.ts:60-85`), and the
pre-switch gate (`usePageFileOperations.ts:164-208`). Electron writes go
through sibling temp file + fsync + rename with a Windows backup dance
(`electron/utils/atomicReplace.ts:47-140`); no in-place overwrite of a live
working copy was found. Byte-route saves are verified before commit — the
produced bytes are re-opened with pdf.js (`annotationApplication.ts:504-521`)
or the staged path is range-read-verified with stat fencing (523-617).

Activation/restore: tab switch sets `isActive=false` → `invalidate('deactivated')`
(`pdfDocumentSession.ts:1053-1062`); the proxy is destroyed only by the next
load's cleanup. Reactivation of a still-loaded document emits `restore`
without reload (1071-1077), so unsaved edits survive. Dirty tabs are
save-protected from cold eviction (`resolveTabLifecycleStates.ts:37-44`).
Split panes clone the working copy per pane — no last-write-wins within a
session.

---

## Slice 1 — Store / persistence / session

### State ownership map

| Copy | Location | Synchronizer |
|---|---|---|
| Canonical entities | `annotationStore.ts:99` | authority |
| External id index | `externalIdentityIndex.ts:11-16` | rebuilt on `#replaceEntities` (`annotationStore.ts:919-928`) |
| Saved semantic baseline | `annotationStore.ts:106` | rebased on `acknowledgeSave` (750), `adoptEntitiesAsSavedBaseline` (754-765), page remap (626-632) |
| pdf.js storage + editors | pdf.js internals | inbound intent sinks create entities then bind editors (`createPdfAnnotationSession.ts:535-636`); outbound `onSetModified` chain + 140 ms debounced sync (`useAnnotationSync.ts:176-181,1065-1087`) |
| Comment projection | `annotationProjection` ref (`createPdfAnnotationSession.ts:240,263`) | refreshed synchronously on every store emission (261-290) |
| Sidebar comments | workspace ref | `emitCommentsForSidebar` (`createPdfAnnotationSession.ts:289`) |
| Shared snapshot LRU | `useAnnotationSync.ts:125-157` | keyed `[identity, revisionToken, pageCount]`; handed out as `structuredClone` copies |
| Live-change fingerprint | `useWorkspaceAnnotationSession.ts:80-118` | captured at `markAnnotationSaved` (139-143), compared inside save transactions |

Load path: full-document pdf.js scan in visible-page-first order merged with
live editors for all pages (`useAnnotationSync.ts:221-233,500-549,710-743`).
Per-page parse failures are swallowed to debug logs
(`loadPdfPageAnnotations.ts:149-155`) — that page's annotations silently
missing until the next successful sync. IDs derive deterministically
(`deriveAnnotationId(documentKey, identity)`, `annotationApplication.ts:127-132`);
ambiguous legacy identities block saving outright (`ExternalIdentityConflictError`,
458-461).

### Confirmed defects

**M7 — Silent background inventory truncation (Medium).**
`useAnnotationSync.ts:126-127,504-511`:

```ts
const MAX_BACKGROUND_PDF_ANNOTATION_PAGES = 5_000;
const MAX_BACKGROUND_PDF_ANNOTATION_RECORDS = 25_000;
...
if (completedPages >= MAX_BACKGROUND_PDF_ANNOTATION_PAGES
    || comments.length + links.length >= MAX_BACKGROUND_PDF_ANNOTATION_RECORDS) {
    break;                       // ← no log, no status flag
```

The per-page cap warns (`loadPdfPageAnnotations.ts:122-131`) but global caps
break silently, and the truncated snapshot is cached locally and in the shared
LRU (`shouldCachePdfAnnotationSnapshot` 650-661), so later syncs keep serving
the incomplete inventory until the revision token changes. Pages beyond the cap
never appear in sidebar/history, with zero diagnostic signal.

**M8 — Positional fallback ids drift (Medium).**
Comment-summary builder:

```ts
const id = annotation.id ?? `pdf-${pageNumber}-${annotationIndex}`;
```

`annotationIndex` is array position from `page.getAnnotations()` at scan time.
Any edit that adds/removes an earlier annotation on the page shifts positions
between scans → new stableKey → new derived canonical id for the same physical
annotation. Duplicate sidebar entries, lost active-comment binding, phantom
"new" entity. Affects documents whose annotations lack `/ID`.

**M9 — `not-saved` outcomes bypass error reporting (Medium).**
When a plan executes but reports not-saved (validation invalid, stale target,
capability-missing native decline), `save()` returns false without toast —
the toast lives only in the `catch` branch (`useWorkspaceSaveService.ts:1080-1111`);
some paths never set `state.error` (`createDocumentPersistence.ts:531-534,609-611,659-661`).
User's only signal is the persistent dirty dot.

**L2 — Blob identity collision (Low-Medium).**

```ts
// createPdfAnnotationSession.ts:109-117
if (source instanceof Blob) {
    return `blob:${'name' in source ? String(source.name) : 'unnamed'}:${source.size}`;
}
```

Two different blobs with equal name+size yield one store identity; the watch
sees no change so previous canonical entities survive into the new document.
The adjacent snapshot identity deliberately avoids this with a WeakMap instance
id (119-131) — the store path did not get the same treatment. Reachable only
for blob-sourced opens with no original/working-copy path.

### Risks needing verification

- **Overlapping save transactions outside the single-flight**: print calls
  `runSaveTransaction({mode:'print'})` directly (`useWorkspaceOrchestration.ts:727-741`)
  with no lease acquisition observed; two overlapping transactions could each
  freeze a frontier containing the same pending entity, because frontier
  baselines cover only `{id, revision, deleted, pageIndex}` (`annotationEntity.ts:164-171`)
  and `acknowledgeSave` doesn't bump revisions. CAS would still pass; possible
  double-append. Needs interleaving proof.
- **Event-guard breadth**: `shouldIgnoreEditorEvent.ts:51-64` suppresses
  manager keydown/copy/cut/paste whenever any non-collapsed selection touches
  the text layer — pdf.js-manager shortcuts (Delete-to-remove-editor) go dead
  during text selection, with no app-level equivalent found. Undo itself is
  safe (workspace accelerator routes around it). Unit matrix pinned in
  `useAnnotationEditorBridge.test.ts:248-284`.
- **`reconcileEditorPresence` lacks its sibling's observed-transient guard**:
  `annotationStore.ts:554-578` tombstones any non-shape transient absent from
  `presentExternalIds`, whereas `reconcileObservedTransients` (588-616)
  requires prior observation. Safe today only because callers enumerate every
  page holding entities (`createPdfAnnotationSession.ts:708-720`); breaks the
  moment a caller passes a partial set.
- **Cross-window writes to the same original path**: each window CAS-fences
  only its own working-copy revision; two windows saving the same original
  have last-writer-wins with no conflict prompt.
- **Full-bytes reopen verification doubles peak memory briefly** on the byte
  route for ~60 MiB docs (`verifySaveBytes`, `annotationApplication.ts:509-521`),
  mitigated by the >64 MiB block (`useWorkspaceSaveService.ts:51,507-533`).
- **Sidebar order instability (cosmetic)**: summaries ordered visible-page-first
  (`useAnnotationSync.ts:221-233,852-857`), so ordering shifts as pages change.

### Coverage notes

Well covered: store/frontier semantics, application ingest/verify, backend
conformance, transaction fencing, sync caching/staleness, event-guard matrix,
persistence/save service, e2e pipelines (`savePipeline.e2e`,
`largePdfAnnotationSave.e2e`, `annotationLifecycle.e2e`). Gaps: overlapping
direct-caller transactions; unsaved-edit survival across `deactivated → restore`
at session level; global inventory caps; positional-id drift; blob identity
collision; no production caller exercises `rollbackSave` for non-shape
entities (`annotationApplication.ts:759-761`), leaving that invariant unpinned.

---

## Slice 2 — Undo–redo stack

### Architecture

Three tiers, one authority chain:

1. **Canonical store + injected authority** — every authored mutation goes
   through `#commit`/`#commitBatch` (`annotationStore.ts:864-900`): apply the
   entity change first, then register a paired `{cmd, undo}` closure over
   *absolute before/after snapshots* (875-880). A per-replay failure rollback
   hook is registered mid-effect (`#applyHistoryEntries`, 901-918).
2. **Engine contract** — `{cmd, undo, estimatedBytes?, annotationIds?}` with
   poisoning errors in
   `engine/annotations/annotation-history/pdfAppAnnotationHistoryCommand.ts:3-45`.
   The default two-stack authority (77-125) is never used in production; a
   runtime adapter is injected (`createPdfAnnotationSession.ts:173-183`).
3. **Composable + workspace ledger** — local stacks capped at 128 depth /
   16 MiB (`usePdfAppAnnotationHistory.ts:17-20,78-91`) with atomic
   transactions (147-225). With a workspace sink attached, pushes forward to
   one workspace ledger interleaving file/metadata/annotation commands,
   truncating redo ahead of the index on new commands
   (`useWorkspaceCommandLedger.ts:40-56`).

**Routing**: window-level capture of Cmd/Ctrl+Z (+Shift), Ctrl+Y → active
workspace expose → blocked while saving or busy
(`runtime/composables/usePdfHistory.ts:93-124`) → ledger. Toolbar buttons
disabled on the same flags (`components/PdfToolbar.vue:81-100`). pdf.js
interop: `uiManager.addCommands` is mirrored into app history unless flagged
`__evbSkipAppHistory` or a replay is in flight
(`bridge/pdfjs-runtime/useAnnotationEditorBridge.ts:670-690`);
`uiManager.undo()/redo()` are rerouted to the app stack when not already
routing (709-729), so pdf.js's own history is never driven from user input.
After each replay, `finishReplay` reconciles editor presence against the store
and schedules comment re-sync (`createPdfAnnotationSession.ts:705-727`).

**Save frontiers as CAS**: `beginSave` freezes epoch + baseline hash +
per-entity revisions (`annotationStore.ts:659-672`);
`assertSaveFrontierCurrent` rejects drift of captured entities and newly
created unsaved entities while tolerating identity bindings and late imports
(781-816); `acknowledgeSave` advances `persistedRevision`/`pdfRef` and resets
the semantic baseline (721-752). Dirty tracking uses a separate semantic
fingerprint snapshot (768-773), not the undo stack.

### Command producers inventory

| Producer | Trigger | Push timing | Failure path |
|---|---|---|---|
| Store `#commit`: create sticky/markup/shape, `setNoteText`, `setStyle`, `moveAnchor`, `delete` | intent sinks (`createPdfAnnotationSession.ts:535-636`), mutation service (774-804), shape tool | applied synchronously, registered immediately | rollback hook restores entities + epoch on replay failure (905-916); poison clears both stacks |
| Store `#commitBatch`: `applyTextMarkupSelection` | highlight intent (561-576) | one batched entry, reverse-order undo | atomic compensation of children |
| `replaceShapeGeometry` | end of drag/resize (`tools/usePdfShapeContext.ts:230-299`) | once per gesture after commit; fabricated `before.revision = max(0, rev-1)` (272-297) | as `#commit` |
| Mutation service `updateComment` / `deleteAnnotation` / `updateColor` / `moveMarker` | sidebar / note-window / context menu | wrapped in `runHistoryTransaction`; pdf.js effects join later (`useAnnotationMutationService.ts:105-151,230-260`) | pdf.js delete errors swallowed — tombstone stays authoritative (134-136) |
| `recordPdfjsExecutorCommand` mirrors | any pdf.js internal command | registered right after pdf.js executes the original (`useAnnotationEditorBridge.ts:670-690`) | replay throw → indeterminate → poison (179-193) |
| Created-highlight undo pair | new Highlight editor reaching storage | **not pushed to the app stack**; installed on the pdf.js layer only with `skipAppHistory:true` (`annotationEditorAdapter.ts:415-452`; deferral at `createPdfAnnotationSession.ts:650`) | not compensated by app history |
| Free-text resize snapshots | resize gesture end (`bridge/pdfjs-runtime/useFreeTextResize.ts:411-437`) | after commit; editor resolved by key at replay; silent no-op if gone | no rollback; throw poisons |

Revert semantics are inverse replays of absolute entity snapshots via
`#replaceEntities`: restores store + external index atomically; sidebar
projection rebuilds from the post-replay emission. **pdf.js DOM editors are
only partially guaranteed**: executor-mirrored commands replay their closures,
but canonical-only commands (intent-sink creates, note text, canonical color,
tombstones) don't touch editors, and presence reconciliation flows DOM→store
only (`annotationStore.ts:546-616`), never store→DOM.

### Confirmed defects

**M1 — Redo after save regresses materialized identity (Med-High). [verified]**
`acknowledgeSave` mutates entities (adds `persistedRevision`, binds
materialized `pdfRef`, resets baseline) without registering history
(`annotationStore.ts:721-748`), while older commands hold pre-save snapshots:

```ts
// annotationStore.ts:870-880
apply(entry.after);
this.#history.registerCommand({
    cmd: register => apply(entry.after, register),
    undo: register => apply(entry.before, register),
```

Sequence *edit E → save → undo E → redo E* replays the pre-save clone,
regressing to `persistedRevision:-1` and dropping the bound `pdfRef` even
though the saved file contains the annotation. It flips back to unsaved; the
next save can rewrite/duplicate it because delete/move verification keys off
`pdfRef`. No test asserts identity fields across this flow — existing e2e
checks counts/dirty bits only
(`tests/e2e/electron/annotationLifecycle.e2e.test.ts:1499-1528`).

**M2 — Page remaps invisible to undo (Med-High).**
`remapPages` renumbers/tombstones entities and remaps the baseline but touches
neither stack nor entries (`annotationStore.ts:618-657`). Undo entries retain
pre-remap snapshots; wholesale replay (924-927) overwrites remapped
`pageIndex`/tombstones with stale values. Scenario: move/delete/rotate pages,
then undo an earlier annotation edit → the annotation jumps back to its old
page or reappears on a page index that no longer exists.

**M6 — Sink-mode `forgetCommands` over-prunes (Medium).**

```ts
// usePdfAppAnnotationHistory.ts:136-141
if (workspaceCommandSink) {
    workspaceCommandSink.reset('annotation');
} else {
    undoStack.splice(0, undoStack.length, ...undoStack.filter(keep));
```

The local branch filters precisely by id; the sink branch prunes *every*
`source:'annotation'` ledger entry (`useWorkspaceCommandLedger.ts:62-99`).
Hard-forgetting one replaced shape erases undoability of unrelated sticky-note
and highlight edits in the same session.

**L1 — Direct `undoAnnotation` expose bypasses guards (Low).**
Session exposes raw history calls (`createPdfAnnotationSession.ts:1019-1020`)
into the viewer API without the `isAnySaving`/busy gating all UI routes
enforce. Undo mid-save changes revisions captured in the frozen frontier,
tripping CAS (`annotationStore.ts:805-814`) — fail-safe (save aborts) but
surfaces as a spurious failed save. Revert does not trim frozen frontiers;
they simply fail CAS on replay.

**L5 — Byte budgets underestimate snapshots (Low).**
Snapshot commands rarely set `estimatedBytes`, defaulting to 1 KiB
(`usePdfAppAnnotationHistory.ts:20,79-85`; ledger default 17), yet each entry
holds structured clones of full entities including shape geometry. Real memory
is bounded by the 128-depth cap, not the 16/32 MiB budgets.

**L6 — Keystroke-per-entry flooding (Low).**
Note-text editing registers one entry per committed edit; nothing coalesces
successive text edits, only exact no-ops are skipped
(`createPdfAnnotationSession.ts:774-779`). Long typing sessions evict older,
unrelated entries from the capped stack.

### Risks needing verification

- **Orphan editor after undoing a create**: for toolbar highlights the pdf.js
  undo pair is deliberately kept off the app stack (`skipAppHistory:true`),
  so canonical undo removes the entity but not necessarily the editor DOM;
  presence reconciliation flows DOM→store only. No mechanism removing the
  orphaned editor was found in the audited files, yet e2e asserts editor
  counts drop after such undos — either a removal mechanism exists outside the
  read set or e2e passes via re-ingest masking identity churn. Needs a targeted
  trace/test.
- **Ghost commands from retired stores**: identity-change resets swap the
  store without clearing shared history itself; clearing relies on proxy-swap
  watchers gated on `!isAnySaving` (`createPdfAnnotationSession.ts:304-332,914-935`).
  An identity change during a save window can leave old-store commands in the
  shared ledger; replaying them mutates an orphaned store.
- **pdf.js internal stack grows unboundedly**: user routes are diverted and
  mirrored replays invoke recorded closures rather than popping pdf.js's stack;
  accumulation persists until uiManager destruction on document swap.
- **Async transaction capture window**: while an async delete awaits pdf.js,
  concurrently registered commands join the transaction and are undone/redone
  atomically with it.
- **Rapid double Cmd+Z** is safe on UI paths (busy latches); the direct expose
  path has no busy latch but replays are synchronous today.
- **`previewShapeGeometry` bumps revision every pointer-move frame**
  (`annotationStore.ts:300-312`): any mid-drag frontier is stale by
  construction — fail-safe, but guarantees a save abort if started during a drag.

### Coverage notes

Strong unit coverage of composable mechanics (poisoning, transactions,
compensation, ledger integration, trimming:
`usePdfAppAnnotationHistory.test.ts`, 763 lines / 20 cases), routing guards,
ledger ordering/pruning, store frontier/baseline tests, and e2e for draw
undo after save, note-undo preserving highlight, highlight coherence across
saves, undo of saved delete restoring persisted highlight. Gaps: no test for
undo×`remapPages` (M2); none for redo-after-save identity regression (M1);
none pinning sink-vs-local `forgetCommands` divergence (M6); none for the
direct-expose undo during saves (L1); no fast unit pinning orphan-editor
removal; no coalescing/eviction test for long typing sessions.

---

## Slice 3 — Shapes / drawing / removal

### Architecture

Canonical state lives in `AnnotationStore`; shapes carry
`identity{id,pdfRef,pdfName,pdfjsUid,elementId}` and are excluded from pdf.js
editor presence reconciliation (`annotationStore.ts:556-557,590-596`) and from
FreeText identity binding. Drawing UI is a per-page SVG overlay
(`PdfShapeOverlay` mounted by `components/PdfViewerPage.vue:46-68`); intents
flow overlay → `tools/usePdfShapeContext.ts:157-304` →
`tools/useAnnotationShapes.ts` (transient draft) → `tools/usePdfShapeTool.ts:41-79`
→ store. Embedded import runs in a worker via full-document pdf-lib parse
(`importEmbeddedShapeAnnotations.ts`, size-capped at 96 MiB), orchestrated by
`runtime/annotations/useManagedEmbeddedPdfShapes.ts` with a module-level LRU
promise cache (`embeddedShapeImportCache.ts`). Removal is tombstone-driven:
native-DOM suppression, targeted node removal, and canvas repaint queues.
Serialization flows through the save transaction's `rewriteShapeState` gate
into `engine/serialization/pdf-serialization-shape-annotations/applyShapeAnnotations.ts`.

### End-to-end draw flow

1. Pointer → normalized coords via `(clientX-rect.left)/rect.width`, clamped
   to [0,1] (`getNormalizedSvgPointerCoords.ts:4-19`,
   `usePdfShapeOverlayInteractions.ts:90-99`). Marker space is the rendered
   page: top-left origin, y-down, scale-invariant — zoom never enters the math;
   stroke widths compensated separately.
2. Intent: mint id, `stableKey='evb-shape:'+UUID`
   (`generateManagedShapeStableKey.ts:5-7`), style from settings,
   `pdfSubtype:'Ink'` for the draw tool, arrow default `closedArrow`.
3. Draft updates append deduped points (< 0.001 spacing); bounds recomputed;
   commit rejects sub-minimum shapes (< 0.005).
4. Live render draws the same normalized numbers; drag/resize previews bypass
   history via `previewShapeGeometry` (`annotationStore.ts:300-312`) and commit
   once per gesture via `replaceShapeGeometry` with pre-drag undo target (272-297).
5. Persist: y-flip `1-markerY` plus 90/180/270 permutations forward
   (`toPdfPointFromMarkerPoint.ts:38-53`), exact inverse on read
   (`toMarkerRectFromPdfRect.ts:42-66`), page view = crop∩media box
   (`packages/pdf-core/pdfPageBoxes.ts:113-125`), rotations snap to multiples
   of 90. Ink gets a generated normal appearance stream with ExtGState opacity
   and round caps (`applyInkAnnotationAppearance.ts:29-107`).

### Identity & import cache

Three-layer identity: `/EVBShapeKey` + `/NM` both carry the stable key; refs
format `N R`; imported ids are `embedded-shape:{pageIndex}:{key|ref|subtype:uuid}`;
canonical ids derive from documentKey + (ref ?? stableKey ?? elementId)
(`annotationApplication.ts:288-296`). Re-import matching prefers stable key →
normalized ref → exact geometry JSON (`shapeAnnotationIdentity.ts:66-88`), so
object renumbering on save does not duplicate shapes as long as keys persist.
Post-save `preparePersistedManagedShapesForSave` releases all persisted refs
then rebinds from scanned bytes — explicitly guarding the stale-ref hazard
where a deleted shape's number could be taken by a survivor
(`annotationStore.ts:948-994`). Import cache keys include revision tokens,
results are cloned per reader, in-flight entries abort when their last
subscriber detaches.

### Deletion pipeline

- Keyboard/context menu → `deleteShapeById`: refuses during saves, idempotent
  guard, canonical tombstone (undoable), fires deleted-shape handler
  (`usePageShortcuts.ts:103-111` → `usePdfSelectedShapeCommands.ts:84-91` →
  `usePdfShapeTool.ts:72-79`).
- Sidebar/by-id deletes serialize through one queue
  (`createPageAnnotationDeleteActions.ts:145-150`); shape summaries route to
  the viewer's shape branch.
- Deferred/embedded variant resolves the canonical id first, tombstones it,
  then attempts backend deletion with errors swallowed — "canonical tombstone
  and removal effect remain authoritative" (`useAnnotationMutationService.ts:116-140`),
  then enqueues deduped DOM-removal effects (194-215).
- Unsaved-only shapes: tombstoned identically; serialization simply never
  writes them; `markShapesSaved` forgets tombstones post-success.
- Imported shapes with refs: tombstones surface as deleted-id/stable-key sets
  consumed three ways — immediate DOM removal + repaint, render suppression
  sets, and hard PDF deletion at save by ref OR stable key, plus GC of any
  EVB-keyed annotation unmatched under rewrite. When the layer is unscannable
  (>96 MiB), rewrite is force-disabled so unseen managed shapes survive;
  deletes then depend solely on tombstone lists, which persist until
  acknowledged — no resurrection found anywhere.
- Comment-linked shapes: shapes have no independent note thread; the sidebar
  entry *is* the projection.

### Serialization fidelity

Type coverage: rectangle↔Square, circle↔Circle, line/arrow↔Line (`/L`+`/LE`),
polyline↔PolyLine, polygon↔Polygon, ink↔InkList+AP. Update-vs-create dispatch
by the *existing* dict subtype, so subtype is preserved in place. Ink
appearance is regenerated on create and update with correct BBox inflation.
Import accepts gray/RGB/CMYK (CMYK via deterministic lossy approximation);
border prefers `/Border[2]` then `/BS/W`; opacity clamped. Tests assert
CMYK→`#808080` and strokeWidth-0 survival through save/reopen
(`tests/unit/app/composables/pdfSerializationOperations.test.ts:324-372`).
Leftover unconvertible shapes make the whole save throw rather than silently
drop.

### Confirmed defects

**H1 — Sidebar shape focus/delete is dead code (High). [verified]**

```ts
// tools/usePdfShapeTool.ts:114-122
const annotationId = comment.appAnnotationId;
return shapeComposable.getAllShapes().find(shape => (
    options.annotationApplication.value.annotationIdForShape(shape) === annotationId
)) ?? null;
```

`toShapeAnnotationCommentSummary` sets `id/annotationId/source` but **no
`appAnnotationId`** (verified: `toShapeAnnotationCommentSummary.ts:30-57`;
repo-wide grep shows `appAnnotationId` populated only for editor/pdf-sourced
summaries). Strict `===` against `undefined` can only match a shape whose
canonical resolution also returns undefined — i.e. never the intended shape,
possibly an arbitrary unresolved one. Sidebar shape delete/focus therefore
fails silently end-to-end unless summaries are enriched somewhere not found
during two independent full reads. Regression test needed either way.

**M4 — Import clamping truncates off-page geometry (Medium).**

```ts
// importEmbeddedShapeAnnotations.ts:307-309
const markerRect = normalizeMarkerRect(
    toMarkerRectFromPdfRect(readPdfRectFromDict(dict), pageView, pageRotation),
);
```

`normalizeMarkerRect` clamps into [0,1]; with `rewriteShapeState=true` the
clipped rect is written back on save — a Square straddling the trim box shrinks
after open→save. Ink/polyline points are *not* clamped, so behavior is
type-dependent.

**M10 — Main-thread full-document parse at save finalize (Medium).**
`useManagedEmbeddedPdfShapes.ts:710-713` dynamically imports the direct parser
(not the worker client used everywhere else) and parses the entire saved PDF on
the UI thread during `primePersistedShapes`. Near the 96 MiB cap this stalls
the renderer on every save finalize; correctness unaffected.

**L7 — Line-end fidelity loss (Low).**
Anything outside Open/ClosedArrow/None maps to undefined on import and
collapses to none / plain line on write, deleting `/LE`; stale `/IC` remains
when updating embedded Line dicts (non-standard, cosmetic).

**L4 — Silent no-op deletes by id (Low).**

```ts
// workspace-shell/annotations/deleteAnnotationById.ts:9-10
const comment = comments.find(c => annotationIdForSummary(c) === annotationId);
if (comment) void remove(comment);
```

Stale sidebar/note-window snapshots yield neither action nor feedback;
contrast with the instrumented failure path in
`createPageAnnotationDeleteActions.ts:88-97`.

**Ambiguous deletes refused quietly (Low).**
`resolveCommentForDelete` returns null unless exactly one candidate matches;
safe-by-default but produces undeletable ghost entries surfaced only as a
generic error.

### Risks needing verification

- Import cache vs page ops: cache keys include revision tokens and reads
  assert them, but whether *every* rotate/delete-page op bumps the token was
  not confirmed. If one doesn't, a stale scan could replay wrong pageIndexes.
- Degenerate live shapes from resize: if resize permits zero-area bounds,
  update returns false, the shape stays unconverted, and the whole save throws
  "annotation geometry is invalid". Draw/import enforce minima; resize floor
  enforcement unaudited.
- Stable-key stripping by third-party tools causes forget-and-reimport
  (history/comment linkage reset) because the geometry fallback includes the
  stable key.
- Rotated pages with offset boxes: transform parity between pdf-lib box
  resolution and pdf.js view construction assumed; needs a `/Rotate 90` +
  offset-CropBox fixture.
- Worker 90 s timeout turns slow-but-valid parses of huge documents into
  failures; session continues additive-only — confirm UX messaging covers it.
- Unaudited remainders: `PdfShapeOverlay.vue` internals/viewBox parity,
  text-markup color-sampling modules (~1 200 lines), `findShapeAtPoint`
  hit-testing.

### Coverage notes

Anchors: serialization operations tests (embedded-shape save/reopen, key
backfill, in-place update + delete-by-ref, polygon append, page-missing
failure), import/worker tests, managed-shapes tests (16), DOM-removal tests
(31), identity tests. Gaps: detached-marker geometry math untested; no
round-trip test for off-page or rotated-page shapes; no line-end coverage
beyond arrows; cache tests thin relative to the machinery (LRU order,
subscriber abort, revision rotation, clone isolation); no delete→save→reopen
integration proving no duplicates through ref-release priming; no test that
shape summaries reach `findShapeForAnnotationComment` successfully (H1).

---

## Slice 4 — Text markup / FreeText

### Architecture

Three layers: canonical store/application; pdf.js-private executors under
`bridge/pdfjs-runtime/`; a presentation controller that repaints edited markup
over suppressed native canvas paint. Creation is intent-first: the store
entity is minted before any pdf.js editor exists, then bound via
`bindProjectedEditorIdentity`. Persistence follows
`docs/architecture/freetext-note-persistence.md` exactly (verified: blank AP + rect rewrite
runs before embedded text updates at `serializePdfEdits.ts:102-104`;
`updateAnnotationTextByRef` writes `/Contents` citing the blank AP; the
0.02 inclusive marker boundary and ZWS/BOM stripping match the doc's rationale
sections).

### Creation flows

Highlight: pointer-up → live selection or cached range restored into the DOM →
`uiManager.getSelectionBoxes(textLayer)` per-line page-unit rects →
`submitSelectionMarkupIntent` mints entity + overlap replacements in the store
*before* an editor exists → synthetic pointer creates the editor → binding via
`canonicalAnnotationId` + `bindProjectedEditorIdentity`, with 12×80 ms retry on
failure. Sticky note: `submitStickyNoteIntent` first, then FREETEXT editor with
ZWS keep-alive and min-size enforcement. Line-wrap geometry: one box per line
from pdf.js, normalized per line by tolerance 0.35·height; persisted-side quad
normalization mirrors this in PDF space.

### Editing/resize

Font-vs-box scaling captured as ratio at rest; during drag font clamps to
[8,96] px applied via `--total-scale-factor` so zoom stays consistent;
external font-size changes reset inline dimensions so the box re-fits text.
Post-resize sync distinguishes resize-driven font writes from toolbar ones and
registers undo snapshots per gesture. NaN position/dimension recovery from
DOM. IME/composition is protected indirectly: editor-event guards ignore
keydown/copy/cut/paste targeting contenteditable/text-layer/note-window, so
native composition proceeds unmolested.

### Suppression mechanism

Edited markup (`colorEdited`) ids merge with hidden embedded-shape ids and are
fed to canvas render as `hiddenAnnotationIds`, so native markup never bakes
into rasters or thumbnails; replacement visuals are drawn via multiply-composite
highlight or vector strokes. Cleanup restores flags on color undo; presentation
repair stops when pages resolve or the viewer deactivates. The flag can stick
for a whole session after a save rewrites `/C` in the file (visually benign —
overlay color equals rewritten native color) and clears on document reload.

### Confirmed defects

**H2 — Success flag hard-coded (High). [verified]**

```ts
// useAnnotationHighlight.ts:367
const createdAnnotation = true;
```

A thrown mode-switch or editor failure still reaches
`if (createdAnnotation) toolManager.maybeAutoResetAnnotationTool()` and returns
true; callers (agent/UI) learn "created" for an annotation that does not exist.

**M5 — Empty selection boxes create orphan entities (Medium).**
Only `null` boxes are rejected; an empty array sails into
`submitSelectionMarkupIntent` minting a text-markup entity whose markerRect is
`geometry[0] ?? null`. Combined with H2 there is no user feedback.

**M3 — Failed bindings can never be tombstoned (Medium).**
`reconcileObservedTransients` kills only transients previously *observed
present* (`annotationStore.ts:583-601`); `reconcileEditorPresence` matches only
external bindings, which intent-first entities lack until binding succeeds.
If all 12 bind retries fail (~1 s), the orphan persists indefinitely in lists
and saves.

**M11 — Cross-page selections drop the second page silently (Low-Med).**
The text layer resolves from `startContainer`; boxes and pageNumber derive from
that single layer, so the second-page half of a spanning selection disappears
without notice.

**Cached-selection restore falls through to live selection (Low).**
Cache is TTL-only (3 000 ms) with no invalidation on scroll/zoom/page-unmount;
stale Range nodes make restore throw (swallowed), after which boxes read
whatever the live selection is — usually null (safe), occasionally mismatched
if the user reselected mid-action.

### Risks needing verification

- Multi-column selections: same-row grouping merges across columns; shared
  lineTop/lineBottom stretching could fatten highlight quads when adjacent
  columns have offset baselines.
- RTL relies entirely on pdf.js box geometry; app-side ordering assumes LTR.
  Needs an RTL fixture test.
- Canvas pixel sampling assumes linear backing-store mapping; CSS transforms
  during zoom animations would skew it. Multiply composite assumes white pages
  — wrong under dark-theme page tinting if present.
- Presentation repair ladder caps at ~1.55 s / 5 attempts; a slower device
  could end with a permanently missing overlay until the next signal.
- No dedicated rotation watch; correctness depends on every rotation path
  emitting layer-committed events.

### Coverage notes

`useAnnotationHighlight.test.ts` covers page-target resolution, sticky-note
editor reuse, cross-viewer clearing, undo registration — but nothing for
line-wrap/RTL/multi-column/cross-page/zero-length selection, nor H2/M5
behavior (both would pass current suites). Orphan-transient lifecycle for
failed bindings untested. FreeText resize tests skip the 8-96 px clamp
boundaries and ratio-drift guard. No IME/composition or newline/unicode
round-trip tests anywhere. `textMarkupVisualModel.test.ts` is a single
happy-path case; canvas-pixels modules have no direct unit tests.

---

## Slice 5 — Sidebar / markers / note windows

### Architecture

Store commit → `projectCanonicalAnnotations` → immutable projection →
`emitCommentsForSidebar` → workspace `annotationComments` ref → sidebar list
(`PdfAnnotationCommentsList.vue` inside `PdfAnnotationsPanel.vue`, wired via
`PdfSidebar.vue:12-27`). Ordering is deterministic:
pageIndex → createdAt → sortIndex → stableKey; shape summaries carry sortIndex.
The panel stays mounted (v-show) so rows update reactively; empty states gate
on loading vs ready status; a stale-wipe guard drops empty payloads during
loading+search.

Note windows are a separate shell subsystem: `useAnnotationNoteWindows` holds
open-note state; overlays render windows plus minimized anchors/connectors.
Markers are a viewer-side view model teleported per page into
`.page_container[data-page=N]`.

### Focus/navigation

Row click → active key set + sidebar forced open → viewer focus action: shape-
sourced rows go through the (broken, H1) shape lookup; editor-sourced rows
clamp page numbers, scroll to marker center with clamped bounds, force-render
lazy target pages (`bufferOverride: 0`) before pulsing markers by stable key.
Deleted-concurrent targets still scroll to the page; pulse finds no element
and does nothing — acceptable degradation, no "no longer exists" signal.

### Marker layer

Percent-based positioning from normalized rects — zoom-invariant; layer is
pointer-events:none with buttons re-enabling hits. Overlap handling is
two-tier: clustering by IoU ≥ 0.22 or center distance ≤ 0.028 with count
badges, then 17 px offsets converted to percent for unclustered collisions.
Dragging commits normalized coords relative to page rect via pointer capture;
rotation goes through page ops/re-render, not CSS, so coordinates stay valid.
Marker eligibility requires hasNote plus point-like rect for FreeText — plain
highlights intentionally get no markers.

### Note window lifecycle

Open re-un-minimizes existing windows and bumps z-order; new windows cycle
five lane positions (the sixth overlaps the first exactly). Text commits emit
→ draft set → dirty computed vs canonical → **220 ms debounced** persist →
viewer controller → mutation service wrapped in a history transaction.
Blur merely re-emits text; minimize keeps drafts alive; ghost protection
closes windows whose entity vanished unless dirty, with a 5 s grace from
creation. Multi-open fully supported; beyond 8 windows z-order slots clamp
and share the top slot. Initial focus uses double nextTick + one rAF repair,
explicitly guarded so user Tab/click wins.

### CRUD consistency

| Action | Path | Undoable |
|---|---|---|
| Note text edit | `updateComment` → history transaction → `store.setNoteText` | Yes |
| Delete (sidebar/context/trash) | transaction → tombstone | Yes |
| Color change | transaction → `setStyle` | Yes |
| Marker move | transaction → `moveAnchor` | Yes |
| Shape create/update/delete | registered commands | Yes |

Bypasses/inconsistencies: legacy grace hooks are dead no-op stubs making a
branch in the comment-actions delete path unreachable; the deferred embedded
delete writes only the canonical tombstone *without* an explicit
`runHistoryTransaction` wrapper at its call site — whether it yields a
reversible history entry depends on store internals (**verify**, cross-ref
Slice 2 inventory where the sibling `deleteAnnotation` *is* wrapped).

### Confirmed defects

**H1 (sidebar side) — Ghost shape rows (High, same root cause as Slice 3).**
`usePdfAnnotationCommentActions.ts:55-57` returns early when the shape lookup
misses — no active key, no scroll, no feedback. Scenario: undo a shape
creation in another pane, immediately click its old sidebar row.

**L4 (note-window side) — Delete button silent no-op.**
The note window can outlive its projection entry (5 s grace / dirty guard);
trash click looks up the *current* projection, misses, and does nothing.

**L3 — Dirty draft never re-persisted after in-flight save (Low).**

```ts
// useAnnotationNoteWindows.ts:386-388
if (metadata.saving) {
    return false;
}
```

A draft edited during a save stays dirty with nothing rescheduled; it reaches
disk only at the next document save/persist-all.

**Dead option + dead code (Low).**
`isAnySaving` is declared in the comment-model options interface and never
read; grace-preservation hooks are unreachable stubs.

**L8 — Virtualization height contract breaks under font scaling (Low).**
Fixed `itemHeight: 112` vs rem-based row height (`6.5rem` + margin); non-default
root font sizes cause overlapping/gapped rows.

### Risks needing verification

- **IME mid-composition persist**: the 220 ms debounce has no compositionstart/
  end guard; partial CJK romanization can land in the canonical store and bump
  modifiedAt.
- Deferred embedded delete undoability (see CRUD table note).
- Duplicate sidebar rows if embedded-shape subtype classification misses the
  suppression set.
- Imported pop-up notes project as `subtype:'FreeText'`; kind labels for
  PDF-native `/Text` notes need verification ("Inline Note" fallback).
- Detached-marker offsets bake against the then-current viewport and don't
  re-resolve on resize until the next recompute trigger.
- Marker-move cache matching drops moves for summaries lacking an app id.

### Coverage notes

Solid unit coverage for note windows (24 scenarios incl. grace/dirty races),
annotation tools state, marker view model, color commands, crud-delete, sync;
e2e covers sticky-note create/edit/marker-drag/undo/delete. Gaps: zero tests
for the list component (search filter incl. `p{N}` tokens, highlight splitting,
empty/loading gating, virtualization math), the note window component (drag
clamping, resize observer loop, focus repair, IME), overlay runtime geometry,
marker drag-commit normalization or cluster badges, delete-action queues and
failure surfacing, `deleteAnnotationById` (the silent-miss bug). Locale parity
verified only for one `noteWindow` key across nine locales, not the full
annotations/contextMenu surface; icon registration is build-enforced and safe.

---

## Cross-cutting synthesis

1. **H1 needs one decisive trace**: whether shape summaries gain `appAnnotationId`
   anywhere between `toShapeAnnotationCommentSummary` and the sidebar. Two
   independent full reads say no. The fix is either to set it in the summary
   factory or to match on `annotationId`; add the regression test first.
2. **M1/M2 share a root design decision**: history entries are absolute entity
   snapshots replayed wholesale, while several legitimate mutations
   (`acknowledgeSave`, `remapPages`) intentionally bypass the stack. Either
   those mutations must rewrite outstanding snapshots (rebase), or replay must
   merge field-wise instead of replacing whole entities.
3. **Silent failure is a pattern**, not a bug cluster: H2/M5/M7/M9/L4 plus the
   swallowed per-page parse failures all fail without user signal. A single
   "annotation operation failed" surfacing path would cover most of them.
4. **Orphan lifecycle is under-specified**: M3 (store entity orphan after
   failed binding) and Slice 2's orphan-editor risk are two halves of one
   gap — nothing reconciles intent-first creations whose pdf.js half failed,
   in either direction.
5. **Undo×save interplay is fail-safe but noisy**: L1 and the mid-drag frontier
   staleness both convert race conditions into user-visible spurious failures;
   consider gating exposes and deferring saves during gestures instead of
   aborting.

## Verification queue (highest value first)

1. Trace shape-summary enrichment for H1; write the regression test.
2. Write failing tests for M1 (redo-after-save identity) and M2 (undo after
   page ops); then decide rebase-vs-merge.
3. Prove or refute the overlapping-print/save transaction interleaving
   (Slice 1 risk).
4. Confirm every rotate/delete-page op bumps `documentRevisionToken`
   (Slice 3 cache-staleness risk).
5. Trace orphan-editor removal after canonical undo of a create
   (Slice 2 R1 / Slice 4 M3).
6. Verify deferred-delete undoability (Slice 5 CRUD note).

*Compiled from five parallel read-only audit passes; headline findings
independently re-verified against source at commit `ab53d0a8f`. No code was
modified.*

