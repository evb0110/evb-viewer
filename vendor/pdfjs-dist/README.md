# EVB PDF.js artifact

This directory contains the complete generated `pdfjs-dist@6.3.317` package
from the public EVB fork at
`https://github.com/evb0110/pdf.js`, commit
`0b4dd364e07b4370cf5e53b6e57a3b0816afb0cb`, tree
`5a047db1e92a13b5f7cb7dad13e69c2d076eba76`, branch
`evb-1734-wide-xref-offsets`, based on the background-rendering & abort-fix
pin at `c6bd72136`. The fork rebases the EVB changes onto upstream `v6.3.289`.

The generated fork metadata keeps `sourceVersion: 5.7.284` to identify the
original EVB fork base. The upstream rebase is identified separately by the
receipt in `provenance.json` and the generated source commit and tree fields.

The tarball is installed only through the `file:` dependency in the root
`package.json`. It is not published to npm. The complete package stays here so
its bytes and generated contents can be reviewed. Product builds copy only the
worker and runtime assets they need into `public/pdf/` and `dist-electron/`.

Run `pnpm install --frozen-lockfile`, `pnpm run verify:pdfjs-provenance`, and
`pnpm run copy:pdfjs` after updating the artifact. Rebuild it from a clean,
full-history fork checkout with the commands recorded in `provenance.json`.
The receipt and sorted manifest must be regenerated with every artifact update.
The fork's license and bundled third-party inventory remain in the package.
Human legal review is still required for modification notices and third-party
license sufficiency.

The OCR repair preserves encoded spaces between touching word boxes and keeps
selection aligned with horizontally reflected text. The source tests cover
overlap, rotation and vertical-font controls.

`page.render()` accepts `hiddenAnnotationIds`, a `Set` of annotation ids as
`getAnnotations()` reports them. PDF.js leaves those annotations' appearances
out of the canvas and keeps every other annotation, so the viewer and its
thumbnails can draw editable annotations from the EVB store without reading
the render task's private operator list.

`page.render({useRequestAnimationFrame: false})` uses the existing promise
scheduler for offscreen OCR rasters. Display content and annotation visibility
stay the same; rendering can continue when hidden tabs receive no animation
callbacks. Default viewer rendering still follows animation frames.

This pin backports upstream [PR 22164](https://github.com/mozilla/pdf.js/pull/22164).
Aborting a range-backed load preserves the request rejection, while a separate
observer handles discarded background promises. Worker termination yields to
those rejections before cleanup, so replacing a document can await its teardown.

`XRef.readXRefStream()` decodes cross-reference stream entry offsets using
base-256 arithmetic with `Number.isSafeInteger()` validation instead of 32-bit
bitwise shifts, allowing range-backed PDF 1.5+ files with >2 GiB, >4 GiB, and
>10 GiB cross-reference stream offsets to open without truncation.
