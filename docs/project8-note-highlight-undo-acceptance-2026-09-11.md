# Project 8 note/highlight undo acceptance

Date: 2026-09-11

This acceptance covers note undo isolation in #539 from the current
integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'undoes a note created after a pointer highlight without removing that highlight' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified that undoing a note created after a
pointer highlight removes only the note and preserves the highlight.

Evidence: `.devkit/analysis/gates/2026-09-11T18-42-09-239Z-19961-dff1b9a5.ndjson`.

Remaining gaps are the later saved-highlight and deletion/undo lifecycle
cases, strict #459 Ink raster parity, four-angle #470 OCR overlay/CropBox
proof, and #540/#541 native save behavior.
