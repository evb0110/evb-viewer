# Project 6, ticket #333 registration-table inventory

Status: read-only preparatory inventory. This report is the only task-owned
path. It is not #333 implementation or completion.

## Inspection identity

- Checkout: `/Users/evb/.t3/worktrees/evb-viewer/t3code-cdb5c070`
- Branch: `t3code/main-registration-inventory`
- Inspected SHA: `c86dc691f1676c76194680973ff3537dc597a556`
- `origin/main`: `c86dc691f1676c76194680973ff3537dc597a556`
- Git common directory: `/Users/evb/WebstormProjects/evb-viewer/.git`
- Primary checkouts intentionally not touched: `/Users/evb/WebstormProjects/evb-viewer` and `/home/ubuntu/projects/evb-viewer`

Reproducible read-only commands:

```sh
cd /Users/evb/.t3/worktrees/evb-viewer/t3code-cdb5c070
git rev-parse HEAD origin/main --git-common-dir --show-toplevel
git status --short --branch
git show c86dc691f1676c76194680973ff3537dc597a556:electron/platform-ipc/registerFeatureIpcAdapters.ts
git show c86dc691f1676c76194680973ff3537dc597a556:electron/main.ts
rg -n 'ipcMain\.(handle|on)|registerPlatformFeatureHandlers|registerLazyPlatformFeature|MainBindings|prepare.*MainBindings|create.*MainBindings|shutdown|dispose' electron packages/contracts
```

The final status check was clean before this report was added. After adding
this report, the only expected change is this file.

## Proposed table

The table should contain one row per contract feature, with documents kept as
eight rows because `DOCUMENTS_CHANNEL_SET` combines them only for the adapter.
The proposed start order below follows the current registration order where it
is safe, then puts lifecycle-bearing providers after their prerequisites.

| Start order | Feature and current provider | Create / IPC hooks | Lifecycle hooks and notes |
| --- | --- | --- | --- |
| 1 | Documents picker | `openDocumentDialog`, `openCombineDialog`, `openFolderDialog`, `openImageDialog` | Eager `registerDocumentsIpcAdapter`; Electron dialog/window ownership. |
| 2 | Documents open | `openDocumentDirect`, `openDocumentDirectBatch`, `cancelOpenDocumentDirectBatch` | Same eager adapter; direct-open operations must exist before window-ready dispatch. |
| 3 | Documents working copy | `createWorkingCopyFromData`, `createWorkingCopyFromPath`, `parsePdfAnnotations`, `cleanupFile`, `cleanupOcrTemp` | Same adapter; sender cleanup and working-copy permissions are established here. |
| 4 | Documents files | File reads/stat/ranges, managed handles, revision and backing status, all file writes, structured save/resync/repair, PDF note/native mutation staging and commit methods | Same adapter; depends on operation lifecycle and serialized PDF persistence during shutdown. |
| 5 | Documents PDF | PDF conformance/validation, default-app open, print data/path/cancel | Same adapter; print handlers register sender cleanup. |
| 6 | Documents recent files | `getRecentFiles`, `removeRecentFile`, `clearRecentFiles` | Same adapter; recent-files cache/menu refresh is a startup dependency. |
| 7 | Documents window | `setWindowTitle`, `showItemInFolder` | Same adapter; depends on registered windows and trusted sender checks. |
| 8 | Documents menu | `setMenuDocumentState`, `setMenuTabCount` | Same adapter; depends on menu/window state. |
| 9 | Window tabs / core | Transfer, transfer ack, target listing, close current window, pending external-open claim/ack, workspace checkpoint save/discard/resume/claim/ack | `registerCoreIpcHandlers`; also owns renderer-ready, renderer-log, renderer-diagnostic bridges. Start after window registry and checkpoint services exist. |
| 10 | Agent | `getMcpIntegrationStatus`, `setMcpIntegrationEnabled`, assistant state/login/cancel, message/interrupt/reset, workspace snapshot and command-response submission | `createAgentService()` is eager, but `AGENT_PLATFORM_FEATURE` handlers are lazy-forwarded. #327 requires status reads not to initialize the provider. |
| 11 | Settings | `get`, `save` | `createSettingsMainBindings(agentService.shutdownAssistant)`; save flush can shut down the assistant, so start after agent service creation. |
| 12 | Shell | `openExternal` | `shellMainBindings`; sender rate limiting and cleanup registration are internal. |
| 13 | Updates | `getUpdateStatus`, `triggerManualUpdateCheck`, `downloadAvailableUpdate`, `installDownloadedUpdate`, `deferDownloadedUpdate`, `skipUpdateVersion` | Lazy import of `@electron/updates`; `initializeUpdates` is a separate startup hook. Shutdown must stop polling/downloads before final log flush. |
| 14 | Host | `snapshotHostEnvironmentForWindow`, `snapshotHostZenModeForWindow`, `setHostZenModeForWindow` | Lazy `hostMainBindings`; display watcher and window attachment are separate startup hooks. |
| 15 | Image export | `exportImages`, `exportMultiPageTiff`, `subscribeProgress` | Lazy `imageExportMainBindings`; operation progress and scratch cleanup must precede final working-copy cleanup. |
| 16 | Page operations | `delete`, `deleteRanges`, `extract`, `reorder`, `move`, `moveRanges`, `insert`, `insertFile`, `rotate`, `crop`, `removeCrop`, `getPageGeometry` | Lazy `pageOpsMainBindings`; queued document mutations depend on main-operation shutdown/drain. |
| 17 | OCR | `cancel`, `getLanguages`, `resolveDocumentTextCatalog`, `resolveDocumentTextCatalogWindow`, `resolveDocumentOcrAvailability`, `resolveDocumentOcrPage`, `acknowledgeResultFile`, `createSearchablePdf`, `subscribeProgress` | Lazy `ocrMainBindings`; `shutdownOcrJobManager` is a separate reverse-order hook. |
| 18 | Scan cleanup | Preview, detection, job start/cancel/state/subscribe/reconnect, output prune, settings get/update | Lazy import of `scanCleanupMainBindings`; current file constructs preview/service/settings objects at module evaluation. Recheck after #297 disposal wiring lands. |
| 19 | Search | `run`, `warmIndex`, `cancel`, `resetCache`, `subscribeProgress` | Lazy `prepareSearchMainBindings()`; it initializes/accesses the worker service. Stop workers before dependent scratch/working-copy cleanup. |
| 20 | DjVu | Open/await/release viewing, convert/await/print, cancel/state/subscribe, page preview, text search/cancel, info/source/sizes/text/outline, render, estimate, temp cleanup, progress subscription | Lazy `prepareDjvuMainBindings()`; it also schedules stale artifact pruning. Shutdown conversions and viewing cleanup before final file cleanup. |

