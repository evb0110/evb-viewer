# Whole-app static breaking-points audit, 2026-08-31

## Outcome

This audit records 140 reachable reliability, correctness, accessibility, and release-control failure modes outside the annotation rewrite: 69 P1, 62 P2, and 9 P3 entries. A few entries describe separate consequences of the same underlying ownership defect, and four are already in the repository ledger. The highest-risk cluster is not rendering polish. It is ownership and recovery: dirty documents can be discarded on native window close, recovery journals can be treated as absent after I/O errors, browser saves can overwrite external edits, and cross-window browser maintenance can delete another window's staged document chunks.

The audit began at `2d0d831aa0eb5d051cdde78020c6f9ee383023b5`. Concurrent work advanced `main` during the audit. The final source review used clean `c1c5a4de051ab249956d9e07a686689b3e7b2f68`, equal to `origin/main`. The intervening changes were version bumps, release-script repairs, tests, and the separate annotation lane. Agents rechecked cited source paths after each movement. No finding below depends on the annotation architecture in issue #170 or its descendants.

This is a static and focused-probe audit, not a claim that every entry has been reproduced in the packaged GUI on all six platform and architecture combinations. Confidence labels mean:

- **Reproduced**: a focused runtime probe demonstrated the failure.
- **Pinned**: an existing test explicitly requires the unsafe behavior or proves the expensive call count.
- **Static**: the complete reachable code path was traced, but no packaged runtime reproduction was run.
- **Known ledger**: already recorded in a repository reliability ledger. It is retained here so the whole-app risk picture is complete.

Priority means likely impact, not implementation difficulty:

- **P1**: data loss, wrong-document action, durable corruption, app or worker exhaustion, broken release safety, or a primary workflow unavailable to keyboard or assistive-technology users.
- **P2**: failed operation, misleading success, persistent resource leak, serious performance stall, or wrong output.
- **P3**: narrower compatibility, metadata, diagnostics, or persistence defect.

## 1. Document ownership, save, and recovery

### D01. P1: native window close can discard dirty work without warning

The browser-only dirty unload guard is in `app/modules/workspace-shell/components/AppShellRoot.vue:345`. Native close calls `BrowserWindow.close()` directly in `electron/platform-ipc/registerCoreIpcHandlers.ts:148`, with no close veto or renderer save/discard/cancel handshake. `window-all-closed` starts shutdown only after the last renderer is gone, so `electron/bootstrap/requestShutdownSaveFlush.ts:39` sees no window to query. Later cleanup in `electron/main.ts:437` can retire checkpoints and working copies. Closing one of several windows is equally unsafe because the destroyed renderer's dirty state is gone. Static.

Red test: close a dirty native window through both title-bar close and `closeCurrentWindow`. Cancel must keep it alive, Save must finish first, and Discard must retire only that window's recovery state.

### D02. P1: unreadable or partial transaction journals are treated as absent

`electron/file-access/recoverTwoTargetDocumentTransition.ts:41-48`, `electron/file-access/workingCopyContentTransitionJournal.ts:362-385`, and `electron/ocr/recoverPreparedOcrRevisionTransition.ts:96-104` catch every read and JSON error and return no journal. `electron/file-access/documentRevisionStore.ts:244-269` then returns or creates a revision. After a crash between byte publication and sidecar publication, `EACCES`, `EIO`, or truncated JSON bypasses rollback and lets a later mutation overwrite recovery evidence. Static. Closed SAV-002, #122, and #146 tested transition-time failure, not restart-time journal-read failure.

Red test: make each prepared journal read fail with `EACCES` and with truncated JSON. Recovery must fail closed, preserve backups, and block a new transition.

### D03. P1: checkpoint I/O failure can end in deletion of dirty recovery bytes

`app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint.ts:38-103` retries a failed write only when a newer checkpoint was already pending. `electron/workspaceCheckpointStore.ts:541-555` returns `null` for every checkpoint read error. Startup treats that as a clean session in `app/modules/workspace-shell/composables/useTabsShellBindings.ts:520-583`, then schedules stale working-copy cleanup through `electron/bootstrap/runInitSequence.ts:343-430`. `electron/file-access/workingCopyCleanup.ts:65-71,208-230` can delete an unclaimed dirty directory older than 24 hours. Static.

Red tests: retry the same checkpoint after a lone `ENOSPC`; and preserve a stale working directory when its valid checkpoint temporarily fails to read.

### D04. P1: desktop recovery claim deletes the journal before restore succeeds

`electron/workspaceCheckpointStore.ts:541-639` transfers ownership and deletes `workspace-checkpoint.json` before returning. `app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint.ts:98-144` records per-tab failures, but `useTabsShellBindings.ts:520-575` ignores the result and still declares readiness. A crash, unavailable cloud file, or one failed tab reopen leaves no retryable checkpoint. Static.

Red test: claim a two-tab dirty checkpoint, fail one reserved open, then terminate the renderer. The next renderer must reclaim the failed tab. Retire only per-tab entries that explicitly acknowledge successful restore.

### D05. P1: a transient snapshot error overwrites the last good checkpoint with source-only dirty state

`app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint.ts:23-37,60-80` catches snapshot failures, emits a dirty tab with null working-copy references, and `useWorkspaceCrashCheckpoint.ts:85-92` persists it. `restoreWorkspaceCheckpoint.ts:21-31,92-110` can then reopen only the source, losing unsaved bytes. `createDeferredWorkspaceExposeProxy.ts:377-385` can supply those null references while the real workspace is unmounted, including the localized-error path in `DeferredDocumentWorkspaceHost.vue:575-589`. Static.

Red test: keep a last-known-good dirty snapshot, make the next snapshot capture fail, crash, and require recovery of the good bytes rather than replacement by a source-only checkpoint.

### D06. P1: every desktop window shares one checkpoint journal

All renderers use the same `workspace-checkpoint.json` in `electron/workspaceCheckpointStore.ts:504-640`, and every renderer claims it in `useTabsShellBindings.ts:520-583`. A new window created by `electron/windowTabTransfer.ts:185-188,301-303` can claim the source window's entire workspace before receiving its transferred tab. One window can steal live working-copy ownership and only one workspace survives a crash. **Known ledger EVB-RP-030**, `docs/internal/reliability/whole-repo-program-ledger-2026-08-21.md:92`.

### D07. P2: queued range work can recreate a working copy after explicit close

`app/modules/pdf-viewer/runtime/composables/pdf/usePdfFile.ts:155-181` can leave queued reads alive while `electron/file-access/workingCopyCleanup.ts:583-721` and `workingCopyStore.ts:436-587` remove the working copy. A later path resolution in `documentFilePathResolution.ts:122-150` and `workingCopyCreation.ts:307-382` can materialize it again. **Known ledger EVB-RP-038**, `docs/internal/reliability/whole-repo-program-ledger-2026-08-21.md:100`.

### D08. P1: a full lazy-original range read has no post-read witness

`electron/features/documents/main/documentFileReadHandlers.ts:478-484,528-548,665-703` performs the post-read witness only when `bytesRead < length`. A full requested read can overlap a same-size in-place rewrite and return mixed bytes without detecting the revision change. Existing `tests/unit/electron/fileOpsPathSecurity.test.ts:1094-1116` covers only one capture and read. Static.

Red test: rewrite the same-size source between chunks of a full-range read and require rejection or restart before bytes are returned.

### D09. P1: browser Save overwrites external edits without a source witness

`app/platform/browser-api/browserSaveTargets.ts:51-93` and `app/platform/browser/browserDocumentRepository.ts:374-394` lock logical refs but validate only the working-copy token. `browserFilePickerAdapter.ts:550-596` closes the File System Access writer unconditionally. A probe changed the external byte from `1` to `9` before Save; EVB returned success and replaced it with the working byte `7`. **Reproduced**. Desktop issue #120 does not cover this browser path.

Red test: replace fake handle bytes after open and before Save. Require a typed conflict, `externalWriteCommitted:false`, and preservation of the external bytes.

### D10. P1: a timed-out browser close can commit after EVB reports no write

