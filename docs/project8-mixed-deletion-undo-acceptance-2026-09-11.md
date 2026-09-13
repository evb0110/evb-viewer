# Project 8 mixed-deletion undo acceptance

Date: 2026-09-11

This acceptance covers mixed annotation deletion undo in #539 from the current
integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'restores one canonical entity and one painted markup when a deletion is undone immediately' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified that immediate undo restores one
canonical annotation entity and one painted markup together.

Evidence: `.devkit/analysis/gates/2026-09-11T18-56-15-710Z-15141-abc2b309.ndjson`.

The ordered annotation lifecycle cases are now covered by focused real
Electron runs except for the saved-highlight dirty-state mismatch already
recorded. Remaining campaign gaps are strict #459 Ink raster parity,
four-angle #470 OCR overlay/CropBox proof, and #540/#541 native save behavior.
