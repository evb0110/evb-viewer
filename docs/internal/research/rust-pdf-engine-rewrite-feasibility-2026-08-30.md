# Rust PDF engine rewrite feasibility

> **Status (2026-08-30): superseded by [ADR 0002](../../architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md) and wayfinder map #150.**
> Read as history, not guidance. Known gaps found in review: it treats the
> problem as engine choice and proposes a PDFium spike first, which the ADR
> rejects; it does not account for the existing `native/pdf-page-ops` writer;
> its Stage 1 (Rust geometry beside pdf.js) would create the mixed-ownership
> state the ADR removes.

Research date: 2026-08-30  
Question: whether it is viable to rewrite the local PDF.js codebase in Rust and use the result in both Electron and the browser through WebAssembly.  
Repositories inspected: [`/Users/evb/npm-repos/pdf.js`](/Users/evb/npm-repos/pdf.js) and [`/Users/evb/WebstormProjects/evb-viewer`](/Users/evb/WebstormProjects/evb-viewer)  
PDF.js revision inspected: `399fce6471b90667ccd46d9e002a75f2a86af0f5`  
Report status: design research and recommendation. No implementation was made.

## Decision in one paragraph

Yes, a shared Rust PDF engine with a native Electron build and a WebAssembly browser build is technically viable. I would not attempt a line-by-line rewrite of PDF.js or promise a drop-in replacement for `pdfjs-dist`. The useful version of this project is a new Rust engine behind a small EVB-owned TypeScript interface. Keep the Vue viewer, page virtualization, DOM layers, editor interaction, and most save orchestration in JavaScript at first. Let Rust own the PDF work that benefits from a file-backed, 64-bit implementation: parsing, page geometry, rasterization, text extraction, selected annotation operations, and eventually incremental writing. Use a native Rust process or library in Electron and a dedicated worker with a range-aware host adapter in the browser. Keep PDF.js as an oracle and a fallback while each capability moves across the interface.

My confidence is high that the architecture is viable. My confidence is low that a full PDF.js feature replacement is a short project. PDF rendering is the approachable part. Exact behavior for malformed files, fonts, CMaps, annotations, editor serialization, forms, XFA, PDF JavaScript, printing, incremental saves, and the existing EVB contracts is where the schedule and compatibility risk live.

## Scope and method

This report combines:

- direct inspection of the local PDF.js checkout at the revision above;
- direct inspection of EVB Viewer’s current PDF.js adapters, range transports, native PDF code, tests, and prior research notes;
- primary documentation and source repositories for Rust WebAssembly, Electron native code, PDFium, MuPDF, `lopdf`, `hayro`, and `zpdf`;
- five substantive read-only Luna research passes covering PDF.js internals, candidate engines, browser and Electron constraints, and EVB integration. A sixth exploratory pass was closed after it produced no result.

The PDF.js checkout was clean when inspected. The EVB checkout was on `main`; at report creation it already had edits in `electron/utils/printHandoff.ts` and `tests/unit/electron/documentsPrint.test.ts`. Those files were not touched.

This note records conclusions and reasoning, not just links. Where a fact came from an earlier EVB run rather than a command rerun during this report, it is labeled as prior project context.

## Feasibility scorecard

| Goal | Assessment | Reason |
| --- | --- | --- |
| Run the same Rust core in Electron and a browser | High | Rust can compile to a native target and `wasm32`; the core must use explicit I/O and avoid host-only APIs. |
| Use native filesystem access in Electron | High | Electron supports Rust native modules, and a utility process can isolate a native worker. |
| Use browser `Blob` or HTTP range reads without loading the whole PDF | High | The host can expose asynchronous range reads to a Rust state machine. EVB already has this shape for PDF.js. |
| Preserve PDF.js rendering and UI behavior during migration | High | Keep the existing display and DOM layers while replacing one engine capability at a time. |
| Make Rust a drop-in `pdfjs-dist` replacement | Low | EVB uses public objects, worker messages, display layers, editor types, and some private behavior. |
| Reproduce all PDF.js behavior with a pure Rust implementation | Low to medium | Parsing and rasterization are possible; full compatibility across fonts, malformed input, forms, XFA, scripting, annotations, and save behavior is a large independent product. |
| Handle multi-gigabyte desktop PDFs without whole-file JavaScript allocation | High | A native file-backed source and checked 64-bit offsets fit the requirement. |
| Handle multi-gigabyte browser PDFs | Medium | It is possible with HTTP or `Blob` range access and bounded caches. It is not safe to model the document as one Wasm or JavaScript buffer. |
| Replace PDF.js completely in EVB | Low in the short term | The correct first milestone is a useful engine behind an adapter, not total replacement. |

## What the local PDF.js codebase actually contains

### Size and package shape

At the inspected revision, the local checkout contains 206 tracked files under `src/` and 132,442 lines in JavaScript source files under `src/`. The JavaScript tests contain another 38,443 lines. The package is Apache-2.0 licensed according to [`package.json`](/Users/evb/npm-repos/pdf.js/package.json:1).

PDF.js is not one parser that happens to draw pages. It is a set of cooperating layers:

