# What pdf.js actually costs us

> **Status (2026-08-30): superseded by [ADR 0002](../../architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md) and wayfinder map #150.**
> Its compensation-layer inventory and attribution argument were verified and
> carried into the ADR. Corrections from review: "Linux exact-xlarge lane red
> on main" was true when written and green from `4f89f9a11` onward;
> "Stages 0, 1, 2, 4 shipped" overstates it, since `app/types/pdfContracts.ts`
> still re-exports `PDFDocumentProxy`/`PDFPageProxy` to 26 importers; hayro
> supports passwords (`Pdf::new_with_password`); pdf-lib is a third writer
> and a second whole-document memory model, which this doc does not count.

Research date: 2026-08-30
Question asked: are many of the problems we fight in this project caused by pdf.js limitations, and if so is a Rust rewrite the answer?
Repositories inspected: `/Users/evb/WebstormProjects/evb-viewer` (branch `main`), `/Users/evb/npm-repos/pdf.js` at `399fce647`, `/Users/evb/oss-repos/hayro` at `5a5f0e24`
Status: read-only research. No production code changed.

Companion document: [`rust-pdf-engine-rewrite-feasibility-2026-08-30.md`](rust-pdf-engine-rewrite-feasibility-2026-08-30.md). That report answers whether a Rust engine is buildable. This one answers whether it is the right thing to build. The two disagree, and the disagreement is the point.

## Answer in one paragraph

pdf.js causes few direct bugs and a large share of our architecture, and the architecture is where the bugs are. By direct attribution pdf.js is responsible for 1 of 71 tracked issues and 6 of the last 40 fix commits. By causal reading it is responsible for the bounded save route, the native first-page preview, the sparse layout work, four separate monkey-patch layers over the annotation editor, and a 1,358-line vendored patch, all of which exist to route around it, and all of which generate bugs of their own. So the premise is right, but the fix implied by it is wrong: the prior feasibility report proposes replacing the parser and renderer, and the parser and renderer are the parts of pdf.js that work. The pain is concentrated in the annotation editor and the whole-document memory model. Attack those two directly and skip the rewrite.

## Method

Four independent lines of evidence, deliberately chosen to disagree with each other:

1. Direct reading of the vendored patch, to see where we have already been forced to reach into pdf.js.
2. Classification of all 71 GitHub issues by root cause.
3. Classification of 3,493 commits and 556 fix commits by scope and root cause.
4. Direct measurement of our own coupling: which files import pdf.js types, which exist only to compensate for it.

Lines 2 and 3 were run as read-only subagent sweeps. Every claim taken from them that carries weight in the recommendations was re-verified by hand against the source; those verifications are noted inline. Line 4 and the patch reading are my own throughout.

Where the four lines disagree, the disagreement is reported rather than averaged.

## Evidence

### The vendored patch

We pin `pdfjs-dist` 5.7.284 (`package.json:169`) with `patches/pdfjs-dist@5.7.284.patch` (`package.json:319`).

The patch is 1,358 lines and 64 hunks, but that overstates it by four. It is four copies of roughly 16 logical edits, applied to `build/pdf.mjs`, `build/pdf.worker.mjs`, and both `legacy/` twins. It was created 2026-08-06 and touched four times since:

| Date | Hash | Subject |
|---|---|---|
| 2026-08-06 | `6a170d89b` | fix(viewer): image masks pre-scale below 0.75x to stop undersampling |
| 2026-08-24 | `afac068d0` | fix: ... guard pdf.js text layer |
| 2026-08-27 | `f7fbdcfa9` | fix(pdf): keep large document workflows path-backed |
| 2026-08-30 | `b537d406d` | fix(pdfjs): stop building an edit toolbar the editor already removed |

The edits fall into two classes.

**Structural, and unfixable upstream.** The bulk of the patch rewrites `ChunkedStream` so it does not hold the document in one contiguous buffer. Upstream, `src/core/chunked_stream.js:28-30`:

```js
constructor(length, chunkSize, manager) {
  super(
    /* arrayBuffer = */ new Uint8Array(length),
```

