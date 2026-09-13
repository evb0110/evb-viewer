# Project 8 restored-note acceptance

Date: 2026-09-11

This acceptance covers restored-note persistence in #539 from the current
integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'persists a restored note after undo before saving a second note' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified that an undone note is restored and
persists when a second note is saved afterward.

Evidence: `.devkit/analysis/gates/2026-09-11T18-39-57-436Z-5748-38c7b774.ndjson`.

Remaining gaps are the remaining note and highlight lifecycle cases, strict
#459 Ink raster parity, four-angle #470 OCR overlay/CropBox proof, and
#540/#541 native save behavior.