| Area | Local source | Role |
| --- | --- | --- |
| Public display API | [`src/display/api.js`](/Users/evb/npm-repos/pdf.js/src/display/api.js:245) | `getDocument`, `PDFDocumentProxy`, `PDFPageProxy`, workers, loading, page requests, text, operator lists, and save calls. |
| Worker entry | [`src/pdf.worker.js`](/Users/evb/npm-repos/pdf.js/src/pdf.worker.js:16) | Exposes the worker-side implementation. |
| Worker implementation | [`src/core/worker.js`](/Users/evb/npm-repos/pdf.js/src/core/worker.js:69) | Owns document loading, page requests, metadata, text, rendering data, annotations, and saving. |
| PDF parser and object model | [`src/core/parser.js`](/Users/evb/npm-repos/pdf.js/src/core/parser.js:62), [`src/core/xref.js`](/Users/evb/npm-repos/pdf.js/src/core/xref.js:35), [`src/core/document.js`](/Users/evb/npm-repos/pdf.js/src/core/document.js:1008) | Tokenization, indirect objects, cross-reference lookup, page trees, recovery, and document state. |
| Page interpretation | [`src/core/evaluator.js`](/Users/evb/npm-repos/pdf.js/src/core/evaluator.js:230), [`src/core/operator_list.js`](/Users/evb/npm-repos/pdf.js/src/core/operator_list.js:650) | Converts page content into serializable drawing operations. |
| Fonts | [`src/core/fonts.js`](/Users/evb/npm-repos/pdf.js/src/core/fonts.js:1), [`src/core/cff_parser.js`](/Users/evb/npm-repos/pdf.js/src/core/cff_parser.js:1), [`src/core/type1_parser.js`](/Users/evb/npm-repos/pdf.js/src/core/type1_parser.js:1), [`src/core/glyf.js`](/Users/evb/npm-repos/pdf.js/src/core/glyf.js:1) | Font parsing, substitution, glyph data, metrics, and text layout support. |
| Images and color | [`src/core/image.js`](/Users/evb/npm-repos/pdf.js/src/core/image.js:79), [`src/core/jpg.js`](/Users/evb/npm-repos/pdf.js/src/core/jpg.js:806), [`src/core/jpx.js`](/Users/evb/npm-repos/pdf.js/src/core/jpx.js:27), [`src/core/jbig2.js`](/Users/evb/npm-repos/pdf.js/src/core/jbig2.js:1520), [`src/core/colorspace.js`](/Users/evb/npm-repos/pdf.js/src/core/colorspace.js:1) | Image masks, JPEG, JPEG 2000, JBIG2, CCITT, ICC, color spaces, transparency, and image caches. |
| Annotations and XFA | [`src/core/annotation.js`](/Users/evb/npm-repos/pdf.js/src/core/annotation.js:77), [`src/core/xfa`](/Users/evb/npm-repos/pdf.js/src/core/xfa:1) | Static annotations, links, widgets, editor-related data, and XFA support. |
| PDF writing | [`src/core/writer.js`](/Users/evb/npm-repos/pdf.js/src/core/writer.js:1) | Serialization used by PDF.js document saving. |
| Main-thread display | [`src/display`](/Users/evb/npm-repos/pdf.js/src/display:1) | Canvas execution, text layer, annotation layer, editor layer, fonts, transport, and public proxies. |
| Viewer | [`web`](/Users/evb/npm-repos/pdf.js/web:1) | The full reference viewer, controls, localization, navigation, printing, and user-facing integration. |

The first major design choice follows from this map. A Rust engine does not need to replace `web/` or most of `src/display/` to be useful. It does need to replace or sit behind enough of `src/core/` and the worker-facing contracts to provide a stable page engine.

### The worker protocol is a real compatibility contract

The worker entry is [`src/core/worker.js`](/Users/evb/npm-repos/pdf.js/src/core/worker.js:69). Its handlers include page access, metadata, outlines, destinations, attachments, permissions, optional content, annotations, structure trees, text, operator lists, raw data, document data, and `SaveDocument`. The current save handler is near [`worker.js:661`](/Users/evb/npm-repos/pdf.js/src/core/worker.js:661), and the operator-list handler is near [`worker.js:862`](/Users/evb/npm-repos/pdf.js/src/core/worker.js:862).

The message envelope is defined in [`src/shared/message_handler.js`](/Users/evb/npm-repos/pdf.js/src/shared/message_handler.js:76). It carries source and target names, an action, callback or stream identifiers, and data. Requests can be one-shot promises or streams. `sendWithStream` begins at [`message_handler.js:229`](/Users/evb/npm-repos/pdf.js/src/shared/message_handler.js:229), and the stream protocol includes start, pull, enqueue, close, error, cancel, and completion messages with backpressure.

The display side asks the worker for an operator list at [`src/display/api.js:1897`](/Users/evb/npm-repos/pdf.js/src/display/api.js:1897), then executes those operations in JavaScript canvas code. A Rust replacement can support this during a transition, but the operator-list format is an internal serialization contract. It is a poor permanent interface because it exposes PDF.js drawing choices, JavaScript object shapes, transfer behavior, image caches, fonts, and feature-specific details.

The public display API also exposes `getDocument` at [`src/display/api.js:245`](/Users/evb/npm-repos/pdf.js/src/display/api.js:245), `PDFPageProxy` near [`src/display/api.js:1308`](/Users/evb/npm-repos/pdf.js/src/display/api.js:1308), and `saveDocument` near [`src/display/api.js:2907`](/Users/evb/npm-repos/pdf.js/src/display/api.js:2907). A drop-in engine would need to preserve these shapes and their error, cancellation, cleanup, and worker behavior. An EVB-owned engine interface can choose simpler contracts.

The package entry point assembles the public exports in [`src/pdf.js`](/Users/evb/npm-repos/pdf.js/src/pdf.js:99). Those exports include document and worker APIs plus `AnnotationLayer`, `TextLayer`, `XfaLayer`, annotation editor classes, and related constants. The display implementation then splits work across [`src/display/canvas.js`](/Users/evb/npm-repos/pdf.js/src/display/canvas.js:1), [`src/display/font_loader.js`](/Users/evb/npm-repos/pdf.js/src/display/font_loader.js:27), the text and annotation layers, and editor code. A Rust engine can replace the document and page work while these JavaScript layers stay in place, but it cannot claim package compatibility until it supplies equivalent behavior for all of these exports.

The operator-list request also produces shared objects for fonts and images and sends separate transfer messages for page work. The Rust migration must either preserve those lifetime and transfer rules in a temporary adapter or replace them with a page-local raster contract. This is why an EVB-owned interface is safer than making PDF.js's current worker messages the long-term design.

### Range loading is part of the parser, not only a transport detail

PDF.js has a local and network PDF manager. [`src/core/pdf_manager.js`](/Users/evb/npm-repos/pdf.js/src/core/pdf_manager.js:1) retries parsing after `MissingDataException` and obtains more bytes through a chunked stream. The worker-side range readers are in [`src/core/worker_stream.js`](/Users/evb/npm-repos/pdf.js/src/core/worker_stream.js:22).

This matters for Rust. A browser build cannot pretend that `std::fs::File` exists. The parser needs a source abstraction that can say, in effect, "the next bytes at offset X are needed" and resume after the host supplies them. Native Electron can implement that source with seek and read. The browser can implement it over `Blob.slice`, IndexedDB-backed chunks, or HTTP `Range` requests. The parser and its cache policy should not know which one it received.

### The dependency list is larger than the Rust source count suggests