Opening a 2.17 GB PDF allocates 2.17 GB in the worker before a single object is parsed. Our patch replaces that with a sparse chunk `Map`, adds `_storeBytes` / `_getStoredByte` / `_getStoredRange`, and adds `discardChunksBefore(position)` for eviction. It also replaces xref recovery: upstream `XRef.indexObjects()` (`src/core/xref.js:429`, called from `:126`) scans the entire file, so the patch adds `indexObjectsBounded()` with a 1 MiB scan window and resumable recovery state.

This is not a workaround that upstream might accept. Every consumer of `Stream` assumes contiguous bytes. It is a fork of the memory model.

**Ordinary upstream defects.** The rest are small guards:

- `_queuedChunk` becomes `_queuedChunks[]` with an `isLast` flag, because `PDFDataTransportStreamRangeReader._enqueue` fired `onDone()` after the first chunk and dropped the rest of a multi-chunk range response.
- A null guard on `AnnotationEditor.addEditToolbar`, which crashed when a layer rebuilt under it.
- A `TextLayer` container-escape guard (`this.#container.parentNode ?? this.#rootContainer`) for unbalanced `endMarkedContent`.
- `.catch(this.#capability.reject)` for an unhandled rejection.
- `_scaleImage` gains a `prescaleThreshold` parameter, passed `4 / 3` for image masks, fixing undersampling in the 0.5x to 1.0x band.

Reading the patch alone, you would conclude pdf.js is a serious problem. That conclusion does not survive the other three lines of evidence unmodified.

### Issue tracker

All 71 issues, classified by root cause:

| Bucket | Open | Closed | Total |
|---|---|---|---|
| OURS | 4 | 57 | 61 |
| PLATFORM | 1 | 5 | 6 |
| PRODUCT | 0 | 3 | 3 |
| PDFJS-LIMIT | 0 | 1 | 1 |

The single pdf.js issue is **#111**, slow first paint on page-heavy non-linearized PDFs. Its trace recorded 162 range requests totalling 169,448,217 bytes, which is 99.385% of the file: a damaged non-linearized xref defeats range loading entirely and pdf.js asks for nearly every byte before `getDocument` resolves.

Even that one is roughly half ours. Of the 10.57 s cold trace, pdf.js `getDocument` took 4,443.2 ms and our own qpdf `validatePdfPath` took 4,996.9 ms. The fix landed entirely in our code as a guarded native first-page preview.

Only one issue was ever reopened: **#82**, an Electron ASAR `fs.promises` shim interacting with Windows 8.3 short names. PLATFORM, not pdf.js. Note for anyone searching this tracker: "reopen" almost always means *document* reopen here, not issue reopening, so a text search will mislead you.

The five largest issues by effort are all OURS: #112 (large-document reliability umbrella, ~102 findings), #139 (FreeText divergence, 19 comments, open), #144 (save-path chain), #125 (annotations audit), #134 (test harness).

### Commit history

3,493 commits over 2026-01-03 to 2026-08-30, about 437/month. 556 fix commits, 15.9% of history.

Top fix scopes, of the 329 using `fix(scope)`:

| Scope | Count | Scope | Count |
|---|---|---|---|
| scan-cleanup | **89** | viewer | 12 |
| pdf | 42 | release | 9 |
| ci | 25 | ocr | 8 |
| e2e | 23 | print | 7 |
| save | 20 | file-access | 7 |
| annotations | 19 | native | 5 |

`scan-cleanup` alone is 27% of all scoped fixes, more than double the next scope, and it is entirely our own Rust and Electron pipeline.

Root cause of the 40 most recent `fix(` commits: **OURS 25, PLATFORM 9, PDFJS 6**.

All six pdf.js ones land in a single directory, `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/`, on editor-layer rebuild and resize:

| Hash | Subject |
|---|---|
| `b537d406d` | fix(pdfjs): stop building an edit toolbar the editor already removed |
| `4f89f9a11` | fix(annotations): keep free text visible during resize transitions |
| `21f4b1831` | fix(annotations): bound FreeText resize lookups and count ready layer visuals |
| `4bcede330` | fix(annotations): keep editors painted through resize transitions |
| `f992d0654` | fix(annotations): bound FreeText resize history lookup |
| `d0251c851` | fix(annotations): bound FreeText resize setup to mounted pages |

