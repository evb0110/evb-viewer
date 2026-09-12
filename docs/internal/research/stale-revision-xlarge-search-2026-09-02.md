# Stale revision while building the xlarge search sidecar

Date: 2026-09-02

Status: Research and implementation note. The production fix and regression tests are included in this task.

## Verdict

`actualRevision:null` means that the xlarge search worker could not read a valid revision token from the revision sidecar belonging to the exact PDF path it was checking. It does not mean that the PDF contained a null revision, that PDF.js returned no text, or that qpdf reported a structural mutation.

The user-visible message is a wrapper around this sequence:

1. Native xlarge search reported that its immutable search index was missing or stale.
2. The worker started a rebuild of that index.
3. The rebuild hit a revision fence. The fence read no usable revision sidecar, so it created `EVB_DOCUMENT_MUTATION_ERROR` with `actualRevision: null`.
4. The worker wrapped that error as `Failed to build the xlarge search sidecar`, then posted `Search failed: ...` to the renderer.

The strongest code-level diagnosis is an identity or lifecycle problem around the resolved PDF path and its `.evb-revision.json` file. The current code has a path fallback that can pair a directly readable temporary PDF with a caller-supplied token without proving that the token was minted for that path. A sidecar removed, quarantined, unreadable, or not recoverable at the exact path produces the same `actualRevision:null` result. Production logs are needed to distinguish those cases.

The concrete race found in the current release is earlier than the worker fence. Search resolved the path and revision through asynchronous IPC work, then registered the worker job. A close could finish its dependent-operation snapshot during that gap, retire the working copy, and leave the late worker request holding a PDF path whose revision sidecar had already gone away. Reopening created a new working copy and sidecar, which explains why the same search worked afterward.

