# PDF Viewer Architecture

This note describes the current PDF viewer module boundaries and the contracts
that are intentionally load-bearing.

## Public Surface

`app/modules/pdf-viewer/components/PdfViewer.vue` is the component shell. It
imports its runtime controller from `app/modules/pdf-viewer/runtime/` and keeps
the parent-facing contract stable through:

- `IPdfViewerProps`
- `TPdfViewerEmit`
- `IPdfViewerExpose`

The exposed API covers viewer navigation and metrics, load-settle waits, region
capture, crop, save and print preparation, annotation commands, shape commands,
image placement, render invalidation, and search-result scrolling.

## Module Ownership

The PDF viewer feature namespace is `app/modules/pdf-viewer/`.

| Path | Ownership |
| --- | --- |
| `public.ts` | Cross-module exports and DOM helper exports |
| `engine/` | Viewer-owned DOM, annotation, serialization, render, and save helpers that used to live in the shared utility layer |
| `runtime/` | Controller composition, load/reload, viewport, navigation, zoom, rendering lifecycle, save/print bridges, and public API assembly |
| `runtime/rendering/` | Authoritative page rendering runtime and renderer controllers |
| `annotations/` | Viewer annotation comment/color feature models |
| `dom/` | Load-bearing selector constants and page lookup helpers |

Shared PDF services, serialization helpers, and generic document/workspace
features stay outside this namespace unless they are truly viewer-owned.
Reusable pure PDF geometry, serialization, conformance, TIFF, and outline logic
belongs in `packages/pdf-core` and should be consumed through the `@pdf-core`
package root. Shared non-PDF viewport and page-source contracts belong in
`app/modules/document-viewer`; viewer-specific integration helpers that depend
on Vue state, DOM conventions, PDF.js runtime shape, or serialization policy
belong under `app/modules/pdf-viewer/engine`.

## DOM Contracts

PDF.js and app layer classes are runtime contracts. Keep these classes stable
and use `app/modules/pdf-viewer/dom/pdf-viewer-dom/` for new viewer-owned
lookups:

- `page_container`
- `page_container--rendered`
- `page_canvas`
- `textLayer` and `text-layer`
- `annotationLayer` and `annotation-layer`
- `annotationEditorLayer` and `annotation-editor-layer`
- documented overlay/debug classes in `docs/architecture/css-load-bearing-classes.md`

`PdfViewerPage.vue` intentionally emits both PDF.js camelCase layer classes and
app kebab-case classes.

Layer hydration has one request owner. Layer promotion may start only from a
settled canvas whose layer readiness is `none` or `canvas-only`, never while
another owner is hydrating it. A priority request that arrives during hydration
is queued and reconsidered when that owner settles.

Viewport intents that require `text-layer` readiness send text-first priority
through the authority raster request. The authority still resolves the exact
target, waits for its text layer, and applies the final viewport position once.
Request-scoped text readiness is published as soon as text rendering succeeds;
annotation readiness remains a separate, later layer-hydration state.

Fit-height admits the horizontal scrollbar from the active spread's fit in the
unobstructed viewport, including page gutters. The scale owner calculates this
geometry; the viewport reserves the scrollbar while that spread requires it.
Do not infer admission from the already scrollbar-reduced scale: that circular
decision alternates the viewport height and continually invalidates rendering.

A resize that arrives during navigation inherits the pending semantic target,
including its exact text range and readiness requirement. Its sampled outgoing
anchor cannot replace that target. Resize previews defer to pending navigation;
the rerender coordinator must not turn that deferral into a page-only fallback.
Search highlighting preserves page-local occurrence identity when native results are ordered and
rendered match counts agree, even when their text offsets differ. See
`docs/internal/research/search-match-navigation-2026-09-05.md` for the reproduced failures.

The search sidebar reveals virtual rows from their logical row heights. Group
expansion exposes the inserted match span with the nearest list scroll. Result
selection uses the same calculation and leaves an already visible row in place.
The virtualizer reads the same fixed-height CSS tokens that size the rendered
group and match rows, whose labels are truncated instead of wrapping.

Sidebar panels keep controls and summaries in normal flow as fixed-size flex
children. One remaining flex child owns vertical scrolling and must use a
flex-derived block size with `min-height: 0`. A results or empty-state child below
panel controls must not claim `min-height: 100%`, since that percentage excludes
its siblings and pushes the scroll rail beyond the sidebar's clip edge. The
global status row owns no sidebar compensation; the app shell already reserves
its height outside the workspace row.

## Wheel gestures and explicit commands