`browserFilePickerAdapter.ts:74-89,550-596` times out `FileSystemWritableFileStream.close()` without canceling it. `browserSaveTargets.ts:71-82,126-175` reports `write-failed` and `externalWriteCommitted:false`. An accelerated probe then released the original close promise and observed the first attempt commit later. **Reproduced**.

Red test: gate `close()`, pass the deadline, and then release it. The result must be indeterminate or the stream must be aborted; a later unowned commit must be impossible.

### D11. P2: browser range opening can assemble bytes from two file revisions

`app/platform/browser/browserDocumentRecordStore.ts:467-563` calls `handle.getFile()` for each range. The token is only size plus last-modified time and is refreshed after bytes are read. A same-size, same-mtime replacement delivered revision A for one range and revision B for the next under one token. **Reproduced**. Desktop #123 does not cover the browser handle path.

Red test: return same-size and same-mtime A then B from a fake handle. The transport must retain one `File` snapshot or reject before delivering B.

### D12. P1: picking the same browser file twice creates two save authorities

`browserDocumentRepository.ts:228-240` creates a random ref for every registration and never calls `FileSystemFileHandle.isSameEntry`. The picker always uses this path at `createBrowserDocumentsFileCapability.ts:277`. Save locks cover only the random refs at `browserDocumentRepository.ts:374-394`, so two tabs can overwrite the same physical file without sharing a revision or lock. Static.

Red test: pick one handle twice, edit both copies, save A and then B. B must see a stale physical-source conflict, and Recent Files should contain one physical target.

### D13. P1: a live browser recovery owner expires after 30 seconds

`browserWorkspaceRecoveryStore.ts:160` updates its timestamp only when content changes. There is no heartbeat. `browserWindowTabs.ts:25,890-975` treats records older than 30 seconds as orphaned after only 60 ms of peer discovery. If `BroadcastChannel` is unavailable or delayed in a background tab, another live window steals the dirty workspace. The existing test at `browserWindowTabs.test.ts:312` pins the steal when discovery is unavailable. **Pinned**.

Red test: keep A live and dirty for more than 30 seconds, delay its response, start B, and require B not to claim until an authoritative lease expires or A releases it.

### D14. P1: browser recovery can persist stale bytes after later edits

`buildWorkspaceCheckpoint.ts:49-80` has no document revision. `useBrowserWorkspaceRecovery.ts:72-183,395` guesses freshness from private counters and DOM events, then reuses an older snapshot when the counter did not advance. Programmatic or delayed commits can therefore crash-recover stale bytes. **Known ledger EVB-RP-032**, `whole-repo-program-ledger-2026-08-21.md:94`.

### D15. P1: one browser window's maintenance deletes another's staged chunks

`browserDocumentMaintenance.ts:125-223` protects only the current store's in-memory `pendingLoad`. `browserDocumentRepository.ts:593-669` writes shared IndexedDB chunks before publishing the generation. Window B can delete window A's unpublished generation during its first sweep. A two-store probe produced `Browser document chunk missing ... #0`. **Reproduced**.

Red test: stage in store A, run maintenance in B, then finalize and read in A. The shared generation must survive.

### D16. P1: final IndexedDB metadata failure leaks the whole staged file

`browserDocumentRepository.ts:723-768` writes all chunks before its document record. Its catch calls `clearPendingBrowserDocumentChunks`, but `browserDocumentChunkStorage.ts:114` deletes `pendingChunkGeneration` while ingestion stored the generation in `entry.chunkGeneration`. A quota-failure probe left five chunks after falling back to memory. **Reproduced**.

Red test: fail only the final document transaction and require zero remaining chunk records.

### D17. P1: the advertised volatile browser tier cannot open PDFs and whole-reads large inputs first

`browserDocumentRepository.ts:723-805` calls `file.arrayBuffer()` before applying the 16 MiB memory tier. `browserWorkingCopyService.ts:127-143` then requires an IndexedDB proxy record, so even a four-byte PDF fails when IndexedDB is absent. A 32 MiB fake file performed a range read and then a full `arrayBuffer()` read. **Reproduced**.

Red tests: under-cap input must produce a usable memory working copy without IndexedDB; over-cap input must remain slice or handle backed, or fail before `arrayBuffer()`.

### D18. P1: recent browser handles cannot re-request read permission after reload

`browserDocumentRecordStore.ts:48-102` contains the correct permission helper, but `browserDocumentRepository.ts:523-538` bypasses it and calls `getFile()` directly. `createBrowserDocumentsFileCapability.ts:354` converts the permission error to `null`. A prompt-state handle never received `requestPermission`. **Reproduced**.

Red test: make `getFile()` fail until `requestPermission({mode:'read'})` grants. Clicking Recent Files must request once and reopen.

### D19. P1: browser Recent Files and durable record retention race across windows

`browserRecentFilesStore.ts:20-104` performs unlocked localStorage read-modify-write. The document queue in `browserDocumentRecordStore.ts:105` is instance-local. `browserDocumentMaintenance.ts:143-223` rechecks recovery leases but not Recent Files before deletion. Windows can lose one recent entry or delete a record another window just reopened. **Known ledger EVB-RP-033**, `whole-repo-program-ledger-2026-08-21.md:95`.

### D20. P2: browser drop registration leaks durable hidden documents

`createBrowserDocumentsFileCapability.ts:896-907` registers dropped inputs as durable sources. `useExternalFileDrop.ts:42-168` and `usePageDragDrop.ts:589-633` do not clean unsupported or insertion-only refs. Picker insertion uses transient registration and cleanup in `createBrowserPageOpsCapability.ts:540-580`, proving the intended ownership model. Static.

Red tests: every unsupported, abandoned, successful, and failed page-drop source must be transient and removed.

### D21. P2: a transient missing volume permanently erases a Recent entry

`electron/recentFiles.ts:186-199,378` classifies `ENOENT` and `ENOTDIR` as permanent absence and rewrites the store. A temporarily unmounted drive or offline network share disappears from history after one check. Existing `recentFiles.test.ts:361` pins deletion. **Pinned**.

Red test: fail one stat with `ENOENT`, then succeed. Keep an unavailable entry and recover it without user re-picking.

## 2. Settings, local state, and false success

### S01. P1: transient settings read failure becomes a destructive default overwrite

`electron/settings.ts:67-78` converts every read error to defaults. `loadSettings` caches them at lines 95-126, and the next `updateSettings` at lines 135-156 atomically replaces the intact file. `EIO`, `EMFILE`, antivirus interference, or temporary permissions can silently erase unrelated preferences. Static, independently found by three lanes.

Red test: reject the first read with `EIO`, then update one field. The update must fail closed and preserve every existing byte until a successful read.

### S02. P1: Recent Files read and canonicalization failures can erase valid history

`recentFiles.ts:301-334` converts non-`ENOENT` read failure to an empty store. Opening another document writes only that entry. The same catch encloses canonicalization persistence, so a failed canonicalization save can quarantine a valid store and attempt to create an empty one. Static.

Red tests: fail initial read with `EACCES` and fail canonicalization write separately. Neither may replace or quarantine valid JSON.

### S03. P1: browser upgrades discard valid older settings cookies

`app/utils/browserSettingsPersistence.ts:50-84` requires current fields such as `performanceMode`, although schema version remained 2 when those fields were added. Lines 181-195 reject and expire a v0.1.421 payload that the sanitizer could migrate. Users lose author, viewer, scale, tab, and performance settings. Static.

Red test: migrate the exact v0.1.421 shape and preserve its non-default fields while supplying new defaults.

### S04. P1: early browser migration resets locale and theme and deletes the source on failed write

`browserSettingsPersistence.ts:108-124,181-195` runs through `performanceProfile.ts:73` before split locale and theme cookies are considered. It writes `en` and `light`, ignores `safeSetLocalStorageItem` failure, and expires the source. A probe migrated `ru` plus `dark` to `en` plus `light`. Existing `browserSettingsPersistence.test.ts:135-146` pins deletion after failed storage. **Reproduced and pinned**.

Red tests: include split cookies in early migration and retain all sources until the destination commit succeeds. `browserRuntimePersistence.ts:38` needs the same commit-after-write rule.

