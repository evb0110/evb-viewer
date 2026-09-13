# Project 8 highlight identity acceptance and fallback

Date: 2026-09-11

The primary #539 acceptance was:

```text
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'keeps the saved highlight identity across undo and redo without another save' --reporter verbose
```

The real macOS Electron test failed at the dirty-state boundary. After
undo/redo, the workspace reported `annotationDirty:false` and no pending
changes, but the active tab still had `tab is-active is-dirty`. This remains a
production acceptance gap. No speculative fix or assertion relaxation was
made.

The disjoint fallback was:

```text
EVB_PDF_PAGE_OPS_ENABLE=1 pnpm exec vitest run --project e2e-regression tests/e2e/electron/annotationLifecycle.e2e.test.ts -t 'restores a persisted highlight after saving its sidebar deletion and undoing' --reporter verbose
```

After the existing native page-tools and Electron builds, the fallback passed
1/1 in real macOS Electron. It verified a persisted highlight returns after a
saved sidebar deletion is undone.

Native gate evidence: `.devkit/analysis/gates/2026-09-11T18-46-22-117Z-48519-cc2eee26.ndjson`.

Remaining gaps are the primary dirty-state mismatch, later animation-frame
and mixed-deletion lifecycle cases, #459 Ink raster parity, four-angle #470
OCR overlay/CropBox proof, and #540/#541 native save behavior.