The proposed order is a planning order, not a required numerical contract.
The current code registers documents and then the lazy features in the order
agent, settings, shell, updates, host, image export, page operations, OCR,
scan cleanup, search, DjVu. Registration installs validated channel stubs;
the provider import is deferred until the first invocation.

## Binding counts versus imports

These are measurements at the inspected SHA, not reduction gates.

- `electron/main.ts`: 842 physical lines, 58 import declarations.
- `electron/platform-ipc/registerFeatureIpcAdapters.ts`: 167 lines, 19 import declarations, 11 lazy feature registrations.
- `electron/platform-ipc/featureIpcAdapters.ts`: 1 line, no imports.
- `electron/platform-ipc/registerIpcHandlers.ts`: 15 lines, 4 import declarations.
- The adapter has 8 document feature registrations and 11 lazy feature registrations. The core adapter has 1 window-tabs registration.
- The binding count is the number of callable methods exposed by the contracts, not the number of imports. The non-document rows above expose 11 agent, 2 settings, 1 shell, 6 updates, 3 host, 3 image-export, 12 page-ops, 9 OCR, 14 scan-cleanup, 5 search, and 21 DjVu methods, excluding broadcast-only events. The shared documents `featureBindings` object has 71 concrete binding keys at this SHA, while four DOCX stream methods are additional adapter-local handlers.
- Event subscriptions are not callable binding methods. For example, progress and state events have subscribe methods where the contract declares them, but broadcast-only events have no main binding.

Arbitrary line or import reductions must not be treated as acceptance gates.
The useful measure is whether each declared method, lazy boundary, lifecycle
dependency, and security exception remains accounted for.

## Raw-handler inventory outside the table

These registrations are intentionally outside the feature table because they
are process bridges, streaming ports, or Electron lifecycle events rather than
ordinary validated request/response feature methods.