Whole-history corroboration: 30 of 556 fix commits (5.4%) touch a `pdfjs`-named path; 68 (12.2%) add or remove a line referencing a pdf.js identifier.

### Our coupling

The document API surface we use is small. Call counts across `app/`:

```
getPage 49 · getViewport 21 · render 11 · getTextContent 6 · getOutline 5
getAnnotations 5 · getOperatorList 4 · saveDocument 1 · getPageLabels 1 · getData 1
```

No forms, no XFA, no scripting, no struct tree, no attachments. Against pdf.js's `src/core` at 86,055 lines (including 16,358 for XFA alone) and `src/display` at 39,687, we use a narrow slice.

The DOM-side dependency is different in kind. `runtimeLib.ts` requires `AnnotationLayer`, `AnnotationEditorLayer`, `AnnotationEditorUIManager`, `DrawLayer`, `TextLayer`, `PDFDateString`. 43 files reference the editor classes.

Coupling is concentrated, not diffuse:

| Measure | Value |
|---|---|
| Files in `app/modules/pdf-viewer/engine/` | 356 |
| Of those mentioning any pdf.js identifier | 54 (15%) |
| Subdirectories in `engine/` | 65 |

That 15% matches the 15% of recent fixes almost exactly. Two independent measures, same number.

### Compensation layers

This is the finding that reframes everything, and it is invisible to both the issue tracker and the commit classifier, because the code and the bugs are all ours.

Five distinct layers exist solely to work around pdf.js's annotation editor. Each verified by hand:

**`useFreeTextResize.ts`, 649 lines.** Exists because pdf.js FreeText editors are not resizable. Contains `patchResizableFreeTextEditors` (`:630`), `markFreeTextResizable`, `patchFreeTextResizeFontSync`, `patchFreeTextPreSelect`, `ensureFreeTextEditorInteractivity`, and, tellingly, `recoverNaNPosition` (`:307`) and `recoverNaNDimensions` (`:347`) which repair NaN geometry the editor produces.

**`findClosestHighlightDrawLayerSvg.ts`.** Performs rectangle IoU matching against DOM SVG elements (`rectIoU`, `:21`) with a 40-pixel distance fallback (`:4`) to determine which drawn highlight belongs to which editor. This is a geometric heuristic reconstructing an identity relationship pdf.js declines to expose.

**`annotationEditorCompatibility.ts`.** Monkey-patches three known shapes (`annotation-editor-layer-div-fallback`, `annotation-editor-ui-current-layer-fallback`, `annotation-editor-text-layer-div-ref`) and reports `severity: 'ok' | 'patched' | 'unsupported'` (`:8`, `:197`).

**`createAnnotationEditorLayerFailureTracker.ts`.** Retries editor layers up to `MAX_EDITOR_LAYER_RETRIES = 2`, then quarantines them.

**`ANNOTATION_EDITOR_RETRY_DELAY_MS = 80`** in `useAnnotationHighlight.ts:161`. `architecture-audit-2026-07-23.md:310-312` says to remove it only "when PDF.js exposes a deterministic created-editor transition."

A sixth layer wraps saving. `usePdfViewerSaveTransaction.ts` has `saveDocumentWithRetry(maxAttempts = 4, retryDelayMs = 50)` (`:405`), a `PDF_SAVE_TIMEOUT_MS` deadline (`:376`), and a source-bytes fallback (`:495`). `classifyPdfSaveRoute.ts:384-385` already routes around it: "Large scanned PDFs can make PDF.js saveDocument stall, so keep replayable-only note saves off that path."

And `docs/architecture/freetext-note-persistence.md` documents the semantics problem directly:

> PDF.js `PopupAnnotation` reads `/Contents` from its **parent** annotation dict, not from the Popup's own dict. ... This is hardcoded in PDF.js and cannot be changed without forking the library.

The resolution is writing a blank Form XObject AP stream so `/Contents` can carry note text without painting it. That whole document exists because of one pdf.js design decision.

### The attribution gap

Issue **#149** is the cleanest illustration. A 9-second renderer stall. The fix was bounding our own `patchResizableFreeTextEditors` page scan. Every classifier files it as OURS, because the bug and the fix are both in our code. Causally it is pdf.js: that function exists only because pdf.js FreeText editors are not resizable.

