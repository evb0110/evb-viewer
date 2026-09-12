# Navigation, zoom, and sidebar feature audit

Date: 2026-08-22. Read-only audit of the working tree. Method: four parallel deep reads (pagination/navigation, zoom, thumbnails sidebar, sidebar panels covering annotations/bookmarks/search), spot-checked against source. Citations are `file:line` as of the audit date; line numbers drift as code changes.

Areas covered: page navigation and pagination, zoom, the left sidebar shell, the pages/thumbnails panel including thumbnail clicks, bookmarks/outline, annotations, search, persistence, platform differences, gaps, and test coverage.

## 1. How the viewer is put together

Three renderer stacks mount inside one chassis and share one "open surface" session plus one programmatic scroll writer:

| Stack | Location | Notes |
|---|---|---|
| PDF.js viewer | `app/modules/pdf-viewer/**` | Most elaborate stack: viewport authority, navigation state machine, wheel paging |
| Native PDF preview (Electron) | `app/modules/native-pdf-viewer/components/NativePdfViewer.vue` | IPC raster driver, JPEG object URLs |
| Page-source viewer (DjVu etc.) | `DocumentPageSourceFeaturePack.vue`, `useDocumentPageSourceRuntime.ts` | Generic `IDocumentPageSource` contract |

Chassis: `app/modules/workspace-shell/components/DocumentViewerChassis.vue`. Shared session: `chassis/documentOpenSurfaceSession.ts`. Sole programmatic scroll writer: `chassis/documentViewportWritePort.ts`.

The left sidebar is one `AppSidebarShell.vue` tab strip with up to four tabs: annotations, thumbnails ("pages"), bookmarks, search (`documentSidebarTabs.ts:1-15`). The workspace shell owns visibility, width, and per-tab session persistence.

## 2. Page navigation and pagination

### 2.1 Current-page tracking during scroll

No `IntersectionObserver` anywhere in `app/`. Scroll-to-page mapping is synchronous intersection-area math:

- PDF.js DOM path: `engine/pdf-scroll-visibility/getViewportVisibilityFromDom.ts`. `collectVisiblePageMetrics()` (:199-263) computes each page's visible area as vertical × horizontal intersection with the viewport, skips buffered placeholders, early-breaks past the viewport bottom. Most visible page wins by strict `>`, so ties go to the earlier page (:241).
- Layout-metrics fallback when DOM yields nothing: same file :116-197, binary search over immutable row metrics.
- Compute cache keyed on container identity + scroll offsets + viewport size: `usePdfScroll.ts:247-282`; invalidated wholesale by `setPageLayoutMetrics` (:235).

DjVu/page-source uses a different tie-break: `resolveNearestDocumentPageToViewportCenter` (`resolveDocumentContinuousScrollWindow.ts:173-199`) binary-searches for the page whose center is nearest the viewport center; ties favor the previous page. Native PDF mirrors pdfjs semantics via `getVisiblePageNumber` (NativePdfViewer.vue:575-591). Boundary flicker behavior therefore differs slightly across renderers.

Hysteresis lives in several places rather than one debouncer:

- Stabilized sync samples the most-visible page three times across frames and majority-votes (`CURRENT_PAGE_SYNC_SAMPLE_COUNT = 3`, `usePdfViewerCurrentPageSync.ts:17`, sampling :285-351). Used for resize/zoom transitions, not plain scrolling.
- Reload recovery pins a page as authoritative for 900 ms (`RELOAD_RECOVERY_PAGE_PIN_MS`, `createPdfViewportSession.ts:65`; pin logic `useViewportPagePin.ts:52-79`).
- A navigation fence at workspace level rejects stale page commits while a programmatic target is pending (`createWorkspacePageNavigationFence.ts`: accept-and-clear on user scroll, reject mismatches while pending).

### 2.2 The semantic owner: viewport authority

`runtime/viewport/createViewportAuthority.ts`. `currentPage = committedAnchor.page ?? 1` (:80). User scroll calls `observeUserScroll(anchor)` (:224-230), which cancels any active intent. Programmatic navigation runs a phase machine idle → awaiting-metrics → resolving → awaiting-slots → applying → awaiting-visual → settled/cancelled (:147-222). Anchor↔scroll math in continuous mode lives in `pdfViewportGeometry.ts:187-287`.

### 2.3 Navigation commands and UI

Toolbar page control is `PdfPageDropdown.vue`: first / previous / next / last buttons (:4-93), stepping through `stepBySpread` so facing mode turns two pages per step (`pdfViewMode.ts:78-115`). Clicking the indicator opens an editable input that accepts page labels resolved by `findPageByPageLabelInput`; Enter commits, Escape cancels, blur commits (:24-72, :257).

Rapid Next/Prev composition uses a command cursor: `navigationCommand {page, revision++}` in `useWorkspacePageNavigationCommand.ts`, surfaced to the toolbar as `pendingNavigationPage ?? feedbackPage ?? currentPage` (`useWorkspaceToolbarPageModel.ts:109-113`). Feedback drives button enablement but is deliberately not displayed as current.

Keyboard: there are no keyboard shortcuts for page navigation in the main viewer. `usePageShortcuts.ts` handles only Escape, Delete/Backspace, Cmd/Ctrl+S/P/F/B, and zoom keys. No PageUp/PageDown/arrows/Home/End/Space anywhere in `app/` outside scan-cleanup's rail and thumbnail Shift+Arrow selection. No Electron menu accelerators page either.

Wheel paging (paged mode): `usePdfSinglePageNavigationController.handleWheel` (:964-1015) lets a page scroll freely until its interior bounds epsilon (`PAGE_SCROLL_EDGE_EPSILON = 1`), then flips one spread per gesture through a flip gate (`createWheelFlipGate.ts`: 180 ms same-direction cooldown, 200 ms idle window, 420 ms max block, 700 ms hard release). A `wheelNavigationCursorPage` lets consecutive packets compose. DjVu/page-source has an equivalent (`createPageSourcePagedWheelNavigation.ts`). Native PDF has none; its wheel handler is zoom-only, so paging feel differs between renderer kinds for the same file type.

