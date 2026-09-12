# Project 8 text-box draft persistence acceptance

Date: 2026-09-11

This acceptance covers the focused text-box draft lifecycle in #539 from the
current integration context.

Commands:

```text
pnpm run build:native:e2e
pnpm run build:electron
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'saves focused canonical text-box drafts across two saves and reopen' --reporter verbose
```

The native page tools and Electron bundle built successfully. The real macOS
Electron test passed 1/1. It verified that a focused canonical text box keeps
its draft across two saves and remains present after hard reopen.

Evidence: `.devkit/analysis/gates/2026-09-11T18-28-17-376Z-2420-9d0eb322.ndjson`.

Remaining gaps are sticky-note lifecycle, filtered annotation lifecycle,
strict #459 Ink raster parity, four-angle #470 OCR overlay/CropBox proof, and
#540/#541 native save behavior.