PDF.js includes or calls into several specialized implementations:

- Brotli decoding through [`src/core/brotli_stream.js`](/Users/evb/npm-repos/pdf.js/src/core/brotli_stream.js:1) and `external/brotli`.
- JPEG 2000 through [`src/core/jpx.js`](/Users/evb/npm-repos/pdf.js/src/core/jpx.js:18) and `external/openjpeg`, including a packaged `openjpeg.wasm`.
- JBIG2 through [`src/core/jbig2_ccittFax_wasm.js`](/Users/evb/npm-repos/pdf.js/src/core/jbig2_ccittFax_wasm.js:17) and `external/jbig2`.
- ICC color processing through [`src/core/icc_colorspace.js`](/Users/evb/npm-repos/pdf.js/src/core/icc_colorspace.js:26) and qcms.
- PDF JavaScript evaluation through [`src/pdf.sandbox.js`](/Users/evb/npm-repos/pdf.js/src/pdf.sandbox.js:16) and QuickJS.
- Adobe CMaps, standard fonts, ICC profiles, and other packaged resources.
- Browser and host facilities such as `ImageDecoder`, `DecompressionStream`, `OffscreenCanvas`, `FontFace`, and optional WebGPU paths.

A Rust rewrite has to choose whether to port, reuse, wrap, or defer each item. A C or C++ dependency that works in native Electron may require a different build or a separate Wasm binary in the browser. This is one reason a single Rust crate with explicit feature flags is safer than assuming the native and browser builds will have identical internals.

## What EVB Viewer depends on today

### PDF.js is already partly isolated, but the remaining seam is deep

EVB pins `pdfjs-dist` 5.7.284 in [`package.json`](/Users/evb/WebstormProjects/evb-viewer/package.json:169), keeps a preview alias, and applies a 1,358-line patch at [`patches/pdfjs-dist@5.7.284.patch`](/Users/evb/WebstormProjects/evb-viewer/patches/pdfjs-dist@5.7.284.patch:1). That patch is evidence that upstream PDF.js internals already need EVB-specific behavior. A fork that promises exact package compatibility would inherit this maintenance cost instead of removing it.

The most useful existing EVB seams are:

| EVB area | Local source | What it already centralizes |
| --- | --- | --- |
| Runtime loading and probes | [`app/services/pdfjs/runtimeLib.ts`](/Users/evb/WebstormProjects/evb-viewer/app/services/pdfjs/runtimeLib.ts:1) | Runtime imports, required exports, worker setup, standard fonts, CMaps, Wasm resources, ICC resources, and compatibility checks. |
| PDF.js facade | [`app/services/pdfjs/pdfViewerFacade.ts`](/Users/evb/WebstormProjects/evb-viewer/app/services/pdfjs/pdfViewerFacade.ts:1) | Annotation layer, draw layer, editor layer, text layer, UI manager, and PDF.js-specific types. |
| Document source | [`app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts`](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts:314) | Path-backed and browser-backed loading, range transport, page lifetime, stale-load handling, cache behavior, and cleanup. |
| Browser document initialization | [`app/platform/browser-api/browserPdfjsDocumentInit.ts`](/Users/evb/WebstormProjects/evb-viewer/app/platform/browser-api/browserPdfjsDocumentInit.ts:1) | Browser range reads, bounded chunks, `PDFDataRangeTransport`, disabled auto-fetch, and disabled full streaming for large documents. |
| Canvas renderer | [`usePdfCanvasRenderer.ts`](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer.ts:244) | Page viewport and canvas rendering. |
| Text renderer | [`usePdfTextLayerRenderer.ts`](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer.ts:340) | Text layer creation, refresh, selection, and cleanup. |
| Annotation renderer and editor bridge | [`usePdfAnnotationLayerRenderer.ts`](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer.ts:426), [`app/modules/pdf-viewer/annotations`](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/annotations:1) | Static annotations, editor interaction, selection, comments, identity, and synchronization. |
| Session | [`pdfDocumentSession.ts`](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession.ts:514) | The current `PDFDocumentProxy` and `PDFPageProxy` lifetime and operation coordination. |

The central migration risk is the session and page contract. A large number of files import `PDFDocumentProxy`, `PDFPageProxy`, `AnnotationEditorUIManager`, or related PDF.js types. That does not mean each file must be rewritten at once. It means the first Rust work should introduce EVB types at the document-source and session seams, then adapt the old PDF.js implementation to those types.

### EVB already has the right large-file pressure

The browser path uses bounded chunks and range requests in [`browserPdfjsDocumentInit.ts`](/Users/evb/WebstormProjects/evb-viewer/app/platform/browser-api/browserPdfjsDocumentInit.ts:55). It sets `rangeChunkSize`, `disableAutoFetch: true`, and `disableStream: true` near [`browserPdfjsDocumentInit.ts:103`](/Users/evb/WebstormProjects/evb-viewer/app/platform/browser-api/browserPdfjsDocumentInit.ts:103). The viewer document source uses a 1 MiB range chunk near [`pdfDocumentSource.ts:302`](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts:302).

The unit test [`pdfjsRangeTransportBounded.test.ts`](/Users/evb/WebstormProjects/evb-viewer/tests/unit/electron/pdfjsRangeTransportBounded.test.ts:1) includes a 17 MiB source and a sparse 2 GiB source. It asserts that large `getData()` and `saveDocument()` requests fail with the typed `native-save-required` result rather than causing a whole-document read. This is a very useful constraint for the Rust design. The new engine must preserve it, not quietly reintroduce a `Vec<u8>` for every open document.

Prior EVB research notes record the larger acceptance target: an 882-page Zaliznyak PDF around 689 MB and a three-copy, 2,646-page file around 2.17 GB. They also record multi-gigabyte append tests around the 4 GiB and 10,000,000,000-byte offset boundaries, checked `u64` positions, qpdf validation, save/restart/reopen flows, and the need to test the real Electron path rather than only synthetic unit inputs. See [`multi-gib-native-incremental-save-2026-08-26.md`](/Users/evb/WebstormProjects/evb-viewer/docs/internal/research/multi-gib-native-incremental-save-2026-08-26.md) and [`xlarge-document-path-architecture-2026-08-27.md`](/Users/evb/WebstormProjects/evb-viewer/docs/internal/research/xlarge-document-path-architecture-2026-08-27.md).

