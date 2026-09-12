# Project 6 #306 workspace driver and capability inventory

Status: preparatory evidence only. This report does not implement #306 or any of its child batches.

## Inspection record

- Checkout: `/Users/evb/.t3/worktrees/evb-viewer/codex-project6-306-inventory`
- Branch: `codex/project6-306-inventory`
- Host: Mac
- Preserved historical report content: commit `e286b91d70857f35f1da966eabefdc09ccf0d749`.
- Prior inspected source: `4468f17a2501700d7b11817fef3cabc5751109f5`.
- Exact current main inspected commit: `441aec95e4a147e144e8f88098d9ded2bf3a78d7`, subject `make annotation editing and PDF round trips reliable`.
- Project 4 historical merge: PR #206, head `52a75bca21a8659637b0a295a818ed2b47f48086`, merged as `ebfb129a8842e17489cfca5b7ec30f467fc828a7` at `2026-09-07T08:27:04Z`. Its 1,152-path count remains historical evidence, measured as `git diff --name-only b4b6b44135dce544489989caecb9250ab8078359 ebfb129a8842e17489cfca5b7ec30f467fc828a7 | wc -l`.
- Current source delta from the prior inspected source: 203 paths. Thirty-four are under the workspace-shell, workspace capability, browser-platform, or focused-test paths named in this report. Reproduce with `git diff --name-only 36e66adb6679400769b110da6fc4488298c88ec7 441aec95e4a147e144e8f88098d9ded2bf3a78d7 | wc -l` and the same command with `-- app/modules/workspace-shell app/types/workspaceExpose.ts app/platform/browser-api tests/unit/app/modules/workspace-shell`, which returns 34.
- The prior nine focused paths remain historical Project 4 annotation/save integration facts. The current 34-path scope additionally changes annotation overlays and actions, workspace expose and command wiring, `usePageSaveOrchestration.ts`, `useWorkspaceInteractionControls.ts`, `useWorkspaceOrchestration.ts`, `workspaceDocumentDriver.ts`, `app/types/workspaceExpose.ts`, and their focused tests. These are current-main source facts, not implementation performed by this report. The exact complete path set remains reproducible with the scoped `git diff --name-only` command below.
- Refresh start: clean at `b22c7ebc56166df633b385e8a9c8f16df7b42bf0`; `origin/main` was fetched as `441aec95e4a147e144e8f88098d9ded2bf3a78d7`. The report uses treeish reads and did not merge or rebase this refresh. No hosted run was recorded for the inspected SHA in this refresh.

The inspected driver and adapter owners are [workspaceDocumentDriver.ts](../../app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts) and [workspaceViewerAdapters.ts](../../app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts). The adapter contract is in [workspaceViewerAdapterTypes.ts](../../app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes.ts), and the public capability shape is in [workspaceExpose.ts](../../app/types/workspaceExpose.ts).

The current-source refresh commands returned `source-delta-count=203`, `workspace-source-delta-count=34`, `docworkspace-lines=1474`, and `docworkspace-top-level-imports=58`. The exact commands and selection rules appear below.

## Existing registry and lifecycle

There is one current adapter registry, `WORKSPACE_VIEWER_ADAPTERS`, with three entries:

| Adapter | Document types | Current observable behavior | Evidence |
| --- | --- | --- | --- |
| `pdf` | `pdf`, `image` | Uses the document-viewer chassis, PDF.js props and listeners, the PDF sidebar, annotations, page operations, save, export consumers and normal print. | `workspaceViewerAdapters.ts:18-39`; `workspaceDocumentDriver.ts:586-684` |
| `native-pdf` | `pdf` | Describes a native PDF opening-preview adapter, but production `useWorkspaceDocumentDriver` does not select it. The actual preview is staged by `stagePdfOpeningPreview`; the post-open document driver remains PDF.js. | `workspaceViewerAdapters.ts:40-46`; `workspaceDocumentDriver.ts:446-477`; `stagePdfOpeningPreview.ts:106-113,255-259` |
| `djvu` | `djvu` | Uses the page-source chassis, conversion banner/dialog, limited view controls, DjVu source, and a DjVu-to-PDF print projection. | `workspaceViewerAdapters.ts:48-60`; `workspaceDocumentDriver.ts:329-397,625-639` |

`resolveWorkspaceViewerAdapter` can select DjVu when DjVu mode has a DjVu source and no PDF source. Its generic resolver can also select native PDF when a PDF source exists and `shouldUseNativePdf` is true. Production `useWorkspaceDocumentDriver` hardcodes `shouldUseNativePdf: false` and constructs `nativePdfSourcePath` as a computed null, so production does not select the native adapter after open. `stagePdfOpeningPreview` owns the separate staged native opening preview. The default pending-document map seeds PDF and images with `pdf`, and DjVu with `djvu` (`workspaceViewerAdapters.ts:120-158`; `workspaceDocumentDriver.ts:446-477`; `stagePdfOpeningPreview.ts:106-113,255-259`).

