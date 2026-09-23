# Bounded staged Analyze window

Detection analyses a document through a fixed number of resident page rasters
instead of staging every page before the sidecar starts. Document length now
decides how long a run takes, not whether it may start. This note records the
ownership rule, the admission arithmetic, and the invariants the tests defend.
The implementation lives in `packages/scan-cleanup/core/detection.ts` and
`packages/scan-cleanup/core/policy/buildNativeScanCleanupManifest.ts`; Electron
preview wiring supplies the bounded window to those core entrypoints.

## Why the whole document was staged before

PR #43 removed the Analyze FIFO transport because classification and output must
not change with free disk space. The output invariant remains correct, while
the transport is now selected from host capability and broker capacity. On a
POSIX host with raster streaming enabled and at least three native process
slots, preview uses the FIFO transport and records `fifo-ppm` in provenance;
otherwise it uses the regular file transport. Neither route uses free disk
space to choose classification or output. The earlier implementation equated
"replayable" with "every page raster exists at once", so
`runScanCleanupDetection` estimated the decoded footprint of the whole document
and refused when it exceeded the scratch budget. A 148-page, 43.2 MiB scan needs
629.41 MiB of decoded rasters, which demanded about 2.46 GiB of free scratch and
refused the document on a machine with ample CPU and RAM.

Replayability does not require simultaneous residency. A page raster is a
function of the source, the page and the DPI, so re-rendering one produces the
same bytes it produced the first time. That is what lets a bounded window
substitute for whole-document staging without moving a single classification.

## The lease protocol

An Analyze manifest that declares `stagedInputWindow` puts the sidecar on the
lease protocol:

1. Before reading a page the sidecar emits `page-input-required` with that page
   number and blocks until a regular file appears at the manifest input path.
2. The producer renders the page to a private scratch file and publishes it onto
   the manifest path with an atomic rename, so the sidecar can only ever observe
   a complete raster.
3. When the sidecar has finished every read of that page it emits
   `page-input-released`.

`stagedInputPeakPixels` travels with the window. The sidecar sizes its page pool
from the largest input it can measure, and under a window most inputs are still
unrendered when it makes that decision, so the producer declares the document's
largest analysis raster and the memory bound stays a fact about the document.

A manifest without `stagedInputWindow` keeps the direct-CLI contract: every
Analyze input must already exist on disk, and no lease frame is ever emitted.

## Keeping rendering ahead of analysis

Rendering and analysis overlap, so detection takes about as long as the slower
of the two rather than their sum.

- Each page renders in its own Poppler process under the admitted render
  concurrency. A page is readable as soon as its render publishes it, never
  after the rest of a range.
- Releasing a lease drops that raster at once and refills the freed slot with
  the next unread page, so the window stays full ahead of the reader.
- A lease still waiting for a slot comes first: the producer starts no
  read-ahead while one waits. Otherwise read-ahead could fill the window with
  pages nobody is reading yet, which the window may not drop because the
  sidecar can open them before their lease frame arrives, and the lease would
  wait forever.
- A waiter re-checks any slot change that happened while it was deciding to
  wait, so a slot freed in parallel is never missed.
- Read-ahead stops at a page it failed to stage instead of skipping it, so the
  window never fills past a page whose own lease still has to render it.

The sidecar publishes each page's `page-analyzed` verdict as soon as that page
finishes, with `completedPages` counting distinct analyzed pages. Verdicts can
therefore arrive in any page order while the count only grows, and one slow
page no longer holds back every later verdict. `page-complete` keeps its
source-order meaning for render work and for the final reconciled Analyze
results.

## One ownership rule

**The detection window owns every raster it staged for the whole run.**

- While a page is leased, the window will not drop it.
- After the lease is released, the window may drop the raster to reclaim its
  slot. This is safe only because the next lease re-renders identical pixels;
  reconciliation relies on it, since the document-level pass re-reads pages the
  window dropped long before.
- The window is disposed only after the sidecar has exited **and** detection has
  read every page's metadata evidence. No raster is released while a native
  result or its evidence is still outstanding.
- Reclaiming a slot is housekeeping, not the lease the sidecar is waiting for. A
  drop the filesystem refuses is warned about and the page still counts as
  admitted, so disposal drops it again at the end of the run; the lease that
  needed the slot succeeds either way, and slot accounting only ever shrinks.