Viewport intent is ordered by when the user expressed it, not by when its
events arrive. A fling is expressed once, at finger lift, and the platform then
emits inertial wheel packets for a second or more. A toolbar, sidebar or
keyboard command issued during that tail is the newer intent, even though tail
packets keep arriving after it.

`createWheelGestureStream.ts` derives identity from structure, not timing.
Chromium sends the first wheel event of a scroll sequence as cancelable and the
rest as non-cancelable, unless a handler prevented the first, in which case
every later packet stays cancelable. So:

- a non-cancelable packet belongs to the sequence in progress, however far apart
  the timestamps are and however late the packet is delivered;
- a cancelable packet after a non-cancelable one begins a new sequence;
- a cancelable packet after a cancelable one is ambiguous, and there a quiet gap
  of `WHEEL_GESTURE_IDLE_MS` decides. The same gap decides on a page where no
  cancelable packet has ever been seen.

The ambiguous case is a prevented sequence, or a run of one-packet sequences.
The DevTools input path produces the latter: `Input.dispatchMouseEvent` sends
each wheel event as a complete sequence of its own, all cancelable and none
prevented, and that is how the E2E suite and automation agents drive a fling. A
new cancelable packet right after a genuine one-packet sequence has the same
flags and the same host boundaries around it, so nothing but the gap separates
the two. Hardware cannot produce that run fast enough to matter: a person would
have to scroll one packet, issue a command and start a new gesture inside the
gap, and a notched wheel stays latched in one sequence for longer than that.

The stream reports two ids. The sequence is the browser's scroll sequence, which
host boundaries refer to. The gesture is the user's intent, which also changes on
a reversal inside one sequence, because inertia never reverses.

Timestamp spacing and delivery delay are separate distortions and a slow machine
produces both. Under a 6x CPU slowdown one fling that normally arrives as 69
packets at a 17 ms median gap arrived as 10 packets at a 192 ms median gap, with
four gaps over 200 ms, and packets wait behind long tasks before they are
handled. Any cutoff on either axis eventually releases a live gesture, so
ownership has none. Delta size is no better, since coalescing inflates a tail
packet.

Packets cannot say whether a sequence is still live when a command arrives,
because the last packet of a live fling can be hundreds of milliseconds old. The
browser process owns the sequence, including its inertial tail, so
`electron/hostEnvironment.ts` forwards `gestureScrollBegin` and
`gestureScrollEnd` as the host event `onWheelScrollSequenceChange`. That event
is window-wide, while identity is local, so a boundary only annotates a sequence
this viewport saw start. Both streams are ordered and a `begin` cannot exist
before the renderer has handled its sequence's first packet, so a `begin` claims
the oldest local sequence start still owed one, skipping prevented starts, which
never reach the host. A viewport with nothing owed declines the `begin` and the
`end` that follows: a fling in a sidebar or another pane is not a live gesture
here. An `end` closes the sequence its `begin` claimed, not the current one, so
the next gesture's first packet may overtake it. An `end` with no `begin` at all
means the viewport started listening mid-sequence and closes the current one.

A local sequence joined by timing spans several browser sequences, so the host's
boundaries for its members are not the gesture's. The port ignores them for such
a sequence and lets packet timing speak. Without that, the `end` of the first
one-packet sequence of a DevTools fling marked the whole gesture over, the
command was fenced without suppression, and the stream scrolled it away.

An `end` restores scrolling at once and keeps the ownership fence. Ownership
ends only when a packet of another gesture arrives. The idle timer merely
restores scrolling where no host reports boundaries, and a residue packet that
arrives afterwards suppresses it again. A hosted browser has no host signal and
uses packet timing for liveness only.

Known limits. Inside a prevented sequence or a run of one-packet sequences,
neither structure nor host says anything, so a quiet gap still decides and a
slow machine can split it. A notched wheel has no inertia, yet its ticks share
one latched sequence, so ticks that follow a command without a pause read as
residue until the sequence ends; this is unverified on hardware. If IPC is starved so long that another
scroller's `begin` and `end` are handled after this viewport's next first packet,
they are misattributed to it and liveness falls back to packet timing until the
following sequence.

A command fences the last observed gesture even if its last packet is old or
the host already ended the sequence. Neither condition proves the renderer has
drained its input queue: a fast facing-layout fling can leave wheel packets
behind a toolbar click. Liveness decides whether to suppress native scrolling,
not whether those queued packets may supersede the command. The next genuine
gesture still releases ownership through the existing stream boundary.

