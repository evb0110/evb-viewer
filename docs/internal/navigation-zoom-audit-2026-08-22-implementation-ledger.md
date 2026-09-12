# Navigation, zoom, and sidebar audit implementation ledger

Date: 2026-08-23

Source audit: `docs/internal/navigation-zoom-feature-audit-2026-08-22.md`.

## Verification baseline

- Local checkout: `26c7b8d6b641f81c501d66dcf239a3ff90d31bcd` (current `main`), clean
  working tree apart from the two untracked audit documents.
- Method: four parallel read-only verification passes (navigation, zoom,
  sidebar/thumbnails, bookmarks/annotations/search), each tracing every concrete
  audit claim to current source with exhaustive searches for the negative
  claims, followed by a single synthesis and prioritization pass. No files were
  modified and no build or test commands were run during verification.
- The audit's line citations have drifted in places; this ledger cites current
  working-tree locations. Where a path moved (for example
  `createTabViewSessionState.ts` now lives under
  `app/modules/workspace-shell/tabs/`), the current path is used.

## Status and priority vocabulary

| Term | Meaning |
| --- | --- |
| Confirmed | The cited condition exists in a reachable production path. |
| Partial | Part of the claim is true, but scope, mechanism, or impact is overstated. |
| Refuted | The current code prevents or contradicts the reported behavior. |
| Positive verified | The recorded safety property is present. |
| P1 | A bounded corrective patch should be scheduled. |
| P2 | Add hardening or parity coverage before changing the area. |
| P3 | Cleanup only. Fold it into nearby work in the same area. |
| No action | Preserve the current behavior or evidence. |

No item in this audit is a verified P0 defect. Three items are P1: the
bookmark panel unmount (a), main-viewer keyboard paging (m1), and the web fit
shortcuts (Z1, found during verification rather than by the audit).

## Corrections to the audit

The audit is broadly accurate; most of its claims verified as written. The
following claims did not survive verification and should not be relied on.

Refuted:

1. "Output scale clamped [1,2]×dpr" for generic thumbnails. The code uses
   `min(2, devicePixelRatio)` (`documentThumbnailRenderMetrics.ts:102-107`).
   A DPR of 3 produces scale 2, not a 2..4 range.
2. "Lane concurrency 1/2/4 by performance profile" for PDF thumbnails. The
   profile constants exist, but `pdfDocumentSession.ts:543-546` creates one
   document-level scheduler without passing a profile value; it defaults to
   concurrency 2 and serves page and thumbnail lanes together.
3. "No smooth scrolling exists anywhere in the viewer."
   `DocumentSearchResults.vue:367-369` uses `scrollIntoView({behavior:
   'smooth'})` for result rows. The document page viewport itself is
   instant-write only, which is the part that matters for gap r.
4. "Feedback drives button enablement but is deliberately not displayed as
   current." The dropdown resolves its displayed page from `navigationPage`
   (`pdfPageDropdownModel.ts:44`, `PdfPageDropdown.vue:156`), so the pending
   page is displayed. The workspace `currentPage` ref stays separate.
5. Gap j as stated. The note-window/cursor-mode invariant is not prose-only:
   `useWorkspaceViewState.ts:79-92` and
   `usePdfViewerAnnotationRuntimeBridge.ts:111-118` enforce it at runtime.

Materially narrowed (Partial):

6. Native PDF does not "mirror pdfjs semantics" for current-page tracking. It
   calls the shared continuous resolver, which measures visible vertical height
   only (`resolveDocumentContinuousScrollWindow.ts:152`), not PDF.js's
   two-dimensional area. Gap q's three-way inconsistency is real, but native's
   description in the audit is wrong.
7. The desktop crash checkpoint persists `zoom` and `zoomMode` only, not
   `effectiveZoom` or `fitMode` (`buildWorkspaceCheckpoint.ts:81-86`,
   `packages/contracts/workspaceCheckpoint.ts:18-23`). Restores still work
   because `zoomMode` carries the fit axis and effective zoom is recomputed.