Continuous vs paged: paged mode absolutely positions every page and hides non-current ones (page-source runtime `getPageStyle` :236-239); continuous stacks and virtualizes with `DOCUMENT_SOURCE_CONTINUOUS_MOUNT_RADIUS = 12`, `MAX_MOUNTED_PAGES = 40`, `MAX_RESIDENT_PAGES = 5` (:49-53).

There is no viewport-height "page down" command anywhere; progression is spread-snapping only.

### 2.4 The goToPage chain (PDF.js)

1. Workspace clamp: `normalizeNavigationPage` truncates, floors at 1, keeps the raw positive page when metadata is missing (`useWorkspaceViewState.ts:134-143`). Non-finite input silently becomes current-page.
2. `handleGoToPage` (:156-204) records the command, fences programmatic navigation, queues `{page, options}` in `queuedPageNavigation`, and replays when the viewer ref appears. Queued navigations survive mounting.
3. Chassis `scrollToPage` (:649-653) normalizes through `chassisAuthority.navigate` then forwards to the mounted stack.
4. Viewer submits a navigation request (`submitPageNavigation`, controller :635-642). Source defaults: `markerRect ? 'annotation' : 'toolbar'`; readiness/post-arrival per source (`search → text-layer + search-highlight`, `bookmark/thumbnail → page-canvas`).
5. Latest-wins queueing (:602-625), replay gated on runtime readiness (:558-600), authority submit as intent kind `search | wheel-page | navigate` with supersession key `'navigation'`.
6. Apply writes scroll once through the write port, then immediately re-projects the visible range so virtualization transfers ownership before paint (:347-350 comment). Awaits visual readiness, forcing renders if needed (:370-429).
7. Prop echo protection: requested-page props never supersede newer internal intent (`shouldSubmitRequestedCurrentPage`, :158-170).

Scroll writes are always instant jumps. No smooth scrolling exists anywhere in the viewer; `consumeAuthorityScroll` matches exact coordinates, so animation would need port changes first. Chromium scroll anchoring is disabled (`overflow-anchor: none`, DocumentViewerChassis.vue:679).

### 2.5 Navigation sources and instrumentation

Canonical union: `'bookmark' | 'toolbar' | 'search' | 'annotation' | 'thumbnail' | 'activation' | 'restore' | 'wheel'` (`engine/pdf-outline-navigation/scrollToPageOptions.ts:6`). Sources drive readiness/post-arrival behavior and trace logs (`workspace-go-to-page`, `navigation-*`, `viewport-*` events via `logPdfRenderTrace` and `BrowserLogger.diagnostic('pdf-nav', …)`). Analytics fires `navigation-idle` automation events per accepted page update but never records which source was used, so funnel analysis of thumbnail-vs-outline-vs-search usage is not possible from analytics today.

External/automation surface: `scrollToPage` exposed to agents (`createWorkspaceExpose.ts:457-459`), registered as a sync automation command, replayed through the deferred host so commands survive the async mount gap.

### 2.6 Where currentPage shows up

Upward path: viewer authority page → chassis gate `shouldAcceptFeaturePackChassisPage` → fence → `currentPage` ref. Consumers: toolbar dropdown display; thumbnails highlight + auto-reveal; bookmark active item via `resolveActiveBookmarkForPage` (last bookmark at-or-before the page, sticky); e2e data attributes `data-chassis-current-page` etc.; print/export read the live page.

### 2.7 Rotation interaction

Rotate CW/CCW routes through annotation materialization plus a reload transition, so reload placement preserves/restores the current page (900 ms pin). DjVu rotation requires PDF projection first, with page restore after (`useDjvuProjectionActions.ensureProjection` :20-34). Opening-page geometry validates rotation ∈ {0,90,180,270} so restored opens land on the correctly rotated frame.

## 3. Zoom

### 3.1 State, units, bounds

State lives in `useWorkspaceViewerShellState.ts`: `zoom` ref (manual multiplier, default 1, :65), `effectiveZoom` (displayed scale, :66), `zoomState` discriminated union `{kind:'custom',scale} | {kind:'fit',axis}` (:71-79), derived `zoomMode` `'custom'|'fit-width'|'fit-height'` (:80-98). Contracts in `packages/contracts/shared.ts:61-70`. Units are pure scale factors; display always formats as rounded percent.

Bounds (`app/constants/pdfLayout.ts:9-44`):

| Constant | Value |
|---|---|
| STEP | 0.25 |
| MIN (manual) | 0.25 |
| FIT_MIN | 0.1 |
| MAX | 10 |
| PRESETS | 50, 75, 100, 125, 150, 200, 300 % |

Clamping policy in `zoomPolicy.ts`: manual zoom clamps [0.25, 10], fit scale clamps [0.1, 10] so tiny pages can still fit. Per-call overrides exist for scan-cleanup preview.

There is no combined "fit page" mode in the document viewers; fit-width, fit-height, custom only. Scan-cleanup preview separately has fit-page.

### 3.2 Controls

- Dropdown: `PdfZoomDropdown.vue` with −/+ buttons (disabled at bounds against effective zoom, :199-204; step ±0.25), percent popover with preset chips, custom percent input (invalid input reverts), Fit Width/Fit Height toggles (:59-74), and view-mode toggles (single/facing/facing-first-single).
- Toolbar inline buttons gated by responsive tiers (`PdfToolbar.vue:104-160`); overflow menu items in `ToolbarOverflowMenu.vue:476-543`.
- Status bar percent: `usePageStatusBar.ts:218-223`.
- Shortcuts (`constants/shortcuts.ts:80-99`): Ctrl/⌘+1 fit width, ⌘+2 fit height, ⌘+= zoom in, ⌘+− zoom out, ⌘+0 actual size (sets exactly 1). The renderer handles them only in browser (`shouldHandleRendererMenuAccelerators`); Electron delivers them as OS menu accelerators over IPC (`electron/menu.ts:530-589`) to avoid double-firing.
- Wheel: shared intent resolver `input/documentWheelInteraction.ts:120-128`. Ctrl/⌘+wheel or deltaZ means zoom, except macOS ctrl+wheel which is classified `platform-scroll` and routed back to native scrolling. Exponential zoom math with sensitivity 0.0016, 180 ms gesture grace, per-document session key, clamping that re-bases cumulative delta (:155-206, :254-350). Gesture boundaries reset on pointerdown/non-modifier keydown (`useDocumentWheelZoomSessionBoundaries.ts`).
- Touch pinch: none exists anywhere. Electron additionally locks Chromium visual zoom (`electron/window.ts:119-129`).

