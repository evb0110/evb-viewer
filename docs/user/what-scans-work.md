# Scan-cleanup supported document class

Status: normative for the automatic scan-cleanup feature as of 2026-08-16.

## Supported inputs

Scan cleanup is designed for page-oriented scans of predominantly dense text,
especially bound books and comparable archival documents. The exercised range
is 300–600 DPI (with deterministic analysis on a fixed 150-DPI canonical
plane), single pages and two-page spreads, and Latin, Hebrew, Syriac, and Greek
text represented in the reference corpus. Moderate skew, uneven paper tone,
book-gutter shadow, marginal notes, stamps, sparse front matter, and occasional
illustrations embedded in otherwise textual pages are supported conditions.

The feature may preserve original PDF content when the lossless path can prove
that the requested crop, canvas, and placement are source-preserving. Other
accepted pages use the raster cleanup path. In both cases the document canvas,
margins, alignment, and page mapping are part of the output contract.

## Automatic routes

The router makes its decision from the canonical analysis plane, so working
render DPI must not change the route for an unchanged document.

- Otsu is the normal route for flat-lit text pages. The landed Stylites-book
  inventory contains 288 Otsu leaves.
- Wolf handles text pages whose local contrast or illumination evidence needs
  an adaptive threshold. The same inventory contains 27 Wolf leaves.
- Sauvola handles high-illumination-deviation pages whose sampled stroke width
  remains at most eight routing-sample pixels. No accepted reference-book leaf
  currently needs this arm, so a production-sized synthetic fixture with
  illumination deviation above 12 protects its end-to-end reachability.
- A route may be intentionally unresolved when no trustworthy content crop can
  be measured. The sole reference example is 126L: deskew confidence is 0.000,
  the content crop is skipped, and the output is still typed as a successful
  black-and-white page rather than an analysis error.

The final reference inventory is therefore 288 Otsu, 27 Wolf, 0 Sauvola, and
1 intentionally unresolved leaf. The earlier 281/34/1 count was the pre-band
candidate, not the landed distribution.

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