8. The 900 ms reload pin is conditional: only restored pages greater than 1
   are pinned (`createPdfViewportSession.ts:695`).
9. The wheel flip gate has a fifth constant the audit missed: trackpad-sized
   deltas use a 220 ms maximum block, and renewed large deltas can release the
   gate before the 700 ms hard release (`createWheelFlipGate.ts:7,97`).
10. The workspace navigation fence has no user-scroll branch; renderer
    controllers cancel or supersede navigation, and the fence clears on a
    surface-observed mismatch (`createWorkspacePageNavigationFence.ts:62-76`).
11. Raster priority classes are not "identical everywhere": generic uses
    100/90/50/20/10, PDF uses 600/500/300/200/100 plus a visible-text class.
    Budget eviction sorts numerically, so prefetch evicts before thumbnails.
12. Sidebar mounting is not uniformly `v-show`: the generic thumbnail panel has
    a source-dependent `v-if`, and `WorkspaceSidebarHost` unmounts the whole
    sidebar slot on collapse. Tab-switch scroll retention holds; collapse
    retention is not guaranteed.
13. The annotation snapshot LRU applies only to documents with a revision
    token; others use a source-keyed `WeakMap`
    (`useAnnotationSync.ts:125-157`). Replaced-editor rebinding is broader
    than exact subtype: text-markup subtypes rebind across each other
    (`useAnnotationSync.ts:757-773`).
14. The search worker is a `worker_threads` worker inside the Electron main
    process's Node instance, not a dedicated process; only the persistent
    native service is a separate child process. Search empty/error states
    number four, not five.
15. The negative keyboard claims are too literal: Space activates search
    results, bookmark rows, outline items, and PDF link overlays, and
    scan-cleanup handles PageUp/PageDown. The narrower claim, no page-paging
    keys in the main viewer, is confirmed.
16. Source-neutral fit layout shares the basic formula but not PDF.js's
    spread-width or tallest-row logic, so facing-mode fits can differ.
17. Two latent code oddities confirmed with sharper detail:
    `resolveCustomReloadZoomMultiplier` ignores its inputs and returns the
    target directly, and the wheel-zoom session's `suppressSnapFor` callback is
    a no-op supplied by the PDF controller
    (`usePdfViewerFeatureController.ts:222-228`); the real protection is early
    wheel routing plus the zoom lock.
18. The FreeText 0.02 threshold is duplicated in more places than the audit
    names: comments list, serialization marker rect, editor marker resolver,
    comment-summary classifier (which adds an epsilon tolerance the others do
    not have), and the marker view model.

## Disposition summary

Items a through y are the audit's gap list; Z items were found during
verification.