Agent/MCP surface: `view.zoom_in/out/fit_width/...` actions in `useDocumentWorkspaceAgent.ts:895-918`.

### 3.3 Fit computation

PDF.js: `computeFitWidthScale` (`usePdfScale.ts:177-279`) divides available size (container minus `DOCUMENT_PAGE_GUTTER_PX = 20` per gutter) by the spread base dimension (width mode) or tallest page in the visible row (height mode), clamped. Signature cache avoids redundant recomputes; a preview scale updates layout during drag-resize before commit (:227-295).

Source-neutral layout for native PDF and DjVu: `resolveDocumentPageDisplayLayout.ts:24-55`, same math, min 1 px output.

Opening-frame provisional geometry projects a first-page shell at final scale while a document loads (`documentOpeningPageFrameAuthority.ts:59-112`, policy key `fitMode:viewMode:zoomMode:zoom`).

Recompute triggers: container resize (debounced rerender 200 ms), sidebar/split drag start-end (settle 20 ms), fit-mode command, page change in fit mode (50 ms coalesce; fit-height re-renders just the new row), view-mode change, continuous-scroll toggle. In continuous mode a custom zoom equal to the current fit scale silently flips back to fit-width (`syncFitWidthZoomModeForCurrentPage`, `usePdfViewerFitWidthController.ts:74-95`).

### 3.4 Scale to pixels

- PDF.js: `outputScale = max(devicePixelRatio, floor)` with floor 2 normal / 1 constrained; pixel budget clamp scales canvases down to `settledMaxCanvasPixels` (2^24 low … 2^27 workstation) while CSS size stays logical so the browser downsamples. Text/annotation layers hydrate via CSS vars `--scale-factor`, `--user-unit`, `--total-scale-factor` (`pdfPageScale.ts:1-45`).
- Zoom orchestration queue coalesces bursts (setTimeout-0), defers resize rerenders behind zoom up to 1500 ms, and throttles gesture frames (110 ms min interval; `idle-once` raster mode on low-tier hosts waits for gesture idle). Committed-canvas snapshot leases keep the old frame visible until the replacement commits, so zooming does not flash blank.
- Native PDF: DPR capped at 2, raster identity `{generation,page,w,h,targetWidthPx}` decides re-render, concurrency 2.
- DjVu/page-source: render target width = round(points × effectiveZoom × dpr); every zoom tick schedules a rAF-coalesced re-render; render aborts while resizing.

### 3.5 Scroll preservation across zoom

Shared anchor math in `zoomAnchor.ts`: capture the point ratios relative to the page rect under the viewport center or cursor, reproject under new layouts, reuse latent anchors within 1 px tolerance. Lifecycle owner `useDocumentViewportLayoutLifecycle.ts` captures pointer anchors during wheel packets and schedules restores nextTick+rAF; restores route through the sole write port with reason `'zoom-anchor-restoration'`, and wheel packets with zoom intent do not bump the interaction epoch, so authored restores are not fenced off by the gesture itself.

Cursor-anchored wheel zoom (PDF.js) goes further: capture snapshots, submit an atomic viewport-state intent carrying the cursor point before any mutation, skip the second anchor replay afterward. Anchor freshness window 240 ms; expected-scroll window 1400 ms absorbs programmatic churn; session lock suppresses single-page snapping mid-gesture.

Non-wheel zooms fall back to a semantic resize anchor, trusting currentPage only when inside the visible range.

### 3.6 Persistence

Per-tab session checkpoints store zoom/effectiveZoom/zoomMode/fitMode (`createTabViewSessionState.ts:12-15`). Desktop crash checkpoint persists them per tab (`buildWorkspaceCheckpoint.ts:81-83`), web equivalent `useBrowserWorkspaceRecovery.ts`. Restore re-issues fit commands or applies the stored custom value; effectiveZoom is recomputed, not restored. App default zoom for new documents: settings preset fit-width / fit-height / 100 / 125 / 150, applied on source change (`useWorkspaceViewerDefaults.ts:45-77`). No per-file zoom memory beyond tab/checkpoint scope.

Reload retention: display zoom captured pre-reload and reapplied after metrics (`createPdfViewportSession.ts:692-775`); note that `resolveCustomReloadZoomMultiplier` currently ignores its inputs and returns the target directly, i.e. manual zoom equals display zoom by construction.

## 4. Left sidebar shell

### 4.1 Tabs and capabilities

Fixed order `['annotations','thumbnails','bookmarks','search']`, filtered by a capability lookup where thumbnails ← capability `pages` (`documentSidebarTabs.ts:10-26`). Fallback order: preferred → thumbnails → first available. `useDocumentSidebarCapabilitySession.ts` keeps user preference separate from format-enforced availability so viewing a DjVu does not destructively rewrite the preferred tab; tabs stay hidden until `capabilitiesReady` to avoid flashing.

Consumers declare capabilities differently: PdfSidebar declares `{annotations: !isDjvuMode, bookmarks: true, pages: true, search: true}` (:301-306); DocumentSourceSidebar derives from provider presence (`outlineProvider`, `thumbnailProvider`, `searchProvider ?? textProvider`) (:86-98).

### 4.2 Shell mechanics

`AppSidebarShell.vue` is a dumb tabbed aside. UTabs with `:content="false"`; panel content is a slot and panel visibility is the caller's job. A hidden probe div measures natural tab widths and flips to compact (icons + sr-only labels + tooltips) on overflow, recomputed on resize and locale change (:21-91).