### S05. P1: renderer settings-load failure still announces app ready

`usePlatformHydratedState.ts:99-119` converts a rejection to a fulfilled `null`. `useSettings.ts:87-99` only logs it. `app.vue:495-505` applies fallbacks and dispatches `evb:app-ready` while `isLoaded` is false. Production Settings UI does not expose that state in `SettingsContent.vue:202`. Static.

Red test: reject `settings.get()` and require a terminal recovered or user-visible failure state before app-ready.

### S06. P1: scan-cleanup global preferences overwrite concurrent changes

`scanCleanupPreferencesStore.ts:218-235` sends full snapshots. `createScanCleanupSettingsStore.ts:445-450` replaces the whole object. Browser `preferencesRepository.ts:86-108` behaves the same. Two windows changing different fields from one initial snapshot lose the first change. Static.

Red test: concurrent disjoint updates must merge by field or compare-and-swap revision.

### S07. P1: scan-cleanup load and save failures are treated as completed

`scanCleanupPreferencesStore.ts:170-206` clears pending state before the write, catches rejection, does not retry, and marks defaults hydrated after load failure. A later edit can replace existing remote settings with defaults. Static.

Red tests: retry an `ENOSPC` write without another edit; after a failed load, preserve unknown remote fields when one field changes.

### S08. P2: browser settings tabs overwrite each other

`browserSettingsCapability.ts:35-40,144-157` caches one snapshot per tab and writes the whole stale object. It has no storage event or broadcast reconciliation. Tab B can revert tab A while changing an unrelated setting. Static.

Red test: two module instances sharing storage must retain disjoint changes.

### S09. P2: localStorage failures are reported as successful settings and Recent operations

`app/utils/localStorage.ts:27` returns false on failure. `browserSettingsCapability.ts:38-40,144-157` ignores it and updates memory; `settingsPersistenceQueue.ts:92-113` records success. `browserRecentFilesStore.ts:166` and `createBrowserDocumentsCapability.ts:226` similarly report successful clear, remove, or touch while durable history remains. Static.

Red tests: make `setItem` throw. Capabilities must reject, retain visible state, and enter retry-pending.

### S10. P2: future settings schemas are stripped and overwritten

`packages/contracts/settings.ts:205` accepts any finite version, drops unknown fields, and can write the object back with the future version. Browser load rejects future payloads but `browserSettingsCapability.ts:123` overwrites them with defaults. Static.

Red test: version 99 plus an unknown field must fail closed and preserve original bytes in Electron and browser.

### S11. P2: permanent Recent failure polls forever behind an endless skeleton

`useRecentFiles.ts:65` retries every 750 ms with no attempt limit. `usePlatformHydratedState.ts:137` never reaches a terminal error. `DeferredDocumentWorkspaceHost.vue:45,708` drops the error, and `PdfEmptyState.vue:105` stays busy with skeleton rows. Static.

Red test: permanent rejection must reach a bounded terminal state with a user retry action.

### S12. P3: graceful shutdown does not await settings queues

`useSettings.ts:137-157` starts an unawaited pagehide save after a 400 ms debounce. Main adds another delay in `createSettingsMainBindings.ts:54-125`. `electron/main.ts:328-396` coordinates documents and checkpoints but not settings or scan-cleanup preference queues. Static.

Red test: immediate Quit after a setting change must wait for the main-process commit.

### S13. P3: malformed assistant-panel width becomes `NaN`

`useAssistantPanelResize.ts:18` clamps parsed storage without checking finiteness. `NaN` survives the clamp and later arithmetic. Static.

Red test: persisted `invalid` and `NaN` must normalize to 384 and rewrite storage.

### S14. P2: unload flush can strand the final scan-cleanup update behind an old promise

`scanCleanupPreferencesStore.ts:170-183,218-240` serializes remote writes on a promise tail. `useScanCleanupDocumentSettings.ts:109-178` invokes final flush from `pagehide` and `beforeunload` without awaiting it. If a prior renderer-side write is unresolved, the final payload never reaches main before the renderer dies. Static.

Red test: gate one settings write, queue a final update, fire unload, and require the shutdown handshake to wait until the final payload has crossed IPC and committed.

## 3. Search, navigation, page operations, and large documents

### O01. P1: print can switch to another document while awaiting readiness

`useWorkspacePrint.ts:799-870` creates a run ID but captures no document identity. After `ensurePrintReady`, it reads live source refs, paths, titles, counts, and bytes. `usePageFileOperations.ts:94` does not gate opens on print preparation. A deferred run for A can print B with A's page number. Static, independently reported twice.

Red test: replace all source refs while readiness is pending. The run must abort without invoking any print backend.

### O02. P1: late browser tab-transfer ACK leaves both copies live

`browserWindowTabs.ts:488-508,669-683,960-1008` removes the source pending transfer after 12 seconds, but the target nonce remains valid for 60 seconds. `useWindowTabTransfers.ts:540-590,688-711` accepts the target ACK locally even though the source now ignores it, so neither side rolls back. Electron broker correctly returns false after timeout. Static.

Red test: complete target restore just after 12 seconds. Target ACK must return false and roll back.

### O03. P2: search cancellation before registration can cancel the newer query

`electron/features/search/main/ipc.ts:109-204` performs asynchronous revision work before dispatch. `searchWorkerService.ts:300-401` records cancellation only for registered jobs. If A is canceled while preprocessing, B registers, then A finishes, late A supersedes B. Static.

Red test: gate A's revision resolution, cancel A, dispatch B, release A, and require B to remain active.

### O04. P2: renderer cleanup cancels jobs whose lifecycle policy says detach

`registerDocumentsIpcAdapter.ts:155,212,653` blanket-cancels token work while `createMainJobRegistry.ts:313-391` defines navigation detach and reconnect. OCR, search, and scan-cleanup jobs therefore cancel on reload instead of following their declared lifecycle. Static.

### O05. P2: full-document path printing is invisible to operation shutdown

`electron/features/documents/main/print.ts:239` runs the full-document path without a registered operation or signal, while the selected-page branch at line 253 registers one. `mainOperationLifecycle.ts:145` and `main.ts:352` cannot cancel or wait for it. Static.

### O06. P2: PDF cache cleanup races render cancellation

`pdfDocumentSession.ts:952-971,1058-1067` queues render invalidation but immediately calls document cleanup. `createPdfRenderingSession.ts:1116-1123` can still be rendering, so pdf.js rejects cleanup. The rejection is swallowed and caches remain until a later deactivation. Static.

### O07. P2: DjVu paged-to-continuous toggle jumps the physical viewport to page 1

`useDocumentPageSourceRuntime.ts:200-211,572-621`, `useDocumentViewportLayoutLifecycle.ts:276-293`, and `zoomAnchor.ts:50-63` reset the physical viewport while semantic page state can remain deep in the document. Static, distinct from #132.

### O08. P1: accepted regular expressions can hang the UI or desktop worker

`packages/contracts/search.ts:578-693` accepts patterns with catastrophic backtracking. Both `createBrowserSearchCapability.ts:1029-1044` and `electron/search/worker.ts:640-670` execute them. Pattern `a*a*a*a*a*a*a*a*b` against 100 `a` characters did not return after ten seconds. **Reproduced**. Closed #129 budgets page count and query length but does not bound regex execution.

Red test: execute regex search under a per-page time or engine-complexity limit and require a typed rejection.

### O09. P1: extractor failures become durable empty or partial complete indexes

`electron/search/indexBuilder.ts:431-595,752-759` swallows ordinary extractor errors, pads missing pages with empty strings, and persists. `ensureSearchIndex.ts:258-284` accepts revision coverage as complete. Search then silently misses text until the source revision changes. Static.

Red test: fail one extractor page and require an incomplete/error index that retries, never a complete empty page.

### O10. P2: quoted whitespace search changes the query

UI parsing preserves quoted whitespace in `usePdfSearch.ts:46-55`, but desktop IPC and worker trim it at `search/main/ipc.ts:123-127` and `search/worker.ts:455-507`. `" a "` becomes `a`; `" "` becomes empty. Static.

