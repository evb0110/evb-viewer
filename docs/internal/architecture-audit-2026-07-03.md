# Architecture Audit — 2026-07-03

Full-application audit for structural fragility and runtime flakiness. Nine parallel
Codex (gpt-5.5-high) auditors, one per subsystem, each producing line-cited findings with
PATCH (localized fix) vs OVERHAUL (structural redesign) recommendations; synthesis and
prioritization by the orchestrating session. Working tree audited as-is (commit a4868541
plus uncommitted changes). Full per-finding details (problem, failure scenario, cited
lines, fix sketch) are in the audit transcripts; this file records the complete list and
the decisions.

## Verdicts by subsystem

| Area | Verdict |
|---|---|
| Architecture / layering / platform abstraction | Patchable (dependency graph clean; risk is platform drift) |
| PDF viewer rendering lifecycle | **Needs overhaul** |
| PDF editing / save integrity | **Needs overhaul** |
| Workspace shell (sessions/tabs/persistence) | **Needs overhaul** |
| Electron main process | Patchable (gap: lifecycle ownership of long-running work) |
| IPC / contracts boundary | Patchable, with one overhaul-grade gap (runtime schemas + cancellation) |
| AI assistant subsystem | **Needs overhaul** |
| OCR / search / DjVu workers | Patchable |
| Tests / CI safety net | **Needs overhaul** |

## Complete findings list (56)

Severity: C=critical, H=high, M=medium, L=low. Fix: P=patch, O=overhaul.

### Architecture / layering (`arch-map`)
- ARCH-1 (H, O) Browser runtime validation checks the hand-written lazy facade, not the real dynamically-imported implementation; a cached failed import poisons all platform calls for the session. `app/utils/platform.ts:101`, `app/platform/lazyBrowserPlatformApi.ts:48`, `app/platform/validatePlatformApi.ts:46`
- ARCH-2 (M, P) `app/platform/browser-api` DjVu preview reaches directly into `window.electronAPI`, bypassing platform validation and the manifest model. `app/platform/browser-api/createDjvuWorkerFromPath.ts:73`
- ARCH-3 (M, P) Fire-and-forget renderer file grants (`void allowRendererFileOpen(...)`) can reject unhandled; later opens fail far from the originating drag/drop. `electron/preload/createElectronApi.ts:122`
- ARCH-4 (L, P) Debug log stream plugin never unsubscribes; HMR/remounts stack listeners. `app/plugins/runtimeErrorLogStream.client.ts:46`

### PDF rendering lifecycle (`pdf-lifecycle`)
- PDFRT-1 (H, O) Document identity is modeled but not wired: transaction controller instantiated without `getDocumentVersion`/`getDocumentLoadToken`, so render currency always compares 0 vs 0; legacy requests hard-code `documentVersion: 0`. `app/modules/pdf-viewer/runtime/usePdfViewerFeatureController.ts:413`
- PDFRT-2 (H, O) Preserved-content reload destroys the PDF.js document without a renderer-owned generation switch; stale async work can throw, clean new-render state, or briefly mount stale content. `app/modules/pdf-viewer/runtime/composables/usePdfViewerDocumentLifecycle.ts:456`
- PDFRT-3 (H, O) `PDFPageProxy` ownership split between LRU cache, metrics hydration, and renderer cleanup; cache evicts with `cleanup()` with no notion of active render leases. `app/modules/pdf-viewer/runtime/composables/pdf/usePdfDocument.ts:101`
- PDFRT-4 (M, P) `prepareCanvasRender()` allocates a canvas before awaiting cancellable PDF.js operator-list work; on abort/stall the canvas is untracked. `app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer.ts:209`
- PDFRT-5 (M, P) Page preview queue calls `pdfPage.render()` directly, bypassing the render coordinator; `reset()` cannot cancel active renders. `app/modules/pdf-viewer/engine/pdf-page-preview/createPagePreviewRenderQueue.ts:74`
- PDFRT-6 (M, P) Annotation layer cancellation is page-token based with no abort signal or document-generation fence; stale `getAnnotations()` runs to completion. `app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer.ts:576`