- `electron/platform-ipc/registerCoreIpcHandlers.ts:90-126`, diagnostics canary. It is automation-only, trusted-sender checked, and intentionally absent from the public feature contract.
- `electron/platform-ipc/registerCoreIpcHandlers.ts:133-155`, renderer log and diagnostic bridges. They carry raw diagnostic records and suppressed-count metadata, so they are process bridges rather than feature invokes. The diagnostic bridge is trusted-sender checked.
- `electron/platform-ipc/registerCoreIpcHandlers.ts:157-159`, renderer-ready notification. It is a one-way lifecycle signal used to release startup/external-open behavior.
- `electron/features/documents/registerDocumentsIpcAdapter.ts:603-628`, four DOCX stream methods. They are adapter-local because begin/chunk/commit/cancel form a stream protocol and are not represented as ordinary feature bindings.
- `electron/features/documents/registerDocumentsIpcAdapter.ts`, `fileSavePdfDataPort`. This is a validated event-registrar data port carrying a serialized PDF persistence session. It cannot use invoke return semantics and is attached to the sender session.
- `electron/bootstrap/requestShutdownSaveFlush.ts:189`, shutdown save-flush result. It is a temporary renderer-to-main shutdown handshake, not a feature request.
- `electron/window/windowCloseHandshake.ts:147`, window-close response. It is a temporary close protocol response tied to the native window-close handshake.
- `electron/platform-ipc/rendererLogBridge.ts:441` and `registerRendererDiagnosticBridge.ts:190` are registration seams used by the core bridges above, not extra feature handlers.

`eventRegistrar.on` and `registrar.handle` calls inside the document adapter
are still validated through the allowed channel sets. They are not raw
`ipcMain` calls and should not be counted as raw-handler exceptions.

## Reverse shutdown order and risks

The current integrated #297 shutdown runner at this SHA has no scan-cleanup
binding disposal step. Its best-effort order is:

1. agent assistant
2. search workers
3. local MCP server
4. updates
5. working-copy materializations
6. DjVu conversions
7. DjVu viewing cleanup
8. OCR job manager
9. range-read handles
10. workspace checkpoint
11. working copies
12. log flush

Before that, preservation steps flush renderer saves, begin main-operation
shutdown, cancel operations, shut down serialized PDF persistence, drain
critical writes, and flush the workspace checkpoint. Those prerequisites must
remain before feature disposal.

The #297 handoff is visible in candidate commit
`f2781aa1b58dd5ca2e5257a8a06a5d123666372f`, but is not an ancestor of the
inspected `origin/main`. Its intended contract is:

- `registerLazyValidatedFeature` returns a waiter for an in-flight provider load.
- `registerLazyPlatformFeature` retains loaded bindings and invokes an optional
  `disposeScanCleanupMainBindings` hook after the load has settled.
- `disposeScanCleanupMainBindingsIfLoaded` is re-exported through
  `featureIpcAdapters.ts` and `registerIpcHandlers.ts`.
- `main.ts` adds `scan-cleanup-bindings` before assistant shutdown.

Risks for the later writer:

- Disposing scan cleanup before an in-flight lazy load settles can leak the
  provider or race a handler registration. The waiter must remain part of the
  contract.
- The current scan-cleanup bindings file has module-scope service creation and
  no disposer. The writer must add or consume the actual service disposal API
  from the integrated #297 work rather than inventing a second shutdown path.
- Search, DjVu, OCR, document persistence, and agent runtime disposal have
  different ownership. Do not turn their existing main.ts shutdown hooks into
  generic table disposal without checking their in-flight operation rules.
- Settings saves call the assistant shutdown callback. Assistant runtime
  lifecycle changes owned by #329 must be re-read after integration so the
  registration table does not create a startup or shutdown cycle.
- A lazy stub is still an installed `ipcMain.handle`. Any later teardown plan
  must account for handler removal or process lifetime, not only provider object
  disposal.

## Ownership reservations and handoffs

Task-owned reservation:

- `docs/internal/project6-ticket333-registration-table-inventory-2026-09-07.md`

Reserved from this task, even for cleanup or formatting:

- `electron/main.ts`
- `electron/platform-ipc/registerFeatureIpcAdapters.ts`
- `electron/platform-ipc/featureIpcAdapters.ts`
- `electron/platform-ipc/registerIpcHandlers.ts`
- `electron/features/agent/assistantRuntimeLifecycle.ts`
- assistant runtime/provider files owned by #329
- `packages/contracts/**`, aliases, ESLint/Vitest/configuration files owned by #317/#319
- native, DjVu, search, OCR, and scan-cleanup implementation files
- Project 4 files, workflows, package files, binaries, and tests
- `/Users/evb/WebstormProjects/evb-viewer/**`
- `/home/ubuntu/projects/evb-viewer/**`

The later #333 writer must recheck, after #329 and the integrator's #297
shutdown wiring are integrated:

