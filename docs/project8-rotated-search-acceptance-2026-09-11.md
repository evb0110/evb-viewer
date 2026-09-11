# Project 8 rotated search acceptance

Date: 2026-09-11

This acceptance covers the current #470 search-match scrolling path from
`origin/project8/integration` at `800ea56d4`.

Command:

```text
pnpm run test:e2e:electron:search-match-scroll
```

The native `evb-pdf-search` tool built for darwin-arm64, the Electron bundle
built, and the real macOS Electron suite passed 1 file and 2 tests:

- the final result stayed visible and centered after a high-zoom xlarge search;
- repeated match selections stayed visible after navigation settled.

Evidence: `.devkit/analysis/gates/2026-09-11T18-14-47-409Z-95405-3adbd4dc.ndjson`.

This closes the measured rotated-search scrolling acceptance. It does not
close the remaining four-angle OCR overlay/CropBox proof, Ink raster parity,
or native annotation-save gaps.