Open/close and width are owned above the shell: `WorkspaceSidebarHost.vue` conditionally mounts (`v-if="showSidebar"`) and provides an 8 px resizer with `role="separator"`. Width constants `SIDEBAR = {DEFAULT_WIDTH: 272, MIN_WIDTH: 220, MAX_WIDTH: 520, RESIZER_WIDTH: 8, MIN_VIEWER_WIDTH: 320}` (`pdfLayout.ts:1-7`); effective max = min(520, container − 320); reopen restores last open width; drag listeners attach only during the gesture (`useSidebarResize.ts`).

Persistence: per-tab session state stores `showSidebar/sidebarTab/sidebarWidth` (defaults `'thumbnails'`, 272) in the workspace document record and exposes them to agents (`createWorkspaceExpose.ts:287-288`). Not localStorage. Toggle command id `'toggle-sidebar'`, shortcut Cmd/Ctrl+B (`usePageShortcuts.ts:307`).

Both sidebars keep content mounted with `v-show`, so scroll position survives tab switches and collapse. Exception: PdfSidebar mounts the outline panel with `v-if` (see gaps, §12a).

Auto-reset guard: leaving the annotations tab or closing the sidebar emits `update:annotation-tool 'none'` so no drawing tool stays armed invisibly (`PdfSidebar.vue:413-432`).

i18n labels: `sidebar.annotations/notes/pages/bookmarks/search` in `packages/i18n-app/messages/en.ts:180-187`, mirrored in eight other locales.

## 5. Thumbnails panel (pages)

### 5.1 Structure

One shared presentation kit, three surfaces built on it:

| Surface | Host | Rendering |
|---|---|---|
| PDF viewer | `PdfSidebar.vue` → `DocumentSidebarPagesPanel` + `PdfThumbnails` canvas rail | pdf.js canvas raster, own scheduler |
| Generic page-source (DjVu, native PDF preview) | `DocumentSourceSidebar.vue` → `DocumentThumbnailList` | `thumbnailProvider` leases: canvas or object-URL `<img>` |
| Scan-cleanup tool rail | ScanCleanupWorkspace own aside | generic provider path |

`DocumentSidebarPagesPanel.vue` is a dumb header/rail/footer flex panel. "Rail" names the scroll container; "list" names the virtualized stack inside it. There is no user-facing rail/list toggle; the names are structural. Two class strings are load-bearing: `.pdf-sidebar-pages-thumbnails` is the auto-scroll lookup target for drag-drop and the external-file-drop hit area.

### 5.2 Rendering pipelines

Generic pipeline (`useDocumentThumbnailController.ts`): demand reconciler with concurrency 3; visible range + 700 px virtual overscan + 420 px render overscan + current±2 pages; rank ordering current < visible < other; current page forced settled quality. Raster width bucketed to 32 px, output scale clamped [1,2]×dpr, minimum CSS width 96. Placeholder pulse disabled under low-graphics and reduced-motion. Object-URL surfaces pre-decode off-DOM before commit so nothing flashes half-decoded.

PDF pipeline (`PdfThumbnails.vue` + `usePdfThumbnailRenderRuntime.ts`): seed width 150, immediate radius 2, prefetch radius 4, lane concurrency 1/2/4 by performance profile. Render key gates staleness on `[epoch, page, width, scale, pageEpoch, visualSignature]`. Already-rendered canvases keep their bitmap while a fresh offscreen canvas renders, then blit back. Bounded rasters (4 Mpx, 16384 px). Under-resolution canvases are cleared and re-rendered. Aspect ratios learned lazily at first paint, seeded by a single-page preload. On reload the measured raster width is kept instead of falling back to the 150 px seed (regression-tested).

Invalidation entry points: lease invalidation (DjVu budget eviction), full reset on document change, explicit `invalidatePages` fed by annotation edits and page ops, and annotation visual-signature changes that re-key affected rows without clearing others. Main-view zoom does not invalidate thumbnails.

Priority classes identical everywhere: navigation 100 > visible 90 > nearby 50 > thumbnail 20 > prefetch 10, so thumbnails evict first under memory pressure and re-render on demand.

### 5.3 Clicking a thumbnail

Generic list: item renders as a native `<button>` with accessible name "Go to page {page}" (`DocumentThumbnailList.vue:27-32`). Click → emit `go-to-page(pageNumber, event)` → `DocumentSourceSidebar` drops the event argument (:19) → workspace `handleGoToPage` → the §2.4 chain.

PDF rail: mousedown arms drag; click handler first consumes a post-drag click-skip token (so reorder never navigates), then checks modifiers. Shift extends range from anchor, Ctrl/Cmd toggles multi-select, otherwise navigate: `emit('go-to-page', page, {navigationSource:'thumbnail'})` → `PdfSidebar.goToPage` → workspace chain with `readiness:'page-canvas'`.

Keyboard: the generic list gets Enter/Space free from the native button. The PDF rail is a `tabindex="0"` container whose keydown handles only Shift+Arrow selection extension (which also navigates and scrolls the focused page into view); rows themselves have no tabindex, role, or activation. Plain arrows/Enter do nothing on PDF rows.

Repeated clicks on the same page intentionally re-issue the navigation intent rather than dedupe; this heals evicted canvases after virtualization.

### 5.4 Current-page highlight and auto-follow

`is-current` class + `aria-current="page"`, bold label, ring border (`DocumentThumbnailItem.vue:111-149`). An architecture test forbids format-owned overrides of current-state styling.

