# Project 8 annotation geometry fallback

Date: 2026-09-11

The primary #459 cross-runtime Ink raster parity acceptance remains blocked by
the native page import fixture. Its prior measured result is retained at 46
different pixels versus an allowed 28. No pixel threshold was relaxed.

The disjoint fallback ran from the current integration context:

```text
pnpm exec vitest run --project unit-app tests/unit/app/modules/pdf-viewer/components/annotationGeometryRendering.test.ts --reporter verbose
```

The fallback passed 1 file and 20 tests. It covers reverse-drawn geometry,
resize previews, rotated pointer/CropBox mapping, upright rotated text,
multiline layout, page-edge positioning, markup hit targets, and shared arrow
alpha at 0, 0.42, 0.55, and 1.

`git diff --check` passed. No production source or test behavior was changed.

Remaining gaps are real cross-runtime Ink raster/persistence acceptance,
four-angle #470 OCR overlay/CropBox proof, and #540/#541 native save behavior.
