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

The rule needs the size of every page before the first fit. The document
session knows page 1 at open and assumes that size for every page it has not
visited, which is also why a typed page jump into an unvisited region of a
mixed-size document lands on the wrong page (issue #822). Reading every page's
size is cheap, 0.16 s for 15,605 pages through the Poppler call that
`getPdfNativePageSizes` already wraps, so the session should learn the whole
document's geometry at open instead of page by page.

Page geometry keeps one owner. A bulk source has to agree with the pdf.js
viewport on crop box, `/Rotate` and `UserUnit`, or the layout shifts when a
hydrated metric replaces a seeded one. Documents without a path hydrate through
pdf.js in the background.

Consequence accepted with the convention: in a document whose page widths differ
greatly, the narrow pages are small in fit width. Fit page and manual zoom
remain.

Not implemented yet. Until issue #826 lands, the behavior contract's L1 states
the decided rule and the viewer violates it on documents of mixed page widths.