Sync loop: currentPage prop change → reveal policy scrolls the rail using a comfort viewport policy (padding clamp(16..48 px, 12% of clientHeight); fully-outside pages center; clipped neighbors get minimal nudge; comfortable pages don't move). Anti-fight guards: manual interaction (pointerdown/wheel/unauthored scroll) suppresses auto-follow for 700 ms; programmatic writes are recognized for 160 ms so they don't count as manual. PDF variant adds suppression while resizing/dragging, a refined post-layout pass, and a pane-activation retry loop (up to 4 frames). Reverse direction is one-way by design: scrolling the rail never writes currentPage.

Scroll anchoring survives width/aspect changes via a Fenwick-tree anchor captured/restored across two rAF paints, because Teleport-target swaps can silently zero scrollTop.

### 5.5 Selection, drag reorder, context menu (PDF only)

Multi-select: normalized sorted unique `selectedThumbnailPages` owned by the workspace, synced bidirectionally with an internal selection model with anchor+focus, clamped when totalPages shrinks, remapped after delete/reorder. Hover-revealed per-row checkbox with aria-pressed.

Drag reorder: 5 px threshold, rAF-coalesced moves, drop index by midpoint on the layout, contiguous-block no-op detection, edge auto-scroll (40 px zones, 6 px/frame), body grabbing cursor, click suppression after drop. Drop remaps selection via old→new map and currentPage via identity delta. External PDF files dropped on the rail insert after the hovered page (Electron paths vs browser File handles unified behind `registerFilesForOpen`).

Context menu: right-click targets the selection if it contains the page else just the page; items Delete (danger), Extract, Export, Rotate CW/CCW, Insert Before/After, Select All, Invert Selection, all disabled during operations or in DjVu mode. Header selection bar duplicates rotate/extract/export/delete/deselect; footer numbering editor consumes/produces contiguous selections.

The generic list supports display-only selection (`selectedPages` prop switches rows to listbox option semantics) but clicks carry no modifier semantics because the middle layer drops the MouseEvent. Scan-cleanup's rail resolves shift/ctrl/meta intents itself and adds arrow/Home/End/PageUp/PageDown keyboard nav with step 5.

### 5.6 Virtualization

Fenwick tree over per-page heights gives O(log N) prefix sums and insertion indexes (`documentThumbnailLayout.ts`); rows absolutely positioned; chrome heights (label row, 30 px base, 8 px gap, default aspect 297/210 landscape A4) measured from live DOM, excluding the bold-current row from base measurement so highlight weight doesn't skew layout. Mount bound verified by test: a 500-page source mounts fewer than 30 rows.

## 6. Bookmarks / outline panel

### 6.1 Components and data sources

Generic read-only tree: `DocumentBookmarkTree.vue` (virtualized, fixed 42 px rows, overscan 12, iterative DFS flattening, active-follow scrolls the rendered row into view or falls back to `scrollToRow`) and `DocumentBookmarkTreeItem.vue` (row `role="button"`, Enter/Space activate, `aria-current="location"`, caret stops propagation). Display modes: top-level / all-expanded / current-expanded via `DocumentBookmarkToolbar.vue`.

Contract: `IDocumentOutlineItem {title; pageNumber|null; children}` plus `getOutline(signal)` (`documentPageSource.ts:49-55`). DjVu adapts it from the worker preview source; PDF parses directly from pdf.js.

### 6.2 PDF outline parsing

`loadOutline()` in `PdfOutline.vue` (:653-671): `pdfDocument.getOutline()` → normalization tolerating junk items, dest accepted only as string/array/null, named destinations cached with negative results cached too, page index from numeric dest or `{num,gen}` ref cached by `"num:gen"` (:375-408). Vertical landing ratio computed only for XYZ/Fit/FitB/FitH/FitBH/FitR kinds, clamped 0..1 (:281-343). Hard caps `MAX_OUTLINE_DEPTH = 256`, `MAX_OUTLINE_ITEMS = 10000` degrade gracefully with warnings. Bold/italic/color style survives ingest. Pending external edits win over the disk outline (`bookmarksDirty` short-circuit).

### 6.3 Editing

`usePdfOutlineEditing.ts`: new drafts anchor to the current page with default title; add root/sibling-above/sibling-below/child each focuses inline editing immediately; rename commits trimmed non-empty titles (Enter commits, Escape restores, blur commits); bold/italic/color toggles with change detection; removal collapses selection to ancestors, picks a sensible next-active neighbor, prunes stale ids globally. Persistence mapping trims titles with an untitled fallback, clamps ratios, keeps namedDest only for non-blank strings.

Selection: ctrl/meta multi-select, shift range, resolved from pointer modifiers; edit mode suppresses navigation on modifier clicks.

Drag reorder: edit mode only; dragging a selected set drags its root representatives; illegal drops into own subtree blocked early and on drop; drop zones before/after/child by row-relative Y bands <0.28 / >0.72 / middle; child-drop auto-expands target; root-end append zone at tree bottom. Pure tree-surgery helpers detect no-op moves via JSON comparison.

Context menu: rename, sibling above/below, add child, bold/italic/default-A toggles, color preset swatches, style-range start/apply, destructive remove whose label reflects how many entries one click removes.

### 6.4 Bookmark click → navigation chain

Read mode: `DocumentBookmarkTree @activate` → `activateSharedBookmark(id)` (clicking the already-active bookmark just toggles expansion) → `navigateToBookmarkDestination` builds a request with source `'bookmark'`, attaches `named-dest` when present, forces `alignment:'page-top'`, `readiness:'page-canvas'`; resolution, supersession, mounting, readiness, and the single pixel write belong to viewport authority (`engine/pdf-outline-navigation/navigateToBookmarkDestination.ts:18-41`). Stale navigations doubly invalidated via monotonic request id + `navigationIntentVersion`. Two-phase fast-jump helpers replay equal resolved targets so virtualized pages still land precisely.

### 6.5 Active bookmark during scroll

`watch(currentPage)` → `updateActiveItemFromCurrentPage()` picks the last flat item with `pageIndex <= currentPage` (sticky "most recent bookmark at-or-before page"); the generic tree then auto-scrolls to the active row within visible rows only.

### 6.6 Where bookmarks persist

Not localStorage, not the analytics DB. Saved into the PDF file itself:

1. In-memory authority `useBookmarkState.ts`: wholesale-replaced shallowRef (deep reactivity would hand out a Proxy that structured clone refuses), dirty flag, revision counter.
2. Renderer route: `serializePdfEdits.ts:111-117` → `applyBookmarks` writes outlines via pdf-lib.
3. Native route (Electron Rust): `buildNativeBookmarksMutationForSave` admitted by save-route classification, executed with expectedPageCount postcondition.
4. Browser exports write bookmarks too (streaming writer, combine worker, DjVu→PDF conversion collects them).

Dirty protocol: baseline JSON snapshot at load, every mutation emits `{bookmarks, dirty, history}`; external applications (undo/save-reload/agent) rebuild the tree with fresh ids and reset expansion/selection/editing state.

## 7. Annotations

### 7.1 Panel composition

`PdfAnnotationsPanel.vue`: tool ribbon (`PdfAnnotationToolbar`) + "keep selected tool active" checkbox; tool vocabulary draw, text, highlight, underline, strikethrough, squiggly, rectangle, circle, line, arrow, select; clicking the active tool deselects to none. Style popover anchored to the active toolbar button opens automatically on tool change and closes while comments reload. Annotation list below: `PdfAnnotationCommentsList.vue` with live count, place-note button, search filter with `<mark>` highlighting, virtualized 112 px rows sorted by summary comparison, kind labels covering all supported subtypes, shape stroke previews with width/fill/opacity, author fallback chain ending at "unknown author", localized timestamps. Row interactions: click focuses, dblclick opens note windows for note-eligible annotations (freetext/typewriter), hover-revealed trash deletes.

### 7.2 State and ingestion

Workspace session `useWorkspaceAnnotationSession.ts` owns comments/status/tool/settings/dirty revisions; `annotationKeepActive` persists alone to localStorage key `pdf.annotations.keepActive`. Canonical domain store at `annotations/domain/annotationStore.ts`: entity Map, external identity index, history authority, saved-semantic snapshots, import modes replace/reconcile/adopt-self-saved.

PDF.js ingestion bridge `annotations/bridge/pdfjs-runtime/useAnnotationSync.ts` merges live editor summaries with a full-document snapshot collected visible-page-first, yielding via requestIdleCallback(250 ms), capped at 5000 pages / 25000 records. Module-global LRU of 8 shared snapshot clones keyed by identity+revision-token+pageCount. Author/name enrichment reads eagerly only under byte-size limits, pageCount ≤ 512, and blob sources; interactive reconciliation on UI-open or first mutation with taxonomy reconciled/already-reconciled/skipped-over-limit/stale/failed. Deleted-editor filtering, replaced-editor rebinding when exactly one same-page/subtype candidate exists. Sync cadence: coalesced rerun loop + 140 ms debounce; first authoritative pass adopts the ingested set as saved baseline unless the user already mutated.

### 7.3 Creation UX

Drawn/highlight tools go through the PDF.js annotation editor layer; leaving the tab disarms. Place note (list header button) opens the sidebar on the annotations tab and calls `viewer.startCommentPlacement()`; toolbar quick-note preserves and restores prior sidebar visibility/tab. On-page context menu: free note at point, selection note, markup creation honoring keep-active, insert image from file/clipboard with embedded-mutation round trip under a document-operation lease. Focus-from-list sets the active stable key and delegates to `viewer.focusAnnotationComment`.

### 7.4 FreeText note windows

UI-only state `{annotationId, draftText, minimized, position}`; saves debounced through `updateAnnotationCommentInViewer` resolving canonical comments by app id first. Disappearance grace 5 s. Workspace flows open windows pinned to the active key and invalidate the page; deletion removes matching windows and sweeps remaining ones only when the list verifiably became empty. Overlay rendering `WorkspaceAnnotationOverlays.vue` + `createAnnotationOverlayRuntime.ts`: floating eligibility by subtype, page-target mapping, render-signature memoization, z-order slots (active base 90, anchor base 25, 8 slots each; constants in `NOTE_WINDOW`, pdfLayout.ts:46-66).

FreeText persistence contract (primary source `docs/architecture/freetext-note-persistence.md`): PDF.js PopupAnnotation reads `/Contents` from its parent FreeText dict while FreeText must hide contents from canvas; working solution replaces the AP stream with a blank Form XObject and shrinks the rect to ≤0.02 normalized size (inclusive marker threshold); legacy zero-width-character notes stripped during ingestion; save ordering invariant rewriteFreeTextNoteRects strictly before embedded-text rewrites, mirrored exactly in `serializePdfEdits.ts:102-104`. Native-save replay handles freshly created notes with alias-conflict skips.

### 7.5 Highlights/shapes save pipeline + thumbnail coherence

Serialization order in `serializePdfEdits.ts:90-118`: markup-subtype rewrites → shapes (incl. canonical-ref deletes) → embedded annotation deletes → FreeText rects → new FreeText notes → embedded note texts → canonical identity bindings → page labels → bookmarks → placed images. Save-route admission weighs annotation dirty flag, live storage fingerprints, and native capability flags. Thumbnail coherence: hidden annotation ids thread into `PdfThumbnails`; annotation mutations invalidate both viewer pages and thumbnail pages. DjVu projection declares `annotations: false`, hiding the tab.

## 8. Search panel and result navigation

### 8.1 Presentation

`DocumentSearchPanel.vue` (sticky header + results, autofocus on activation), `DocumentSearchBar.vue` (Enter runs, Shift+Enter previous, clearing re-runs; Aa/whole-word/regex toggles; prev/next arrows disabled at zero matches), `DocumentSearchResults.vue` (grouped by page into mixed virtual rows 36/84 px, overscan 8; new query expands only the first page group, streamed updates preserve expansion and auto-expand new pages; determinate progress with pages text; truncation chip "showing first N"; five distinct empty/error states; navigation watcher expands the active group and scrolls it into view), `DocumentSearchResultItem.vue` (page indicator respects custom page labels; match number per page; excerpt with `<mark>`; `aria-current="true"` on active).

### 8.2 Session and backends

Contract `IDocumentSearchSession` (`documentSearch.ts:51-70`); matches carry optional word-box geometry for highlight mapping. Format-independent engine `useDocumentSearchSession.ts`: dual-generation staleness (backend + run), minQueryLength derived from backend, select bumps navigation id and fires onNavigate, auto-selects result 0 after success. Backend chooser prefers indexed searchProvider over page-by-page textProvider scan (DjVu worker provides either).

PDF engine (Electron desktop) `usePdfSearch.ts`: trims query and strips symmetric surrounding quotes; min length 1; debounced execution cancelling prior backend requests via capability; streaming progress merged by resultsStartIndex with FNV-1a signature tokens for cheap diffing; current-result preservation across updates including geometry changes; wrap-around next/previous; typed too-large error localization; telemetry buckets.

Electron side: dedicated search worker process maintaining bounded index caches, headless pdfjs extraction, compact sidecar persistence with legacy JSON fallback, native Rust binary path first (`evb-pdf-search`, memmap2/unicode-casefold) with JS fallback logged; regex/wholeWord unsupported natively; sidecar validity keyed to max(pdf mtime, ocr manifest mtime) so OCR output participates in search text and invalidation; persistent native service preferred with one-shot fallback.

Browser build `createBrowserSearchCapability.ts`: documents >64 MiB reject with typed error; web-worker extraction with direct fallback; memory LRU 4 prepared documents plus inner page-text LRU 24 pages / 32 MiB; IndexedDB persistence DB `evb-browser-search-cache` validated against file size/contentSignature/documentRevision/pageCount before hydration, pruned to 16 records / 128 MiB by last access; highlight-grade runs demand per-page geometry so matches map to word boxes; mid-page stop at result limit emits truncated flag.

### 8.3 Result click → navigation chain

PDF: item activate → results `goToResult(index)` → panel session.select → adapter validates → workspace handleGoToResult → `usePdfSearch.setResultIndex` bumps navigation id → driver injects matches/current-match/navigation-id into viewer props → render controller watches them → `usePdfTextLayerRenderer.scrollToCurrentMatch` performs the scroll with explicit branches for unmounted page / missing text layer / empty rects. The sidebar list simultaneously auto-scrolls to the active row.

Non-PDF: session.select → onNavigate → `handleGoToPage(pageIndex + 1, {navigationSource:'search'})`; the viewer receives results/current-index only while the sidebar is open on the search tab.

### 8.4 Highlight rendering on pages

PDF text layers `usePdfSearchHighlight.ts`: clears prior art (CSS Highlight API ranges + DOM spans + restored mapped text), indexes text-layer runs, normalizes, reconciles stored offsets to visual matches, computes per-run overlaps. Preferred rendering: CSS Custom Highlight API registries named `pdf-search-match` / `pdf-search-current-match` with deterministic range ids; fallback PDF.js-style span injection. Debug switches via localStorage keys. DjVu/page-source overlays word-box rectangles from match geometry only once the page visual is fresh.

Lifecycle: openSearch opens sidebar+tab+focus request; closeSearch clears results and returns to thumbnails tab; document/revision changes clear results.

## 9. Persistence summary

| Thing | Where persisted | Notes |
|---|---|---|
| Zoom/mode/fit axis | Per-tab session checkpoint + desktop crash checkpoint + web recovery store | effectiveZoom recomputed on restore |
| Default zoom for new docs | Browser settings storage | preset incl. fit-width/fit-height |
| Sidebar open/tab/width | Per-tab session state, workspace record, agent expose | defaults thumbnails/272 |
| currentPage | Same session/checkpoint stores | restored after pageCount known |
| Bookmarks | Inside the PDF file itself | renderer or native route; no localStorage |
| Annotations | PDF file (embedded) via serialization/native routes | keep-active checkbox is the only localStorage annotation key |
| Thumbnail rail scroll | Not persisted across sessions; preserved across pane relocation and tab switches (v-show) | pane relocation snapshots nearest row + intra-row ratio |
| Search cache (web) | IndexedDB `evb-browser-search-cache` | Electron uses sidecar files |

## 10. Platform differences

- Thumbnails are platform-agnostic above the source seam; providers differ (web DjVu = WASM worker rasterization; Electron DjVu and native PDF preview = IPC returning JPEG bytes).
- Keyboard shortcuts: browser handles zoom/save/print in-renderer; Electron delivers OS menu accelerators over IPC and must not preventDefault.
- External thumbnail drop registration differs (real paths vs File objects) behind one capability seam.
- Native PDF raster driver exists only on Electron (DPR cap 2); it lacks wheel paging, unlike pdfjs/page-source viewers.
- Chromium visual zoom locked in Electron; web relies on wheel preventDefault.
- Performance profiles adapt raster concurrency/budgets by device tier, not OS.

## 11. Constants quick reference

| Constant | Value | Where |
|---|---|---|
| SIDEBAR default/min/max/resizer/min-viewer | 272/220/520/8/320 px | pdfLayout.ts:1-7 |
| ZOOM step/min/fit-min/max | 0.25/0.25/0.1/10 | pdfLayout.ts:9-44 |
| THUMBNAIL_WIDTH seed | 150 | pdfLayout.ts:68 |
| NOTE_WINDOW margins/sizes/z | margin 8, min 260×240, default 380×360, z bases 90/25, slots 8 | pdfLayout.ts:46-66 |
| Thumbnail overscan (generic) | 700 px virtual / 420 px render | useDocumentThumbnailController.ts:31-32 |
| Auto-follow cooldown / programmatic guard | 700 ms / 160 ms | controller :36-37 (duplicated in PdfThumbnails.vue:124-125) |
| Wheel flip gate | 180/200/420/700 ms | createWheelFlipGate.ts:3-11 |
| Reload page pin | 900 ms | createPdfViewportSession.ts:65 |
| Current-page sync samples | 3 | usePdfViewerCurrentPageSync.ts:17 |
| Drag threshold / scroll zone / speed | 5 px / 40 px / 6 px per 16 ms | usePageDragDrop.ts:57-60 |
| Outline caps | depth 256, items 10000 | pdfOutlineHelpers.ts:24-25 |
| Annotation sync caps | 5000 pages, 25000 records, debounce 140 ms | useAnnotationSync.ts:126-127 |
| Note disappearance grace / save debounce | 5000 ms / ANNOTATION_NOTE_SAVE_DEBOUNCE_MS | useAnnotationNoteWindows.ts:17,66 |
| Browser search limits | 64 MiB doc cap; LRU 4 docs; IndexedDB 16 recs/128 MiB | createBrowserSearchCapability.ts |
| Page-source continuous limits | mount radius 12, mounted max 40, resident max 5, concurrency 2 | useDocumentPageSourceRuntime.ts:49-53 |

## 12. Gaps, potential bugs, odd corners

a. **Bookmark panel state destroyed by v-if**: PdfOutline mounts with `v-if="isOpen && effectiveTab==='bookmarks'"` while all other panels use `v-show`. Every departure unmounts it, resetting display mode, expansions, selection, style range, and forcing a full outline reload on return. The generic sidebar uses show-style blocks, so behavior differs by format.

b. **effectiveTab can name an unavailable tab** while capabilities are not ready (`reconcile(...) ?? preferredTab`), producing a selected tab with an empty content area until readiness settles.

c. **Scroll-to-active fails under collapsed ancestors**: the bookmark tree scrolls only within visible rows; a deep active bookmark in top-level mode can sit off-screen until manually expanded.

d. **Active-bookmark tie-breaks are order-sensitive**: equal-page candidates resolve to whichever appears later in flatten order; a child inheriting its parent's page outranks an earlier sibling branch regardless of hierarchy intent.

e. **Positional bookmark ids cause state loss on external sync**: ids regenerate on every external application (save/reload/undo round-trip), wiping expansion/selection/editing state even for structurally identical lists.

f. **Dirty detection by JSON.stringify comparison** of bookmarks: safe today because both sides pass through the same persistence mapping, but brittle to future field additions and O(document) stringify per edit on large outlines.

g. **PDF sidebar search cancel is a stub** (`cancel: () => undefined`): leaving the search tab neither cancels the in-flight IPC/native search nor the pending debounce; wasted cycles possible until run-id staleness catches up at completion.

h. **Minimum query length differs by format**: 1 char for PDF vs 2 for document-source backends; communicated but inconsistent.

i. **Exact-limit truncation ambiguity (browser)**: reports truncated when total equals the limit exactly; UI then claims "showing first N" though nothing was cut.

j. **Note-window ↔ cursor-mode invariant is prose-only**: if annotationCursorMode ever evaluates false while note windows are open, PDF.js tears down backing editors; only a bridging computed prevents it, with no type enforcement.

k. **The 0.02 point-note threshold is duplicated**, not shared, between the comments list marker detection and the serialization boundary; divergence would make list classification disagree with save behavior.

l. **Silent author metadata gaps on big PDFs**: oversized documents quietly render "unknown author" placeholders with a skipped-over-limit result that surfaces nowhere.

m. **No keyboard paging anywhere** (accessibility): main viewer supports no PageUp/PageDown/arrows/Home/End/Space navigation; keyboard users get scrollbar or toolbar buttons only. Relatedly, the flagship PDF thumbnail rail rows lack tabindex/role/activation, unlike generic and scan-cleanup rails.

n. **Generic sidebar drops modifier info**: DocumentThumbnailList emits the MouseEvent but DocumentSourceSidebar forwards only the page number, so ctrl/shift multi-select can never work there despite display support existing.

o. **Failed thumbnails have no retry/error UI** in the generic controller: onError is never provided, so a failed render leaves a pulsing placeholder until some other state change retriggers demand.

p. **Duplicated policy constants/logic between adapters**: the 700/160 ms cooldown/guard pair and reveal policy exist in both the generic controller and PdfThumbnails; architecture tests enforce composition, not values. Drift risk.

q. **Tie-breaking inconsistencies between viewers**: most-visible-area (pdfjs, earlier wins) vs nearest-center (page-source, previous wins) vs free-scroll-only (native PDF). Same document type can flicker differently at boundaries.

r. **No smooth scrolling at all**: intentional, but any future smooth-scroll desire conflicts with exact-coordinate write fencing.

s. **navigationSource never reaches analytics**: sources are trace-log only, limiting funnel analysis.

t. **Latent width default mismatch**: PdfSidebar falls back to 240 when width prop missing though canonical default is 272; unreachable today.

u. **metricsCache unbounded within a document lifetime** in the generic controller; cleared only on source change. Fine for typical sizes.

v. **Module-global annotation snapshot LRU** retains up to eight structured-cloned whole-document arrays across tabs/workspaces; bounded in count, unbounded in bytes.

w. **Cosmetic dead controls**: DocumentSourceSidebar shows the bookmark display-mode toolbar during loading/error states; closeSearch hardcodes thumbnails without availability check.

x. **DjVu search highlights are sidebar-gated**: collapsing the sidebar mid-review erases page highlights until reopened (deliberate perf choice, visually surprising).

y. **Verified-safe corners worth knowing**: locale switches re-trigger the compact-tab probe correctly; structuredClone boundaries around pdfjs proxies respected by the wholesale shallowRef bookmark store; stale async bookmark navigations doubly invalidated; post-drag click suppression prevents reorder-as-navigation; reload transitions keep measured raster width to avoid the 150 px seed trap.

## 13. Test coverage map

Unit tests:
- Shared layout engine: Fenwick tree cases incl. anchor preservation and first-aspect adoption (`documentThumbnailLayout.test.ts`)
- Reveal policy and scheduler priority/concurrency/stale-release
- Virtualization bound: 500 pages < 30 mounted rows
- Architecture boundaries asserting shared panel/rail/item composition and no format-owned current-state styles
- PDF selection renormalization; drag/drop; page ops remapping selection and currentPage
- Sidebar shell integration (nav routing, fit probe, sr-only labels, resizer sharing)
- Save-route admission including bookmarks dirty flag; agent bookmark plan validation; annotation round-trip harness carries bookmarks field
- Zoom: render queue lanes, inactive cancellation, reload raster-width retention, canvas render keys, annotation suppression in thumbnails

E2E (Electron/Playwright):
- Viewer smoke: scan rail rows, thumbnail paint probes, sidebar geometry/resizer probes, all four tabs asserted by role
- Full sidebar search loop on real files including native late-page DjVu search with visible result geometry and aria-current assertions
- No under-resolution thumbnail on first sidebar open
- Split-pane continuity against the thumbnail rail; annotation lifecycle; capture parity snapshot helpers reading data-page attributes

Known coverage gaps: no direct unit test for `useDocumentThumbnailController.ts` itself (only indirect), none for `DocumentThumbnailItem/Rail/AppSidebarShell` in isolation, no end-to-end test of PDF rail keyboard handling, and no test exercising bookmark panel unmount/remount state loss (gap a).