### O11. P2: the desktop fallback marks exactly 500 matches truncated

`electron/search/worker.ts:608-678,727-775` treats hitting 500 as proof of more results. Browser and native request limit plus one. A document with exactly 500 matches receives a false truncation warning. Static.

### O12. P1: ordinary search-worker retirement skips native-daemon shutdown proof

`searchWorkerService.ts:489-507,563-578,634-652,780-800` cancels then terminates the Worker without the `shutdown` protocol. `electron/search/worker.ts:835-887` only closes its detached native service and reports completion after that protocol. Idle expiry or timeout can overlap an unverified daemon with its replacement. Static.

### O13. P1: terminating search workers stop counting toward the cap too early

`searchWorkerService.ts:753-800` deletes sender state before `terminate()` settles. Admission at lines 968-1008 counts only the map. Timeouts and rejections are logged and forgotten, so replacements can exceed the cap and shutdown loses the old Worker. Static.

### O14. P1: transformed PDF printing drops page rotation

`packages/pdf-core/pdfPrintLayout.ts:94,256,310-338,437-468` reads boxes but not `/Rotate`. Embedded page content does not inherit the page dictionary rotation. A 200 by 400 page with `/Rotate 90` produced portrait A4 instead of landscape. **Reproduced**. Closed #143 fixed missing `/Contents`, not rotation.

Red test: render a rotated marker through single and facing transformations and assert upright geometry and correct auto orientation.

### O15. P1: browser page operations erase hierarchical page labels

`native/pdf-page-ops/src/page_tree_ops.rs:501` handles only root `/Nums` and never traverses `/Kids`. `browserPageOpsCore.ts:182-261` copies pages but does not preserve labels. Valid number-tree labels disappear after browser reorder, insert, or delete. Static, missed variant of closed #119.

### O16. P2: browser reorder and insert lose current page identity

`createBrowserPageOpsCapability.ts:350,476,581` returns only success and page count. `usePageOpsHandlers.ts:235` remaps only when a delta exists, while desktop returns one in `pageOpsMainBindings.ts:531`. Browser reload uses the old numeric page in `createPdfViewportSession.ts:675`. Static.

### O17. P1: PDF open can exhaust the worker while reading page labels

`usePageLabelState.ts:97-118,181-198` calls dense pdf.js `getPageLabels()` before applying its 200-page compatibility limit. pdf.js `pdf.worker.mjs:40367-40441` allocates every label and builds alphabetic labels with repeated strings. A 150,000-page alphabetic range creates about 433 million characters, roughly 825 MiB before array overhead and cloning. The million-page unit test only drops the array after it returns. Static with calculated bound.

Red test: xlarge synchronization must not call the dense API.

### O18. P2: sparse continuous layout still scans the whole document synchronously

`loadPrioritizedDocumentPageMetrics.ts:158-178` becomes sparse only above 100,000 pages, but `useDocumentPageSourceRuntime.ts:163-182,312-320,385` computes total height through `pageTops.at(-1)`, which walks every preceding page. A one-million-page harness counted one million reads and 108 ms before Vue work. **Reproduced**.

### O19. P1: opening a large DjVu probes every remaining page with a native process

`documentPageSourceFeaturePackState.ts:383-428` starts whole-document hydration after the first visual. `loadPrioritizedDocumentPageMetrics.ts:301-345` keeps four workers going to the end; `createDjvuPageSource.ts:68-103,277-287` retains all sizes; each cache miss launches `djvused` through `pagePreview.ts:300-325`. The existing 40,000-page test requires 39,999 calls. **Pinned**.

Red test: after several idle scheduler turns, requests must remain within visible and bounded priority windows.

### O20. P2: outline loading serially resolves every destination and cannot cancel stale work

`PdfOutline.vue:731-800` checks staleness only after resolution. `pdfOutlineHelpers.ts:337-527` walks every entry and awaits destination, page index, and page calls serially. A 10,000-item outline can require 20,000 worker roundtrips, and switching documents does not stop it. Static.

### O21. P2: PDF cache and page-label compatibility limits occur after expensive work

This is the shared design defect behind O06 and O17: bounds in application state do not help when the underlying pdf.js API must first materialize a dense result. New tests should assert calls and allocations, not only the final sparse collection shape.

### O22. P2: active streamed PDF saves time out after ten total minutes

`packages/contracts/documentPersistenceFrames.ts:14-18` defines negotiated timeouts, but `electron/features/documents/createDocumentsPreloadFileClient.ts:94-99,505-520,603-704` arms its final-result timer when the port is created, before byte production and upload, and never refreshes it on acknowledged progress. Main refreshes its own inactivity timer on every frame in `serializedPdfPersistence.ts:190-200,274-281,885-959`. A healthy slow save with every chunk under the 60-second ACK bound still fails at ten total minutes. Static.

Red test: advance a chunk generator in sub-60-second acknowledged steps for more than ten minutes, then deliver the result. The save must succeed and honor the negotiated inactivity timeout.

## 4. Print, export, image, and DjVu correctness

### E01. P1: DjVu export can overwrite an unselected sibling `.png`

`electron/features/image-export/main/ipc.ts:204-212,289-365` lets users choose JPG or TIFF, but `djvuImageExport.ts:130-137,224-259` replaces the extension with `.png` and atomically replaces that sibling without a second confirmation. Static.

Red test: choose `name.jpg` while `name.png` exists and require confirmation or collision-safe naming before any replacement.

### E02. P1: normal RGBA PNG input fails strict native and single-input browser WASM paths

`tryCreatePdfWithNativeImageCombiner.ts:73-79,129-137,334-346` and `native/evb-raster-io/src/lib.rs:777-824` accept grayscale or RGB only. Browser worker `browserPdfCombine.worker.ts:241-275` treats single-input WASM failure as fatal instead of falling back. A common transparent PNG therefore cannot become a PDF in those paths. Static, adjacent to broad issue #169 but a concrete missing case.

Red test: import an ordinary RGBA PNG through desktop and single-input browser paths and require preserved or explicitly composited output.

### E03. P2: mirrored EXIF orientations are collapsed to normal

`imageDpi.ts:176-219` and `browserRasterImageMetadata.ts:124-158` do not preserve mirrored orientations 2, 4, 5, and 7. Combiner and fallback paths in `tryCreatePdfWithNativeImageCombiner.ts:399-409`, `pdfCombineShared.ts:428-475,590-625`, and `appendPdfImagePage.ts:7-55` therefore output wrong geometry. Static.

### E04. P2: TIFF Orientation is ignored

Both Rust `native/pdf-image-combine/src/tiff_io.rs:90-179` and JS `iterateDecodedTiffFrames.ts:147-191` read pixels without applying orientation before `pdfCombineShared.ts:628-665`. Static.

### E05. P2: generated multi-page TIFF discards physical resolution

`combinePagesIntoMultiPageTiffLocal.ts:254-374` and `packages/pdf-core/tiffEncoding.ts:19-58` hardcode X and Y resolution to 1 and unit unknown. Native `tiff_io.rs:251-273` does the same. A 300 DPI source becomes physically undefined. Static.

Red test: combine two 300 DPI pages and require tags 282 and 283 equal 300 and tag 296 equal inches.

### E06. P1: DjVu facing-page and orientation choices are ignored

`electron/features/djvu/main/pdfExport.ts:708-796` uses view mode and orientation only to select the print surface. It never transforms the converted PDF. Three source pages still produce three sheets in facing mode, and forced orientation does nothing. Static, related to but not fixed by #127.

### E07. P1: DjVu raster printing forces every page to the first page's dimensions

`electron/utils/printHandoff.ts:249-289` parses only pdfinfo's first-page size. `buildRasterPrintHtml` at lines 360-413 emits one global page size and uses the first page for aggregate admission at 459-461. Mixed orientation or size is letterboxed and large later pages can bypass the intended pixel budget. Static.

Red test: print portrait A5 followed by landscape A3 and preserve per-page output geometry, or fail closed before rasterizing.

### E08. P1: PDF image export renders MediaBox instead of CropBox

