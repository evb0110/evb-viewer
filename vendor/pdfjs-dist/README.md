# EVB PDF.js artifact

This directory contains the complete generated `pdfjs-dist@6.3.312` package
from the public EVB fork at
`https://github.com/evb0110/pdf.js`, commit
`c3253faa113dd231ea95630afd40dbb31efead08`, tree
`61abab5aba6ccc2bfe574869e71dc5960b716d51`, branch
`ticket/168-fork-rebase`. The fork rebases the EVB changes onto upstream
`v6.3.289`.

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