The fix admits every search and warm-index request before the first asynchronous path lookup. The admission is tied to the request ID, the renderer owner, and any known `pdf-work-*` path. Explicit cancellation now finds preprocessing requests, and the existing close path can cancel and await them before deleting a working-copy directory. Once dispatch starts, the worker job inherits the admission signals. See the [admission block](../../../electron/features/search/main/ipc.ts#L83-L248), [search handler](../../../electron/features/search/main/ipc.ts#L287-L363), [warm-index handler](../../../electron/features/search/main/ipc.ts#L365-L417), and [worker service dispatch](../../../electron/features/search/main/searchWorkerService.ts#L300-L345).

## Redacted observation

The production event should be interpreted as if it were recorded this way:

```text
documentRef: "/private/var/folders/.../<redacted>.pdf"
expectedRevision: "<redacted revision token>"
actualRevision: null
```

The revision token and the original private path are intentionally not reproduced here. The `actualRevision` field is populated by the sidecar assertion as `sidecar?.token ?? null` ([electron/file-access/documentRevisionSidecar.ts:452-463](../../../electron/file-access/documentRevisionSidecar.ts#L452-L463)).

## What the error means in this repository

The error contract defines `EVB_DOCUMENT_MUTATION_ERROR` as a typed error with `code`, `message`, `documentRef`, `expectedRevision`, and `actualRevision` fields ([packages/contracts/documentMutationErrors.ts:9-42](../../../packages/contracts/documentMutationErrors.ts#L9-L42)). The stale-revision predicate and default message are defined at [packages/contracts/documentMutationErrors.ts:151-171](../../../packages/contracts/documentMutationErrors.ts#L151-L171).

The xlarge worker only takes this build path after native search reports `index-missing-or-stale`. It calls `buildXlargeSearchIndex`, and wraps any non-cancellation build failure with the exact `Failed to build the xlarge search sidecar: ...` prefix ([electron/search/worker.ts:340-434](../../../electron/features/search/worker.ts#L340-L434)). The final worker error string adds `Search failed: ...` ([electron/search/worker.ts:443-452](../../../electron/features/search/worker.ts#L443-L452)).

The xlarge builder checks the working-copy revision before reading text, before later page windows, and before publishing the completed index ([electron/search/xlargeIndexBuilder.ts:133-146](../../../electron/features/search/xlargeIndexBuilder.ts#L133-L146), [electron/search/xlargeIndexBuilder.ts:170-210](../../../electron/features/search/xlargeIndexBuilder.ts#L170-L210), [electron/search/xlargeIndexBuilder.ts:249-270](../../../electron/features/search/xlargeIndexBuilder.ts#L249-L270)). Therefore the event identifies a failed revision fence, but the message alone does not identify which fence failed.

The revision sidecar path is the PDF path plus `.evb-revision.json` ([electron/file-access/documentRevisionSidecar.ts:74-79](../../../electron/file-access/documentRevisionSidecar.ts#L74-L79)). A missing file or non-ENOENT read error returns `null`; invalid JSON or schema is quarantined and also returns `null` ([electron/file-access/documentRevisionSidecar.ts:403-425](../../../electron/file-access/documentRevisionSidecar.ts#L403-L425)). Journal reconciliation runs before the read, but its failure is swallowed before the sidecar is read again ([electron/file-access/documentRevisionSidecar.ts:427-450](../../../electron/file-access/documentRevisionSidecar.ts#L427-L450)). Thus `actualRevision:null` narrows the failure to "no valid sidecar token was available at this path at the fence," but does not distinguish:

- sidecar absent, usually `ENOENT`;
- sidecar unreadable;
- sidecar invalid and quarantined;
- pending journal unable to repair an absent sidecar; or
- a valid sidecar existing at another path while the builder checked the wrong path.

If a sidecar existed with a different valid token, the error would contain that token as `actualRevision`, not `null`.

## Compact failure timeline

| Stage | Current behavior | Source evidence |
| --- | --- | --- |
| Renderer request | The page-search composable captures the current working-copy path and revision token, cancels the previous run, and sends both to the search capability ([app/modules/pdf-viewer/runtime/composables/usePdfSearch.ts:440-516](../../../app/modules/pdf-viewer/runtime/composables/usePdfSearch.ts#L440-L516), [app/modules/pdf-viewer/runtime/composables/usePdfSearch.ts:558-625](../../../app/modules/pdf-viewer/runtime/composables/usePdfSearch.ts#L558-L625)). | A renderer race is guarded, but the request can still outlive a file-side change. |
| Main-process admission | Main resolves a readable PDF path and then forwards a supplied revision token unchanged. If no token was supplied, it obtains one for the resolved path ([electron/features/search/main/ipc.ts:279-284](../../../electron/features/search/main/ipc.ts#L279-L284), [electron/features/search/main/ipc.ts:287-363](../../../electron/features/search/main/ipc.ts#L287-L363)). | A supplied token is not re-bound to the resolved path here. |
| Xlarge classification | The worker stats the path and classifies documents over 16 MiB or 200 pages as xlarge ([electron/search/xlargeSearchRouting.ts:13-18](../../../electron/features/search/xlargeSearchRouting.ts#L13-L18), [electron/search/worker.ts:455-507](../../../electron/features/search/worker.ts#L455-L507)). | Classification is a routing choice, not a revision check. |
| Native attempt | Strict native search checks the immutable search index. A missing or stale index returns `index-missing-or-stale` ([electron/search/nativeSearch.ts:561-624](../../../electron/features/search/nativeSearch.ts#L561-L624)). | This starts the rebuild; it is not yet the reported mutation error. |
| Rebuild admission | The xlarge builder asserts the revision sidecar before text extraction and around each publish boundary ([electron/search/xlargeIndexBuilder.ts:133-146](../../../electron/features/search/xlargeIndexBuilder.ts#L133-L146), [electron/search/xlargeIndexBuilder.ts:249-270](../../../electron/features/search/xlargeIndexBuilder.ts#L249-L270)). | `actualRevision:null` was produced at one of these sidecar fences or the catalog fence it calls. |
| Text source | The xlarge catalog route uses the Poppler-backed extractor. The PDF.js route is selected only below the small-document threshold ([electron/ocr/documentTextCatalog.ts:579-727](../../../electron/features/ocr/public/documentTextCatalog.ts#L579-L727), [electron/search/extractTextWithPdfjs.ts:238-260](../../../electron/features/search/extractTextWithPdfjs.ts#L238-L260)). | The error is not evidence of a PDF.js text-extraction failure. |
| User-visible failure | The worker wraps the build error and posts it to the renderer ([electron/search/worker.ts:407-452](../../../electron/features/search/worker.ts#L407-L452)). | This explains the exact two-layer message. |

## Identity and sidecar boundaries

The main-process resolver prefers a direct path when it matches the `pdf-work-*` shape. Otherwise it first tries an original-to-working-copy mapping, then falls back to any allowed temporary path ([electron/features/search/main/ipc.ts:43-77](../../../electron/features/search/main/ipc.ts#L43-L77)). The allowed-path check validates temporary-directory containment, existence, and symlink safety, but does not require working-copy registration or a revision sidecar ([electron/utils/pathValidator.ts:263-315](../../../electron/utils/pathValidator.ts#L263-L315)).

That creates a concrete failure seam. A request can contain a token supplied by the renderer, resolve to a directly readable PDF, and reach the worker with that pair. The builder then checks `<resolved path>.evb-revision.json`. If the token came from a different working-copy path, or if the resolved path is an unmanaged temporary copy, the check returns `actualRevision:null` when no sidecar exists there.

The normal open path is meant to avoid this. Working-copy creation registers the path and initializes its revision sidecar before the path is returned to the document workflow ([electron/file-access/workingCopyCreation.ts:98-199](../../../electron/file-access/workingCopyCreation.ts#L98-L199)). Sidecar writes use a temporary file and atomic replacement ([electron/file-access/documentRevisionSidecar.ts:466-481](../../../electron/file-access/documentRevisionSidecar.ts#L466-L481)). On macOS, that makes a short ordinary rename gap an unlikely explanation. A crash, deletion, wrong path, or invalid sidecar remains possible.

The renderer also waits for a stable document identity before deferred search ([app/modules/workspace-shell/components/DocumentWorkspace.vue:1290-1324](../../../app/modules/workspace-shell/components/DocumentWorkspace.vue#L1290-L1324), [app/modules/workspace-shell/composables/createDeferredWorkspaceSearch.ts:21-87](../../../app/modules/workspace-shell/composables/createDeferredWorkspaceSearch.ts#L21-L87)). Revision-change events cancel OCR and search for the affected path ([electron/features/documents/main/registerDocumentRevisionInvalidationEffects.ts:8-18](../../../electron/features/documents/main/registerDocumentRevisionInvalidationEffects.ts#L8-L18)). These protections lower the probability of a normal renderer-only race, but they do not prove that the main process checked the same path whose token the renderer supplied.

## Ranked root-cause hypotheses

The ranking is based on what `actualRevision:null` proves and on the current source seams. It is not a claim that the production incident has been reproduced.

| Rank | Hypothesis | Why it fits | Falsifiable prediction |
| --- | --- | --- | --- |
| 1 | The request paired a revision token with the wrong resolved PDF path, or with an unmanaged temporary PDF. | The IPC path resolver permits an allowed direct temporary file, and `resolveSearchDocumentRevision` forwards a supplied token without checking that the token belongs to the resolved path ([electron/features/search/main/ipc.ts:55-77](../../../electron/features/search/main/ipc.ts#L55-L77), [electron/features/search/main/ipc.ts:279-284](../../../electron/features/search/main/ipc.ts#L279-L284)). The builder checks the sidecar beside the resolved path. | A redacted request trace shows different input and resolved identities, no registered working-copy entry for the resolved path, or a sidecar at the token's original path but not at `documentRef`. A test that sends a valid token with a different allowed PDF reproduces `actualRevision:null`. |
| 2 | The working copy or its revision sidecar was retired, deleted, or replaced while the search job was active. | Search is cancellable and cleanup waits for registered dependents ([electron/features/search/main/searchWorkerService.ts:300-343](../../../electron/features/search/main/searchWorkerService.ts#L300-L343), [electron/file-access/workingCopyCleanup.ts:617-778](../../../electron/file-access/workingCopyCleanup.ts#L617-L778)), so an ordinary managed close should be safe. The incident would therefore point to an untracked path, an alias mismatch, a process crash, or a cleanup path that escaped the registration fence. | File-operation logs show sidecar `ENOENT`, retirement, or directory deletion at the request time. The search operation's normalized path key does not match the cleanup registration key, or the PDF was not registered as a working copy. A search-close/delete race using the production path shape reproduces the event. |
| 3 | The sidecar was invalid, unreadable, or left behind a journal that could not be reconciled. | Invalid files are quarantined and reads return `null`; journal reconciliation errors are swallowed before the second read ([electron/file-access/documentRevisionSidecar.ts:403-450](../../../electron/file-access/documentRevisionSidecar.ts#L403-L450)). | Logs contain `Failed to read revision sidecar` or `Quarantined corrupt revision sidecar`, or a pending revision journal exists while the sidecar is absent. Replaying that file state produces the same typed error. |
| 4 | A restart, upgrade, or old working-copy state left a PDF without a compatible revision sidecar. | Current Electron-issued tokens use the `drt1:` format ([electron/file-access/documentRevisionStore.ts:120-145](../../../electron/file-access/documentRevisionStore.ts#L120-L145)), while token parsing accepts any nonempty string up to its size limit ([packages/contracts/documentRevision.ts:36-52](../../../packages/contracts/documentRevision.ts#L36-L52)). The supplied `drt:...` prefix is therefore a clue to check deployed-version provenance, not proof of the cause. | The incident occurs only after restart or upgrade, and the sidecar is absent or has an old schema, authority, or token format. The app version and sidecar metadata identify a migration boundary. |
| 5 | A provisional-sidecar durability window was exposed to search. | Fresh working-copy creation writes a provisional sidecar before returning the path, while durable promotion can happen later. The xlarge builder calls the sidecar assertion directly instead of the store-level assertion that waits for provisional durability ([electron/file-access/documentRevisionStore.ts:158-210](../../../electron/file-access/documentRevisionStore.ts#L158-L210), [electron/file-access/documentRevisionStore.ts:388-395](../../../electron/file-access/documentRevisionStore.ts#L388-L395)). The renderer's open-settle checks make this less likely during ordinary use. | A crash or immediate search starts between provisional creation and durable promotion, or the sidecar disappears after restart. Instrumented timing shows the first fence before durability promotion. |
| 6 | PDF.js, Poppler, qpdf, or the native PDF search parser caused this error. | The xlarge route uses the catalog and Poppler extractor, and the sidecar fence runs independently of parser output. qpdf's large-document structural loader has a separate source-change error ([native/pdf-page-ops/src/incremental_document.rs:150-243](../../../native/pdf-page-ops/src/incremental_document.rs#L150-L243)). Native search opens a completed immutable index and reports its own errors ([native/pdf-search/src/main.rs:184-275](../../../native/pdf-search/src/main.rs#L184-L275)). | Parser or qpdf logs show their own error type, such as text extraction failure or qpdf input-change failure, while the revision sidecar is present and matches. With a valid sidecar, a parser failure must not produce `actualRevision:null`. |

## Existing regression seams

The focused unit coverage is useful but leaves the production identity seam open:

- [tests/unit/electron/xlargeIndexBuilder.test.ts:159-185](../../../tests/unit/electron/xlargeIndexBuilder.test.ts#L159-L185) verifies that a stale error during extraction aborts the writer and publishes nothing. It uses a plain `Error`, not the typed stale error with `actualRevision:null`.
- [tests/unit/electron/searchWorkerWarmupAndCache.test.ts:911-1058](../../../tests/unit/electron/searchWorkerWarmupAndCache.test.ts#L911-L1058) covers coalesced warmups, one rebuild, and fail-closed xlarge behavior, but mocks the builder and does not read a real revision sidecar.
- [tests/unit/electron/xlargeSearchRouting.test.ts:39-87](../../../tests/unit/electron/xlargeSearchRouting.test.ts#L39-L87) covers thresholds and same-revision build coalescing, not path/token ownership.
- [tests/unit/electron/searchPathResolution.test.ts:41-73](../../../tests/unit/electron/searchPathResolution.test.ts#L41-L73) covers direct working-copy paths, mapped originals, and denied paths. It does not cover an allowed direct PDF paired with a supplied token from another path.
- [tests/unit/electron/documentRevisionStore.test.ts:109-168](../../../tests/unit/electron/documentRevisionStore.test.ts#L109-L168) covers provisional durability and the first mutation fence. It does not connect a missing or corrupt sidecar to the xlarge search IPC route.
- [tests/unit/electron/workingCopyCleanup.test.ts:398-628](../../../tests/unit/electron/workingCopyCleanup.test.ts#L398-L628) covers dependent cancellation, retention, re-registration, and late joiners. It should be extended with the exact normalized path and alias forms used by search admission.
- [tests/unit/electron/documentRevisionInvalidationEffects.test.ts:48-78](../../../tests/unit/electron/documentRevisionInvalidationEffects.test.ts#L48-L78) verifies cancellation on revision events, but not that a canceled xlarge rebuild cannot surface a stale-build error after cancellation.

The named production Haspelmath PDF is not present in this checkout, so these tests do not establish a byte-level reproduction of that document.

## Permanent fix and remaining candidates

The lifecycle fix described above is implemented. It closes the specific pre-dispatch race without weakening the worker's revision fence. A canceled request returns the existing canceled search response, while a request that reaches the worker still fails closed if its revision changes.

These are implementation candidates, not changes made by this research task.

1. Bind the revision token to the main-process document identity before dispatch. When a request carries a token, resolve the registered working-copy record and verify the normalized path and token against the same sidecar. If the caller supplies an original path, map it before accepting the token. Reject an unmanaged direct PDF plus a supplied working-copy token instead of allowing the builder to discover the mismatch later.
2. Give revision-sidecar reads distinct failure states for missing, unreadable, invalid, and unreconciled. For a registered working copy, run the existing revision recovery and durability gate before building, then retry once only when no mutation is active. Preserve the stale fence and fail closed if recovery cannot establish a matching sidecar. This should make the cause actionable without minting a new revision over an active transition.
3. Make search admission and cleanup use the same canonical working-copy identity, including normalization and registration ownership. Implemented for the Electron search and warm-index IPC paths. The admission uses `normalizePathForLookup`, registers the known working-copy path before preprocessing, and remains active until dispatch completes or cancellation settles. Existing cleanup waiting behavior remains the final deletion guard.
4. Add a post-cancellation fence in the search service so a revision event or close turns an in-flight stale-build error into the existing canceled response when cancellation won the race. This improves the user-visible result after the identity fix, but it must not hide a sidecar that was never associated with the request.
5. If production evidence confirms an old sidecar schema or token issuer, add an explicit versioned migration at working-copy recovery. Do not treat a token-prefix change alone as sufficient evidence, because the current token parser intentionally accepts arbitrary valid strings.
6. Do not change PDF.js, Poppler, qpdf, or native page operations based on this event. Their failure paths should be investigated only if telemetry shows a parser error with a valid matching revision sidecar.

## Recommended regression tests

The highest-value tests can stay close to the current seams:

| Test seam | Required assertion |
| --- | --- |
| `searchPathResolution.test.ts` plus IPC dispatch coverage | An allowed direct PDF cannot be dispatched with a revision token owned by another path. An original path maps to its registered working copy before the token is accepted. Include `/var` and `/private/var` normalization. |
| `documentRevisionSidecar.test.ts` or `documentRevisionStore.test.ts` | Missing, unreadable, invalid, and unreconciled sidecars are distinguishable in diagnostics; a matching sidecar succeeds; a missing sidecar retains typed stale semantics with `actualRevision:null`. |
| `xlargeIndexBuilder.test.ts` | A real `createStaleRevisionError` with `actualRevision:null` at the initial, mid-window, and pre-publish fences aborts the temporary writer and never publishes an index. |
| `searchWorkerWarmupAndCache.test.ts` | A typed stale error during the one permitted rebuild reaches the failure envelope, does not fall back to legacy JavaScript search, and is canceled cleanly when a revision event wins the race. |
| `workingCopyCleanup.test.ts` | Search admission, revision invalidation, and cleanup use the same canonical path. The sidecar remains readable until the dependent settles, including late cancellation and path-alias cases. |
| Electron large-document test | Start search on the exact production fixture when it is available, mutate or close the document during index construction, then assert cancellation or a retryable, classified failure. Reopen and confirm the sidecar and search index are rebuilt for the new revision. |

## Evidence needed from production

The next diagnostic build should record a request ID and redacted path identity, never a full revision token or private path. The useful fields are:

- input path category and resolved path category, with a stable hash for comparison;
- whether the resolved path had a registered working-copy entry and which normalized identity it used;
- revision-sidecar read result: present, missing, unreadable, invalid, or journal-repaired;
- only a short token hash or prefix for expected and actual values, never the token itself;
- xlarge fence stage: initial, text-window, catalog, or pre-publish;
- cleanup, retirement, revision-change, and cancellation events for the same request and path identity;
- app version, commit, operating system, and whether this followed a restart or upgrade.

Those fields would separate the first three hypotheses without exposing document names, temporary-directory details, credentials, or private tokens.

## Official IPC and cancellation semantics

Electron documents `ipcMain.handle` as an asynchronous handler whose returned promise becomes the renderer's reply, and `ipcRenderer.invoke` rejects when the main handler throws. That is why the fix keeps cancellation inside the main handler and returns a normal canceled response for work that lost the lifecycle race. See the [Electron `ipcMain` API](https://www.electronjs.org/docs/latest/api/ipc-main) and [Electron `ipcRenderer` API](https://www.electronjs.org/docs/latest/api/ipc-renderer/).

Node documents that `AbortController.abort()` causes its `AbortSignal` to emit `abort`, which is the notification used by the job registry and the pre-dispatch admission. Node also documents that `Worker.terminate()` is asynchronous, so cleanup must wait for the operation to settle rather than treating cancellation as immediate. See [Node.js globals](https://nodejs.org/docs/latest/api/globals.html) and [Node.js worker threads](https://nodejs.org/api/worker_threads.html).

## Verification

The focused test run passed:

```text
pnpm exec vitest run tests/unit/electron/searchIpcResourceLimits.test.ts tests/unit/electron/searchWarmIndexIpc.test.ts tests/unit/electron/searchWorkerService.test.ts tests/unit/electron/xlargeIndexBuilder.test.ts --reporter=dot
Test Files 4 passed (4)
Tests 55 passed (55)
```

The interpretation above comes from the current repository's Electron, renderer, contract, OCR, native, cleanup, and test code, with the official IPC and Node cancellation semantics linked above. The named production Haspelmath PDF remains an external fixture and was not copied into the repository. The exact note path is `docs/internal/research/stale-revision-xlarge-search-2026-09-02.md`.