Issue **#141** is the mirror image. Body reads as a pure pdf.js defect; confirmed root cause was a stale `node_modules` holding the pre-patch build. Filed OURS. But the behavior it exposed (`_enqueue` firing `onDone()` after the first chunk) is genuine unpatched-pdf.js misbehavior, and it confirms the range-transport patch is load-bearing rather than defensive.

Issue **#147** blames pdf.js annotation work in its body; the closing measurement pinned it on main-process `clone-working-to-temp`. OURS.

So attribution data systematically undercounts a dependency you can patch yourself. Four genuine upstream defects never became tickets, because they went straight into the vendored patch.

| Attribution method | pdf.js share |
|---|---|
| Issues by root cause | 1 of 71 |
| Last 40 `fix(` commits | 6 of 40 |
| `engine/` files touching pdf.js | 54 of 356 |
| Architecture existing to route around pdf.js | large, and unmeasured |

## What the prior feasibility report missed

`rust-pdf-engine-rewrite-feasibility-2026-08-30.md` is competent on architecture. Its advice about `u64` offsets, host-specific I/O adapters, an EVB-owned interface, and keeping pdf.js as a differential oracle is all sound and worth keeping. Three corrections:

**It never asks which problems the rewrite would solve.** It answers "is this buildable" and stops. The premise it implicitly assumes, that the parser is the problem, is the opposite of what the evidence shows.

**It does not mention `native/pdf-page-ops`.** We already have 131,565 lines of Rust across 8 crates:

| Crate | Lines | Role |
|---|---|---|
| `scan-cleanup` | 64,469 | scan pipeline |
| `pdf-page-ops` | 29,391 | page/annotation/save operations |
| `pdf-image-combine` | 9,446 | image codecs and assembly |
| `scan-primitives` | 4,543 | shared imaging |
| `jbig2-codec` | 3,347 | JBIG2 |
| `pdf-search` | 2,649 | mmap-backed text search |
| `evb-native-support` | 1,570 | protocol and process support |
| `evb-raster-io` | 974 | PNG and zlib I/O |

`pdf-page-ops` alone contains `annotations.rs` (1,809), `incremental.rs` (1,764), `text_layer.rs` (1,717), `page_sizes.rs` (1,239), `catalog.rs`, `page_tree_ops.rs`, `split_pages.rs`, `page_geometry.rs`, and `wasm.rs` (552) with a working `wasm32` request protocol. Electron already invokes `evb-pdf-page-ops(page-geometry)`, `(save-mutations)`, `(annotation-index)`, `(embedded-shape-index)`, `(pdf-conformance)` and more.

Stages 0, 1, 2 and 4 of that report's migration plan are substantially shipped, including the dual native/wasm build it treats as an open risk.

**It dismisses `hayro` as an experimental prototype.** `hayro-jpeg2000` is already a dependency of `pdf-image-combine`.

## hayro, assessed properly

77,253 lines of Rust. Dual MIT / Apache-2.0.

| Crate | Lines | Role |
|---|---|---|
| `hayro-interpret` | 26,898 | content stream interpreter |
| `hayro-syntax` | 15,340 | parser, `no_std` compatible |
| `hayro-jpeg2000` | 9,708 | JPEG 2000 |
| `hayro-jbig2` | 8,854 | JBIG2 |
| `hayro-cmap` | 2,808 | CMap parsing |
| `hayro` | 1,757 | bitmap rendering |
| `hayro-svg` | 1,684 | SVG output |
| `hayro-postscript` | 1,555 | Type 4 function subset |
| `hayro-ccitt` | 1,057 | CCITT G3/G4 |
| `hayro-write` | 711 | writing |

Three properties matter for us.

**The memory model is right.** `PdfData` is `Arc<dyn AsRef<[u8]> + Send + Sync>` (`hayro-syntax/src/data.rs:15`), and `Pdf::new` takes `impl Into<PdfData>` (`pdf.rs:36`). `memmap2::Mmap` implements `AsRef<[u8]>`, so a 2.17 GB PDF costs zero heap and the OS pages in on demand. That is precisely the property pdf.js structurally cannot have, and `pdf-search` already proves we are comfortable with mmap'd PDF bytes.