The viewport write port owns the rule. `queueNavigationRequest` calls
`fenceCommandAgainstLiveGesture` for every source except `wheel`. Packets of
the fenced gesture are `command-residue`: `observeDocumentViewportWheelInteraction`
does not advance the interaction epoch for them and the chassis dispatches them
to no renderer, so they cannot cancel the command. Chromium makes wheel events
non-cancelable after the first of a sequence, so residue cannot be swallowed.
The port instead raises `userScrollSuppressed`, which the chassis applies as
`overflow: hidden` on the viewport. Authored `scrollTop` writes still land, the
stable scrollbar gutter keeps the layout width, and the port restores scrolling
when the gesture goes quiet or a new gesture begins. A new gesture remains
trusted physical input and supersedes the command as before.

Two consequences of suppression are handled in the port. A command whose target
is already rendered lands within a frame of its fence, before suppression
reaches the compositor, so a residue delta can displace the write;
`consumeAuthorityScroll` restores it while residue is live. And a sequence that
begins while the viewport is not user-scrollable is bound to nothing and stays
dead until it ends. Restoring scrolling inside its first event is too late in
the app, because the compositor judges the sequence against a copy that learns
of the change a frame later. The same holds for a short settling window after
scrolling is restored. The port therefore adopts such a sequence:
`observeDocumentViewportWheelInteraction` prevents its cancelable first event,
which keeps the rest of it cancelable, and applies its deltas by hand as plain
user scrolling. A plain test page does not reproduce this, since it resolves the
scroll on the main thread and sees the new style at once, so this behaviour has
to be checked in the real app.

`documentViewerRuntime.test.ts` covers the fence and `pdfViewportSessionBehavior.test.ts`
covers a pending navigation surviving residue. Both halves were also confirmed
in Chromium with the real write port: without the fence the command never
lands, and with it the command lands on its target and stays there.

## Current-page resolution per renderer stack

Each renderer stack answers "which page is the user looking at?" with its own
measure. The three answers agree in the middle of a page and can differ by one
at a spread boundary. This is recorded, not unified. Unifying them would change
observable page reporting in all three stacks at once, so it should only happen
if boundary flicker is actually reported (navigation/zoom audit item q).

| Stack | Measure | Tie-break | No candidate |
| --- | --- | --- | --- |
| PDF.js (`getViewportVisibilityFromDom.ts`, consumed by `usePdfScroll.ts` `resolveMostVisiblePage`) | Largest visible **area**: vertical intersection multiplied by horizontal intersection, so a horizontally scrolled-off page loses to a narrower fully visible one | Strict `>`, so the **earlier** page keeps the title | Falls back to the previous page, marked non-authoritative |
| Generic page source (`useDocumentPageSourceRuntime.ts` `syncCurrentPageFromViewport` → `resolveNearestDocumentPageToViewportCenter`) | Page whose **center** is nearest the viewport center, found by binary search; visible area is never measured | Strict `<` on the distance comparison, so the **previous** (lower) page wins an exact tie | Returns null and the current page is left alone |
| Native PDF preview (`NativePdfViewer.vue` `getVisiblePageNumber` → `resolveDocumentContinuousScrollWindow`) | Greatest visible **vertical height** only; horizontal overflow is ignored | Strict `>`, so the **earlier** page keeps the title | Falls back to the currently active page |

Consequences worth knowing before touching any of them:

- A zoomed-in PDF.js page scrolled sideways can hand the current page to a
  neighbour, while the native preview and page-source stacks cannot, because
  neither looks at the horizontal axis.
- Only the page-source stack can report a page that is barely visible: the
  nearest-center rule ignores how much of the page is on screen.
- All three are projections. The workspace navigation fence
  (`createWorkspacePageNavigationFence.ts`) still decides whether an observed
  page is accepted, so a disagreement during programmatic navigation is
  rejected rather than shown. `consumePageUpdate` is that decision: it judges
  the page, commits an accepted one to `currentPage`, releases the target, and
  returns the arming navigation source, all in one call, so no caller can read
  a released fence beside an uncommitted page or credit a superseded page to
  the surface that armed the abandoned target.

## Safety Targets

Keep focused coverage around:

- annotation comment reload merging, local deletion, transient note identity,
  and marker movement
- source reload during save and reload grace windows
- zoom rerender anchoring and effective zoom emissions
- visible range, buffered rendering, and stale render cancellation
- search highlight timing after page renders and rerenders

Do not change FreeText note persistence or PDF serialization behavior casually.
Read `docs/architecture/freetext-note-persistence.md` before editing annotation
serialization or note-window code.