That prior work changes the recommendation. The Rust engine should be designed around file-backed and range-backed access on day one. It should not begin with a convenient whole-file `Vec<u8>` and plan to remove it later.

### Prior large-PDF evidence that should shape this project

The two EVB research records above contain a useful design that is relevant even if the final engine is Rust rather than qpdf plus Rust:

- qpdf opens a file through a seekable input source and loads objects as needed. Its JSON v2 output can omit stream data with `--json-stream-data=none`, retain the structural dictionaries, and report `maxobjectid`. This bounds memory by structural content instead of by every encoded image and content stream.
- A qpdf JSON sidecar is not free. It still retains decoded object structure, so EVB needs per-object, aggregate, sidecar, timeout, diagnostic, and child-process memory limits. The prior xlarge run recorded a 7,890,472-byte structural sidecar, 0.52-second qpdf time, and about 53 MB RSS for the 2,168,527,413-byte, 2,646-page fixture.
- qpdf is not the append writer. Its normal writer rewrites a new file, so the existing EVB design keeps a small append-specific writer that emits only changed and new objects, a new xref stream, `/Prev`, `startxref`, and `%%EOF`.
- All append positions must remain checked `u64`. Classic xref tables stop representing offsets at 10,000,000,000 bytes, so the append writer must switch to an xref stream with `/W [1 8 2]` before that boundary. The writer must preserve the exact source prefix, recheck source identity and length, flush and validate, and truncate back to the previous length on failure.
- Omitted base streams need a distinct type. Treating an omitted stream as an empty `Vec<u8>` could silently replace real source data with an empty stream during a later mutation.

The prior records also contain measured acceptance evidence. This is project history, not a rerun of those tests during this report:

| Fixture or check | Recorded result | Why it matters here |
| --- | --- | --- |
| 882-page dictionary, 722,167,887 bytes | Final release-build save took 1.20 seconds, appended 635 bytes, used 27,115,520 bytes peak Rust RSS, and preserved a byte-identical source prefix. | A native Rust append path can be fast and memory-bounded when it does not replay the source. |
| 2,168,527,413-byte, 2,646-page fixture | Two isolated Electron acceptance lanes recorded successful save and reopen behavior. The full lane took 102.375 seconds, with native save at 29.755 seconds. | The complete Electron path matters more than a synthetic parser benchmark. |
| Sparse logical offsets | Public-binary tests covered 5.27 GiB, 10.55 GiB, and the 10-billion-byte classic-to-stream transition, with qpdf checks passing. | The writer must test numeric offset behavior independently of physical file size. |

For this Rust project, the lesson is not "make Rust call qpdf everywhere." The lesson is to keep the parser, cache, writer, and host I/O contracts explicit. A native qpdf sidecar remains a sensible fallback for structural mutation work. A Rust parser may replace it if the Rust engine passes the same corpus and resource tests.

## Runtime constraints

### Browser WebAssembly

Rust's official `wasm32-unknown-unknown` documentation describes a target with minimal assumptions about the host. `std::fs` calls always error, and `std::thread::spawn` panics on this target. The target also has no general C/C++ toolchain; C or C++ dependencies need a different build route such as Emscripten or a separately produced Wasm library. See the [Rust `wasm32-unknown-unknown` target documentation](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html).

The core should therefore use:

- `u64` for PDF file offsets and lengths, with checked conversions at every Wasm or JavaScript boundary;
- bounded byte windows, structural caches, and eviction rather than one `ArrayBuffer` for the source;
- explicit source callbacks or a resumable `NeedRange` result for reads;
- cancellation and backpressure in every potentially long operation;
- `wasm-bindgen` or a small generated binding layer only at the host edge;
- optional SIMD with a scalar fallback;
- a single-threaded worker baseline.

Wasm linear memory is contiguous and uses 32-bit pointers in the ordinary browser target. Growing memory can fail, and JavaScript views into memory can become invalid after growth. A design that allocates a page-sized RGBA buffer, a decoded image, a font, and the source window at the same time must account for those peaks. A parser that stores every decoded stream is a poor browser design even if the encoded PDF itself is small.