| ID | Verified status | Rating | Priority | Decision |
| --- | --- | --- | --- | --- |
| a | Confirmed | Medium | P1 | Keep the PDF outline panel alive across tab switches; pin with a state-retention test. |
| b | Confirmed, transient | Low | P3 | Clamp `effectiveTab` to available tabs when readiness settles; fold into the next sidebar change. |
| c | Confirmed | Low | P2 | Reveal must expand collapsed ancestors (or scroll the nearest visible ancestor) before giving up. |
| d | Partial, conditional | Low | P3 | Prefer shallower depth on equal-page ties when next editing the resolver. |
| e | Partial, conditional | Low | P3 | Derive stable bookmark identity from content path, not position, when next reworking outline sync. |
| f | Confirmed | Low | P3 | Replace stringify equality with a keyed comparison when next touching bookmark persistence. |
| g | Confirmed | Low | P2 | Wire the sidebar adapter's `cancel` to real request cancellation and debounce clearing. |
| h | Confirmed | Low | P3 | Unify minimum query length at the shared session contract. |
| i | Confirmed | Low | P2 | Report truncation only when the scan actually stopped early, not at exact-limit totals. |
| j | Refuted as a bug | None | No action | Runtime guards exist. Optionally add an invariant test when next in the area. |
| k | Confirmed, wider than reported | Medium | P2 | Centralize the 0.02 marker predicate (five call sites, one with a divergent epsilon). |
| l | Confirmed | Medium | P2 | Surface skipped-over-limit author enrichment in the comments panel instead of dropping the result. |
| m1 | Confirmed | Medium | P1 | Add main-viewer keyboard paging (PageUp/PageDown/Home/End at minimum). |
| m2 | Confirmed | Medium | P2 | Make PDF thumbnail rows keyboard-reachable (roving tabindex, role, Enter/Space). |
| n | Confirmed | Low | P3 | Forward the MouseEvent through `DocumentSourceSidebar` when generic multi-select is wanted. |
| o | Partial | Low | P3 | The scheduler retries on its own; add an error state only alongside other thumbnail work. |
| p | Partial | Cosmetic | P3 | Share the 700/160 ms constants; the reveal policy is already shared. |
| q | Partial | Low | P3 | Document the three algorithms; unify only if boundary complaints materialize. |
| r | Refuted as stated | None | No action | Instant jumps are intentional; smooth scroll would need write-port redesign first. |
| s | Confirmed | Low | P3 | Thread `navigationSource` into the accepted-page analytics payload when funnel data is wanted. |
| t | Confirmed, latent | Cosmetic | P3 | Point the fallback at `SIDEBAR.DEFAULT_WIDTH` when next editing `PdfSidebar`. |
| u | Confirmed | Low | P3 | Bound or scope `metricsCache` when next touching the generic controller. |
| v | Confirmed | Medium | P2 | Add a byte bound to the annotation snapshot LRU. |
| w | Confirmed | Cosmetic | P3 | Hide the bookmark toolbar during loading/error; make `closeSearch` capability-aware. |
| x | Confirmed, deliberate | None | No action | Sidebar-gating DjVu highlights is a documented perf choice; revisit only on user complaint. |
| y | Positive verified | Positive | No action | Preserve the listed safeguards; all spot-checks passed. |
| Z1 | New finding | Medium | P1 | Implement fit-width/fit-height shortcuts in the browser renderer. |
| Z2 | New finding | Cosmetic | P3 | Delete `resolveCustomReloadZoomMultiplier`'s dead parameters and the no-op `suppressSnapFor` plumbing, or make them real. |

## P1 items

### Z1, web build ignores the advertised fit shortcuts

The shortcut table advertises Ctrl/⌘+1 (fit width) and Ctrl/⌘+2 (fit height)
on every platform (`app/constants/shortcuts.ts:80-99`), but the browser
renderer's `usePageShortcuts.ts:155-175` handles only zoom in, zoom out, and
actual size, and the browser menu registrations for fit are no-ops
(`app/platform/browser-api/documentsMenuCapability.ts:45-49`). Electron users
get the accelerators via the OS menu; web users get nothing while seeing the
same labels.

Acceptance checks:

1. In the browser build, Ctrl/⌘+1 and Ctrl/⌘+2 switch a PDF, native-preview,
   and DjVu document to fit-width and fit-height respectively.
2. Electron behavior is unchanged (accelerators still arrive once, via the
   menu, with no double-firing).
3. A unit test covers the two new branches beside the existing zoom-key tests.

### a, bookmark panel state destroyed on every tab switch

`PdfSidebar.vue:79-90` mounts `PdfOutline` with `v-if` while the sibling
panels use `v-show`. Every departure from the bookmarks tab discards display
mode, expansion, selection, and style-range state and forces a full outline
reload on return. The generic sidebar keeps its outline mounted, so PDF is the
odd one out.

Decision: lazy-mount on first activation, then keep alive (`v-if` latched by a
"has been activated" flag combined with `v-show`), rather than plain `v-show`,
so documents whose bookmarks tab is never opened do not pay for outline
parsing.

Acceptance checks:

1. Expanding nodes, selecting entries, and choosing a display mode, then
   switching to thumbnails and back, preserves all of it.
2. The outline does not load before the bookmarks tab is first activated.
3. Closing and reopening the sidebar (host unmount) may still reset state;
   that is the documented boundary, not a regression.