The lifecycle contract has `beforeOpen`, `afterOpen`, and `beforeClose` hooks (`workspaceViewerAdapterTypes.ts:24-31`). The controller runs them around open finalization and before close commits (`useWorkspaceFileLifecycleController.ts:47-77`). The only current hook factory is DjVu. It invalidates pending opens before open and close, captures and cleans the active DjVu temporary activation, and exits DjVu mode after a successful PDF conversion/open when the working copy changed (`workspaceViewerAdapters.ts:63-93`).

The driver itself exposes `id`, `capabilities`, `canPreparePrint`, `source`, `view`, and `run`. The only command is `prepare-print`; DjVu implements it, while PDF.js and native PDF return an unavailable print result (`workspaceDocumentDriver.ts:248-277,328-333,446-448`). The binding already centralizes active component, props, listeners and exposed viewer refs, but it still branches on the driver ID for PDF.js, DjVu and native-PDF wiring (`workspaceDocumentDriver.ts:563-715`).

Current-main change since the prior refresh: `IWorkspaceDocumentDriverBindingOptions` no longer carries the legacy `onImagePlacementFinalize` callback, and the binding no longer forwards `finalizeImagePlacement` (`workspaceDocumentDriver.ts:498-580,612-632` at `441aec95...`). `IWorkspaceFilePort` now includes `handleSelectAll` (`workspaceExpose.ts:150-170`). These are integrated annotation/save boundary changes. They do not add a new driver command or capability and must be preserved when #309 and #310 handoffs are refreshed.

## Capability matrix at the inspected SHA

The values below are the direct adapter tables. `false` means the current adapter does not advertise the capability. It does not claim that a similarly named shell function is absent.

| Capability | PDF.js `pdf` | Native PDF | DjVu | Current owner or observable boundary |
| --- | :---: | :---: | :---: | --- |
| `closeableDocument` | yes | yes | yes | Workspace file lifecycle controller closes the current document. |
| `conversionBanner` | no | no | yes | DjVu adapter and workspace conversion UI. |
| `conversionDialog` | no | no | yes | DjVu conversion action and public workspace expose. |
| `crop` | yes | no | no | PDF page-operation/crop consumers. |
| `optimizePdf` | yes | no | no | PDF file-operation consumer. |
| `pdfDocument` | yes | yes | no | PDF viewer state and native PDF viewer. |
| `pdfMutationActions` | yes | no | yes | PDF mutation actions, with DjVu conversion-oriented mutation state. |
| `print` | yes | yes | yes | Shell print flow; DjVu has driver preparation, PDF/native use existing print consumers. |
| `regionCapture` | yes | no | no | PDF viewer capture action. |
| `repairSave` | yes | no | no | PDF save consumer. |
| `save` | yes | no | no | PDF persistence and save service. |
| `saveAs` | yes | no | yes | PDF save-as consumer and DjVu conversion/save-as path. |
| `sidebar` | yes | no | yes | PDF sidebar or DjVu source sidebar. |
| `continuousScroll` | yes | no | yes | Viewer shell state and native/page-source viewer props. |
| `viewMode` | yes | no | no | PDF view controls. |
| `viewRotation` | yes | no | no | PDF view controls. |

The default capability constructor sets every field to false (`workspaceExpose.ts:67-105`). The source-level PDF capability table is separate from viewer capabilities. PDF declares annotations, direct image export, outline, page edits, search and text (`workspaceDocumentDriver.ts:102-109`). DjVu/page-source receives source capability and page-source events through the native-viewer listener map (`workspaceDocumentDriver.ts:654-668`). Native PDF does not emit `update:sourceCapabilities` or `update:pageSource`; `NativePdfViewer.vue` emits zoom, page, document, loading, initial-visual and load-error events only (`NativePdfViewer.vue:137-148`). For the native opening preview, the evidence is the static adapter table plus `stagePdfOpeningPreview.ts`; there is no native-PDF runtime source-capability claim.

### Implemented behavior

- Open selection and pending-document seeding for PDF, image and DjVu are implemented by the adapter resolver and driver (`workspaceViewerAdapters.ts:120-158`; `workspaceDocumentDriver.ts:446-491`).
- Closeable-document, print, viewer selection, sidebar, continuous-scroll, view-mode, view-rotation, save, save-as, repair-save, optimize, crop, region-capture, conversion and PDF-document flags are implemented as declared adapter capabilities (`workspaceViewerAdapters.ts:18-60`).
- DjVu print preparation creates a projection session, validates cancellation, waits for the output-service handoff, and reports completion (`workspaceDocumentDriver.ts:329-397`).
- Viewer props, event listeners and exposed refs are routed from the active driver (`workspaceDocumentDriver.ts:563-715`).
- DjVu open/close cleanup is lifecycle-hooked and fenced by the lifecycle generation in the controller (`workspaceViewerAdapters.ts:63-93`; `useWorkspaceFileLifecycleController.ts:47-77`).

