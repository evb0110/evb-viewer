# Project 8 sticky-note round-trip acceptance

Date: 2026-09-11

This acceptance covers the edited sticky-note lifecycle in #539 from the
current integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'round-trips a canonical sticky note after editing, recoloring, and moving it' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified sticky-note editing, recoloring,
movement, save, hard reopen, and persisted note content and style.

Evidence: `.devkit/analysis/gates/2026-09-11T18-34-37-222Z-62553-115927ca.ndjson`.

Remaining gaps are filtered annotation lifecycle, strict #459 Ink raster
parity, four-angle #470 OCR overlay/CropBox proof, and #540/#541 native save
behavior.