Wasm threads are possible, but they are not a free translation of native Rust parallelism. The `wasm-bindgen` threaded ray-tracing guide describes the required atomics, build flags, worker shims, and `COOP` and `COEP` headers. It also notes that the browser main thread cannot block and that ordinary `std::thread` and Rayon assumptions do not carry over cleanly. See the [wasm-bindgen threaded example](https://rustwasm.github.io/docs/wasm-bindgen/examples/raytrace.html).

Use a dedicated browser worker for the engine. Start with one engine instance per worker and bounded in-flight requests. Add shared memory or a worker pool only after measurements show that rasterization or decoding needs it and the host can provide the required headers.

`WebAssembly.instantiateStreaming` also depends on the server returning the Wasm file with `application/wasm`. The loader needs an ArrayBuffer fallback for development servers, older deployments, and hosts that do not provide the right MIME type. Measure compressed download, compilation, instantiation, and first-page rendering separately. A large binary can feel slow before parsing begins.

### Electron

Electron’s native-code documentation explicitly supports native Node addons written in Rust and identifies performance-sensitive or OS-integrated work as a use case. See the [Electron native-code documentation](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron).

For EVB, I prefer a Rust executable or native library hosted in an Electron utility process over loading a native addon into renderer workers. Electron’s multithreading documentation warns that native modules in Workers can crash or corrupt memory because many modules assume a single thread. It also notes that `process.dlopen` is not thread-safe. See the [Electron multithreading documentation](https://www.electronjs.org/docs/latest/tutorial/multithreading).

The Electron shape should be:

```text
Vue renderer
  -> typed IPC or MessagePort
  -> Electron main process, small routing only
  -> utility process
  -> Rust engine, native file source and bounded worker state
```

The utility process gives the engine a restartable owner for native memory, file descriptors, and long-running parses. Requests need IDs, cancellation, deadlines, and a document revision or session token. The renderer should never own a Rust pointer or assume that a utility process cannot restart.

### One core, two host adapters

The native and browser builds should share the PDF algorithms and data model, but they should not share the I/O implementation.

```text
Shared Rust crates
  parser, xref, filters, fonts, page model, renderer, text, annotations, writer

Native adapter                         Browser adapter
seek/read/write/flush                  NeedRange/read-window callbacks
filesystem paths                       Blob or HTTP Range source
native process                         dedicated Web Worker
native output file                     bounded Uint8Array or streamed sink
```

The right invariant is shared semantics, not identical transport. If the shared code calls `std::fs` or blocks while waiting for a browser range, the split is already wrong.

## Candidate engines and libraries

There are two different choices here. EVB can adopt an existing PDF engine and wrap it in Rust, or it can build a more native Rust stack. The first choice buys compatibility sooner. The second gives better control over Wasm, memory, and licensing, but requires much more PDF work.

| Candidate | Strengths | Problems for EVB | Recommendation |
| --- | --- | --- | --- |
| PDFium through [`pdfium-render`](https://github.com/ajrcarey/pdfium-render) | Broad rendering, text, images, forms, annotations, links, attachments, document creation, and a mature Chromium-derived engine. The wrapper has native and browser examples. | PDFium is a separate C++ build. The wrapper does not contain PDFium. Browser use needs a separate PDFium Wasm module. Some prebuilt Wasm builds have non-growable heaps. PDFium has no general thread-safety guarantee. | Best permissive candidate for a serious rendering spike. Budget native and Wasm packaging work. |
| MuPDF through [`mupdf-rs`](https://github.com/messense/mupdf-rs) or the official [`mupdf.js`](https://github.com/ArtifexSoftware/mupdf.js/) | Strong rendering and document editing. The official JavaScript binding already runs the MuPDF C engine in WebAssembly and documents annotations, editing, redaction, merging, splitting, and saving. | MuPDF uses AGPL or a commercial license. A Rust wrapper does not remove that choice. The official browser example loads an entire response buffer, so range behavior must be tested rather than assumed. | Run a benchmark and feature spike if the license is acceptable. Do not adopt it for EVB without an explicit licensing decision. |
| [`lopdf`](https://github.com/J-F-Liu/lopdf) | Pure Rust, permissive licensing, object parsing, annotations, serialization, and incremental update support. Useful for structural PDF work. | Its high-level model retains the document in memory until serialization. It does not provide a full renderer. Raising an input-size limit would not create a file-backed parser. | Use as a writer or object-model reference for small and controlled operations. Do not make it the large-document renderer. |
| [`hayro`](https://github.com/LaurenzV/hayro) | Pure Rust and browser-oriented, with a promising rendering direction. | The project describes itself as experimental and does not claim the full selection, search, annotation, and form behavior EVB needs. | Good prototype candidate for a narrow Rust/Wasm rendering spike. |
| [`zpdf`](https://github.com/Xero-Team/zpdf) | Ambitious pure Rust parser, renderer, Wasm, forms, annotations, and writer goals. | Young project. README claims need independent testing against EVB’s malformed, large, annotation, font, and save corpus. | Inspect and benchmark. Do not make it the production choice before fixture evidence. |
| [`pdf-extract`](https://github.com/jrmuizel/pdf-extract) | Extraction utility. | It is not a renderer, form engine, annotation editor, or save engine. | Exclude as the primary engine. |

PDFium is BSD-style licensed according to its [upstream license](https://pdfium.googlesource.com/pdfium.git/+/f066bf72748ec2782a76b7bba58b2a4d064354ff/LICENSE). That makes it the first candidate to test if EVB needs a permissive license and high rendering fidelity. `pdfium-render` still adds the engineering cost of building and packaging PDFium for every native platform and for the browser.

MuPDF is technically attractive because the official `mupdf.js` project already proves a browser Wasm binding around the full engine. Its licensing is the blocking product decision. The [MuPDF `COPYING` file](https://github.com/ArtifexSoftware/mupdf/blob/master/COPYING) contains the AGPL terms, and Artifex offers commercial licensing. A prototype can answer performance questions, but it cannot silently settle EVB’s distribution terms.

`lopdf` is useful but easy to misapply. Its own documentation says the high-level document is kept in memory until serialization. That is fine for a bounded mutation document and wrong for a multi-gigabyte source with large image streams. It can inform a narrow append writer without dictating the memory model of the whole engine.

## Recommended architecture

### Keep the viewer and replace the engine behind an EVB interface

The first stable shape should look like this:

```text
Existing Vue viewer and composables
  -> EVB PdfEngine interface
     -> PDF.js adapter, current production path
     -> Rust native adapter, Electron path
     -> Rust Wasm adapter, browser worker path
     -> optional compatibility fallback for unsupported files/features
```

Do not make the Rust adapter return `PDFDocumentProxy` or `PDFPageProxy`. Those types belong to the PDF.js adapter. Do not expose `fnArray` and `argsArray` as the permanent EVB interface. During the transition, a PDF.js-compatible adapter may translate between the two formats where that is the cheapest path.

### Suggested interface

This is deliberately narrower than PDF.js. The exact TypeScript names should follow EVB’s existing type-prefix convention, but the responsibilities should be separate.

```ts
interface IPdfEngine {
  open(source: IPdfSource, options: TPdfOpenOptions): Promise<IPdfDocument>;
}

interface IPdfDocument {
  readonly id: string;
  readonly revision: string;
  readonly pageCount: number;

  getMetadata(signal?: AbortSignal): Promise<TPdfMetadata>;
  getPageInfo(pageIndex: number, signal?: AbortSignal): Promise<TPdfPageInfo>;
  renderPage(request: TPdfRenderRequest, signal?: AbortSignal): Promise<TPdfRaster>;
  getTextContent(pageIndex: number, signal?: AbortSignal): Promise<TPdfTextContent>;
  getAnnotations(pageIndex: number, signal?: AbortSignal): Promise<readonly TPdfAnnotation[]>;
  applyMutation(mutation: TPdfMutation, signal?: AbortSignal): Promise<TPdfMutationResult>;
  save(options: TPdfSaveOptions, signal?: AbortSignal): Promise<TPdfSaveResult>;
  close(): Promise<void>;
}

interface IPdfSource {
  readonly length: bigint;
  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}
```

The Rust side can use an equivalent trait, but the host-facing contract should make these rules explicit:

- PDF file offsets are `u64` or JavaScript `bigint`, never a JavaScript `number` once they can exceed exact integer precision.
- A read has a bounded requested length. The source may return fewer bytes only when the contract says it is a short final range.
- Every page operation carries a document revision or session token so stale results cannot update a replaced document.
- Every expensive operation can be cancelled. Cancellation must stop queued work and release page-local buffers.
- Rendering returns a bounded raster or a host-owned transferable buffer. The core does not retain a canvas or DOM object.
- Text returns page-local batches with stable string offsets and geometry. It does not return a document-wide string by default.
- `save` has a native file-backed result and a browser output result. The native result should be a committed path or revision, while the browser result may be a bounded output stream or a `Blob` only when the caller explicitly accepts materialization.
- Errors distinguish malformed input, unsupported feature, password required, cancellation, stale session, range failure, resource limit, and output failure. A generic `UnknownErrorException` loses too much information for migration and diagnostics.

### Source implementations

For native Electron:

```text
NativeFileSource
  read(offset: u64, length: u32) -> bytes
  stat() -> stable identity, length, modification data
  append(bytes) -> count
  flush() -> result
```

Use ordinary seek and read first. `mmap` is not required and adds file-stability concerns when another process can write the staged file. The EVB large-PDF research already favors a file-backed parser or qpdf sidecar over eager `lopdf` parsing.

For the browser:

```text
BrowserRangeSource
  Rust asks for offset and length
  JS worker checks its chunk cache
  JS reads Blob.slice or HTTP Range
  JS returns a transferable Uint8Array
```

A resumable Rust state machine is preferable to a Rust function that tries to block on a future. One practical design is an internal `NeedRange { offset: u64, length: u32 }` result. The worker stores the parser state, the host fetches the range, and the worker resumes with the bytes. This also gives the host a natural place to coalesce requests, enforce a chunk budget, and cancel stale page work.

### Rendering choices

There are three reasonable migration choices.

1. Rust returns an EVB-owned operator stream and JavaScript executes it. This minimizes initial canvas changes but keeps a large compatibility contract and duplicates PDF.js’s display assumptions.
2. Rust renders page tiles or a complete page into RGBA or a browser image buffer. This has a cleaner interface and is a better target for the native path, but it requires pixel-level comparison and a new text-layer path.
3. Use an existing PDFium or MuPDF renderer and expose the same raster contract. This gets fidelity sooner while leaving the engine licensing or C++ packaging decision in view.

I recommend option 2 for the long-term EVB interface and option 1 only as a transition if it materially reduces the first migration. The public contract should be page geometry, page raster, text, annotations, and save. It should not be PDF.js’s internal command arrays.

### Keep DOM layers and editors in JavaScript first

Keep these in JavaScript until the engine has proved the basic path:

- Vue components and page virtualization;
- scroll, zoom, rotation, and viewport ownership;
- canvas placement and device-pixel-ratio policy;
- text selection and DOM text layer behavior;
- annotation DOM and editor interaction;
- comments, undo, redo, identity, and annotation storage;
- print layout and document export orchestration;
- Electron staged-file transactions and promotion;
- browser document repository and chunk storage;
- PDF.js fallback for unsupported documents.

Move these capabilities first:

- file-backed document open and metadata;
- page count, page boxes, rotation, and page labels;
- page-local rasterization;
- page-local text extraction;
- static annotation records;
- bounded structural inspection;
- native incremental writing after the read and identity contracts are stable.

XFA, PDF JavaScript, rich widgets, editor serialization, and exact PDF.js annotation behavior should be explicit later milestones. They are not good prerequisites for proving that a shared Rust parser and renderer can work.

## Staged migration plan

### Stage 0: freeze the interface and build an oracle adapter

Add an EVB-owned document, page, source, raster, text, annotation, and save interface. Implement it by wrapping the current PDF.js session. Do not change behavior yet.

The adapter should own conversion of PDF.js exceptions, cleanup, cancellation, and stale-load handling. New viewer code should import EVB types rather than PDF.js types. Existing PDF.js code can remain behind the adapter.

Exit criteria:

- current unit and Electron paths remain green;
- no new viewer module needs a `PDFDocumentProxy` or `PDFPageProxy` type;
- one interface call can be traced from the viewer to PDF.js and back;
- the existing large-document range test still proves that large `getData()` and `saveDocument()` do not materialize the source.

### Stage 1: Rust metadata and page geometry

Implement `open`, metadata, page count, page boxes, rotation, page labels, and page acquisition in a Rust Wasm worker and a native adapter. Keep PDF.js for rasterization, text, annotations, and saving.

Test mixed page sizes, rotations, blank pages, sparse pages, malformed but accepted files, encrypted files, and the real Zaliznyak fixture. Compare first, middle, and final pages, not only page zero.

Exit criteria:

- geometry is identical or the difference is documented and handled by the viewer;
- range requests stay bounded;
- no whole-document JavaScript value appears in the path-backed flow;
- stale document replacement and cancellation work under rapid navigation.

### Stage 2: Rust structural reads and text

Add page-local object lookup, text extraction, outlines, destinations, attachments, permissions, optional content, and page-local text batches. Keep the JavaScript text layer so the UI behavior does not move at the same time as parsing.

Text comparison must cover Unicode normalization, UTF-16 offsets used by selection, whitespace, bidi order, marked content, word boxes, ligatures, vertical writing, and fonts that need fallback.

The structural parser should be file-backed or range-backed. Do not use eager `lopdf` for large files. A qpdf-backed structural sidecar is a possible native-only bridge for large saves, but qpdf should not become a browser dependency unless a Wasm build is separately justified.

### Stage 3: Rust rasterization

Choose an engine after benchmarking PDFium, MuPDF if licensed, and at least one pure Rust candidate against EVB’s fixture classes. Implement page raster output with cancellation and bounded buffers.

The comparison set must include:

- page dimensions, rotation, crop boxes, and device-pixel-ratio behavior;
- text-heavy pages;
- vector-heavy pages;
- image-heavy pages with JPEG, JPEG 2000, JBIG2, masks, and ICC color;
- transparency, patterns, clipping, Type 3 fonts, and malformed-but-recoverable input;
- blank and sparse pages;
- a large page that tests raster memory limits;
- first, changed middle, and final pages in the large fixtures.

Keep PDF.js as the pixel and behavior oracle. A mismatch must identify whether the cause is parsing, font metrics, color, image decoding, blend mode, clipping, or viewer placement.

### Stage 4: annotations and native save

Start with static annotation records and render them in the existing annotation layer. Add links, highlights, FreeText, ink, stamps, and comments only when the Rust document model can preserve identity and round-trip semantics.

For desktop save, use the existing staged-file transaction and add a Rust append writer with checked `u64` offsets. Recheck file identity and length immediately before append. Flush, validate the append tail, validate changed objects, and roll back to the previous exact length on failure.

The prior EVB work found that synthetic large-file tests can pass while a restarted exact fixture still fails. Acceptance must run the real user flow: load, interact, save, hard restart, reopen, inspect, save again, and validate the result with qpdf and the viewer.

### Stage 5: remove PDF.js capabilities one at a time

Only after the previous stages pass should EVB remove PDF.js rendering, text, annotations, and selected save paths individually. PDF.js should remain as a compatibility fallback for unsupported features for a long time. Editors and XFA may remain on PDF.js if moving them would cost more than the product gains.

## Test and acceptance strategy

### Unit contracts

Test the Rust core without a browser or Electron:

- classic xref tables, xref streams, hybrid references, object streams, incremental `/Prev` chains, dangling references, sparse object IDs, and nonzero generations;
- `u64` offsets at `2^32 - 1`, `2^32`, 4 GiB, 10,000,000,000 bytes, and near the practical signed 64-bit limit;
- indirect stream lengths, binary names and strings, filters, masks, colors, font encodings, and malformed objects;
- page trees with unusual ordering, cyclic references, excessive nesting, and resource limits;
- cancellation, stale revision, range failure, password request, unsupported feature, and output failure errors;
- bounded cache eviction and allocation failure;
- deterministic serialization and exact append rollback.

### Differential tests against PDF.js

Run the same source through PDF.js and the Rust adapter. Compare:

- page count and geometry;
- metadata, outlines, destinations, page labels, permissions, and attachments;
- text strings, offsets, styles, marked content, and geometry;
- annotation type, rectangle, color, opacity, contents, identity, and appearance;
- raster dimensions and pixel metrics with a documented tolerance;
- save, reopen, and second-save semantics.

For every mismatch, retain the source PDF, the request, both serialized results, and a small diagnostic image or text diff. Do not hide unsupported features behind a silent fallback. Return a capability result that the viewer can display and the tests can assert.

### Browser integration

Run the Rust Wasm engine in the same worker and range-storage arrangements used by EVB. Test HTTP range responses, `Blob.slice`, missing range support, short reads, cancellation during a range fetch, repeated page navigation, backpressure, memory pressure, and worker termination.

Track these timings separately:

- Wasm download and decompression;
- compile and instantiate;
- PDF header and trailer discovery;
- first-page geometry;
- first-page raster;
- text result;
- later-page raster;
- worker memory peak and retained range bytes.

### Electron integration

Run the native engine in a utility process. Test process restart, renderer reload, utility-process termination, file replacement while open, stale file identity, disk-full behavior, save cancellation, crash at each save phase, and Unicode and long paths on Windows.

The native path must be measured on the low-end Windows acceptance machine and on Linux as a separate check. A fast macOS run is not evidence that the utility process, filesystem semantics, or native package works everywhere.

### Large fixtures

Use the existing EVB fixture classes:

- ordinary small PDFs for feature coverage;
- the 882-page, roughly 689 MB Zaliznyak PDF;
- the 2,646-page, roughly 2.17 GB multi-copy fixture;
- sparse valid PDFs with logical offsets around 4 GiB and 10,000,000,000 bytes;
- PDFs with large image streams, unusual xref layouts, incremental revisions, and annotation edits.

The go/no-go test is the complete user path, not a green parser unit test:

```text
open -> first paint -> navigate -> search/select -> edit -> save
     -> hard restart -> reopen -> inspect -> save again -> qpdf check
```

## Key reasoning and trade-offs

### Why a literal PDF.js rewrite is the wrong target

PDF.js’s 132,442 source lines are only part of the work. Its behavior also depends on its worker protocol, display-layer object shapes, browser APIs, external decoders, resource files, exception behavior, test corpus, viewer, and years of compatibility fixes. A literal rewrite would spend a large amount of time preserving JavaScript-specific contracts that EVB does not need to keep.

The 1,358-line EVB patch makes the drop-in approach less attractive. A Rust implementation that reproduces the patched `pdfjs-dist` package would need to preserve both upstream and local quirks before it could deliver a product improvement.

### Why a new engine behind a TypeScript interface is viable

EVB already has a document-source seam, a PDF.js runtime facade, a browser range transport, native page operations, and large-file tests. Those seams give the migration a place to start. The viewer can keep using DOM and editor code while the engine behind the page source changes.

The interface also gives native and browser builds the same semantics without forcing the same host code. Native code can seek and append. Browser code can ask JavaScript for ranges and return bounded output. The parser, page model, and renderer can still share tests and most logic.

### Why Rust is useful specifically for EVB

Rust is a good fit for the parts of this project that have caused large-file pressure: checked file offsets, bounded allocations, file-backed access, process isolation, and explicit error handling. It is not automatically better at PDF compatibility. PDF compatibility comes from the engine and the test corpus, not from the language choice.

The biggest benefit would be a clear memory model. The core can refuse an oversized decoded stream, evict page-local data, and append a bounded revision without ever constructing a JavaScript value proportional to the whole document. That is more valuable for EVB than a language rewrite by itself.

### Why PDFium and MuPDF deserve an early spike

A pure Rust renderer gives maximum control over Wasm and licensing, but it puts font, image, color, graphics, malformed-input, and annotation compatibility on EVB. PDFium or MuPDF can answer the fidelity question much earlier. The cost is native and browser packaging, ABI work, thread-safety rules, and licensing.

The first benchmark should therefore compare an existing mature engine with a pure Rust candidate. Do not choose from README claims. Render the actual EVB fixtures, inspect annotations and text, perform a save, and measure browser startup and memory.

### Why the output contract must differ by host

A desktop save can append to a staged path and return a committed revision. A browser save may need to produce a new `Blob`, stream bytes to an application-managed store, or ask the server to persist a revision. Pretending both are one `Uint8Array` API will recreate the whole-file memory problem in the browser.

Likewise, native incremental append and browser output generation are different transactions. Share the PDF writer and validation rules where possible, but keep promotion, durability, and failure recovery in the host adapter.

## Suggestions

1. Start with a one-week or two-week engine spike, not a rewrite branch. The spike should open the exact Zaliznyak fixture through a range-aware source, report page geometry, render selected pages, extract text, and run in both a browser worker and an Electron utility process.
2. Benchmark PDFium first for permissive licensing. Benchmark MuPDF in parallel only if EVB can obtain a commercial or AGPL decision. Include one pure Rust candidate so the Wasm and binary-size trade-off is visible.
3. Create the EVB `PdfEngine` interface before adding Rust code. Make the current PDF.js implementation the first adapter. This turns the migration into replaceable capabilities rather than a second viewer.
4. Treat `u64` offsets and bounded reads as non-negotiable. Never make a whole-file `Uint8Array` the required input or output for an xlarge document.
5. Keep PDF.js as a differential oracle and fallback. Remove it only after the replacement proves the real Electron and browser flows on exact fixtures.
6. Keep editors, XFA, and PDF JavaScript out of the first milestone. Add explicit capability reporting instead of promising parity that the first Rust engine cannot provide.
7. Put the native engine in an Electron utility process. Keep renderer IPC small and recoverable. Avoid loading native modules inside Electron workers.
8. Use qpdf or another contained structural helper only where it solves a measured problem. Do not make a native sidecar the browser architecture.
9. Publish a compatibility matrix as part of the engine. It should state which page, text, annotation, form, scripting, and save features use Rust, PDF.js, or an unsupported result.
10. Make the go/no-go decision after the exact fixture spike. If mature-engine packaging or licensing dominates the cost, a Rust structural and save engine with PDF.js rasterization may still be a good product result. If pixel fidelity and browser delivery dominate, an existing engine may be the better core even if Rust owns the adapters.

## Open decisions

These choices materially affect the design and should be decided before a production implementation begins:

- Is AGPL or commercial MuPDF licensing acceptable for every EVB distribution channel?
- Is a PDFium C++ build and separate PDFium Wasm binary acceptable in the package size and release process?
- Does the browser need local offline multi-gigabyte PDFs, or are HTTP range sources and bounded browser storage enough?
- Must browser save return a single downloadable file, or can EVB stream or upload the result?
- Which PDF.js editor types are product requirements, and which can remain on the compatibility path?
- Is exact PDF.js pixel output required, or is a documented rendering tolerance acceptable?
- Does the first native engine need incremental append for all mutations, or only the current EVB page-operation set?
- Can the first Rust engine run in a separate process on every Electron platform, including packaging and code signing?
- Which browser headers and deployment environments can guarantee Wasm threads later, if measurement justifies them?

## Source register

### Local code and project notes

- [PDF.js local checkout](/Users/evb/npm-repos/pdf.js) at commit `399fce6471b90667ccd46d9e002a75f2a86af0f5`.
- [PDF.js package metadata](/Users/evb/npm-repos/pdf.js/package.json).
- [PDF.js worker implementation](/Users/evb/npm-repos/pdf.js/src/core/worker.js).
- [PDF.js worker stream source](/Users/evb/npm-repos/pdf.js/src/core/worker_stream.js).
- [PDF.js message handler](/Users/evb/npm-repos/pdf.js/src/shared/message_handler.js).
- [PDF.js public display API](/Users/evb/npm-repos/pdf.js/src/display/api.js).
- [EVB PDF.js runtime facade](/Users/evb/WebstormProjects/evb-viewer/app/services/pdfjs/runtimeLib.ts).
- [EVB PDF.js viewer facade](/Users/evb/WebstormProjects/evb-viewer/app/services/pdfjs/pdfViewerFacade.ts).
- [EVB document source](/Users/evb/WebstormProjects/evb-viewer/app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts).
- [EVB browser range initialization](/Users/evb/WebstormProjects/evb-viewer/app/platform/browser-api/browserPdfjsDocumentInit.ts).
- [EVB bounded range test](/Users/evb/WebstormProjects/evb-viewer/tests/unit/electron/pdfjsRangeTransportBounded.test.ts).
- [EVB multi-gigabyte save research](/Users/evb/WebstormProjects/evb-viewer/docs/internal/research/multi-gib-native-incremental-save-2026-08-26.md).
- [EVB xlarge document path research](/Users/evb/WebstormProjects/evb-viewer/docs/internal/research/xlarge-document-path-architecture-2026-08-27.md).

### Primary external sources

- [Rust `wasm32-unknown-unknown` target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html).
- [wasm-bindgen threaded Wasm example](https://rustwasm.github.io/docs/wasm-bindgen/examples/raytrace.html).
- [Electron native code and Rust addons](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron).
- [Electron multithreading and native modules](https://www.electronjs.org/docs/latest/tutorial/multithreading).
- [Electron utility process](https://www.electronjs.org/docs/latest/api/utility-process).
- [PDFium Rust wrapper](https://github.com/ajrcarey/pdfium-render/blob/master/README.md).
- [PDFium upstream license](https://pdfium.googlesource.com/pdfium.git/+/f066bf72748ec2782a76b7bba58b2a4d064354ff/LICENSE).
- [PDFium prebuilt binaries](https://github.com/bblanchon/pdfium-binaries).
- [Official MuPDF JavaScript and Wasm binding](https://github.com/ArtifexSoftware/mupdf.js/).
- [MuPDF source and license terms](https://github.com/ArtifexSoftware/mupdf/blob/master/COPYING).
- [Community MuPDF Rust binding](https://github.com/messense/mupdf-rs).
- [lopdf](https://github.com/J-F-Liu/lopdf).
- [hayro](https://github.com/LaurenzV/hayro).
- [zpdf](https://github.com/Xero-Team/zpdf).
- [pdf-extract](https://github.com/jrmuizel/pdf-extract).

## Bottom line

Build a Rust PDF engine if the goal is a durable native and browser core with bounded memory, 64-bit file handling, and a clean EVB-owned interface. Do not frame the work as "rewrite PDF.js in Rust." Frame it as "replace the PDF worker behind a stable viewer interface, one capability at a time."

The first deliverable should be a dual-target spike that opens and renders the real large fixture, uses bounded range reads in the browser, uses a utility process in Electron, and reports precise differences against PDF.js. If that spike passes, the project is viable. If it fails, the failure will identify whether the real blocker is engine fidelity, licensing, Wasm memory, native packaging, or EVB’s current coupling. That is the information needed before committing to a multi-year rewrite.