### Missing or format-specific behavior, with current owners

| Area | Current source owner | Observed behavior at the inspected SHA | Classification |
| --- | --- | --- | --- |
| Open and PDF working-copy adoption | `app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.ts`, `app/modules/workspace-shell/composables/document-session/openPdfAfterPasswordPrompt.ts` | PDF picker/direct/batch opens finish through PDF working-copy and revision state. The final tree also handles password retry and records `wasEncrypted`. DjVu returns a prepared outcome and records `pendingDjvu` before conversion. | Implemented outside the driver; #307 migration target. |
| Close and session restore | `app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController.ts`, `app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint.ts`, `app/modules/workspace-shell/document-sessions/workspaceDocumentController.ts` | Lifecycle generation, stale-open fencing, checkpoint restore ordering and document readiness remain controller/checkpoint behavior. | Implemented outside the driver; #307 migration target. |
| PDF save and save-as | `app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts`, `app/modules/workspace-shell/composables/usePageSaveOrchestration.ts`, `app/modules/workspace-shell/composables/createPageMutationWriterSave.ts`, `app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts`, `app/modules/workspace-shell/composables/file-operations/workspaceSavePlan.ts` | PDF bytes, revision tokens, dirty history, writer save transactions and working-copy persistence are handled by the final PDF persistence/service path. | Format-specific; #309 migration target. |
| DjVu save | `app/composables/useDjvu.ts`, `app/modules/workspace-shell/composables/usePageFileOperations.ts`, `app/modules/workspace-shell/expose/createWorkspaceExpose.ts` | DjVu advertises `saveAs` and conversion, but there is no driver save command. Conversion/save-as remains in shell consumers. | Missing driver operation; #309 target. |
| DOCX and image/TIFF export | `app/modules/workspace-shell/composables/useWorkspaceExport.ts`, `app/composables/useDocxExport.ts`, `app/platform/browser-api/browserImageExportConfig.ts`, `app/platform/browser-api/createBrowserImageExportCapability.ts` | Export remains an export-port concern. The driver contract has no export command or export-target declaration. | Missing driver operation; #309 target. |
| PDF print | `app/modules/workspace-shell/composables/useWorkspacePrint.ts`, PDF print helpers and `app/modules/pdf-viewer` | PDF print uses the shell print flow and PDF viewer/source capabilities. The driver returns unavailable for `prepare-print`. | Format-specific; #309 target. |
| DjVu print | `app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts`, `app/utils/getDjvuCapability.ts` | Driver-owned preparation exists and hands a generated PDF to native print. | Implemented partial driver behavior; #309 integration target. |
| Viewer mounting and UI visibility | `app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts`, `app/modules/workspace-shell/components/DocumentWorkspace.vue`, `app/modules/workspace-shell/composables/useWorkspaceViewerShellState.ts`, `app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue` | Driver supplies component/props/listeners and flags, but sibling shell/UI code still owns format-specific visibility and command gating. | Partly implemented; #310 target. |
| Public command guards | `app/modules/workspace-shell/expose/createWorkspaceExpose.ts` and `app/types/workspaceExpose.ts` | Public commands read capability flags for save, crop, region capture, view controls and conversion, while some document/open and export routing remains in ports. | Mixed integration boundary; current on final main. |

The exact final-main image-export owner query was:

```sh
git ls-tree -r --name-only 441aec95e4a147e144e8f88098d9ded2bf3a78d7 app/platform | rg -i 'image.?export|export'
```

It returned `app/platform/browser-api/browserImageExportConfig.ts` and `app/platform/browser-api/createBrowserImageExportCapability.ts`.

Project 4 changed the ownership evidence around open and save. The final tree adds password-open handling and `wasEncrypted` session state in `createDocumentOpenFlow.ts`, and routes PDF save preparation through `usePageSaveOrchestration.ts` and the writer-owned save plan instead of the removed annotation-source preservation helpers. `useWorkspaceOrchestration.ts` now wires `useUnencryptedSaveNotice` and `createPageMutationWriterSave`. These are current source facts, not #306 implementation proposals (`createDocumentOpenFlow.ts`; `createDocumentPersistence.ts`; `usePageSaveOrchestration.ts`; `useWorkspaceOrchestration.ts`).

The current-main delta also includes the released Project 4 annotation/save integration. `createPageMutationWriterSave.ts`, `useWorkspaceSaveService.ts`, `workspaceSaveExecutionResult.ts`, `nativePdfMutationArtifact.ts`, `useAnnotationContextMenu.ts`, `useWorkspaceFailureSurface.ts`, and their two focused tests are already in `origin/main` at the inspected SHA. They are released source owners to preserve, not available #306 worker files. The driver, adapter, lifecycle, save/export/print, and UI paths named in the handoffs remain bounded ownership or integration boundaries and must be rechecked against the child batch's starting SHA.

## Current consumers and tests