1. exact `HEAD`, `origin/main`, Git common directory, branch/worktree status,
   active reservations, and dirty files;
2. the actual assistant service/runtime factory and whether #327's lazy
   provider boundary still matches the table;
3. the actual `disposeScanCleanupMainBindings` export, disposer shape, loaded
   versus loading behavior, and shutdown step position;
4. all `main:` contract methods against binding keys, including event-only
   methods and the four document stream handlers;
5. every direct `ipcMain.handle/on` site listed above, including any new site
   added by the integrator;
6. reverse dependencies between main-operation drain, serialized PDF
   persistence, worker shutdown, provider disposal, working-copy cleanup, and
   log flush;
7. line/import/binding counts at the new exact SHA. Counts are evidence, not
   hard reduction targets.

## Remaining uncertainty

- The inspected remote main does not yet include the #297 candidate disposal
  commit, so the final scan-cleanup reverse edge cannot be confirmed here.
- The #329 assistant runtime changes are not present in this checkout. The
  table records the current #327 boundary and the handoff that must be checked
  again after integration.
- Contract helper expansion means a text count of `main:` is not a binding
  count. The reported callable counts come from the concrete binding objects
  and must be regenerated with the project’s eventual table implementation.
- No build, dependency install, test, Electron launch, merge, push, or heavy
  validation was run by this inventory.

## #333 bounded correction checkpoint, 2026-09-08

The reviewed candidate `272e7ef7ac1cf0fadc731904cdfac0aad84d40aa` was corrected
in the same assigned worktree. Fresh `origin/main` was
`36e66adb6679400769b110da6fc4488298c88ec7`; the candidate was already
descended from it, so no rebase was needed. Backup ref:
`refs/t3/backups/project6-333-correction-272e7ef7`.

`electron/main.ts` is now 1 physical line with 1 import declaration. It is a
thin composition root that imports the platform bootstrap module
`electron/bootstrap/mainProcess.ts`, which retains the existing startup,
diagnostics, document, close-handshake, save-flush, and reverse shutdown
orchestration. The registration table now drives the single runtime pass for
all 20 descriptors, including the core window-tabs registrar, eight document
rows, and eleven lazy platform rows.

Raw ownership is executable through
`electron/platform-ipc/rawIpcRegistration.ts`. The audit rejects unknown or
duplicate names and is exercised at the real registration sites for the
diagnostics canary, renderer log, renderer diagnostic, shutdown-save-flush,
and window-close response handlers. Focused tests also verify cleanup of the
shutdown and close listeners.

Focused command:

```sh
pnpm exec vitest run --project unit-electron \
  tests/unit/electron/featureRegistrationTable.test.ts \
  tests/unit/electron/ipcRegistrySecurity.test.ts \
  tests/unit/electron/mainShutdownOrder.test.ts \
  tests/unit/electron/requestShutdownSaveFlush.test.ts \
  tests/unit/electron/windowCloseHandshake.test.ts \
  tests/unit/electron/rendererDiagnosticBridge.test.ts \
  tests/unit/electron/rendererLogRegistry.test.ts --reporter dot
```

Result: 7 test files passed, 63 tests passed. Changed-file ESLint, Electron
typecheck, `node scripts/architecture/boundary-check.mjs --scope=all`, and
`git diff --check` also passed. The diagnostic and log bridge interfaces now
receive the audited registrar in production; their optional fallback exists only
for isolated unit fixtures and is not part of the shipped wiring. Remaining handoffs are unchanged: recheck the
#329 assistant runtime boundary and the integrator's #297 scan-cleanup
disposal wiring before final integration.

## #333 bounded correction 2 checkpoint, 2026-09-08

The pre-correction head was
`1ed9d5b5ae70e4e26a082db06667358a0ae68199`. Fresh `origin/main` remained
`36e66adb6679400769b110da6fc4488298c88ec7`, so the task branch required no
rebase. Backup ref:
`refs/t3/backups/project6-333-correction2-1ed9d5b5`.

`registerFeatureIpcAdapters.ts` now returns one typed registration runtime. It
retains one disposal callback per table descriptor in start order and executes
the callbacks in reverse order exactly once, continuing through errors before
rethrowing the first error. `mainProcess.ts` invokes that runtime through the
existing shutdown coordinator before the established agent, search, MCP,
updates, working-copy, DjVu, OCR, checkpoint, and log steps. Scan-cleanup is
therefore disposed through the table runtime rather than a separate global
pointer.

