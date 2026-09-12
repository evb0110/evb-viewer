# Project 8 empty sticky-note acceptance

Date: 2026-09-11

This acceptance covers the first sticky-note lifecycle case in #539 from the
current integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'shows a placed empty sticky note in the sidebar before text is entered' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified that pointer placement creates an empty
sticky note and that the note appears in the canonical sidebar before any
text is entered.

Evidence: `.devkit/analysis/gates/2026-09-11T18-31-27-803Z-29623-a38cb173.ndjson`.

Remaining gaps are the edited sticky-note round trip, filtered annotation
lifecycle, strict #459 Ink raster parity, four-angle #470 OCR overlay/CropBox
proof, and #540/#541 native save behavior.
