# Project 8 text-box pointer acceptance

Date: 2026-09-11

This acceptance covers the #539 pointer text-box journey from the current
integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationControls.e2e.test.ts -t 'creates a compact text box that grows and commits its text geometry at the page edge' --reporter verbose
```

The native darwin-arm64 page tools and Electron bundle built successfully.
The real macOS Electron test passed 1 test. It created a text box through the
pointer path at the page edge, verified focus and initial geometry, grew it
through multiline input while keeping content inside the page, replaced the
text, and committed the final geometry with Cmd+Enter.

Evidence: `.devkit/analysis/gates/2026-09-11T18-22-57-666Z-61706-022b8632.ndjson`.

The remaining acceptance gaps are focused text-box draft persistence, sticky
note lifecycle, Ink raster parity, four-angle OCR overlay/CropBox proof, and
native annotation-save behavior.