The raw audit now accepts scoped instances. Global registrations still reject
duplicates, while `window-close-response` uses one `window:<id>` scope per live
window and releases that scope on close, timeout cleanup, or listener cleanup.
The two-window regression exercises both response handlers and verifies that no
listeners remain.

Source-reading tests now inspect `electron/bootstrap/mainProcess.ts`. The entry
contract test asserts that `electron/main.ts` contains only the one-line
bootstrap import.

Correction-2 focused command:

```sh
pnpm exec vitest run --project unit-electron \
  tests/unit/electron/featureRegistrationTable.test.ts \
  tests/unit/electron/ipcRegistrySecurity.test.ts \
  tests/unit/electron/mainShutdownOrder.test.ts \
  tests/unit/electron/requestShutdownSaveFlush.test.ts \
  tests/unit/electron/windowCloseHandshake.test.ts \
  tests/unit/electron/rendererDiagnosticBridge.test.ts \
  tests/unit/electron/rendererLogRegistry.test.ts \
  tests/unit/electron/focusWindowForUserPolicy.test.ts \
  tests/unit/electron/mainFailureReporter.test.ts \
  tests/unit/electron/startupCrashMarker.test.ts --reporter dot
```

Result: 10 test files passed, 100 tests passed. Changed-file ESLint, Electron
typecheck, architecture boundary scan, and `git diff --check` passed. The only
remaining integration gap is the existing #329 assistant-runtime and #297
scan-cleanup handoff recheck.

## #333 correction 3 checkpoint, 2026-09-08

The pre-correction head was
`9de5679e11484d4fb276fa655eda0a665dec4355`. Fresh `origin/main` remained
`36e66adb6679400769b110da6fc4488298c88ec7`, with merge-base
`36e66adb6679400769b110da6fc4488298c88ec7`, so no rebase was needed. The
recoverable backup ref is
`refs/t3/backups/project6-333-correction3-9de5679e`.

The assigned identity stayed unchanged throughout this correction. Project
`6b0c8150-d5c2-4b91-bd94-34f3c2e33f69`, checkout
`/Users/evb/.t3/worktrees/evb-viewer/t3code-cdb5c070`, branch
`t3code/main-registration-inventory`, and Git common directory
`/Users/evb/WebstormProjects/evb-viewer/.git` were verified before mutation
and before commit. The two primary main checkouts were not touched.

`electron/features/scan-cleanup/scanCleanupMainBindings.ts` now exports the
real `disposeScanCleanupMainBindings` lifecycle function on the lazy binding
object. It memoizes the existing preview-service `dispose()` promise, so
reverse table shutdown retains one callback and repeated shutdown calls invoke
the underlying disposer once. The lazy provider still loads only on an IPC
request, and disposal still waits only for an already-started load.

The new focused seam test is
`tests/unit/electron/scanCleanupMainBindings.test.ts`. It imports the real
binding module, invokes the property retained by registration and the named
lifecycle export, and proves both calls share one promise and one underlying
dispose call. Existing fabricated runtime-disposer tests remain in
`featureRegistrationTable.test.ts`.

Focused command:

```sh
pnpm exec vitest run --project unit-electron \
  tests/unit/electron/featureRegistrationTable.test.ts \
  tests/unit/electron/ipcRegistrySecurity.test.ts \
  tests/unit/electron/mainShutdownOrder.test.ts \
  tests/unit/electron/requestShutdownSaveFlush.test.ts \
  tests/unit/electron/windowCloseHandshake.test.ts \
  tests/unit/electron/rendererDiagnosticBridge.test.ts \
  tests/unit/electron/rendererLogRegistry.test.ts \
  tests/unit/electron/focusWindowForUserPolicy.test.ts \
  tests/unit/electron/mainFailureReporter.test.ts \
  tests/unit/electron/startupCrashMarker.test.ts \
  tests/unit/electron/scanCleanupMainBindings.test.ts --reporter dot
```

Result: 11 test files passed, 101 tests passed. The focused lifecycle subset
also passed, with 3 files and 11 tests. The only output was the repository's
existing Vite native-config warning.

Changed-file ESLint passed for the binding and new test. Full `pnpm run
typecheck` passed, including Electron, tests, scripts, and server packages.
`node scripts/architecture/boundary-check.mjs --scope=all` passed with 9894
internal imports scanned, and `git diff --check` passed.

The correction-3 commit is `3697b6de5` before this evidence-only report hash
update. No build,
dependency install, Electron launch, merge, push, or broad integration claim
was made.