**The output model is right.** `hayro-interpret/src/device.rs:8` defines a `Device` trait with `draw_path`, `draw_glyph_run`, `draw_image`, clip and transparency stack operations, and `begin_marked_content(tag, mcid)`. Positioned glyph runs plus marked content is the raw material for a selectable text layer.

**Testing is already differential.** `hayro-tests` runs 1,599 PDFs: 679 from pdf.js's own regression suite, 454 from PDFBOX, 127 from pdfium, 298 custom, 41 corpus. The demo builds wasm with SIMD and non-SIMD variants running in a Web Worker.

Risks, stated plainly:

- **Bus factor 1.** 1,740 of ~1,770 commits by Laurenz Stampfl. Apache/MIT so forkable, and we would be writing the equivalent ourselves otherwise, but it is a real exposure.
- **Declining activity.** 191 commits in 2025-11, 149 in 2026-01, 53 in 2026-06, 44 in 2026-07, 9 in 2026-08.
- **No password-protected document support.** `hayro-syntax` names this as its main gap.
- **Performance is explicitly unoptimised.** The README says it "has not been a focus at all so far."
- **Known rendering gaps:** knockout groups, non-embedded CID fonts.

## What a Rust engine would and would not fix

Would fix: the whole-document buffer, whole-file xref recovery, 64-bit offsets, the memory ceiling on large browser documents. Real wins, and #111-class cold-open problems.

Would not fix, and this is the larger half: `app/modules/pdf-viewer/engine/` has 65 subdirectories covering the raster scheduler, page buffer manager, render coordinator, render pipeline, render timeout, layer visual snapshot, rerender protocol, rerender strategy, resize anchor, skeleton, page slots, memory, portal and transactions. That machinery exists because of virtualized scrolling, zoom and Vue lifecycle. **Swapping the raster producer removes none of it.** A Rust engine inherits all of it unchanged.

Would not fix either: pdf.js's `TextLayer` (564 lines) and `AnnotationLayer` (4,449 lines) are DOM code a raster-only engine does not replace. Adopting hayro means building the selection layer ourselves from `draw_glyph_run` and marked content.

And nothing in a Rust parser touches the annotation editor, which is where six of the last six pdf.js-attributable fixes landed.

## Recommendations

