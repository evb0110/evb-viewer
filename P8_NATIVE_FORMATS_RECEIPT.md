# Project 8 native formats receipt

- Host: macOS
- Worker thread: `d5f2bcaf-f741-4cd6-86de-d794c02eacbd`
- Caller/coordinator: `c5633c7a-e267-4631-9782-3f553fd68908`
- Task key: `p8-bundle-formats-20260911`
- Checkout: `/Users/evb/.t3/worktrees/evb-viewer/t3code-d5f2bcaf`
- Branch: `t3code/native-pdf-page-image-print`
- Tested source: `433379503df745c11c4be2301a9755333a24811e`; receipt commit `7632c4a4930a60696c5e01c1e6e7ef0888151c61` remains preserved above it.
- Task-scoped test correction commit: `24cf22df92b7651c1a7eeb96457b328c2af8c738`.
- Source fix commit: `175ad3a539c17f97d25af4aeeff5e087ee597b3b`.
- Source follow-up commits: `506d45706` preserves exact paths in revision sidecars; `a4e5a01b8` preserves exact native paths through open/save routing and working-copy creation. Receipt/report commits are not intended for main integration.

## Verification

- `cargo test --manifest-path native/Cargo.toml -p evb-raster-io --locked`: passed, 29 tests.
- `cargo test --manifest-path native/Cargo.toml -p evb-pdf-image-combine --locked`: passed, 121 tests.
- `cargo test --manifest-path native/Cargo.toml -p evb-pdf-page-ops catalog --locked`: passed, 4 catalog tests plus 1 split-pages regression.
- `cargo fmt --manifest-path native/Cargo.toml --all --check`: passed.
- Existing native coverage exercised PNG variants, PNG tRNS white compositing, physical TIFF resolution, TIFF orientation, catalog metadata preservation, bounded streaming, late-failure output preservation, and raster export behavior.
- `pnpm exec vitest run --project unit-electron ...nativePdfAssembler...workingCopy.test.ts --reporter=dot`: passed, 6 files and 160 tests.
- `pnpm exec vitest run --project unit-electron --project unit-app ...browserPdfImageCombineWasm...pdfCombineCatalog.test.ts --reporter=dot`: passed, 6 files and 87 tests.
- Frozen offline install: `pnpm install --frozen-lockfile --offline` reused 1,499 packages, ran postinstall and verified the cached Electron binary; `pnpm exec nuxi prepare` passed.
- A hidden macOS Electron DjVu print run first exposed an existing fixture mismatch: `mixed-dpi.djvu` has 2 pages while the test selected page 3. After correcting the existing test to select pages 1 and 2, the same journey passed, 1 test.
- Hidden macOS Electron compact page-label save/reopen ran to completion but failed its compact-range assertion. Independent qpdf and native `read-catalog` inspection showed correct labels at all boundaries, represented as dense per-page entries. This is reported to the coordinator as a browser label-state boundary, not native catalog data loss.
- `pnpm exec vitest run --project unit-electron tests/unit/electron/pathEncoding.test.ts tests/unit/electron/openPathCapabilities.test.ts tests/unit/electron/recentFiles.test.ts tests/unit/electron/originalPathSaveWitness.test.ts tests/unit/electron/workingCopySave.test.ts --reporter=dot`: passed, 5 files and 57 tests.
- `pnpm exec vitest run --project browser-integration tests/integration/browser/browserPageOpsAcceptance.test.ts --reporter=dot`: passed, 1 file and 1 test.
- `pnpm exec vitest run --project native-integration tests/integration/native/nativeBookmarkContinuation.test.ts tests/integration/native/nativePdfSave.test.ts --reporter=dot`: passed, 2 files and 2 tests.
- `pnpm exec vitest run --project unit-electron tests/unit/electron/pdfConversion.test.ts tests/unit/electron/pdfCombineSharedNative.test.ts tests/unit/electron/nativePdfAssembler.test.ts --reporter=dot`: passed, 3 files and 49 tests after the desktop decoder fallback.
- `pnpm run build:electron`: passed after the source fix.
- Hidden macOS Electron print against a disposable three-page mixed-DPI DjVu assembled with `djvm`: passed, 1 test. Selected pages 1, 2, and 3 produced a nonblank three-page PDF. The existing two-page test fixture selection was restored afterward.
- Existing macOS print-composition acceptance against its generated four-page PDF: passed, 1 selected test. It produced three landscape sheets and verified first-page-single, facing, and trailing-page half-sheet ink placement.
- Hidden macOS Electron production combine through `documentOpen.openDocumentDirectBatch` plus the existing automation file-grant hook: valid BMP, GIF, and WebP all accepted after the fallback, producing a qpdf-valid three-page working copy with rendered sizes 24x16, 32x20, and 40x24. Normalized scratch directories were absent after completion.
- Hidden macOS Electron PNG control through the same production route: accepted a transparent 36x22 PNG, producing a qpdf-valid one-page working copy and a rendered 36x22 nonblank page.
- POSIX #518 witness probe over exact 68,157,440-byte (65 MiB) and 537,919,488-byte (513 MiB) valid PDFs: three cycles per fixture. Unchanged witness assertions passed; every same-byte atomic replacement was rejected. Capture/assert/replacement checks were 0-2 ms because POSIX uses the existing bounded sample witness. This is decisive negative evidence for automatic full-content replacement approval; the guard remains intact.
- Existing focused path checks after the exact-path source change: 4 files and 91 tests passed, covering path encoding, open-path grants, working-copy handling, and recent-file identity. Electron build passed.
- Hidden macOS Electron #519 probe with `.devkit/analysis/p8-e17-20260911/report exact.pdf`: exact path opened, native page rotation returned `success:true`, Save returned `true`, reopen returned the same exact `originalPath`, and qpdf validation passed. A filename ending in a literal trailing space is rejected by the supported-extension gate before open, so that narrower case remains a path-policy gap.
- Hidden macOS Electron native page-ops insertion through the real `pageOps.insertFile` IPC and automation file grant accepted the transparent PNG and produced a qpdf-valid two-page working copy. The renderer automation snapshot remained at one page after the direct native mutation, so renderer state synchronization is handed to owner `03fb9179`, not changed here.
- Existing selected-format/rollback export coverage: 6 Electron unit files and 149 tests passed (`imageExportIpc`, image export, DjVu export paths/PDF export/compact export, and page-ops IPC handlers). Native dialog interception is not available in the hidden package, so no false claim is made for a native picker dialog journey.

