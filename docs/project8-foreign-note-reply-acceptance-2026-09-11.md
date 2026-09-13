# Project 8 foreign note-reply acceptance

Date: 2026-09-11

This acceptance covers foreign note filtering and deletion in #539 from the
current integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'shows foreign note replies as read-only and deletes them with their parent' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified that foreign note replies are read-only
and that deleting the parent removes the replies with it.

Evidence: `.devkit/analysis/gates/2026-09-11T18-36-58-712Z-81561-066aeb8a.ndjson`.

Remaining gaps are the restored-note lifecycle, filtered annotation coverage,
strict #459 Ink raster parity, four-angle #470 OCR overlay/CropBox proof, and
#540/#541 native save behavior.