The focused driver test covers pending PDF/DjVu selection, unavailable PDF print, DjVu print projection and handoff ordering, adapter document-type parity, capability flags, active viewer listeners and annotation routing (`tests/unit/app/modules/workspace-shell/viewers/workspaceDocumentDriver.test.ts:66-302,349-381`). Open-flow tests cover PDF state adoption at `:771-779`, password retry and `wasEncrypted` at `:806-861`, and prepared DjVu opens at `:1133-1163` (`tests/unit/app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.test.ts`). The lifecycle controller is the source of the open, finalize, stale-generation and close ordering (`useWorkspaceFileLifecycleController.ts:47-77`). Exact focused tests for the handoff paths are:

- `tests/unit/app/modules/workspace-shell/composables/useDocumentOpenVisualSettle.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useDocumentOpenSurfaceLifecycle.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/usePageSaveOrchestration.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useDjvuProjectionActions.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useWorkspaceExport.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useWorkspacePrint.test.ts`
- `tests/unit/app/modules/workspace-shell/components/workspacePdfToolbarOpeningPreview.test.ts`
- `tests/integration/browser/documentLifecycleUi.test.ts`
- `tests/e2e/electron/nativeSaveReopen.e2e.test.ts`
- `tests/e2e/electron/djvuPrintHandoff.e2e.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/createWorkspaceExpose.test.ts`

The open-surface tests are directly applicable to #307. `useDocumentOpenSurfaceLifecycle.test.ts` checks generation ownership and generic-ready forwarding, while `useDocumentOpenVisualSettle.test.ts` checks first-visual gating, same-generation navigation latching, cancellation, timeout diagnostics and surface fences. The #309 tests cover save ordering and recovery snapshots (`usePageSaveOrchestration.test.ts`), DjVu projection actions (`useDjvuProjectionActions.test.ts`), image/TIFF export and operation leases (`useWorkspaceExport.test.ts`), and print single-flight, native/path routing and save-before-print behavior (`useWorkspacePrint.test.ts`). The #310 opening-preview test checks committed native pagination and available controls (`workspacePdfToolbarOpeningPreview.test.ts`).

These tests establish behavior for the handoffs. They are not evidence that the future driver migrations are complete.

## Reproducible branch inventory

The following commands were rerun against the final main object from this task branch. They query the named base commit independently, so they do not assert that the current report checkout is still at the inspected source base. `set -euo pipefail` and `git cat-file -e` make an absent or invalid base fail closed. The selection rule is deliberately narrow and names the decision sites counted. These are baseline evidence, not quotas or trend targets.

The source and file-count commands below use treeish reads and count only the named comparison scope:

```sh
set -euo pipefail
BASE_SHA=441aec95e4a147e144e8f88098d9ded2bf3a78d7
git cat-file -e "${BASE_SHA}^{commit}"
printf 'source-delta-count='; git diff --name-only 36e66adb6679400769b110da6fc4488298c88ec7 "$BASE_SHA" | wc -l | awk '{print $1 + 0}'
printf 'workspace-source-delta-count='; git diff --name-only 36e66adb6679400769b110da6fc4488298c88ec7 "$BASE_SHA" -- app/modules/workspace-shell app/types/workspaceExpose.ts app/platform/browser-api tests/unit/app/modules/workspace-shell | wc -l | awk '{print $1 + 0}'
printf 'docworkspace-lines='; git show "${BASE_SHA}:app/modules/workspace-shell/components/DocumentWorkspace.vue" | wc -l | awk '{print $1 + 0}'
printf 'docworkspace-top-level-imports='; git show "${BASE_SHA}:app/modules/workspace-shell/components/DocumentWorkspace.vue" | awk '/^import[[:space:]]/{count++} END{print count+0}'
```

Observed output:

```text
source-delta-count=203
workspace-source-delta-count=34
docworkspace-lines=1474
docworkspace-top-level-imports=58
```

