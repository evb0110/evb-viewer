# EVB PDF.js artifact

This directory contains the complete generated `pdfjs-dist@5.7.304` package
from the public EVB fork at
`https://github.com/evb0110/pdf.js`, commit
`f029c04600ed3d851491c0d70eafe7caa1557d36`, tree
`b4653b1e48fcb781ffeafed8efcdceb1a0b986fe`, branch `evb/5.7.284`.

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