`electron/features/image-export/main/export.ts:645-680` invokes `pdftoppm` without `-cropbox`, affecting PNG, JPEG, TIFF, and selected-page export. Hidden margins and content outside the visible crop appear, with wrong pixel dimensions. Static.

Red test: a 600 by 800 MediaBox with a 300 by 400 CropBox at 72 DPI must output 300 by 400.

### E09. P1: canceled or failed split DjVu TIFF export leaves completed parts behind

`djvuImageExport.ts:284-357` promotes each eight-page part immediately. Later abort or failure throws without deleting prior `outputPaths`; the rejected IPC never gives the caller those paths. A failed ten-page export can leave a plausible but incomplete part 1. Static.

Red test: fail page 10 after part 1 promotion and require absence of every new part.

### E10. P2: exported PNGs lose their planned DPI

`export.ts:351-380,645-680` renders at the requested resolution but neither native nor JS PNG encoder receives DPI. `native/evb-raster-io/src/lib.rs:298` emits no `pHYs`. Static.

Red test: 300 DPI export must contain about 11,811 pixels per metre on each axis.

### E11. P2: valid long export names fail only after expensive rendering

`image-export/main/ipc.ts:289` reserves no suffix space. `export.ts:900` appends `-001`; `djvuImageExport.ts:130` appends `-page-001` or `-part-001`; `imageExportPathPlanning.ts:10` can append another collision suffix. A valid 255-byte selection becomes `ENAMETOOLONG`. Static.

Red test: deterministically truncate by UTF-8 bytes before rendering and keep every generated component within 255 bytes.

### E12. P1: valid long filenames can fail during ordinary open

`workingCopyCreation.ts:98` preserves the full basename, `documentRevisionSidecar.ts:74,493` appends revision and temp suffixes, and `workingCopyCreation.ts:195` aborts open on failure. A 204-byte basename produced a 269-byte component and `ENAMETOOLONG`. **Reproduced**. Windows backup naming in `atomicReplace.ts:294` has the same suffix-budget issue.

### E13. P1 conditional: case-sensitive Windows directories map two documents to one working copy

`workingCopyStore.ts:142,333` lowercases all drive and UNC paths, even under Windows per-directory or share case sensitivity. A probe registered `Report.pdf` and `report.pdf`; both lookups returned the second working copy. Original-path page operations use the mapping at `pageOpsMainBindings.ts:300`. **Reproduced**.

### E14. P2: Open Folder sorts numbered pages lexically

`documentOpenHandlers.ts:69,278` sorts raw basenames, so `page-1.png`, `page-10.png`, `page-2.png` becomes the PDF page order. Static.

### E15. P2: folder import silently drops symlinked files

`documentOpenHandlers.ts:55` accepts only `Dirent.isFile()`. A symlink to a regular PDF or image is silently omitted on macOS and Linux; an all-symlink folder reports empty at line 274. Static.

### E16. P2 conditional: byte-identical cloud refresh blocks later saves

`workingCopyStore.ts:189` records identity metadata, and `originalPathSaveWitness.ts:61,457-473` rejects identity changes before a content fingerprint can prove equality. A cloud client that atomically replaces a file with identical bytes causes "Original file changed on disk". Static.

### E17. P3: valid POSIX filenames ending in whitespace are altered or rejected

`normalizePossiblyEncodedExistingPath.ts:31` trims before probing. A real `report.pdf ` normalized to null in a probe. `documentDialogCommon.ts:109` can append another `.pdf`. **Reproduced**.

### E18. P2: DjVu image export and print cleanup can replace success with failure

This audit found several raw cleanup awaits after output publication. `scan-cleanup-core/detection.ts:1679-1699` can orphan a transferred result store, and `renderScanCleanupRasterBatch.ts:117-130` can reject a successful Poppler raster batch if final directory removal fails. The same transaction rule should apply across export: publish success first, then make scratch cleanup best effort and observable.

## 5. OCR, scan cleanup, workers, and assistant runtime

### A01. P1: assistant chat history disappears after one hour of inactivity

`assistantChatSessionStore.ts:84-86,238-263,283-342` uses a one-hour TTL, archives an expired session before lookup, and creates a new empty session. Runtime state loading in `codexAssistant.ts:257-262,757-762` triggers this during ordinary use. No runtime archive reader exists in `assistantChatPersistence.ts:606-670`. A probe advanced time, reopened the same scope, and got a new session with no messages plus one expired archive. **Reproduced**. Current user data contained 12 session files and 28 archives, metadata only inspected.

Red test: fake time beyond TTL and require ordinary scoped reopen to retain visible history unless the user explicitly resets it.

### A02. P1: assistant `maxSessionBytes` is not enforced

`assistantChatPersistence.ts:59-60,286-308,753-759,816-853` compacts by rewriting the same oversized latest snapshot. Upstream permits eight 10 MiB images through `packages/contracts/agent.ts:608-619` and `assistantImageAttachments.ts:107-168`, with no aggregate message/history budget. A 65,536-byte cap produced 100,581 bytes after compaction and 100,677 after the next snapshot. **Reproduced**.

### A03. P2: assistant archives grow without retention

`assistantChatPersistence.ts:585-598,656-669,906-946` and `assistantChatSessionStore.ts:238-280,447-450` archive expiry, eviction, reset, and corruption indefinitely. `maxSessions` applies only to the sessions directory. Static.

### A04. P1: assistant persistence and shutdown report success after transcript failure

`assistantChatPersistence.ts:691-703,745-813` deletes the pending snapshot before append, catches write and maintenance rejection, and lets flush resolve. `codexAssistant.ts:1332-1344` then quits normally after lost messages. A partial append followed by success can create an interior malformed record that quarantines the whole transcript at lines 855-918. Static.

Red test: make the log path a directory, require flush rejection and retained pending state, repair the path, flush, restart, and recover the message.

### A05. P1: concurrent Assistant sends can bind one turn's tools to another document

`codexAssistant.ts:950-968,1058-1071` checks conflict before asynchronous runtime and thread startup. `createAssistantSessionTurnCoordinator.ts:43-57` claims only afterward. `assistantMcpSessionScope.ts:27-45` has one global binding and `mcpServer.ts:723-725` snapshots whatever binding exists when a tool arrives. Two windows can both pass admission and the second overwrites the first. Static.

Red test: gate two distinct thread starts and require exactly one send to succeed and one to return busy.

### A06. P1: failed Claude interrupt relabels old output as the replacement turn

`claudeAgentSdkAssistant.ts:927-940,1082-1178` swallows interrupt failure and completes locally. Later SDK events use mutable current turn and message IDs. `codexAssistant.ts:598-682,1199-1211` accepts them as the new turn after another send. Static.

Red test: reject interrupt, start turn B, emit late A delta and result, and require B to receive neither.

### A07. P2: malformed successful `turn/start` leaves chat permanently active

`codexAssistant.ts:1102-1129` accepts any record, treats missing `turn.id` as optional, publishes success, and leaves the owner in `starting`. Later sends stay busy. Static.

### A08. P2: stale Codex notifications mutate current state before fencing

`createAssistantAppServerNotificationController.ts:352-395,556-566` writes usage and error state before checking the notification's turn. Late turn A completion can overwrite turn B usage or errors even when the event is later dropped. Static.

### A09. P1: automatic Codex replacement leaves a phantom turn and MCP owner

`assistantRuntimeLifecycle.ts:222-243` directly supersedes turn ownership and nulls its local binding instead of using `createAssistantSessionTurnCoordinator.ts:138-147`, which cancels presentation and synchronizes global MCP state. A path or version refresh can leave the panel streaming and other documents busy. Static.

### A10. P1: Reset Chat does not cancel captured Electron tool work

Explicit Interrupt calls `abortActiveEmbeddedMcpRequests` at `codexAssistant.ts:1192-1199`. Reset branches at lines 1256-1321 interrupt the provider and clear transcript without it. Clearing the global binding does not abort controllers that already captured the scope. Static.

### A11. P1: provider-session replacement preserves visible history but sends a blank conversation