```sh
set -euo pipefail
BASE_SHA=441aec95e4a147e144e8f88098d9ded2bf3a78d7
git cat-file -e "$BASE_SHA^{commit}"
printf 'base=%s\n' "$BASE_SHA"

# Driver selection: the three adapter-to-driver return decisions in useWorkspaceDocumentDriver.
printf 'driver-selection='; git grep -nE 'adapter\?\.id ===|return adapter \? drivers' "$BASE_SHA" -- \
  app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts | wc -l | awk '{print $1 + 0}'

# Adapter resolution: DjVu/PDF/native selection predicates and default adapter lookup.
printf 'adapter-resolution='; git grep -nE 'context\.isDjvuMode|context\.pdfSourcePath|context\.shouldUseNativePdf|return getWorkspaceViewerAdapter' "$BASE_SHA" -- \
  app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts | wc -l | awk '{print $1 + 0}'

# Lifecycle transitions: hook definitions plus controller call sites for beforeOpen,
# afterOpen and beforeClose.
printf 'lifecycle-hooks='; git grep -nE 'beforeOpen|afterOpen|beforeClose' "$BASE_SHA" -- \
  app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts \
  app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController.ts | wc -l | awk '{print $1 + 0}'

# Viewer binding: the four driver-ID decisions that choose props, listeners and refs.
printf 'viewer-binding='; git grep -nE 'driver\.id ===|activeDocumentDriver\.value\.id' "$BASE_SHA" -- \
  app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts | wc -l | awk '{print $1 + 0}'

# Capability table: boolean assignments in the three named adapter tables.
printf 'capability-assignments='; git grep -nE '^[[:space:]]+[a-zA-Z]+: (true|false),' "$BASE_SHA" -- \
  app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts | wc -l | awk '{print $1 + 0}'

# Capability interface inventory: boolean fields in the public capability interface.
printf 'capability-fields='; git show "$BASE_SHA":app/types/workspaceExpose.ts | awk '/^export interface IWorkspaceViewerCapabilities/{inside=1; next} inside && /^}/{exit} inside && /^[[:space:]]+[a-zA-Z]+: boolean;/{count++} END{print count+0}'
```

Observed output from the rerun:

```text
base=441aec95e4a147e144e8f88098d9ded2bf3a78d7
driver-selection=3
adapter-resolution=6
lifecycle-hooks=6
viewer-binding=4
capability-assignments=27
capability-fields=16
```

The six counts are 3, 6, 6, 4, 27 and 16. The 27 count is assignments, not distinct capabilities. The 16 count is the public boolean interface field count. These commands query final main directly and do not infer trends from unrelated repository-wide regex totals.

## Public PR #349 ownership and overlaps

At `2026-09-08T00:37:21Z` UTC, the public PR endpoint reported:

- PR: `https://github.com/evb0110/evb-viewer/pull/349`
- head: `bea27ef44334a2207e994876a272c49b06955671`
- base branch: `own-annotations`
- state: merged as `fa010960da5fe6104b21b3af0a89822b4aeff038` at `2026-09-07T07:13:48Z`
- changed-file count from the paginated public files endpoint: 1,729
- named handoff-path matches from the same paginated query: 23

The query was `gh api repos/evb0110/evb-viewer/pulls/349/files --paginate --jq '.[] | .filename'`. Filtering that complete paginated result against the named driver, lifecycle, save/export/print and UI paths produced this complete reservation set for the three handoffs:

The exact filter command that produced the 23 matches was:

```sh
gh api repos/evb0110/evb-viewer/pulls/349/files --paginate --jq '.[] | .filename' |
  rg '^(app/modules/workspace-shell/(checkpoint/restoreWorkspaceCheckpoint\.ts|components/(DocumentViewerChassis|DocumentWorkspace|WorkspacePdfToolbarView)\.vue|composables/(document-session/(createDocumentOpenFlow|createDocumentPersistence)\.ts|file-operations/(workspaceSavePlan|workspaceSaveTransactionRequest)\.ts|usePage(FileOperations|SaveOrchestration)\.ts|useWorkspace(Export|FileLifecycleController|InteractionControls|Print|ViewState|ViewerShellState)\.ts)|document-sessions/workspaceDocumentController\.ts|useWorkspaceOrchestration\.ts|viewers/workspaceDocumentDriver\.ts)|app/composables/useDocxExport\.ts|app/pages/workspace\.vue|app/types/workspaceExpose\.ts|tests/unit/app/modules/workspace-shell/viewers/workspaceDocumentDriver\.test\.ts)$' |
  sort
```

The selection rule names the handoff paths, and the `sort` output below contains 23 lines. It is complete for that named filter, not a claim about all 1,729 PR files.

```text
app/composables/useDocxExport.ts
app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint.ts
app/modules/workspace-shell/components/DocumentViewerChassis.vue
app/modules/workspace-shell/components/DocumentWorkspace.vue
app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue
app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.ts
app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts
app/modules/workspace-shell/composables/file-operations/workspaceSavePlan.ts
app/modules/workspace-shell/composables/file-operations/workspaceSaveTransactionRequest.ts
app/modules/workspace-shell/composables/usePageFileOperations.ts
app/modules/workspace-shell/composables/usePageSaveOrchestration.ts
app/modules/workspace-shell/composables/useWorkspaceExport.ts
app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController.ts
app/modules/workspace-shell/composables/useWorkspaceInteractionControls.ts
app/modules/workspace-shell/composables/useWorkspacePrint.ts
app/modules/workspace-shell/composables/useWorkspaceViewState.ts
app/modules/workspace-shell/composables/useWorkspaceViewerShellState.ts
app/modules/workspace-shell/document-sessions/workspaceDocumentController.ts
app/modules/workspace-shell/useWorkspaceOrchestration.ts
app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts
app/pages/workspace.vue
app/types/workspaceExpose.ts
tests/unit/app/modules/workspace-shell/viewers/workspaceDocumentDriver.test.ts
```