4. A regression test exercises the tab-switch retention path (the audit noted
   no test covers this today).

### m1, no keyboard paging in the main viewer

`usePageShortcuts.ts` handles Escape, delete, letter accelerators, and zoom
keys only; no PageUp/PageDown/Home/End/arrow/Space page navigation exists in
the main viewer on any platform, and Electron has no menu accelerators for
paging either. Keyboard users are limited to the scrollbar and toolbar
buttons.

Decision: implement PageUp/PageDown/Home/End first; they are unambiguous in
both paged and continuous modes (step by spread via the existing
`stepBySpread` and first/last navigation, all through the existing
`handleGoToPage` chain with a `toolbar`-class source). Arrows and Space stay
out of scope until the focus model is settled, because Space already activates
focused rows in several components and arrows collide with native scrolling
and thumbnail selection.

Constraints verification established: handlers must not fire while focus is in
an editable control (the page-label input, search field, note windows, outline
rename); the existing shortcut guard already covers most of this and must be
reused, not duplicated.

Acceptance checks:

1. PageUp/PageDown step one spread backward/forward in paged and continuous
   modes for all three renderer stacks; Home/End go to first/last page.
2. Keys are inert while typing in any text input, the outline rename editor,
   or a note window.
3. Existing Shift+Arrow thumbnail selection behavior is unchanged.
4. Unit coverage in the shortcuts tests; one e2e assertion that PageDown
   advances the chassis current page.

## P2 items

### m2, PDF thumbnail rail rows are mouse-only

Rows are `tag="div"` with click handlers but no tabindex, role, or keyboard
activation (`PdfThumbnails.vue:22-41`), unlike the generic list's native
buttons and scan-cleanup's rail. A fix needs a roving tabindex over
virtualized rows, which interacts with the Fenwick anchor restore and
auto-reveal, so it should ride with other thumbnail rail work rather than a
drive-by patch. Acceptance: Tab reaches the rail, arrows move row focus,
Enter/Space navigates, focused row scrolls into view, selection semantics
unchanged.

### c, active bookmark invisible under collapsed ancestors

`DocumentBookmarkTree.vue:63-117` searches only visible rows when following
the active item, so in top-level display mode a deep active bookmark stays
off-screen. Decision: when the active row is not visible, expand its ancestor
chain (or reveal the nearest visible ancestor in display modes where
auto-expansion would fight the chosen mode). Acceptance: scrolling the
document to a page whose bookmark is nested under a collapsed node makes that
bookmark (or its ancestor) visible in all three display modes.

### g, sidebar search cancel is a stub

`PdfSidebar.vue:278` supplies `cancel: () => undefined`, so leaving the search
tab cancels neither the in-flight IPC/native request nor the pending debounce.
Generation guards prevent stale results from applying, so this is waste, not
corruption. Decision: route cancel to `usePdfSearch`'s existing cancellation
capability and clear the debounce timer. Acceptance: leaving the tab mid-search
stops the native/worker request (observable via the search worker logs) and no
result mutation lands afterward.

### i, exact-limit truncation mislabel (browser)

`browserSearchWorkerClient.ts:1087-1098,1124-1127` sets the truncated flag
when total equals the limit even if the scan completed. The UI then claims
"showing first N" with nothing cut. Decision: set truncated only when the scan
stopped early. Acceptance: a document with exactly limit matches reports a
complete result set; limit+1 matches reports truncated.

### k, the 0.02 point-note threshold is scattered

Five call sites classify point-note markers: `PdfAnnotationCommentsList.vue`,
`toFreeTextNoteMarkerRect.ts`, `resolveEditorMarkerRect.ts`,
`buildPdfAnnotationCommentSummary.ts` (with an epsilon tolerance the others
lack), and `useAnnotationMarkerViewModel.ts`. Divergence would make list
classification disagree with save behavior. Decision: one shared predicate,
one constant, and a decision on whether the epsilon belongs everywhere or
nowhere; read `docs/architecture/freetext-note-persistence.md` first per repo rules.
Acceptance: all five sites import the shared predicate and a test pins the
threshold semantics at the boundary values.