Codex exit clears thread IDs but retains messages in `createAssistantAppServerNotificationController.ts:590-600`; the replacement thread at `assistantRuntimeLifecycle.ts:480-512` receives only the new prompt. Claude effort or Fast changes recreate an ephemeral SDK session in `codexAssistant.ts:686-752` and `claudeAgentSdkAssistant.ts:970-1001`, again with only the latest prompt. The UI still displays persisted history. Static.

### A12. P2: Assistant login flows lack single ownership and completion correlation

`codexAssistant.ts:843-916` lets each login overwrite global pending ID and return window. Browser-open and cancel failures leave provider flows alive. `createAssistantAppServerNotificationController.ts:301-315` accepts completion without matching login ID. Older flows can clear or focus newer ones. Static.

### A13. P2: Claude model switch keeps the previous model's Fast-mode options

`assistantSelectionState.ts:27-30,61-78` derives speed modes from old provider status, and `useAgentAssistantPanelController.ts:734-746` applies it without refresh. Opus can lack Fast or Sonnet can retain it until later normalization. Static.

### A14. P2: Claude reset can wait forever before process close

`claudeAgentSdkAssistant.ts:927-940` directly awaits SDK interrupt. Reset and stale-scope cleanup await it without the bounded helper at `codexAssistant.ts:471-482,1256-1278`. Explicit Interrupt already uses a five-second bound at 1192-1211. Static.

### A15. P1: OCR forgets a Worker after termination timeout

`ocrJobWorkerLifecycle.ts:227-296` catches timeout or rejection from `worker.terminate()` and finalizes anyway. `jobManager.ts:242-245,926-947` releases resource and admission leases and treats shutdown as settled. A live Worker and native descendants become untracked and later jobs can exceed caps. Static.

### A16. P1: Tesseract erases failed process-tree termination proof

`ocr/worker/tesseractRunner.ts:187-190` converts the boolean termination result to void. Lines 216-228 and 332-341 delete output and report normal cancel or timeout even if the process tree is still alive. Existing `ocrWorkerTesseractRunnerAbort.test.ts:71-98` pins settlement while termination never resolves. **Pinned**.

### A17. P1: native image combiner cleans scratch after unproven termination

`tryCreatePdfWithNativeImageCombiner.ts:658-673` settles without inspecting termination proof, with a three-second fallback. Enclosing paths at 449-523 remove input lists and output while the child may still use them. Static.

### A18. P1: document utility assumes a process group it never creates

`fingerprintFileWithUtilityProcess.ts:36-52` uses `utilityProcess.fork` without a detached group, then asks `processTree.ts:161-164` to terminate a preferred process group. If negative-PID liveness returns `ESRCH`, the helper can report success before direct-PID fallback. The caller ignores false proof at lines 53-65. Static.

### A19. P2: OCR cancel can settle while detached Tesseract remains alive

`ocrJobWorkerLifecycle.ts:164-183,227-295` posts cancel, waits only 250 ms, then terminates the Worker. `tesseractRunner.ts:33-34,187-190` and `processTree.ts:181-197` allow a two-second native escalation. Worker termination can interrupt it. Static, overlaps A16 at a separate boundary.

### A20. P2: renderer destruction detaches unrecoverable OCR work and results

`ocr/jobManager.ts:714-725` chooses detach for renderer loss. Registry and pending-result ownership remain tied to the dead `webContentsId` in `createMainJobRegistry.ts:212-319` and `createPendingResultFileStore.ts:129-187`. `cleanupForSender` has no caller. Work can continue and results remain for 15 minutes but no replacement renderer can claim them. Static.

### A21. P2: bundled OCR models cannot self-heal offline

`ocr/languageModels.ts:498-582,814-860,927-951` trusts a current seed marker without checking runtime files, caches successful seeding, and goes straight to network download after deleting an invalid runtime model. Missing or corrupt English/Russian cannot be restored from the intact packaged copy while offline. Existing test at `ocrLanguageModels.test.ts:154-165` pins skip-on-marker. **Pinned**.

### A22. P2: installed OCR model corruption after the header is accepted

`ocr/languageModels.ts:395-496,702-718,953-963` validates only header offsets for installed files. SHA-256 is checked only for a new download. Bitrot that preserves the table and file size remains installed. Static.

### A23. P2: advertised Tesseract modes cannot produce usable output

`packages/contracts/agentOcr.ts:72-76` accepts PSM 0 through 13. `tesseractRunner.ts:72-76` forwards them, but packaging includes only English and Russian, not `osd.traineddata`. A focused probe found PSM 0 and 2 produced no PDF or TSV; 1 and 12 warned about missing OSD. **Reproduced**.

### A24. P2: toolbar and agent DOCX export lose RTL metadata

`WorkspacePdfToolbarView.vue:549-555`, `useDocumentWorkspaceAgent.ts:890-895`, and `useDocxExport.ts:25-49` call export without OCR languages. `exportTextAsDocx.ts:102-125` and `docxStreaming.ts:183-190` then omit bidi and RTL properties for Arabic, Hebrew, or Syriac OCR. Static.

### A25. P2: failed manual OCR cancellation becomes a clean canceled UI

`useOcr.ts:149-207` catches backend cancel failure, then its five-second timer marks canceled, clears the listener, and removes the active request. `useOcrPopupPresenter.ts:633` discards the returned failure. The backend may still run while the popup returns to Configure with no error. Static.

### A26. P2: scan worker error during cancellation drops quarantine evidence

`electron/utils/workerTask.ts:475-514` knows forced Worker termination cannot prove detached children stopped, but its cancellation error and exit branches at 626-679 reject the raw abort reason and clear the cooperative timer. `createScanCleanupService.ts:742-749` therefore misses working-copy quarantine. Static.

### A27. P2: scan detection cleanup can replace success and orphan the result store

`scan-cleanup-core/detection.ts:1679-1699` marks the store transferred before fallible close and removal awaits. A cleanup rejection overrides the successful return, but the store is no longer closed. The caller in `createScanCleanupPreviewService.ts:3999-4033` never receives ownership. Static.

### A28. P2: final Poppler directory removal invalidates a successful raster batch

`renderScanCleanupRasterBatch.ts:117-130` prepares successful output, then an `rm` in `finally` can override it. Conversion cleanup already treats the equivalent failure as best effort in `runScanCleanupConversion.ts:3397-3405`. Static.

### A29. P2: scan settings migration short-circuits legacy merge

`createScanCleanupSettingsStore.ts:429-434` uses `changed ||= mergeLegacyStorage(...)`. If pruning already changed state, short-circuiting skips migration. Renderer `scanCleanupPreferencesStore.ts:185-200` then clears legacy storage after the reported success. Static.

### A30. P2: anisotropic DPI can understate raster pixels by half

`sourceDpiDetection.ts:160-233`, `effectiveOptions.ts:213-249`, and `runScanCleanupConversion.ts:2265-2274,2516-2559` collapse X and Y DPI to the maximum scalar while retaining original dimensions. A 9600 by 4800, 600 by 300 PPI page is planned as 46.08 million pixels but `pdftoppm -r 600` emits 92.16 million, crossing an 80 million guard only after rendering. Static with numeric proof.

### A31. P3: accepted scan settings can fail the operation contract

`scanCleanupSettings.ts:210-219,326-368` accepts fractional `thickness`, but `ipcRequestCodecs.ts:626-681` and Rust `options.rs:471-475` require an integer. TypeScript also allows 129 polygons times 64 points on one page while Rust caps the page at 8,192 points. Static.

### A32. P3: persisted cutter endpoints 0 and 1 become one-pixel leaves

`ipcRequestCodecs.ts:371`, migration `v1.ts:144-173`, and Rust `split.rs:570-612` accept endpoints that the pointer UI limits to 0.02 through 0.98. Static.

### A33. P2: Codex shutdown reports stopped after termination is unconfirmed

`electron/features/agent/codexAppServerClient.ts:287-297` correctly throws when process-tree termination cannot be proven. `assistantRuntimeLifecycle.ts:222-244` catches the error, clears ownership, drops the client, and publishes stopped anyway. A replacement runtime can start while an old descendant remains alive. Static.