### PDF editing / save integrity (`pdf-editing`)
- PDFED-1 (**C**, O) Stale serialized saves can overwrite newer queued mutations: renderer materializes full-PDF bytes before entering the main mutation queue; commit checks only target/original base, not the working-copy revision the bytes were based on. Silent loss of page ops / OCR content. `app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts:623`, `electron/features/documents/main/serializedPdfPersistence.ts:327`
- PDFED-2 (H, P) Original-file save + working-copy refresh failure returns "valid with warning"; renderer marks clean while the working copy is stale — later ops read/overwrite stale bytes. `electron/features/documents/main/workingCopySave.ts:269`
- PDFED-3 (H, P) Structural page ops (delete/rotate/reorder/crop) mutate the working copy without first persisting unsaved viewer edits (only extract calls `ensureWorkingCopyFreshForRead`); unsaved annotations can disappear. `app/modules/pdf-viewer/runtime/composables/pdf/usePageOperations.ts:282`
- PDFED-4 (M, P) Native mutation saves lack base-revision protection; a mutation plan built against state A can apply to state B. `electron/features/documents/main/nativePdfMutationSaveHandlers.ts:221`
- PDFED-5 (H, O) pdf-lib full-rewrite path guards corruption only by a 50%-size heuristic; documented risk of dropping PDF.js incremental annotations can pass validation silently. `app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits.ts:37`, `docs/architecture/freetext-note-persistence.md:55`
- PDFED-6 (M, O) Window/app quit bypasses renderer dirty-save coordination; bounded shutdown cleanup can discard unsaved edits after timeout. `electron/bootstrap/runInitSequence.ts:319`

### Workspace shell (`workspace-shell`)
- SHELL-1 (H, O) Open/close/switch transactions are not serialized; `beginTransaction` overwrites the active transaction; an open can publish state after close/removal. `app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore.ts:303`
- SHELL-2 (H, P) Persistence has no reliable content compare-and-swap: guards by `workingCopyPath` only; writes don't force-refresh revision; concurrent writers degrade to last-writer-wins. `app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts:62`
- SHELL-3 (H, P) Some working-copy writes bypass the save lease (`loadPdfFromData(... persistWorkingCopy)` via `applySnapshot`); races with Save As / native-mutation saves. `app/modules/workspace-shell/composables/usePageAnnotationActions.ts:938`
- SHELL-4 (M, O) Document identity split across original path, working copy, and tab; same file opened twice shares assistant scope; rename/Save As desynchronizes consumers. `app/modules/workspace-shell/document-sessions/createWorkspaceDocumentSessionCore.ts:86`
- SHELL-5 (M, P) Tab transfer close uses a different closeability predicate (`workspaceHasPdf` only) than normal close; DjVu/native viewers can skip lifecycle cleanup. `app/modules/workspace-shell/composables/useWindowTabTransfers.ts:366`
- SHELL-6 (L, P) Dead/misleading session states: `closed` phase never produced; `pendingClose.persist` hardcoded true even on discard. `app/modules/workspace-shell/document-sessions/documentSessionTypes.ts:15`

### Electron main process (`electron-main`)
- MAIN-1 (H, O) Shutdown timeouts don't cancel active work; `quitAndInstall` can proceed while qpdf/native saves still write. `electron/bootstrap/shutdown.ts:36`
- MAIN-2 (H, P) Streamed PDF persistence sessions are outside shutdown ownership until late commit; working-copy cleanup can race an uncancellable committing session. `electron/features/documents/main/serializedPdfPersistence.ts:270`
- MAIN-3 (M, P) Legacy `savePdfDataAs` bypasses the working-copy mutation queue; interleaves with queued page ops. `electron/features/documents/main/documentSave.service.ts:161`
- MAIN-4 (M, P) Range-read `FileHandle` cache (30s TTL) not closed at shutdown; Windows file locks can break working-copy deletion. `electron/features/documents/main/documentFileReadHandlers.ts:38`
- MAIN-5 (M, O) Exports/native read-side jobs have renderer aborts but no app-shutdown abort; `runNativeToolCommand()` doesn't expose cancel groups. `electron/features/image-export/main/ipc.ts:123`