- A run that published its results hands the rasters still resident to the
  raster cache, which is the same thing an ordinary page render leaves behind
  and is bounded by the window. A run that failed or was canceled destroys every
  raster it staged, so a detection that published nothing leaves nothing behind.

Ownership transfers in exactly two ways, and both leave the raster with the
retention index rather than with the run:

- Pages that were already retained when the run started are outside the rule
  from the beginning. They were on disk before free space was measured, they
  cost the window no scratch, and the window never drops them. If one disappears
  mid-run it becomes an ordinary staged page and is re-rendered.
- A raster another consumer adopts is no longer the window's to destroy. A
  preview that reads a staged raster names that exact path in a manifest of its
  own and then runs a sidecar against it, so the window gives its slot back
  without unlinking the file and the retention index disposes of it with every
  other cached raster. Without this, background detection could pull a page out
  from under the preview the user is looking at. The adoption outlives the
  release rather than being consumed by it: however often the window gives that
  slot back, the file stands until a re-render republishes the path or the index
  drops the entry, so a retried drop cannot unlink what the other consumer is
  still reading.

## Admission

`resolveStagedRasterWindow` budgets one window, never the document:

- The budget keeps a 512 MiB reserve off the filesystem and, above a 512 MiB
  floor, never spends more than a quarter of free space. Both are unchanged.
- A window costs the *N largest* pages, each counted twice, because a page in
  flight exists as a private render and as the published raster until the rename
  completes.
- The requested width is `min(16, max(2, rasterConcurrency * 2))`. Scratch
  pressure narrows it one page at a time; the producer's render concurrency is
  then capped by the admitted window, so residency and production stay bounded
  together.
- Only when a single measured page cannot fit does the run refuse, with
  `insufficient-scratch` and the two figures a user can act on. The renderer
  states both in the user's language; the English exception never reaches the
  alert. A page whose geometry cannot be measured is not a shortfall: the
  narrowest window is admitted rather than refusing over an unknown with no
  figures in it.
- Compressed PDF size plays no part in admission.

Structured diagnostics are logged once per run at debug level, as JSON with no
document content: pages, staged pages, retained pages, free scratch bytes,
budget bytes, whole-document bytes, window pages, window bytes, render
concurrency, and whether the run was admitted.

## Invariants under test

| Invariant | Coverage |
| --- | --- |
| A document whose whole manifest exceeds the budget runs when one window fits | `tests/unit/electron/scanCleanupDetectionStagedWindow.test.ts` |
| 148-page variable geometry equivalent to the reported fixture completes | same |
| Identical results at window sizes one, two and normal concurrency | same |
| Cancellation and a failed page leave no staged raster and publish nothing | same |
| Residency never exceeds the window, including under concurrent leases | `tests/unit/electron/scanCleanupStagedRasterWindow.test.ts` |
| Read-ahead fills free slots concurrently and never starves a waiting lease | `tests/unit/electron/scanCleanupStagedRasterWindow.test.ts` |
| A later page's verdict is published before an earlier page is even staged, and the count stays monotone | `native/scan-cleanup/tests/page_cli.rs` |
| Window admission, narrowing and the refusal figures | `tests/unit/electron/resolveRasterHandoff.test.ts` |
| Lease frames are transport only, and are rejected without page identity | `tests/unit/electron/scanCleanupNativeProtocolCodec.test.ts`, `native/scan-cleanup/src/protocol/progress.rs` |
| Only a staged manifest admits an Analyze input that is absent at execution | `native/scan-cleanup/src/protocol/manifest_v3.rs` |
| The sidecar leases every read, pairs every release, and replays a dropped page | `native/scan-cleanup/src/adapters/batch_cli.rs` |
| A raster a preview adopted survives every release of its slot, and is reclaimed once republished or forgotten | `tests/unit/electron/scanCleanupPreview.test.ts` |
| A refused drop neither fails the lease that needed the slot nor escapes disposal | `tests/unit/electron/scanCleanupStagedRasterWindow.test.ts` |
| The refusal reaches the user fully localized, with both figures | `tests/unit/app/modules/scan-cleanup/formatScanCleanupError.test.ts`, `tests/unit/app/modules/scan-cleanup/scanCleanupWorkspaceSession.test.ts` |
| The real sidecar analyses a document the budget cannot hold whole | `tests/unit/scripts/scanCleanupStagedWindowEndToEnd.test.ts` |