Red test: return false from detached termination and require shutdown failure or restart refusal until liveness is resolved.

## 6. Release, update, web, and CI

### R01. P1: stale committed WASM can ship

`package.json:29,122`, `scripts/release/policy.mjs:397-419`, and CI at `.github/workflows/ci.yml:971-973,1120-1122` use portable freshness. `scripts/check-wasm-freshness.mjs:121-149` detects byte differences but fails only in strict mode. `wasmFreshness.test.ts:190-220` explicitly accepts `fresh:false`. Rust behavior can change while exports stay the same and stale browser/Electron WASM still passes release. **Pinned**.

### R02. P1: Windows ARM64 installer ships after installed-app journey failure

`.github/workflows/build-target.yml:344-364` makes the NSIS installed journey advisory, while artifact readiness at 522-542 depends on upload. `release.yml:951-1005` attaches it anyway. Static.

Red gate: a failed installed journey must set `artifact_ready=false`, or a deterministic blocking installation and launch test must replace the flaky UI step.

### R03. P1: Store AppX packages are never installed or launched

`.github/workflows/store-appx.yml:65-175` unpacks and inspects but never runs `Add-AppxPackage`, starts the registered application, performs a PDF smoke, or uninstalls. Registration, identity, activation, and installed resource failures can ship. Static.

### R04. P1: Store versus direct-download parity covers only `app.asar`

`scripts/release/build-provenance.mjs:17-59` compares commit, version, arch, lockfile, and `app.asar`. `submit-store-appx.yml:71-85` trusts it. Native tools, DLLs, OCR models, and global resources can differ while parity passes. Static.

### R05. P1: supplemental release assets are mutable under one tag

`scripts/release/policy.mjs:1-18` excludes Intel ZIP and Windows ARM64 assets from `SHA256SUMS`; `release-checksums.mjs:49-76` tolerates that; `release.yml:919-929,994-1005` uploads with `--clobber`. Repair reruns can replace public bytes under the same version. Static.

### R06. P1: landing advertises mirror URLs for assets the mirror omits

`publish-release-mirror.mjs:56-63` filters supplemental assets. `latest.get.ts:68-80` nevertheless emits mirror URLs for every installer, and `landing/app/pages/index.vue:193-201` renders them. Tests pin mirror exclusion. macOS Intel and Windows ARM64 mirror links are guaranteed 404s. **Pinned**.

### R07. P1: mirror activation can split distribution with no rollback

`release.yml:788-853` moves stable mirror first and publishes GitHub draft second. `publish-release-mirror.mjs:121-126,264-309` overwrites the pointer and has no rollback. Later GitHub promotion or pruning failure leaves updater clients on a version the public catalog has not promoted. Static.

### R08. P1: production web deploy can include dirty and untracked source

`scripts/deployVercelPrivate.mjs:32-52,156-197` recursively copies the checkout with a hard-coded exclusion set, not Git-tracked HEAD. `deployVercelPrivate.test.ts:166-199` confirms ordinary new files ship. No cleanliness or commit gate exists. **Pinned**.

### R09. P1: production alias updates without automated acceptance or rollback

`package.json:24-27` calls the helper with `--prod`. `deployVercelPrivate.mjs:219-280` promotes immediately and returns only process status. Route, database, and retention checks remain manual in `docs/contributing/vercel-deploy.md:38-50`. Static.

### R10. P2: desktop rollout identity is resampled on every check

`landing/server/api/releases/latest.get.ts:41-55,192-197` uses a 90-day cookie. `electron/updates.ts:243-264` uses bare Node fetch and neither stores nor sends it. A two-request probe observed incoming Cookie headers `[null, null]`. At a 10 percent canary, 28 independent polls give about a 94.8 percent chance of at least one canary selection. **Reproduced**.

### R11. P1: updater failover bypasses withdrawal, rollback, and canary policy

`electron/updates.ts:243-270,291-308,653-707,789-829` treats mirror stable and then mutable GitHub latest as alternate version authorities when landing policy is unavailable. Mirror stable has no withdrawn tags or cohort. Existing `updates.test.ts:520-582` pins GitHub and mirror selection. An emergency withdrawal can be undone during a control-plane outage. **Pinned**.

### R12. P2: newer manual-install release is reported as up to date

When landing selects a newer version but neither feed contains `latest.yml`, `updates.ts:689-706` returns `shouldCheck:false`. Lines 807-829 map that to `no-update`, and `packages/i18n-app/messages/en.ts:1440` says the user has the latest version. Existing test at `updates.test.ts:633` pins it. **Pinned**.

### R13. P2: one failed feed and one 404 are treated as confirmed feed absence

`updates.ts:310-334` throws only when both probes are errors. One timeout plus one 404 returns false and reaches the false up-to-date state. Static.

### R14. P3: update UI drops precise unsupported-runtime reasons

`updates.ts:187-270,734` supplies Store, architecture, and signing reasons. `useAppShellUpdatesDialog.ts:68` replaces all with generic unsupported text. Static.

### R15. P3: download and install failures are labeled check failures

`updates.ts:871,984,1022` uses one error phase for later-stage failures. `messages/en.ts:1442` always says the check failed. Users receive the wrong recovery instruction. Static.

### R16. P2: private deploy can include gitignored local files

`deployVercelPrivate.mjs:36,176` and `check-web-deploy-source.mjs:143` do not align with `.gitignore` and `.vercelignore`. A gitignored root `*.tmp` was copy-eligible at audit time. This overlaps R08 at a narrower source-selection seam. Static.

### R17. P2: analytics drops batches on persistence failure hidden behind HTTP 200

Client `useAnalytics.ts:225-246` checks only response status. `landing/server/api/events.post.ts:42-91` can return 200 with `{ok:false,persisted:false}`. The client deletes the batch instead of retrying. Historical SRV-1 documented the same class, but no open issue remains. Static.

### R18. P2: landing privacy requests point users to public GitHub issues

`landing/app/pages/privacy.vue:50`, `landing/app/locales/en.ts:55`, and `app/pages/privacy.vue:43` direct deletion or privacy requests to public issue creation. Users can publish personal details. This is a privacy UX defect, not a security audit. Static.

### R19. P3: download analytics races cross-origin navigation

`landing/app/utils/analytics.ts:15` sends an unawaited request without keepalive. Download links in `index.vue:162,193` navigate cross-origin immediately. The event can be canceled and response persistence is ignored. Static.

### R20. P2: coverage gate can false-red on an unreachable push base

CI `.github/workflows/ci.yml:137-141,201-206` invokes `checkZeroExecutionCoverage.ts:109-130`, whose `git diff base...head` has no unrelated-history handling. The changed-area classifier already handles this safely in `classify-changed-areas.mjs:82-113`. Static.

### R21. P2: `tests/unit/landing` is excluded from all Vitest and TypeScript projects

`vitest.shared.config.ts:45,180-183,241-305`, package scripts, and `tests/tsconfig.json:14-17` leave that path outside every current test/typecheck project. No tracked tests currently live there, so this is a latent placement trap rather than a present red suite. Static.

## 7. Accessibility and user-interface reachability

### U01. P1: tagged PDF semantics are discarded

`PdfViewerPage.vue:2-36` creates unlabeled page containers and a raw text-layer div. `usePdfTextLayerRenderer.ts:779` renders only pdf.js `TextLayer`. No app code calls `getStructTree` or an equivalent structure layer. Headings, lists, tables, page boundaries, and authored reading order become flat positioned text. Static.

Red test: render a tagged fixture and inspect the accessibility tree for page labels and authored structural roles.

### U02. P1: Crop and Copy Region are pointer-only after keyboard activation

Toolbar buttons are keyboard reachable in `PdfToolbar.vue:203`, but `PdfCropOverlay.vue:2`, `PdfRegionSnipOverlay.vue:2`, `usePdfCropSelection.ts:127`, and `usePdfRegionSnip.ts:116` expose only pointer coordinates. Escape cancels, but no keyboard can create or commit a rectangle. Static.

### U03. P1: page reordering has no keyboard path