This is a query-backed complete historical set for the named handoff paths, not a claim that these are all 1,729 PR files. PR #349 is settled as merged, and its head `bea27ef...` and merge commit `fa010960...` are ancestors of current main. Project 4 is settled as PR #206 merged into `main`; the current source proves that its former reservations are released. The listed paths remain ownership boundaries for the handoffs, but no Project 4 or PR #349 reservation blocks this report refresh.

## Named implementation handoffs

The following are bounded worker prompts in path form. They describe future work only. Project 4 and PR #349 reservations are settled and released. The driver and adapter files remain shared #306 contract owners, while each batch should claim only its named source paths.

### #307, open, close and session restore

Candidate owned source paths:

- `app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.ts`
- `app/modules/workspace-shell/composables/useWorkspaceFileLifecycleController.ts`
- `app/modules/workspace-shell/composables/useDocumentOpenSurfaceLifecycle.ts`
- `app/modules/workspace-shell/composables/useDocumentOpenVisualSettle.ts`
- `app/modules/workspace-shell/composables/useDocumentTransitions.ts`
- `app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects.ts`
- `app/modules/workspace-shell/composables/useDocumentWorkspacePageSessionRestore.ts`
- `app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore.ts`
- `app/modules/workspace-shell/composables/useWorkspaceSplitPayload.ts`
- `app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint.ts`
- `app/modules/workspace-shell/document-sessions/workspaceDocumentController.ts`

Integration handoff path:

- `app/modules/workspace-shell/useWorkspaceOrchestration.ts`, which wires the open, lifecycle and restore composables into the shell. The #307 worker may propose the driver-facing calls, but the integrator owns the cross-batch wiring.

Shared contract paths:

- `app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts`
- `app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts`
- `app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes.ts`
- PR #349 overlap paths are settled and released; the driver and adapter files remain shared #306 contract owners

Public interfaces to preserve or extend through the existing owners:

- `IWorkspaceDocumentDriver`, `IWorkspaceDocumentDriverOptions`, `IWorkspaceDocumentDriverSource`
- `IWorkspaceViewerLifecycleHooks`, `IWorkspaceViewerLifecycleContext`
- `TDocumentOpenOutcome`, `IDocumentSessionState`, `IWorkspaceExpose`

Expected behavior: route open, close and restore selection through the one adapter/driver registry. `useDocumentOpenSurfaceLifecycle.ts:22-62` owns the open-intent generation and calls the shared surface session's `begin`; it must not create a second visibility state. `useDocumentOpenVisualSettle.ts:22-323` owns accepted-versus-visual settle waiters, abort/timeout handling and the shared surface/viewport readiness gate. Keep the render-lease settle-before-release ordering by resolving the visual waiter only after the shared surface is ready, committed, and its viewport lifecycle is ready. Preserve document-instance fencing, stale-open cancellation, working-copy cleanup, DjVu activation cleanup and checkpoint restore order. Do not move mutable per-document state into an adapter singleton.

Focused tests:

- `tests/unit/app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useDocumentOpenSurfaceLifecycle.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useDocumentOpenVisualSettle.test.ts`
- `tests/unit/app/modules/workspace-shell/viewers/workspaceDocumentDriver.test.ts`
- `tests/unit/app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint.test.ts`
- existing lifecycle tests covering open, close, stale instance and restore

Integration-only files: `scripts/architecture/boundary-check.mjs`, `tests/unit/scripts/depGraph.test.ts`, and the proposed diagnostic rule `scripts/architecture/formatComparisonRule.mjs` with focused test `tests/unit/scripts/formatComparisonRule.test.ts`. These two proposed paths are not created in this report. The sole integrator owns activation in `eslint-plugin-custom.mjs` and `eslint.config.mjs`, plus the changed-area lint command. No unowned rule is assumed.

### #309, save, export and print

Candidate owned source paths:

- `app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts`
- `app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts`
- `app/modules/workspace-shell/composables/file-operations/workspaceSavePlan.ts`
- `app/modules/workspace-shell/composables/file-operations/workspaceSaveTransactionRequest.ts`
- `app/modules/workspace-shell/composables/usePageFileOperations.ts`
- `app/modules/workspace-shell/composables/usePageSaveOrchestration.ts`
- `app/modules/workspace-shell/composables/useDjvuProjectionActions.ts`
- `app/modules/workspace-shell/composables/useWorkspaceExport.ts`
- `app/modules/workspace-shell/composables/useWorkspacePrint.ts`
- `app/composables/useDocxExport.ts`
- `app/platform/browser-api/browserImageExportConfig.ts`
- `app/platform/browser-api/createBrowserImageExportCapability.ts`

Prerequisite and handoff from #308:

- #308 must first consolidate save planning and transaction execution into `app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts`, preserving the revision compare-and-set, stale-revision, working-copy and progress-replay invariants. #309 consumes that released service contract. It must not reintroduce `usePageSaveOrchestration.ts`, `workspaceSavePlan.ts` or `workspaceSaveTransactionRequest.ts` as competing save owners.