### l, silent author-enrichment skips on big PDFs

Oversized documents get "unknown author" placeholders while the
`skipped-over-limit` reconciliation result is discarded by every caller
(`createPdfAnnotationSession.ts:444-446`, `DocumentWorkspace.vue:678-685`,
`usePdfViewerPublicApiController.ts:257-270`). Decision: surface a one-line
localized notice in the comments panel when enrichment was skipped, updating
the English and Russian message files together. Acceptance: a PDF over the
enrichment limits shows the notice; normal documents show nothing new.

### v, annotation snapshot LRU is unbounded in bytes

The module-global LRU keeps up to eight structured-cloned whole-document
annotation arrays across tabs (`useAnnotationSync.ts:125-157,604-660`).
Count-bounded, byte-unbounded. Decision: track approximate byte size and evict
by bytes as well as count. Acceptance: a synthetic large-annotation document
cannot push the cache past the chosen byte budget; hit behavior for small
documents is unchanged.

## P3 batch

These ride along with the next change in their area; none justifies a
standalone branch. b (clamp `effectiveTab` when readiness settles), d
(equal-page tie depth preference), e (content-derived bookmark identity), f
(keyed dirty comparison), h (one minimum-query-length constant in the shared
contract), n (forward the MouseEvent), o (thumbnail error surface), p (share
the 700/160 ms constants), q (document the three current-page algorithms), s
(add `navigationSource` to the accepted-page analytics payload), t
(`SIDEBAR.DEFAULT_WIDTH` fallback), u (bound `metricsCache`), w (hide the
bookmark toolbar during loading/error, capability-check `closeSearch`), Z2
(delete or realize the dead zoom parameters and no-op `suppressSnapFor`).

e and f landed together, since both sit in the bookmark panel's outline sync.
Bookmark ids now come from the content path (parent id, trimmed label, page
index, named destination, plus an occurrence counter that tells identical
siblings apart) in
`app/modules/pdf-viewer/engine/pdf-outline-identity/createBookmarkIdentityFactory.ts`,
so inserting, removing, or reordering unrelated siblings leaves every other id
alone and an outline rebuilt from the same persisted entries reproduces the ids
that selection, expansion, drag state, and row keys are held under. Identity
reads each field the way persistence writes it: the label trimmed and, when
blank, replaced by the untitled label, and array destinations ignored because
saving drops them. Fields are joined length-prefixed, so a label containing the
separator cannot impersonate a neighbouring field and hand two different
bookmarks the same id. Draft bookmarks keep counter ids, because a bookmark
whose title is about to be typed has no content to be identified by. Dirty
detection and the external-apply guard now compare the persisted fields
directly
(`app/modules/pdf-viewer/engine/pdf-bookmark-serialization/areBookmarkEntriesEqual.ts`)
in one linear pass, so an outline that arrives with the same content but a
different key order or optional-field spelling no longer reads as an edit and
no longer forces a rebuild that would discard panel state. Bookmark ids stay in
memory; `IPdfBookmarkEntry` carries none, so there is no persisted positional
key to migrate.

