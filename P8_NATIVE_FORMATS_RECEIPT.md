# Project 8 native formats receipt

- Host: macOS
- Worker thread: `d5f2bcaf-f741-4cd6-86de-d794c02eacbd`
- Caller/coordinator: `c5633c7a-e267-4631-9782-3f553fd68908`
- Task key: `p8-bundle-formats-20260911`
- Checkout: `/Users/evb/.t3/worktrees/evb-viewer/t3code-d5f2bcaf`
- Branch: `t3code/native-pdf-page-image-print`
- Tested source: `433379503df745c11c4be2301a9755333a24811e`; receipt commit `7632c4a4930a60696c5e01c1e6e7ef0888151c61` remains preserved above it.
- Task-scoped test correction commit: `24cf22df92b7651c1a7eeb96457b328c2af8c738`.
- Branch tip: `f4810edde6409dec0d9d238af29487ffc5ba2751`; documentation-only receipt/report commits are not intended for main integration.

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

## Issue dispositions

- #354 NPDF-3: native subset/page-identity support is already on current main; browser retained-link acceptance remains with the browser caller owner and was not independently changed here.
- #355 NPDF-4: browser number-tree support is already landed in `0756ecb3c`; this lane did not duplicate the browser caller change.
- #356 NPDF-5: browser label preservation is already landed in `945451192`; this lane did not duplicate the browser caller change.
- #357 NPDF-7: native canonical qpdf-name handling is already landed in `7aa34b221`; large-file annotation acceptance remains with the annotation owner.
- #358 IM-1: already landed in `545eef1` on current main. Native and focused Node image-combine coverage passed. Desktop open/combine/insert and packaged OS acceptance remain unrun; no existing headless image-picker journey was available.
- #359 IM-2: already landed in `5e9cc6120`. Native PNG variant tests passed, including indexed, low-bit grayscale, 16-bit RGB and interlaced decoding. Browser WASM and desktop PDF rendering acceptance remain open.
- #360 IM-3: already landed in `573e5062f`. Native tRNS tests passed for grayscale and RGB white compositing. Browser/native parity and full desktop round-trip acceptance remain open.
- #363 IM-6: already landed in `db08f8f46`. Native catalog, focused Electron assembler, browser page-ops, and native save/continuation integration checks passed; multi-request production acceptance remains open.
- #364 PE-01: already landed in `54762ca5e`. No separate native check was required in this lane; Electron export filename acceptance remains open.
- #367 PE-04: already landed in `dc32412c9`. Existing source/test coverage was not runnable without Node dependencies; native print preparation acceptance remains open.
- #368 PE-05: already landed in `41461d547`. Native image-combine late-failure and output-preservation tests passed; Electron DjVu PNG batch acceptance remains open.
- #369 PE-06: already landed in `91dbf33dd`. Focused image-export unit coverage and native integration checks passed; Electron selected-format export acceptance remains open.
- #513 LEGACY-E03: already landed in `3c1ceed78` lineage on current main. Native image-combine checks passed; packaged desktop EXIF acceptance remains open.
- #514 LEGACY-E04: already landed in `7abe858e7` lineage on current main. Native TIFF orientation tests passed; packaged desktop import acceptance remains open.
- #515 LEGACY-E05: already landed in `c515b46da`. Native TIFF resolution tests passed; desktop multi-page TIFF export acceptance remains open.
- #516 LEGACY-E06: already landed in `e4c60b6ee`. Existing unit coverage identifies facing/landscape composition, and the corrected hidden DjVu print journey passed the selected mixed-DPI page handoff. A three-page facing-page run and packaged-platform handoff remain open.
- #517 LEGACY-E12: already landed in `1fb345c9e`. Existing long multibyte filename coverage is present; the focused unit checks passed. Full native open/edit/save/reopen and packaged Windows acceptance remain open.
- #558 LEGACY-E07-ACCEPTANCE: already qualified by `0250054e4`; source and test remain on current main. The configured Electron mixed-size runtime acceptance was not rerun.
- #518 LEGACY-E16: no implementation change. Existing witness tests pass and retain the safe rejection of same-byte atomic replacement outside the bounded fallback. The required exact-65-MiB/exact-513-MiB three-cycle POSIX/Windows measurement matrix was not run and remains incomplete.
- #519 LEGACY-E17: current exact-first path implementation is present. Focused path encoding, exact trailing-whitespace path, recent-file identity, save-witness, and native save integration checks passed. The requested POSIX Electron open/reopen journey and full save/recovery collision matrix remain open.

- #361 IM-4: source-boundary reset is already landed in `01e2d0df6`; the native catalog code was not changed here.
- #362 IM-5: unread-label preservation is already landed in `d57770025`; the compact-range reopen assertion still exposes a browser state representation gap, reported to the coordinator without independent browser edits.
- #365 PE-02: quick-print document binding remains assigned to its existing owner; no independent edit was made.
- #366 PE-03: printable annotation appearances remain assigned across quick-print and annotation owners; no independent edit was made.

## Gaps and processes

The remaining gaps are browser caller/state handling for compact label representation, image-import desktop and browser visual parity, packaged OS checks, full #518 measurement research, the POSIX #519 Electron journey, selected-format/rollback Electron journeys, and the headless page-insert dialog path in the compact-label journey. No Electron, native full-build, or other long-lived process was left running by this lane. No hosted CI, release, issue closure, or Project status change was performed.
