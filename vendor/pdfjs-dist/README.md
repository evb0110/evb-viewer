# EVB PDF.js artifact

This directory contains the complete generated `pdfjs-dist@6.3.315` package
from the public EVB fork at
`https://github.com/evb0110/pdf.js`, commit
`dd722a6628764218a99e3d8ac6e9c2b70141f993`, tree
`845071699cbf0e9a0fa353e2a769f9d64aafd97e`, branch
`evb-1442-background-rendering`, based on the native annotation appearance
renderer at `f88c766ad`. The fork rebases the EVB changes onto upstream `v6.3.289`.

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