Landed with the #83/#85 shortcut work. q is written up in
`docs/architecture/pdf-viewer-architecture.md` ("Current-page resolution per renderer
stack"). s reports the arming navigation source in the accepted-page
`navigation-idle` payload. Z2 removed both dead seams. Those seams were the
ignored `resolveCustomReloadZoomMultiplier` parameters and the `suppressSnapFor`
plumbing, and neither had a real implementation to promote. The viewport
ownership boundary test forbids reintroducing one in the navigation
controller.

o and u landed together in the generic thumbnail controller. For o, the
controller now counts a page's consecutive render failures at the demanded
width and, on the third, drops that page from the demand set and marks it
failed. Withdrawing the demand from inside the failure callback is what stops
the retry loop, because the scheduler re-queues a failed page the moment the
callback returns. The row then shows a warning glyph and `common.pageRenderFailed`
instead of the pulsing skeleton, and its accessible name becomes
`documentSourceSidebar.goToPageRenderFailed` so the failure reaches screen
readers through the row name rather than through decoration inside a button.
An error clears on a successful render, on a source replacement, when the page
leaves the retained window, and when the user activates the row, which doubles
as the retry gesture. A page that already committed a narrower thumbnail never
trades it for the failure tile: its demand is pinned to the width that
committed render asked for, which is what the scheduler compares a settled
demand against, so the demand reads as satisfied, the older thumbnail survives
a failed upgrade, and the row keeps its plain name. It has to be the requested
width and not the leased raster width, which a provider is free to make smaller;
demanding the leased width would look unsatisfied and restart the retry loop. Per-page
bookkeeping keeps one broken page from touching its neighbours. For u, `metricsCache` became a 256-entry LRU
(`documentThumbnailMetricsCache.ts`): page metrics are fixed-shape records, so
entries stand in for bytes, and the budget is several times the largest demand
window. Layout keeps its own aspect ratios, so an eviction costs one extra
`getPageMetrics` call and never a layout shift.

b and n landed together in the shared sidebar seam. For b, `effectiveTab` is
now the reconciliation result alone
(`app/utils/document-viewer/sidebar/useDocumentSidebarCapabilitySession.ts`);
the old `?? preferredTab` fallback let an unavailable tab stay active whenever
the available list was empty, which is every moment before a page source
resolves and the whole life of a source with no sidebar capability. Falling
back to the raw preference there was visible, not cosmetic: the search panel
is mounted under `v-show`, so a workspace whose preference was `search` showed
that panel, and marked it active, over a sidebar with no tabs at all, and a
preference of `bookmarks` opened the bookmarks block against a source that has
no outline provider. `null` closes every panel and hands the tab strip an empty
selection instead. The clamp reads the preference and never writes it, so a
capability that comes back re-adopts the user's choice on the next tick, and a
preference the current format can serve is never swapped for a fallback. No
watcher was added on purpose: a write would destroy the shared workspace
preference that the composable exists to protect, and the architecture boundary
test already forbids format components from reconciling tabs themselves.

For n, the sidebar forwards the pointer event the thumbnail row was activated
with instead of dropping it. The inline `emit('go-to-page', $event)` handler it
used could only ever pass the first emitted argument, so the modifier keys the
rail already published died one layer above it and generic multi-select could
not be built without synthesizing an event. `IDocumentThumbnailListEmits`
(`app/utils/document-viewer/thumbnails/documentThumbnailListEmits.ts`) now
states the rail's contract in one place, and the sidebar republishes the event
as optional because bookmark rows navigate without one. Consumers that only
navigate are unaffected: `DocumentWorkspace` takes the page number and drops
the event, and the type system enforces that it must, since binding the
navigation handler straight to the event is rejected (a `MouseEvent` cannot
stand in for `IScrollToPageOptions`, whose properties are all optional). Nothing
in this change resolves selection intent; it only makes the intent readable
where multi-select would be implemented.

## Suggested implementation order

1. Z1 (small, self-contained, user-visible on the web today).
2. a (one component, plus its missing regression test).
3. m1 (shortcut layer plus e2e assertion).
4. i and g together (both in the search seam).
5. k, then l (both under the annotation contract, k first so l's UI work sits
   on the unified predicate).
6. c, m2, v as the area next comes up; P3 batch opportunistically.

## Issue tracking

Filed 2026-08-23, all labeled `ready-for-agent` except the P3 umbrella:

| Item | Issue |
| --- | --- |
| Z1 web fit shortcuts | #83 |
| a bookmark panel state | #84 |
| m1 keyboard paging | #85 |
| m2 thumbnail rail keyboard access | #86 |
| c active bookmark under collapsed ancestors | #87 |
| g search cancel stub | #88 |
| i exact-limit truncation | #89 |
| k 0.02 marker predicate | #90 |
| l author-enrichment surfacing | #94 (blocked by #90) |
| v annotation snapshot LRU byte bound | #95 |
| P3 batch umbrella | #96 |
