# Scan-cleanup supported document class

Status: normative for the automatic scan-cleanup feature as of 2026-08-16.

## Supported inputs

Scan cleanup is designed for page-oriented scans of predominantly dense text,
especially bound books and comparable archival documents. The exercised range
is 300–600 DPI (with deterministic analysis on a 150-DPI canonical plane,
which a coarser scan or an oversized page lowers to the scan's own resolution
or the shared raster cap), single pages and two-page spreads, and Latin, Hebrew, Syriac, and Greek
text represented in the reference corpus. Moderate skew, uneven paper tone,
book-gutter shadow, marginal notes, stamps, sparse front matter, and occasional
illustrations embedded in otherwise textual pages are supported conditions.
A scan whose PDF places one pixel per point on a page longer than half a
metre declares no real resolution; it is measured as a 300 DPI scan (600 DPI
when even that leaves the page longer than half a metre), and its cleaned
pages keep the source's page size.

The feature may preserve original PDF content when the lossless path can prove
that the requested crop, canvas, and placement are source-preserving. Other
accepted pages use the raster cleanup path. In both cases the document canvas,
margins, alignment, and page mapping are part of the output contract.

## Automatic routes

Auto binarizes every page with the paper/ink midpoint route (reported as
Otsu). Each stroke is cut between the paper found within one and a half
x-heights of it and its own ink core found within half an x-height, slightly
toward the paper, so a stroke keeps its printed weight, a hairline narrower
than the scanner's blur stays joined, and a light dash beside dark digits
keeps its own cut. Where the nearby ink is shallower than three tenths of the
page's ink depth, the page-wide midpoint applies, so faint show-through stays
paper.

Wolf and Sauvola remain available as explicit choices. They normalize contrast
per window, which thickens light words more than dark ones; Auto no longer
selects them.

A page may be intentionally unresolved when no trustworthy content crop can
be measured. The sole reference example is 126L: deskew confidence is 0.000,
the content crop is skipped, and the output is still typed as a successful
black-and-white page rather than an analysis error.

## Not supported or not promised

The automatic cleanup classifier is not calibrated as a general photographic
or continuous-tone restoration system. Documents dominated by photographs,
paintings, maps, or genuinely grayscale artwork should use an explicit
preservation/color path or be reviewed page by page. Camera captures with
perspective distortion, severe curvature, missing page boundaries, or mixed
unrelated documents in one image are outside the declared class.

The feature also does not promise to:

- reconstruct ink, characters, page edges, or illustrations missing from the
  source scan;
- correct OCR text, spelling, language, reading order, or semantic structure;
- erase source-supported handwriting, stamps, show-through, or marginalia;
- make every component match a historical DPI-dependent raster pixel for
  pixel; or
- judge aesthetic stroke weight from a sparse population without reporting
  the population/fallback evidence used.

Inputs outside this class are not silently certified by the reference-corpus
oracles. They require an explicit preservation choice or separate evidence
appropriate to that document family.