### IPC / contracts boundary (`ipc-contracts`)
- IPC-1 (H, O) Main-side validation is not a contract invariant: registrar checks channel+sender only, forwards raw args; per-service revalidation is uneven. `electron/platform-ipc/validatedIpcRegistrar.ts:57`
- IPC-2 (H, O) Type-derived invoke maps don't protect runtime parity: startup validation samples a hand-picked method subset; test fixture is a cast partial. `packages/contracts/ipcMain.ts:20`, `app/platform/validatePlatformApi.ts:46`
- IPC-3 (M, P) The lazy browser proxy is a second manually-maintained contract surface; descriptor coverage isn't enforced. `app/platform/browserPlatformPathDescriptors.ts:119`
- IPC-4 (M, P) Error propagation lossy/inconsistent: no discriminated error envelope; invalid decoded events silently dropped (frozen progress UI). `electron/preload/ipcClient.ts:35`
- IPC-5 (H, O) No boundary-level cancellation for long-running invokes; renderer timeout/navigation leaves qpdf/native work running holding queues/temp files. `electron/preload/ipcClient.ts:64`
- IPC-6 (M, P) Progress/revision events are fire-and-forget with no subscription/start handshake or replay; late subscribers and reloaded windows miss events. `electron/utils/createIpcProgressPump.ts:63`
- IPC-7 (M, P) Large binary reads use structured-clone invokes (512MB budget, 8MB ranges) without stream backpressure/cancel; memory spikes on big PDFs. `packages/contracts/electronApiDocuments.ts:407`

### AI assistant (`agent-assistant`)
- AGENT-1 (**C**, P) Active turns can be double-submitted: `sendInFlight` guards only send setup; `claimAssistantTurn` unconditionally supersedes the prior owner; interleaved transcripts. `electron/features/agent/codexAssistant.ts:1000`
- AGENT-2 (H, P) Streaming events dropped before turn id binding: deltas/completions arriving before `turn/started` are classified stale; UI can stick in `starting`/`running`. `electron/features/agent/createAssistantAppServerNotificationController.ts:139`
- AGENT-3 (H, P) Interrupt marks the runtime ready before cancellation is confirmed; a new turn can start on a still-busy provider thread. `electron/features/agent/codexAssistant.ts:1229`
- AGENT-4 (H, O) Window/session ownership too coarse: sessions keyed by `provider:scopeKey`, events broadcast to every window; two windows on the same document cross-talk. `electron/features/agent/assistantChatSessionStore.ts:116`
- AGENT-5 (M, P) Viewer scope changes (revision/command target) aren't part of the panel state machine; turns bind to stale MCP scope. `app/modules/agent-panel/composables/useAgentAssistantPanelController.ts:1074`
- AGENT-6 (M, O) Chat "store" is volatile (in-memory Map, ephemeral provider threads); quit/crash drops all history and turn-recovery state. `electron/features/agent/assistantChatSessionStore.ts:140`
- AGENT-7 (L, P) Browser agent capability satisfies the type but ignores scope/provider/model; browser builds silently diverge. `app/platform/browser-api/browserAgentCapability.ts:35`

### OCR / search / DjVu (`ocr-search-djvu`)
- BG-1 (H, P) OCR cancellation emits no terminal backend event; UI depends on a local 5s timeout; result-file cleanup best-effort. `electron/ocr/jobManager.ts:922`
- BG-2 (H, O) Competing OCR jobs on the same document race in the same `.ocr` artifact directory (dedup by requestId, not path+revision); partial indexes, cross-job rollback. `electron/ocr/jobManager.ts:666`
- BG-3 (M, P) OCR queue admission uses source bytes + 32KB/page, underestimating rendered-image cost; compressed scans blow disk/memory. `electron/ocr/jobManager.ts:269`
- BG-4 (M, P) Search warmups and same-document index builds are not singleflighted; duplicate builds race sidecar persistence. `electron/features/search/main/searchWorkerService.ts:466`
- BG-5 (H, O) DjVu native preview renders can't be canceled once in flight ("terminate" flips a renderer flag; `ddjvu` runs to completion or 30-min timeout). `electron/features/djvu/main/pagePreview.ts:201`
- BG-6 (M, P) DjVu PDF worker has a cancel protocol the client never uses (no `signal`/`createCancelMessage`); cancellation is forced termination. `electron/features/djvu/main/pdfWorkerClient.ts:62`
- BG-7 (L, P) DjVu conversion progress has no terminal failure/cancel event; stale progress UI. `electron/features/djvu/main/pdfExport.ts:463`
- BG-8 (L, P) OCR language registry guard is sound but download/package scripts scrape it with regex instead of importing it; release-only drift risk. `scripts/download-tessdata.sh:18`