Shared contract paths:

- `app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts`
- `app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts`
- `app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes.ts`
- `app/types/workspaceExpose.ts`
- PR #349 overlap paths are settled and released; the driver and adapter files remain shared #306 contract owners

Public interfaces to preserve or extend through the existing owners:

- `IWorkspaceFilePort`, `IWorkspaceExportPort`
- `IWorkspaceDriverCommand`, `TWorkspaceDriverCommandResult`
- `IWorkspaceViewerCapabilities`, `IDocumentSourceCapabilities`
- existing save, export, and print contract files in `packages/contracts`: `documentRef.ts`, `documentRevision.ts`, `pdfDateString.ts`, `shared.ts`, `electronApiDocuments.ts`, `documentMutationErrors.ts`, `pdfAnnotationParseTypes.ts`, `diagnostics/failureReceipt.ts`, and `pageNumbers.ts`

Expected behavior: drivers declare or route save strategy, export targets and print path without format-string checks in the migrated directories. Preserve PDF revision fencing and dirty-state updates, DjVu conversion/save-as and print handoff, image export, DOCX/TIFF export, cancellation and current filename/page-selection behavior. In current main, #309 owns the `useDjvuProjectionActions` action-wiring block at lines `1150-1172` only as an integration handoff; #310 owns the surrounding UI and viewer presentation. The prior `1166-1188` range is historical evidence from the previous inspected tree. Neither worker claims the whole file.

Focused tests:

- `tests/unit/app/modules/workspace-shell/viewers/workspaceDocumentDriver.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/createDocumentPersistence.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSavePlan.test.ts`
- `tests/e2e/electron/nativeSaveReopen.e2e.test.ts`
- `tests/e2e/electron/djvuPrintHandoff.e2e.test.ts`
- existing export and print browser/Electron tests

Integration-only files: `scripts/architecture/boundary-check.mjs`, `tests/unit/scripts/depGraph.test.ts`, `eslint-plugin-custom.mjs`, `eslint.config.mjs`, and the final changed-area test command. The integrator owns lint-rule activation and whole-repository checks.

### #310, workspace UI shell and viewer mounting

Candidate owned source paths:

- `app/modules/workspace-shell/components/DocumentWorkspace.vue`
- `app/modules/workspace-shell/components/DocumentViewerChassis.vue`
- `app/modules/workspace-shell/composables/useWorkspaceViewerVisibility.ts`
- `app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation.ts`
- `app/modules/workspace-shell/composables/useWorkspaceShellState.ts`
- UI composables released by Project 4, including `app/modules/workspace-shell/composables/useWorkspaceViewState.ts` and `app/modules/workspace-shell/composables/useWorkspaceInteractionControls.ts`
- `app/pages/workspace.vue`

Shared contract paths:

- `app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue`
- `app/modules/workspace-shell/composables/useWorkspaceViewerShellState.ts`
- `app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts`
- `app/modules/workspace-shell/viewers/workspaceViewerAdapters.ts`
- `app/modules/workspace-shell/useWorkspaceOrchestration.ts`
- `app/types/workspaceExpose.ts`
- PR #349 overlap paths are settled and released; the driver and adapter files remain shared #306 contract owners

Public interfaces to preserve or extend through the existing owners:

- `IWorkspaceDocumentDriverView`
- `IWorkspaceViewerCapabilities`
- `IWorkspaceDocumentDriverBindingOptions`
- `IWorkspaceToolbarSnapshot` and `IWorkspaceExpose`

Final-main baseline: `DocumentWorkspace.vue` is 1,474 lines and has 58 top-level import statements at `441aec95...`. Reproduce with `git show 441aec95e4a147e144e8f88098d9ded2bf3a78d7:app/modules/workspace-shell/components/DocumentWorkspace.vue | wc -l` and `git show 441aec95e4a147e144e8f88098d9ded2bf3a78d7:app/modules/workspace-shell/components/DocumentWorkspace.vue | awk '/^import[[:space:]]/{count++} END{print count+0}'`. The prior 1,492-line baseline is historical evidence from `36e66adb...`. The #310 issue's under-800 and under-30 figures are reporting targets unless its live child ticket defines otherwise. They do not justify dropping behavior or coverage. Mount the component supplied by the active driver, read capability flags for toolbar/panel visibility, keep PDF.js annotation and sidebar listeners intact, preserve native opening-preview handoff, and keep DjVu conversion/sidebar/view-control restrictions. The workspace component should retain layout and state coordination, not reintroduce format branches through a second registry. `DocumentWorkspace.vue:1150-1172` is the current #309 `useDjvuProjectionActions` action-wiring handoff; #310 owns the rest of the UI file and must coordinate that boundary with the integrator.

Focused tests:

