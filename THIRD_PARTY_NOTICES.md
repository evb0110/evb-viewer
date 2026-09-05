# Third-Party Notices

This file is a practical index of the major third-party components and assets that EVB Viewer bundles or vendors. It is not a substitute for the upstream license files; keep those files with the assets when refreshing dependencies.

## Bundled Web Assets

- PDF.js is built from the exact EVB fork commit `f029c04600ed3d851491c0d70eafe7caa1557d36` of `https://github.com/evb0110/pdf.js` and committed as the local tarball under `vendor/pdfjs-dist/`. The receipt, sorted manifest, and `scripts/verify-pdfjs-provenance.mjs` bind its bytes and contents. Builds copy only runtime assets under `public/pdf/`; the complete package never ships wholesale. No npm package is published. Upstream license files for CMaps, ICC profiles, standard fonts, and WebAssembly helpers remain in the package and copied assets. Human legal review is required for the fork's modification notices and bundled third-party inventory.
- DjVu.js browser assets are vendored under `public/vendor/djvujs/`; see `public/vendor/djvujs/LICENSE.md`.

## Desktop Native Resources

- Tesseract OCR binaries and `tessdata_best` language models are bundled under `resources/tesseract/`.
- Poppler binaries and poppler-data resources are bundled under `resources/poppler/`; Windows poppler-data license files are retained under `resources/poppler/win32-x64/share/poppler/`.
- qpdf binaries are bundled under `resources/qpdf/`.
- DjVuLibre binaries are bundled under `resources/djvulibre/`.

## Package Dependencies

Application and development dependencies are declared in `package.json`, workspace package manifests, and `landing/package.json`. Refresh this notice whenever bundled native resources, vendored browser assets, or license-carrying package artifacts change.
