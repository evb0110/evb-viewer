# Project 8 undone-highlight frame acceptance

Date: 2026-09-11

This acceptance covers post-undo highlight absence in #539 from the current
integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'keeps an undone highlight creation absent through subsequent animation frames' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified an undone highlight creation stays
absent through subsequent animation frames.

Evidence: `.devkit/analysis/gates/2026-09-11T18-49-42-136Z-70267-341e1827.ndjson`.

Remaining gaps are the undone-note frame case and mixed deletion undo,
strict #459 Ink raster parity, four-angle #470 OCR overlay/CropBox proof, and
#540/#541 native save behavior.