Ranked by pain removed per unit of work. Ahead of all of them: **the Linux exact-xlarge lane is red on `main`** (issue #149 residual, 8.5 to 9.7 s against 1.9 s on macOS for pre-save placement under xvfb software rendering). Red main outranks research.

### 1. Own the annotation editor layer

Highest value. This is where the recurring bugs are and where we reverse-engineer pdf.js through DOM geometry.

We already own the annotation model (`annotationStore.ts` as sole authority per `architecture-audit-2026-07-23.md:246-247`), the comment UI, note windows, and the native writer. We use four of pdf.js's eight editor types.

Replacing `AnnotationEditorLayer`, `AnnotationEditorUIManager` and `DrawLayer` with our own Vue implementation over `AnnotationStore` deletes, outright:

- `useFreeTextResize.ts`, 649 lines including the NaN geometry recovery
- `findClosestHighlightDrawLayerSvg.ts`, the IoU identity matcher
- `annotationEditorCompatibility.ts`, three monkey-patches and an `unsupported` severity path
- `createAnnotationEditorLayerFailureTracker.ts`, retry and quarantine
- the 80 ms identity retry
- the blank AP stream contortion in `freetext-note-persistence.md`

It also closes #139 and #149 by construction rather than by another bound.

Estimated: one subsystem, several related files, substantial interaction testing. `hard` by our labelling rules.

### 2. Retire `pdf.js saveDocument`

`classifyPdfSaveRoute.ts` already routes around it for large scans. The remaining pdf.js save path carries a four-attempt retry, a timeout and a source-bytes fallback. We have a Rust incremental writer with checked `u64` offsets and qpdf validation. Finish the migration and delete the path, along with its compensations.

Estimated: `medium`.

### 3. Only then, spike hayro on rasterization

One bounded experiment, roughly a week:

- mmap the 882-page / 722,167,887-byte Zaliznyak fixture through `hayro-syntax`
- render first, middle and last pages
- diff against pdf.js on dimensions, rotation, text-heavy, vector-heavy and image-heavy pages
- record peak RSS, and wasm download / compile / first-paint separately

That single test answers fidelity, memory and performance together. If it passes we have an incremental path; if it fails we learned it in a week rather than a year.

Do not start here. It is the largest and riskiest piece and it is not what is hurting us.

### 4. Keep the parts of the prior report that hold

The EVB-owned engine interface, `u64` offsets, host-specific I/O adapters, capability reporting, pdf.js as differential oracle and fallback: all still correct. Adopt the interface work as part of items 1 and 2 rather than as a precondition for a rewrite.

## Open decisions

- **Is the browser path a real requirement for multi-gigabyte files?** If the big documents live on desktop, mmap solves the primary pdf.js limit outright and the wasm story gets much easier. This single answer changes the shape of item 3.
- **How much does rendering fidelity drift cost?** hayro will not be pixel-identical to pdf.js. If users compare against Acrobat rather than last week's build, a documented tolerance is acceptable.
- **Is a bus-factor-1 dependency acceptable?** Forkable under Apache/MIT, and the alternative is writing it ourselves, but the declining commit rate is a genuine signal.
- **Which editor types are product requirements?** Item 1 is sized by this. FreeText, Highlight, Ink and Stamp is a very different project from full parity.
- **Do we need password-protected documents?** hayro does not support them today. If required, pdf.js stays as a fallback regardless of item 3.

## Source register

### Local, this repository

- `patches/pdfjs-dist@5.7.284.patch`, `package.json:169,319`
- `app/services/pdfjs/runtimeLib.ts`, `annotationEditorCompatibility.ts:8,197`
- `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useFreeTextResize.ts:307,347,630`
- `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationHighlight.ts:161`
- `app/modules/pdf-viewer/engine/annotations/annotation-markup-subtype-draw-layer/findClosestHighlightDrawLayerSvg.ts:4,21`
- `app/modules/pdf-viewer/runtime/rendering/createAnnotationEditorLayerFailureTracker.ts`
- `app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts:376,405,495`
- `app/modules/pdf-viewer/runtime/save/classifyPdfSaveRoute.ts:384-385`
- `native/pdf-page-ops/src/` (`annotations.rs`, `incremental.rs`, `text_layer.rs`, `wasm.rs`)
- `docs/architecture/freetext-note-persistence.md`
- `docs/internal/architecture-audit-2026-07-23.md:246-247,310-312`
- `docs/internal/reliability-readiness-audit-2026-08-19.md`
- `docs/internal/research/rust-pdf-engine-rewrite-feasibility-2026-08-30.md`
- GitHub issues #82, #111, #112, #125, #134, #139, #141, #144, #147, #149

### pdf.js, `/Users/evb/npm-repos/pdf.js` at `399fce647`

- `src/core/chunked_stream.js:28-30`
- `src/core/xref.js:126,429`
- `src/display/editor/` (15,999 lines), `src/display/text_layer.js` (564), `src/display/annotation_layer.js` (4,449)

### hayro, `/Users/evb/oss-repos/hayro` at `5a5f0e24`

- `hayro-syntax/src/data.rs:15`, `hayro-syntax/src/pdf.rs:36`
- `hayro-interpret/src/device.rs:8`
- `hayro-tests/manifest_{pdfjs,pdfbox,pdfium,custom,corpus}.json`
- `hayro-demo/build.sh`, `README.md`

## Bottom line

The instinct was right and the proposed remedy was wrong. pdf.js is not where our bugs are logged, but it is why a large part of our architecture exists, and that architecture is where the bugs are logged. The two places it genuinely constrains us are the whole-document memory model, which we have already forked, and the annotation editor, which we have wrapped in five compensation layers and 649 lines of NaN recovery.

Replace the annotation editor. Retire the pdf.js save path. Then, with a week and a real fixture, find out whether hayro can render. A ground-up Rust engine may still be the right destination, but it is the wrong first move, and half of it is already built.