### Tests / CI safety net (`tests-quality`)
- TEST-1 (H, O) Shared platform fixture is a partial object cast to `IPlatformApi`; capability-group refactors pass unit tests while real preload/browser break. `tests/helpers/createElectronPlatformApiFixture.ts:33`
- TEST-2 (H, P) Release gates don't prove any real Electron user workflow (E2E is nightly + `continue-on-error`). `package.json:54`, `.github/workflows/ci.yml:246`
- TEST-3 (H, O) E2E isolation depends on global mutable session state, fixed ports, and possible reuse of unrelated Nuxt servers. `tests/e2e/electron/globalSetup.ts:15`, `scripts/electron-run/electronRunNuxtServer.ts:452`
- TEST-4 (M, P) E2E readiness is polling/sleeps/retries rather than app-emitted events; retries mask real races. `tests/e2e/electron/helpers/viewerCore.ts:377`
- TEST-5 (M, O) E2E bypasses UX via `__openFileDirect`/`__evbTestApi`/implementation CSS selectors; policy only bans Vue privates. `tests/e2e/electron/helpers/workspaceExpose.ts:82`
- TEST-6 (M, P) Coverage ratchet is aggregate, not risk-weighted; save/lifecycle/IPC code can land near-uncovered. `scripts/checkCoverageRatchet.ts:24`
- TEST-7 (M, P) Save/IPC coverage is deep but mock-composed; no in-process contract test wiring real preload clients to registered handlers. `tests/unit/electron/documentsIpcAdapter.test.ts:22`

## Cross-cutting root causes (orchestrator synthesis)

1. **No revision fencing (compare-and-swap) on document writes.** The working-copy
   mutation queue serializes writes but accepts stale payloads: PDFED-1/2/4, SHELL-2/3,
   MAIN-3. This is the one *data-loss-grade* architectural hole.
2. **No single owner for async-work lifecycle/generations.** Cancellation and "is this
   result still current?" checks are ad hoc per layer: PDFRT-1/2/3/6, SHELL-1, MAIN-1/2/5,
   IPC-5, BG-2/5, AGENT-1/3.
3. **Document identity is fragmented** (original path vs working copy vs tab vs assistant
   scope): SHELL-4, AGENT-4. Blocks a clean fix of #1 and #2.
4. **Contracts enforced only at compile time**, with 4+ hand-maintained surfaces (preload,
   browser impl, lazy proxy, test fixture) that drift: IPC-1/2/3, ARCH-1/2, TEST-1, AGENT-7.
5. **No terminal-event guarantee** for long-running operations (OCR, DjVu, progress pumps,
   assistant turns): BG-1/7, IPC-6, AGENT-2.
6. **The safety net can't catch any of the above**: mocks drift with the code, real-app
   automation is non-blocking, readiness is timing-based: TEST-1..7.

## Decisions: overhaul vs patch

**Overhauls (5, in recommended order):**
1. **Transactional document persistence** — revision token minted in main, CAS enforced at
   every working-copy/original commit (serialized saves, native mutations, page ops,
   Save As, OCR apply); one write path, no lease bypasses. (Fixes PDFED-1/2/4, SHELL-2/3,
   MAIN-3.)
2. **Test-fixture/contract generation + one blocking Electron smoke lane** — generate
   fixtures, lazy proxy, and runtime validation from one descriptor source; per-run
   ports/sessions and event-driven readiness for e2e. Do this early: it is the safety net
   for the other overhauls. (Fixes TEST-1/3/5, IPC-2/3, ARCH-1.)
3. **Single document-generation / lifecycle owner in the viewer + shell** — one generation
   bumped on open/reload/switch, injected into transactions, render scheduling, page
   leases, annotation layers; serialized open/close arbiter per tab. (Fixes PDFRT-1/2/3,
   SHELL-1.)
4. **Unified DocumentIdentity model** — `documentInstanceId` + source ref + working-copy
   ref + revision consumed by tabs, sessions, assistant scope, transfers. (Fixes SHELL-4,
   AGENT-4, and de-risks overhaul #1.)
5. **Main-process operation lifecycle coordinator** — registry of long-running work
   (native tools, workers, streamed persistence, exports) with abort signals; quit/update
   blocks on or cancels critical writes; boundary-level IPC cancellation. (Fixes MAIN-1/2/5,
   IPC-5, BG-5.)

**Patch program (do first / alongside):** PDFED-2, PDFED-3, MAIN-3, SHELL-3, AGENT-1/2/3,
BG-1/4/6, IPC-4/6, ARCH-3/4, TEST-2, and the remaining M/L items. These are localized,
high-value fixes that don't depend on the overhauls.

**Assistant subsystem:** patch the turn-lifecycle bugs (AGENT-1/2/3) now; the
session/routing redesign (AGENT-4) should ride on overhaul #4; decide whether chat
persistence (AGENT-6) is a product requirement before investing.