- `tests/unit/app/modules/workspace-shell/viewers/workspaceDocumentDriver.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/createWorkspaceExpose.test.ts`
- `tests/unit/app/modules/workspace-shell/components/workspacePdfToolbarView.test.ts`
- `tests/integration/browser/documentLifecycleUi.test.ts`
- viewer mounting, toolbar visibility and panel availability Electron cases

Integration-only files: `scripts/architecture/boundary-check.mjs`, `tests/unit/scripts/depGraph.test.ts`, lint-rule activation, and final changed-area classification. The integrator owns these checks; released Project 4 and PR #349 reservations do not transfer integration-only ownership to a batch worker.

## Safest first implementation batch for #306

The safest first batch is #310, limited to viewer mounting and capability reads. The final tree already supplies `IWorkspaceDocumentDriverView`, the adapter capability tables, active component/props/listeners and the open-surface presentation owned by `DocumentViewerChassis`. This batch can replace UI format checks while leaving open fencing and save side effects untouched. #307 should follow once the lifecycle tests are claimed because it carries stale-instance, working-copy and restore ordering invariants. #309 should follow the save-owner handoff because it changes write and output side effects.

This is a migration recommendation, not current behavior and not an implementation in this report.

## Current source recheck and final implementation boundary

The source recheck is complete against current main `441aec95e4a147e144e8f88098d9ded2bf3a78d7`.

- Current main is 203 paths beyond the prior inspected source. Thirty-four focused paths changed in the workspace-shell, capability, browser-platform, or focused-test scope. This includes integrated annotation editing, save routing, command wiring, and driver binding changes. These are current source facts, not new #306 implementation ownership.
- Project 4 and PR #349 are settled historical merges. Their heads and merge commits are ancestors of current main. The 34 current paths remain recheck boundaries for the handoffs, while the named driver, adapter, lifecycle, save/export/print, and UI owners remain bounded as recorded.
- Driver and adapter facts remain stable at the current SHA: three adapter IDs, the PDF/image/DjVu document map, 16 capability fields, 27 boolean assignments, six source capability fields, the driver command union, view fields and lifecycle hook signatures. The branch counts remain 3/6/6/4/27, plus 16 public capability fields.
- Ownership remains bounded as recorded: #307 owns open/close/restore, #309 owns save/export/print, and #310 owns mounting/UI. Password-open state, writer-owned save routing and opening-surface ownership are current source facts.
- No hosted run is recorded for current main at this refresh. The older green run is retained only as historical evidence for the earlier inspected source.

At the final #306 implementation boundary, recheck the exact driver and adapter interfaces, capability values, lifecycle hooks, source owners, focused tests, six branch counts, 16-field interface count, `DocumentWorkspace.vue` measurements, exact image-export paths, PR #349 file query, and #307/#309/#310 owner assignments. These facts can drift after this report commit.

Before a child batch starts, refresh this exact checklist against its starting SHA:

- Re-read `workspaceDocumentDriver.ts`, `workspaceViewerAdapters.ts`, `workspaceViewerAdapterTypes.ts`, `workspaceExpose.ts`, `useWorkspaceFileLifecycleController.ts`, `useWorkspaceOrchestration.ts`, the #307 restore paths, the #309 save/export/print paths, and the #310 visibility/presentation/UI paths named above.
- Rerun the six labeled branch counts, the 16-field capability-interface count, the 1,492-line and 58-import `DocumentWorkspace.vue` measurements, the exact image-export query, and the nine-path focused delta query. Treat every value as drift-prone.
- Reconfirm the public interfaces `IWorkspaceDocumentDriver`, `IWorkspaceDocumentDriverOptions`, `IWorkspaceDocumentDriverSource`, `IWorkspaceViewerLifecycleHooks`, `IWorkspaceViewerLifecycleContext`, `IWorkspaceDocumentDriverView`, `IWorkspaceViewerCapabilities`, `IWorkspaceDocumentDriverBindingOptions`, `IWorkspaceToolbarSnapshot`, and `IWorkspaceExpose`.
- Requery PR #349 with its timestamp, rerun the exact 23-match filter, and confirm its settled ancestry before any child starts. The 23-path result is historical ownership evidence, not a live reservation ledger.
- Reconfirm the #307, #309, and #310 owner assignments, including `useWorkspaceOrchestration.ts` as integration handoff, `DocumentWorkspace.vue:1150-1172` as the current #309/#310 boundary, the historical `1166-1188` range, and `eslint-plugin-custom.mjs` plus `eslint.config.mjs` as integrator-owned activation paths.

## Final worktree evidence

This refresh edits only the owned report path. Treeish reads inspected the requested current main object; this task did not edit source, tests, configuration, workflows, native code, fixtures or generated files. No dependency install, build, Electron run or heavy test run was performed.

The closing command must be:

```sh
git status --short --branch
```

Expected closing output after committing the report is the clean branch line for `codex/project6-306-inventory`. The integrator should record the report commit SHA and the clean output in the handoff.
