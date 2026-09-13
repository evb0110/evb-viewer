# Project 8 saved-highlight undo/redo acceptance

Date: 2026-09-11

This acceptance covers saved highlight history in #539 from the current
integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'keeps saved highlight create undo and redo coherent across intervening saves' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified saved highlight creation, undo, and redo
remain coherent when saves occur between the history operations.

Evidence: `.devkit/analysis/gates/2026-09-11T18-44-23-266Z-37211-9b7f18c9.ndjson`.

Remaining gaps are saved-highlight identity and deletion/undo lifecycle cases,
strict #459 Ink raster parity, four-angle #470 OCR overlay/CropBox proof, and
#540/#541 native save behavior.