## Issue dispositions

- #354 NPDF-3: native subset/page-identity support is already on current main; browser retained-link acceptance remains with the browser caller owner and was not independently changed here.
- #355 NPDF-4: browser number-tree support is already landed in `0756ecb3c`; this lane did not duplicate the browser caller change.
- #356 NPDF-5: browser label preservation is already landed in `945451192`; this lane did not duplicate the browser caller change.
- #357 NPDF-7: native canonical qpdf-name handling is already landed in `7aa34b221`; large-file annotation acceptance remains with the annotation owner.
- #358 IM-1: source fallback is fixed in `175ad3a53`. Production macOS combine accepted generated BMP, GIF, and WebP through the real file-grant/open batch route, preserving page order and dimensions. Native page-ops image insertion also produced a valid two-page working copy; renderer post-mutation page-count refresh and picker/drop UI injection remain open.
- #359 IM-2: already landed in `5e9cc6120`. Native PNG variant tests and fresh browser WASM/image metadata/export checks passed, plus the desktop PNG control. Packaged OS acceptance remains open.
- #360 IM-3: already landed in `573e5062f`. Native tRNS tests and fresh browser/image export checks passed; the desktop transparent PNG control was qpdf-valid and rendered at the expected size. Exact cross-engine pixel-bucket parity remains open.
- #363 IM-6: already landed in `db08f8f46`. Native catalog, focused Electron assembler, browser page-ops, and native save/continuation integration checks passed; multi-request production acceptance remains open.
- #364 PE-01: already landed in `54762ca5e`. No separate native check was required in this lane; Electron export filename acceptance remains open.
- #367 PE-04: already landed in `dc32412c9`. Existing source/test coverage was not runnable without Node dependencies; native print preparation acceptance remains open.
- #368 PE-05: already landed in `41461d547`. Native image-combine late-failure and output-preservation tests passed; Electron DjVu PNG batch acceptance remains open.
- #369 PE-06: already landed in `91dbf33dd`. Focused image-export unit coverage and native integration checks passed; Electron selected-format export acceptance remains open.
- #513 LEGACY-E03: already landed in `3c1ceed78` lineage on current main. Native image-combine checks passed; packaged desktop EXIF acceptance remains open.
- #514 LEGACY-E04: already landed in `7abe858e7` lineage on current main. Native TIFF orientation tests passed; packaged desktop import acceptance remains open.
- #515 LEGACY-E05: already landed in `c515b46da`. Native TIFF resolution tests passed; desktop multi-page TIFF export acceptance remains open.
- #516 LEGACY-E06: already landed in `e4c60b6ee`. Corrected hidden DjVu print handoff passed with the generated three-page mixed-DPI fixture, and the existing macOS facing-first-single acceptance passed with three landscape sheets and independent raster placement assertions. Packaged-platform handoff remains open.
- #517 LEGACY-E12: already landed in `1fb345c9e`. Existing long multibyte filename coverage is present; the focused unit checks passed. Full native open/edit/save/reopen and packaged Windows acceptance remain open.
- #558 LEGACY-E07-ACCEPTANCE: already qualified by `0250054e4`; source and test remain on current main. The configured Electron mixed-size runtime acceptance was not rerun.
- #518 LEGACY-E16: negative POSIX decision recorded. Exact 65 MiB and 513 MiB valid fixtures completed three same-byte atomic-replacement cycles each; every replacement was rejected and unchanged witnesses passed within the 12,000 ms ceiling. POSIX uses sample-only capture, so automatic full-content approval is not safe. Windows cycles, cancellation gates, and full memory/read-volume instrumentation remain open.
- #519 LEGACY-E17: exact ordinary POSIX path acceptance is qualified in hidden Electron. `report exact.pdf` opened, edited, saved, qpdf-validated, and reopened with the exact path retained. Literal trailing-space filenames remain rejected by the supported-extension policy, and the full save/recovery collision matrix remains open.

- #361 IM-4: source-boundary reset is already landed in `01e2d0df6`; the native catalog code was not changed here.
- #362 IM-5: unread-label preservation is already landed in `d57770025`; the compact-range reopen assertion still exposes a browser state representation gap, reported to the coordinator without independent browser edits.
- #365 PE-02: quick-print document binding remains assigned to its existing owner; no independent edit was made.
- #366 PE-03: printable annotation appearances remain assigned across quick-print and annotation owners; no independent edit was made.

## Gaps and processes

The remaining gaps are browser caller/state handling for compact label representation, renderer refresh after direct image insertion, desktop image picker/drop UI injection, exact browser/native pixel parity, packaged OS checks, #518 Windows/cancellation instrumentation, literal trailing-space extension policy, the full #519 save/recovery collision matrix, selected-format/rollback native dialog journeys, and the headless page-insert dialog path in the compact-label journey. No Electron, native full-build, or other long-lived process was left running by this lane. No hosted CI, release, issue closure, or Project status change was performed.