`PdfThumbnails.vue:53` begins reorder only on mousedown. `usePageDragDrop.ts:401` uses mouse movement and mouseup. `PdfPageSelectionBar.vue:10` has no move action. Static.

### U04. P1: keyboard users cannot toggle a thumbnail selection directly

The only direct toggle is an `aria-hidden` span in `PdfThumbnails.vue:31`. `usePdfThumbnailSelection.ts:390` maps both Enter and Space to navigation. Existing `usePdfThumbnailSelection.test.ts:257` explicitly expects Space not to select. This blocks selection-dependent rotate, extract, export, and delete. **Pinned**.

### U05. P1: cancelable DjVu conversion overlay is not a modal or focus-managed surface

`DjvuConvertDialog.vue:520` closes before conversion. `DjvuConversionOverlay.vue:1` uses `AppProgressOverlay.vue:1`, whose wrapper is only `role=status`, with no focus entry, containment, inert background, Escape action, or restoration. Cancel can require tabbing through the workspace. Static.

### U06. P2: keyboard context menu leaves focus in the thumbnail list

`PdfThumbnails.vue:48` can open on keyboard context-menu action, but `PdfContextMenuBase.vue:1` is a plain div and `usePositionedMenu.ts:77` only positions it. Arrow, Enter, and Space continue operating the thumbnail list. Static.

### U07. P2: tab strip exposes invisible close buttons and lacks tablist navigation

`TabBar.vue:3,32,444,623` leaves inactive close buttons at opacity zero but tabbable. It lacks tablist semantics and Arrow, Home, and End behavior; its keyboard handler covers Enter and Space only. Static.

### U08. P2: failed settings load can cause one later edit to overwrite all defaults

`useSettings.ts:66-121`, `usePlatformHydratedState.ts:99`, `settingsPersistenceQueue.ts:42-97`, and `app.vue:495` leave `lastSaved` null after load failure. A later edit builds a full default-derived patch. This renderer path compounds S01. Static.

### U09. P2: ordinary settings-save failures are invisible

`useSettings.ts:121` and `settingsPersistenceQueue.ts:92` track retry and error, but `SettingsContent.vue:202` does not consume them except for the assistant toggle around line 480. Most settings look saved until restart. Static.

### U10. P3: runtime diagnostics are hard-coded English

`useAppShellTabLifecycle.ts:109`, `rendererErrorGuard.client.ts:123`, and `app.vue:46` bypass the localization catalog for user-visible failures. Static.

### U11. P2: browser Firefox back navigation loses the live workspace offline

`runtimeErrorLogStream.client.ts:109` and `useShutdownSaveFlushReporting.ts:41` install unconditional `beforeunload`. Firefox excludes such pages from BFCache. `browserWindowTabs.ts:732` implements BFCache restore, but `nuxt.config.ts:92,308` marks the shell no-store and there is no service worker. Clean Back while offline reloads or fails instead of restoring. Static, supported by MDN's documented Firefox behavior.

## 8. Additional lower-severity contract gaps

1. Scan-cleanup persisted cutter endpoints accept 0 and 1, unlike pointer UI limits, and can produce one-pixel leaves. See `ipcRequestCodecs.ts:371`, migration `v1.ts:144-173`, and Rust `split.rs:570-612`.
2. Fractional scan `thickness` is valid in persisted settings but invalid at operation start. See `scanCleanupSettings.ts:326-328` and `ipcRequestCodecs.ts:657-660`.
3. TypeScript permits 8,256 manual-zone vertices on one page while Rust caps 8,192. See `inputLimits.ts:102-110`, `ipcRequestCodecs.ts:427-479`, and Rust `options.rs:736-750`.
4. Exact cleanup failures can override otherwise successful scan detection and raster batches, as detailed in A27 and A28.
5. PNG and TIFF physical-resolution metadata defects affect interoperability even when pixel dimensions are correct, as detailed in E05 and E10.

## 9. Audited paths that appeared sound

The audit did not find a separate high-confidence defect in these areas:

- normal picker cancellation and File System Access abort handling;
- PDF.js blob URL revocation and ordinary worker URL construction;
- normal IndexedDB chunked reads, aside from cross-window ownership and revision consistency;
- browser dirty `beforeunload` warning itself, aside from Firefox BFCache exclusion;
- renderer IPC codec validation, duplicate-handler detection, and typed listener teardown;
- desktop tab-transfer late-ACK handling;
- external-open startup claim, acknowledgement, and requeue;
- DOCX port commit/cancel fencing;
- registered search-job cleanup before the unregistered-cancel and ordinary-retirement gaps;
- scan-cleanup manifest option mappings, coordinate systems, progress/result envelopes, staged native publication, and packaged worker paths;
- OCR language registry, pinned download revision, first-download checksums, Poppler argument arrays, page-selection validation, and apply-time ownership/revision/result hash checks;
- macOS signing and notarization order, signed-DMG launch checks, and the core public build matrix;
- exact-version alternate download origins after landing policy has already selected a tag;
- landing release API cache headers and per-request cohort selection for real browser clients;
- QPDF argument arrays and tracked-path Unicode normalization collisions;
- provider-specific assistant model preferences, renderer event fences, explicit Interrupt generation matching, and normal full assistant shutdown.

## 10. Verification performed

Agents ran focused existing suites throughout the audit. Reported green sets included:

- browser document paths: 9 files, 130 tests;
- release scripts and policies: 4 files, 26 tests;
- updater and rollout policy: 32 tests;
- settings and migrations: 7 files, 45 tests;
- path handling: 3 files, 49 tests;
- viewer navigation: 22 tests;
- page operations: 65 TypeScript tests plus Rust tests;
- operations and concurrency: 97 tests;
- landing and server: 94 tests plus deploy-source and Drizzle checks;
- frontend state: 49 tests;
- packaging and update lane: 129 tests;
- search lane: focused worker and contract suites;
- assistant persistence probes for TTL and size-cap failure;
- direct probes for regex hang, rollout cookies, rotated print geometry, browser external-save overwrite, late close commit, mixed browser ranges, volatile storage, cross-window chunk deletion, quota leakage, handle reauthorization, long filenames, Windows case-fold collision, trailing-space path handling, large sparse layout cost, and OCR PSM behavior.

These green existing suites do not refute the findings. Many demonstrate missing cases, and several explicitly pin the unsafe current behavior. No full packaged Electron stress run or six-platform installation matrix was performed in this audit.

## 11. Backlog dedupe

The current open issue list was checked after the audit. It consisted mainly of annotation rewrite issues #150 and #161 through #196, plus #112, #131, #132, and #139. Annotation architecture was excluded. Exact duplicates retained in this report are clearly marked as known ledger items:

- EVB-RP-030: global desktop workspace checkpoint;
- EVB-RP-032: stale browser recovery snapshot;
- EVB-RP-033: browser cross-window Recent Files authority;
- EVB-RP-038: closed working-copy resurrection.

Issue #131 is adjacent to scan-cleanup bounds but does not cover the settings, DPI, cleanup, or cancellation failures here. Issue #132 is adjacent to sparse viewer work but does not cover dense page labels, full metric hydration, or uncancelable outlines. Issue #169 is adjacent to image-to-PDF architecture but does not state the RGBA, orientation, metadata, collision, or transaction failures above. Closed issues cited beside findings fixed related paths but not the reported seam.

## 12. Recommended order

1. Stop irreversible loss first: D01 through D05, D09 through D16, S01 and S02.
2. Fence wrong-document actions and global ownership: O01, O02, A05, A09, A10, D06, D12, D13, D19.
3. Make every write and flush fail closed: S03 through S10, A01 through A04, A27 and A28.
4. Bound workers and large-document paths: O08, O09, O12, O13, O17 through O20, A15 through A19.
5. Restore release authority: R01 through R13 before treating another release as fully promoted.
6. Fix output correctness: O14 through O16 and E01 through E17.
7. Treat keyboard and tagged-PDF failures as primary workflow defects, not polish: U01 through U07.

The durable pattern is consistent across most P1 findings: assign one explicit owner, retain evidence until the successor acknowledges it, and never turn an I/O error or timeout into absence or success.
