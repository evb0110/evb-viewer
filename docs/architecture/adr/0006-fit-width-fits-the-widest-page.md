# Fit width fits the document's widest page

In continuous scroll, fit width uses one scale for the whole document, chosen so
that its widest page or spread fits the viewport. Narrower pages are centred and
smaller. Fit width therefore never leaves a horizontal scroll range, and the
scale does not change as the reader scrolls. In paged mode the current page or
spread keeps defining the scale.

This is the convention of Chrome's PDF viewer, Evince, SumatraPDF and Apple's
PDFKit. pdf.js fits the current page and lets wider pages overflow sideways,
and Okular scales every page on its own. The viewer followed pdf.js; a discovery
run on real documents found a horizontal scroll range in fit width on six of 28
PDFs, and the owner chose to follow the established convention. Issue #826 holds
the sources.

The rule needs the size of every page before the first fit. Previously the
session knew page 1 at open and estimated unvisited pages, so a first typed
jump into a mixed-size document could land on the wrong page (issue #822).
The existing Poppler preview reader samples large documents and omits
`UserUnit`; its timing is not evidence for a complete geometry table.

The implementation now loads a revision-checked, metadata-only native page
geometry table for path-backed documents. It includes the effective crop box,
`/Rotate` and direct-page `UserUnit`. The document session converts it to
viewport dimensions before the first layout, and the table is final for that
revision: pages are never re-measured under the reader, so a navigation can
compute its target offset from the layout. PDF.js reads page 1 for its first
raster, and a disagreement there is logged as a geometry defect, not applied.
On 2026-09-24 the table matched PDF.js's viewport on every page of the owner's
desktop corpus and the repository fixtures (20 files, 7,315 pages, largest
difference 0.0001 pt) and on synthetic pages with an inherited or oversized
crop box, `/Rotate` of -90 and 450, and `UserUnit` 2.5. A reversed media box
makes the native reader fail, which falls back to the PDF.js read below.

Blob sources and unavailable-native fallbacks collect PDF.js metrics in bounded
parallel batches and publish them once before first navigation, up to the
existing 20,000-page dense-layout limit. Above that limit, sources without a
native snapshot still use progressive sparse geometry. That remains an
implementation gap against L1: a later wider page can change the fit. A
15,605-page synthetic Blob took about 16 s to enumerate in the local probe;
large path-backed documents avoid that per-page renderer roundtrip cost.

Continuous fitting considers every page row and its gutter count, so a facing
spread can constrain the scale even when a single cover is slightly wider.
Paged mode still fits the current row.

Consequence accepted with the convention: in a document whose page widths differ
greatly, the narrow pages are small in fit width. Fit page and manual zoom
remain.

The takeover's recorded Linux replay shows the mixed-size 66-page fixture
landing on page 33 on the first typed jump, with zero horizontal scroll range
and unchanged displayed zoom across scrolling. Native macOS timing and the
large sparse fallback above are separate coverage limits.
