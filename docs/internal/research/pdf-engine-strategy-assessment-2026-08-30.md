# PDF engine strategy assessment

> **Status (2026-08-30): superseded by [ADR 0002](../../architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md) and wayfinder map #150.**
> The most reliable of the four assessments; its evidence labels, hayro MSRV
> finding (1.92 vs this repo's 1.89 toolchain), and `wasm.rs` 256 MiB cap were
> all verified. Not adopted: its gate order (interface freeze and a native read
> spike before EVB annotation ownership) and the speculative `IPdfEngine`
> interface, deferred until a second engine exists. Research on map #150 later
> found that `noView` hiding needs `ENABLE_STORAGE`, that lopdf 0.44 already
> decrypts R2–R6 and builds for wasm here, and that the pdf.js patch ports to
> 9 source files.

Date: 2026-08-30

Scope: EVB Viewer desktop and browser document opening, rendering, text, annotations, printing, and saving.

Status: research report. No implementation, benchmark, or test result is claimed by this document unless marked as measured evidence.

## Executive conclusion

The hypothesis is partly right. PDF.js is a material cause of two recurring classes of EVB problems:

- Its current range and recovery paths can allocate or assemble data in proportion to the PDF, even when EVB has a path-backed source. The historical issue #111 measured 162 range requests that transferred 99.385% of a 162.6 MiB file before the first useful page. The v5.7.284 source also allocates a length-sized `Uint8Array` for its chunked stream, concatenates received range chunks, and scans the complete stream during xref recovery.
- Its save API is a whole-document serialization API. It walks every page and returns a complete byte array. EVB therefore has to keep a separate native save path for large documents.

PDF.js is not the general cause of the recent failures. EVB also has its own duplicate annotation state, viewport and session fencing, page-count scans, DOM layout work, and file publication protocol. A missing `/Contents` dictionary on a valid blank page is a `pdf-lib` limitation. A long renderer heartbeat gap on the 2,646-page Linux run is a cross-layer scheduling and editor-layer problem. Neither is fixed by replacing the PDF parser alone.

The recommended answer is an EVB-owned document-engine seam, not a line-by-line Rust clone of PDF.js. Keep PDF.js behind that seam for browser rendering and as a compatibility fallback. Add a desktop native path first for file-backed loading, page-local raster and text work, and large-document mutation. Use the existing Rust page-operations and qpdf-backed save work as the first native pieces. Evaluate PDFium and a pure-Rust renderer through the same corpus and interface. Do not commit to a full engine replacement until a prototype proves fidelity, malformed-file recovery, accessibility data, cancellation, packaging, and license fit.

The radical Rust idea is technically viable as a staged product architecture. It is not a sound first project as a complete PDF.js replacement. The scarce resource is not a parser API. It is years of compatibility behavior across fonts, color, malformed files, forms, JavaScript, XFA, annotations, text geometry, printing, and security fixes.

## Evidence discipline

This report uses four labels.

- **Measured** means a number recorded in an EVB issue, local source inspection, or a command run for this report. It is not a new benchmark unless the report says so.
- **Source-backed** means a behavior stated by the cited upstream source or visible in the cited repository code.
- **Inference** means a conclusion drawn from those facts. It should be tested at the proposed gate.
- **Estimate** means planning judgment, not a schedule commitment.

The three untracked research drafts already in the checkout were useful inputs, but none is treated as authority. The architecture draft correctly separates PDF.js limits from EVB lifecycle issues. The dependency-cost draft gives a useful coupling inventory. The Rust feasibility draft correctly rejects a drop-in rewrite and proposes a small EVB interface. Where those drafts used counts or older issue states, this report uses the local code and current upstream evidence instead of repeating an unverified number.

The research also used two independent model reviews. A Luna-max worker audited the repository and drafted the synthesis. A Pi review challenged the causal attribution and migration order. Their disagreements were useful, especially around Hayro and issue #149, but neither review is evidence by itself. The claims below were checked against current source, issue records, or primary upstream documentation.

### Corrections to the starting material

- Current Hayro source supports password-based opening through `Pdf::new_with_password`, despite stale prose elsewhere in the crate that still says password-protected PDFs are unsupported. This removes one objection from the earlier drafts. It does not supply a finished text layer, annotation editor, forms UI, or browser range source. See the current [`pdf.rs`](https://github.com/LaurenzV/hayro/blob/5a5f0e247c970df948505ee0bb36e2df2504bf86/hayro-syntax/src/pdf.rs#L33-L68).
- Hayro's current minimum Rust version is 1.92. EVB pins 1.89.0 and declares workspace `rust-version = "1.87"`. A current Hayro prototype therefore includes a toolchain or dependency-version decision. See [Hayro's current README](https://github.com/LaurenzV/hayro/blob/5a5f0e247c970df948505ee0bb36e2df2504bf86/README.md#minimum-supported-rust-version-msrv), [`rust-toolchain.toml`](../../../rust-toolchain.toml), and [`native/Cargo.toml:13-18`](../../../native/scan-primitives/Cargo.toml#L13-L18).
- Issue #149 is closed after the bounded-scan and macOS acceptance work. Its latest Linux record still shows a roughly 9.7-second pre-save placement interval under Xvfb software rendering. That residual result is a platform and editor-path investigation, not evidence of a PDF.js parser stall. See [issue #149](https://github.com/evb0110/evb-viewer/issues/149).
- EVB already compiles `pdf-page-ops` to Wasm, but the current request protocol accepts a complete request payload and caps it at 256 MiB. It proves cross-host Rust reuse for bounded operations. It does not prove range-aware multi-gigabyte parsing in a browser. See [`wasm.rs:15-35`](../../../native/pdf-page-ops/src/wasm.rs#L15-L35).

## 1. What PDF.js owns in EVB today

EVB pins `pdfjs-dist` to 5.7.284, carries a 1,358-line local patch with 64 hunks across the standard and legacy display and worker bundles, and also declares a 5.4.296 preview alias in [`package.json:168-170`](../../../packages/i18n-app/package.json#L168-L170) and [`package.json:318-319`](../../../packages/i18n-app/package.json#L318-L319). A lexical audit found direct `pdfjs-dist` import patterns in 77 production TypeScript, JavaScript, and Vue files under `app`, `packages`, and `electron`. At the time of this research, the upstream GitHub release endpoint reported v6.3.289, published on 2026-08-29. That gap matters for future upgrade work, but an upgrade would not remove EVB's current coupling or the whole-byte `saveDocument` contract. See the [historical 1,358-line patch snapshot](https://github.com/evb0110/evb-viewer/blob/fc44d9ae691b1496e39a730bae1862e9337f3d67/patches/pdfjs-dist@5.7.284.patch), [upstream v6.3.289 release](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289), and [PDF.js repository and Apache-2.0 license](https://github.com/mozilla/pdf.js). The patch file is no longer tracked at the current tree; the immutable snapshot preserves the dated evidence.

### Capability and coupling map

| Capability | PDF.js owns | EVB code that couples to it | Boundary risk |
| --- | --- | --- | --- |
| Open and parse | `getDocument`, loading tasks, worker parsing, passwords, xref recovery, object lookup | [`runtimeLib.ts:10-14`](../../../app/services/pdfjs/runtimeLib.ts#L10-L14), [`pdfDocumentSource.ts:313-365`](../../../app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts#L313-L365) | The loader and lifetime of PDF.js tasks are mixed with EVB document sessions. |
| Range and blob input | `PDFDataRangeTransport`, range readers, chunk scheduling, stream recovery | [`browserPdfjsDocumentInit.ts:34-107`](../../../app/platform/browser-api/browserPdfjsDocumentInit.ts#L34-L107), [`pdfDocumentSource.ts:442-539`](../../../app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts#L442-L539) | EVB owns a custom range source, but PDF.js owns when requests are made and when readers are released. |
| Page handles and geometry | `PDFDocumentProxy`, `PDFPageProxy`, page boxes, rotation, viewport, operator lists | [`pdfViewerFacade.ts:1-76`](../../../app/services/pdfjs/pdfViewerFacade.ts#L1-L76), [`pdfDocumentSource.ts:45-50`](../../../app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts#L45-L50) | PDF.js types appear in the apparent contract. Page leases and rendering fences must match PDF.js lifetime rules. |
| Raster rendering | `page.render`, canvas render task, image and font decoding | [`pdfViewerFacade.ts:99-175`](../../../app/services/pdfjs/pdfViewerFacade.ts#L99-L175), [`docs/architecture/pdf-viewer-architecture.md:20-40`](../../architecture/pdf-viewer-architecture.md#L20-L40) | Raster output is consumed by EVB's DOM and viewport code. A new renderer must preserve page geometry and cancellation semantics. |
| Text and selection | `streamTextContent`, `getTextContent`, text items and transforms | [`pdfViewerFacade.ts:99-175`](../../../app/services/pdfjs/pdfViewerFacade.ts#L99-L175), [`docs/architecture/pdf-viewer-architecture.md:42-57`](../../architecture/pdf-viewer-architecture.md#L42-L57) | PDF.js text-layer DOM is part of selection and accessibility behavior. A raster-only Rust engine cannot replace it. |
| Search | Page-local text extraction and EVB search indexing | [`docs/architecture/pdf-viewer-architecture.md:8-18`](../../architecture/pdf-viewer-architecture.md#L8-L18) | Search must consume a stable text result, not PDF.js text-layer DOM internals. |
| Annotation layers | `AnnotationLayer`, annotation objects, links, widgets, appearance handling | [`pdfViewerFacade.ts:99-175`](../../../app/services/pdfjs/pdfViewerFacade.ts#L99-L175) | The PDF.js layer and EVB canonical annotation store can diverge. |
| Annotation editors | `AnnotationEditorLayer` and `AnnotationEditorUIManager` | [`runtimeLib.ts:75-98`](../../../app/services/pdfjs/runtimeLib.ts#L75-L98), [historical `useFreeTextResize.ts:1-31`](https://github.com/evb0110/evb-viewer/blob/ad3fa9b27658965de8c0e19a5f8f68fc1a1f4269/app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useFreeTextResize.ts#L1-L31) | EVB calls a private editor executor and requires 13 UI-manager methods. This is a high-cost replacement seam. The former resize helper is no longer tracked at this path. |
| Editor compatibility | PDF.js editor constructors, methods, and accessors | [historical `annotationEditorCompatibility.ts:154-230`](https://github.com/evb0110/evb-viewer/blob/ad3fa9b27658965de8c0e19a5f8f68fc1a1f4269/app/services/pdfjs/annotationEditorCompatibility.ts#L154-L230) | EVB probes and patches the installed PDF.js build. An upgrade or alternate engine changes this contract. The former compatibility helper is no longer tracked at this path. |
| Save serialization | `PDFDocumentProxy.saveDocument` and incremental update assembly | [`usePdfViewerSaveTransaction.ts:149-175`](../../../app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts#L149-L175), [historical `classifyPdfSaveRoute.ts:363-420`](https://github.com/evb0110/evb-viewer/blob/266c40084f96636efdff0175d6d03e1677dc0cad/app/modules/pdf-viewer/runtime/save/classifyPdfSaveRoute.ts#L363-L420) | The API returns complete bytes and can stall on large scans. EVB retries, times out, and falls back around it. The former classifier path is no longer tracked at this location. |
| Print rasterization | Page render and text-layer inputs used to build printable bytes | [`pdfPrint.ts:1-35`](../../../app/utils/pdfPrint.ts#L1-L35), [`pdfPrint.ts:160-320`](../../../app/utils/pdfPrint.ts#L160-L320) | Browser printing has explicit memory and pixel caps. The final printable-PDF assembly also uses `pdf-lib`. |
| Public TypeScript contract | PDF.js proxy and page types | [`pdfContracts.ts:1-23`](../../../app/types/pdfContracts.ts#L1-L23) | A consumer can depend on a PDF.js type even if the code calls it a generic PDF contract. |

PDF.js is therefore more than a renderer in EVB. It currently owns document parsing, page objects, text, several DOM layers, editor state, and part of saving. The EVB architecture document already names the intended ownership split: the shell owns product operations, the engine owns PDF work, and pure geometry and serialization belong in `packages/pdf-core` ([`docs/architecture/pdf-viewer-architecture.md:8-40`](../../architecture/pdf-viewer-architecture.md#L8-L40)). The current implementation has not completed that split because PDF.js types and editor objects cross the boundary.

### What the upstream PDF.js source actually does

The [PDF.js README](https://github.com/mozilla/pdf.js) describes a general-purpose HTML5 PDF parser and renderer. The pinned v5.7.284 source provides these concrete facts:

1. `ChunkedStream` constructs `new Uint8Array(length)` for the document stream, and `ChunkedStreamManager.sendRequest` collects range chunks and concatenates them before passing data to the stream. See [`chunked_stream.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/chunked_stream.js#L28-L38) and [`chunked_stream.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/chunked_stream.js#L298-L329).
2. In recovery mode, `XRef` calls `indexObjects`, which gets the entire stream and scans it to reconstruct objects. See [`xref.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/xref.js#L99-L105) and [`xref.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/xref.js#L409-L467).
3. `SaveDocument` walks all pages, then returns the complete stream bytes. If no changes exist it returns the original stream bytes. If changes exist it performs an incremental update against that byte stream. See [`worker.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/worker.js#L665-L797) and [`worker.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/worker.js#L847-L863).
4. The display API exposes page proxies, page rendering, annotations, and text streams, while `getData` and `saveDocument` resolve to complete byte arrays. See [`api.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/display/api.js#L684-L775), [`api.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/display/api.js#L961-L975), [`api.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/display/api.js#L1290-L1465), and [`api.js`](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/display/api.js#L1705-L1754).

These are design choices that make a broad browser viewer practical. They are not evidence that PDF.js is defective in ordinary documents. They do show why a path-backed multi-gigabyte editor cannot use every PDF.js operation as its persistence path.

The key assumptions remain in current upstream after v6.3.289. At commit `9785821159384da2dbf6e4240bfc9ea7e7023a49`, `ChunkedStream` still constructs the document-length byte array, range requests are still collected and concatenated, and `SaveDocument` still supplies `stream.bytes` to `incrementalUpdate`. See the current [`chunked_stream.js`](https://github.com/mozilla/pdf.js/blob/9785821159384da2dbf6e4240bfc9ea7e7023a49/src/core/chunked_stream.js#L28-L34), [range request assembly](https://github.com/mozilla/pdf.js/blob/9785821159384da2dbf6e4240bfc9ea7e7023a49/src/core/chunked_stream.js#L284-L315), and [`worker.js`](https://github.com/mozilla/pdf.js/blob/9785821159384da2dbf6e4240bfc9ea7e7023a49/src/core/worker.js#L794-L884). This is why upgrading and replacing are separate decisions.

## 2. Classification of recurring project problems

The useful question is not "does the stack mention PDF.js?" Almost every viewer operation does. The useful question is whether changing the engine would remove the failing work, or whether EVB would recreate the same work around a new engine.

### Representative evidence matrix

| Evidence | Classification | Why this classification fits | What a replacement could change |
| --- | --- | --- | --- |
| #111 recorded a 162.6 MiB damaged or non-linearized file, 162 range requests, 99.385% of the file transferred, and about 10.57 seconds to the first nonblank canvas. The issue body also records PDF.js document loading at about 4.44 seconds and qpdf validation at about 5.00 seconds. [Issue #111](https://github.com/evb0110/evb-viewer/issues/111) | Intrinsic PDF.js limit plus malformed-PDF complexity | The PDF.js stream and xref recovery paths can require a complete byte view. The malformed xref causes a full scan. The time is not all parser time because validation and UI work are separate measured stages. | A file-backed native parser can avoid a JavaScript-sized document buffer and can choose an explicit recovery budget. It cannot make malformed files cheap. |
| PDF.js `saveDocument` walks pages and returns complete bytes. EVB's save transaction retries it up to four times and falls back to source bytes after failure. [Save code](../../../app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts#L358-L497) | Intrinsic API limit plus EVB coupling | The whole-byte result is a real PDF.js contract. EVB's retry, timeout, and fallback policy is its own behavior. | A native append or staged writer can stream output and validate before publication. It must still preserve annotations and page identity. |
| #141 reports a Linux hang in EVB's bounded range transport, followed by PDF.js logging that no range-reader instance existed. [Issue #141](https://github.com/evb0110/evb-viewer/issues/141) | EVB integration and PDF.js lifecycle coupling | The custom transport, abort, reader release, and PDF.js request scheduling form one protocol. The issue does not prove an upstream PDF.js parser defect. | An adapter with explicit request ownership and cancellation can remove the fragile transport. A native file reader removes this browser transport only on desktop. |
| EVB requires `AnnotationEditorUIManager` methods, probes private editor methods, and has a PDF.js-private FreeText resize executor with NaN recovery. [Runtime contract](../../../app/services/pdfjs/runtimeLib.ts#L75-L98), [historical FreeText bridge](https://github.com/evb0110/evb-viewer/blob/ad3fa9b27658965de8c0e19a5f8f68fc1a1f4269/app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useFreeTextResize.ts#L1-L31) | EVB misuse or coupling to PDF.js internals | The code calls internals and compensates for editor behavior. The PDF format is not the source of the TypeScript method contract. | Moving canonical annotation state and geometry out of PDF.js can reduce coupling. A new engine will not remove the need for an editor owner. The former bridge path is historical evidence only. |
| #139 left four FreeText objects in the saved PDF while the UI and sidebar lost them. The issue points at snapshot, summary, application, and sync code rather than byte loss. [Issue #139](https://github.com/evb0110/evb-viewer/issues/139) | EVB state and projection bug | The saved objects remained, so the persistence bytes and the visible projection disagreed. | An engine with a different editor layer might hide the symptom, but only one EVB annotation authority fixes the state model. |
| #149 recorded a Linux xlarge renderer heartbeat gap near 9.97 seconds during a 2,646-page FreeText placement run, with thousands of DOM mutations and long tasks. [Issue #149](https://github.com/evb0110/evb-viewer/issues/149) | Native/Electron/browser lifecycle and EVB editor coupling | Page-count scans, editor layers, DOM mutations, and event-loop scheduling account for the observed symptom. The record is not a parser benchmark. | A page-local native engine may reduce parser work, but it cannot make an unbounded DOM/editor pass safe. |
| #106 describes a large-PDF open that left an old sidebar and desynchronized fit behavior. [Issue #106](https://github.com/evb0110/evb-viewer/issues/106) | EVB session and viewport lifecycle | The symptom is a stale product projection after document replacement. | Engine isolation helps only if the document/session fence is also corrected. |
| #122 joins Save, Save As, sidecar, journal, and queued mutations in one transaction. [Issue #122](https://github.com/evb0110/evb-viewer/issues/122) | Native/Electron/file lifecycle | Publication, sidecars, cancellation, and atomic replacement are host concerns. | A native engine can expose a staged artifact, but Electron still needs atomic publication and crash recovery. |
| #146 covers rollback fencing, symlink behavior, and Windows file witnesses. [Issue #146](https://github.com/evb0110/evb-viewer/issues/146) | Native/Electron/file lifecycle | The failure boundary is path identity and publication, not PDF page rendering. | A different parser does not change filesystem semantics. |
| #143 fails on a valid blank page with no `/Contents` when `pdf-lib@1.17.1` embeds the page for printing. [Issue #143](https://github.com/evb0110/evb-viewer/issues/143) | Independent third-party PDF-library limit | EVB's print assembly calls `PDFDocument.embedPages`; the failing assumption belongs to pdf-lib. | Upgrade, patch, or replace the print assembler. Replacing PDF.js does not address this call. |
| #81 involved JBIG2 arithmetic-decoder truncation and synthesized padding. [Issue #81](https://github.com/evb0110/evb-viewer/issues/81) | PDF-format complexity and third-party codec behavior | JBIG2 is a difficult compressed image format with security-sensitive malformed inputs. | A new engine changes the decoder and its security update path, not the format's complexity. |
| #132 concerns page layout, thumbnails, outlines, and very large page counts. [Issue #132](https://github.com/evb0110/evb-viewer/issues/132) | EVB/Chromium layout | The visible failure is in layout and product data structures. | A new page parser helps only if it also changes the amount of DOM and array work. |

The evidence supports a narrow claim: PDF.js materially contributes to the large-file memory and whole-document save ceilings, and EVB has coupled tightly to its annotation editor. It does not support the broad claim that PDF.js caused the sidebar, file transaction, layout, or pdf-lib defects.

### The FreeText seam is especially important

EVB's own persistence documentation records a PDF semantic constraint: the PDF.js popup editor reads `/Contents` from the parent FreeText dictionary, while EVB needs visible FreeText content and note text to remain distinct. The current workaround uses a blank appearance Form XObject for the popup note. See [`docs/architecture/freetext-note-persistence.md:1-37`](../../architecture/freetext-note-persistence.md#L1-L37).

This means a replacement engine must have a stated annotation model, not just a page raster API. EVB needs to decide whether the canonical object is an EVB annotation record, a PDF annotation dictionary, or a PDF.js editor object. The report recommends the first. PDF.js and any native engine should be projections of that record.

## 3. What EVB needs from an engine

The repository shows a document product with navigation, page metrics, load waits, crop, save, print, annotations, shapes, image placement, and search ([`docs/architecture/pdf-viewer-architecture.md:8-18`](../../architecture/pdf-viewer-architecture.md#L8-L18)). It does not establish that EVB currently promises every PDF feature in the standard. The feature list below separates the requirements needed for the current viewer/editor from features that should remain explicit product decisions.

### Desktop requirements

| Need | Required for the proposed desktop path | Notes |
| --- | --- | --- |
| File input | Yes | Open by path, read bounded ranges, seek with checked `u64` offsets, and avoid a renderer-sized JavaScript copy. Existing Rust policy uses bounded encoded input and qpdf for larger structural work. See [`load_policy.rs:8-16`](../../../native/pdf-page-ops/src/load_policy.rs#L8-L16) and [`load_policy.rs:83-124`](../../../native/pdf-page-ops/src/load_policy.rs#L83-L124). |
| Malformed-PDF recovery | Yes | Open damaged xrefs and report a typed failure when recovery exceeds a budget. Recovery must be measured separately from first-page rendering. |
| Page geometry and raster | Yes | Return page boxes, rotation, crop, and cancellable page-local raster output. The result must not expose PDFium, MuPDF, or PDF.js handle types to the UI. |
| Text and selection | Yes | Return Unicode text, item or span geometry, reading-order hints, and stable page-local offsets. EVB's text layer and search need these results. A raster-only renderer is insufficient. |
| Search and outline | Yes | Search can remain an EVB service over page-local text. Outline and link objects should be ordinary engine data, not DOM queries. |
| EVB annotations | Yes | Read existing annotations needed for display, and round-trip EVB-owned FreeText, highlight, ink, shapes, and image placement. Keep canonical state in EVB. |
| Standard annotations and links | Yes for display, scoped for editing | Links, text markup, widgets, and common appearance streams need a corpus test. Editing every standard annotation is not a first native milestone. |
| Passwords and encryption | Required if the product promises encrypted-PDF opening | The engine must report needs-password, wrong-password, and unsupported security handlers distinctly. Do not silently fall back to an empty document. |
| Forms and XFA | Product decision before engine selection | Basic AcroForm display may be required by users. XFA needs a separate compatibility decision. PDFium can be built with XFA, but that does not make XFA behavior identical across engines. |
| JavaScript actions | Optional for the first native editor | Treat document JavaScript as a security policy and compatibility project. Do not execute it in an unrestricted utility process. |
| Printing | Yes | Desktop printing should render through the same page geometry and text contracts, then assemble output through a tested writer. A blank page without `/Contents` must work. |
| Save | Yes, but not through a whole-byte renderer API | Prefer native incremental append for small mutations and staged replacement for operations that require rewriting. Existing native code already has rollback, sync, and exact seeded-output checks in [`incremental.rs:25-216`](../../../native/pdf-page-ops/src/incremental.rs#L25-L216). |
| Crash and cancellation | Yes | Run native work in an Electron utility process or equivalent isolated child, with cancellation, bounded messages, and typed errors. The current qpdf validation and atomic replace path is in [`documentSaveUtilityProcess.ts:80-192`](../../../electron/features/documents/main/documentSaveUtilityProcess.ts#L80-L192). |
| Accessibility | Yes | Preserve a selectable text DOM or accessible text representation, annotation focus order, keyboard behavior, and page labels. Engine raster output alone cannot meet this requirement. |

The desktop engine does not need to expose PDF.js's operator list, `PDFPageProxy`, annotation editor manager, or canvas task objects. Those are implementation details that currently leak through [`pdfViewerFacade.ts:1-76`](../../../app/services/pdfjs/pdfViewerFacade.ts#L1-L76) and [`pdfContracts.ts:1-23`](../../../app/types/pdfContracts.ts#L1-L23).

### Browser requirements

| Need | Required in browser | What can remain desktop-only or deferred |
| --- | --- | --- |
| Source | HTTP range, Blob, and user-selected file support with explicit abort and source identity checks | Native path handles and filesystem transactions |
| Memory | Bounded range and page-local work, with clear input and canvas budgets | A promise of arbitrary multi-gigabyte browser editing. Browser memory is an acceptance limit, not a number to hide. |
| Rendering | Page raster, geometry, text layer, links, and basic EVB annotation projection | Native utility-process rendering |
| Search | Page-local extraction and cancellation | Native sidecar indexing, unless a shared Wasm text path proves useful |
| Save | Downloadable output for supported mutations | Atomic in-place replace, sidecar journal, and native fsync |
| Forms/XFA/JavaScript | Existing supported behavior must be documented and tested | Full XFA or document JavaScript can remain PDF.js-owned until a separate browser security and compatibility project exists |
| Accessibility | Text and annotation DOM contracts must stay intact | A native raster path cannot replace browser semantics |

The existing browser transport already uses `length`, a range transport, disabled auto-fetch, disabled streaming, and bounded individual range allocation ([`browserPdfjsDocumentInit.ts:100-167`](../../../app/platform/browser-api/browserPdfjsDocumentInit.ts#L100-L167)). That is a useful seam, but it does not override PDF.js's internal stream and recovery choices.

### Required versus optional engine features

For the next decision, treat these as required: common PDF parsing, password errors if supported, malformed-xref recovery, page geometry, raster, text geometry, search input, links and outlines, existing EVB annotation display, EVB annotation round-trip, printing, and a large-file-safe save path. Treat XFA, document JavaScript, rich forms, signatures and validation, multimedia, redaction, and full editing of every third-party annotation as optional until the product owner records a commitment.

That list is deliberately conservative. Calling XFA or JavaScript "required" without a product commitment would force a new engine to reproduce execution environments that neither a small Rust engine nor a simple PDFium wrapper provides for free.

## 4. Realistic strategies

### Comparison matrix

| Strategy | Licensing and security | Fidelity and features | I/O, Wasm, and packaging | Maintenance and judgment |
| --- | --- | --- | --- | --- |
| Continue with PDF.js and isolate it | Apache-2.0. Retains the current Mozilla-supported security and compatibility stream, but EVB must track its pinned version and local patch. | Highest immediate fidelity because it is the current renderer. Retains text, selection, annotations, forms, XFA or JavaScript behavior that EVB already gets. | Browser fit is strong. Desktop path-backed loading can improve around PDF.js, but PDF.js's internal chunked stream, recovery, and whole-byte save remain. | Lowest delivery risk. Recommended baseline. Move PDF.js types behind an EVB interface, keep save native, bound editor work, and remove private calls over time. |
| Replace selected capabilities with Rust | Existing EVB Rust modules already own bounded page operations and incremental writing. Dependency license review remains required. | Good for page geometry, metadata, bounded mutation, structural checks, and possibly page-local rendering or text after corpus proof. It does not automatically cover fonts, color, malformed recovery, forms, XFA, JavaScript, or accessibility. | Strong desktop fit. Rust's WebAssembly target has no ordinary filesystem and `std::thread::spawn` panics on `wasm32-unknown-unknown`; use explicit range callbacks and a worker rather than assuming native APIs. See the [Rust target documentation](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html). | Best first native investment. It can deliver value without a renderer rewrite. Keep the interface capability-based and fall back to PDF.js for unsupported features. |
| Wrap PDFium | PDFium's public headers use a BSD-style notice, and its `LICENSE` contains Apache-2.0 terms. Verify all Chromium third-party notices in the packaged build. PDFium has a mature fuzzing and Chromium security process, but its public APIs are not thread-safe. See the [PDFium license](https://pdfium.googlesource.com/pdfium/+/main/LICENSE), [README](https://pdfium.googlesource.com/pdfium/+/main/README.md), and [public header](https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h). | Strong native rendering, text, annotations, forms, and optional XFA. It is a C++ library, not a small Rust crate. The public custom file-access struct exposes `unsigned long` file length and offsets, and the save callback uses `unsigned long` block sizes. The wrapper must test large files and callback truncation on every target. See [fpdfview.h](https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h#L473) and [fpdf_save.h](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_save.h#L20). | Desktop packaging means Chromium build tooling or a carefully maintained binary build. Browser Wasm is not an official drop-in path in the sources inspected. A safe Rust FFI wrapper needs a single-threaded service boundary. | Plausible desktop candidate if the fidelity spike wins and build maintenance is accepted. Do not select it from feature lists alone. |
| Wrap MuPDF | MuPDF.js and the underlying MuPDF code use AGPLv3 or a commercial license. This is a commercial and distribution decision before technical work. See the [MuPDF.js README and license section](https://github.com/ArtifexSoftware/mupdf.js#license) and [MuPDF COPYING](https://github.com/ArtifexSoftware/mupdf/blob/master/COPYING). | Broad high-fidelity rendering and document APIs, with annotations, widgets, search, structured text, save, and passwords exposed by the binding. The binding's examples read a whole buffer, and Wasm objects require explicit destruction. | Official JS/TS Wasm binding exists, which is attractive for browser experiments. The examples still open full `ArrayBuffer` data or fetched buffers, so large-file range behavior needs proof. ESM packaging is possible; AGPL or commercial terms remain the hard constraint. | Technically serious, legally unsuitable unless EVB accepts commercial licensing or satisfies AGPL obligations. Keep as a comparison benchmark, not the default. |
| Build on a pure-Rust engine | License depends on the engine. Hayro uses MIT or Apache-2.0 files, but its upstream README calls it experimental and says the demo does not cover text selection, search, annotations, or forms. See [Hayro](https://github.com/LaurenzV/hayro). | A pure-Rust core could give EVB control of offsets, allocation, and Wasm. Current candidates have incomplete viewer features and unproven compatibility with EVB's corpus. A small structural crate such as lopdf is not a renderer and keeps high-level objects in memory until serialization, according to its [upstream FAQ](https://github.com/J-F-Liu/lopdf#frequently-asked-questions). | Good potential for a shared native/Wasm core if it uses a range callback and bounded page results. That potential is not a production feature. Packaging is simpler than Chromium only after codecs, fonts, and platform rendering are solved. | Good research target for a page-local renderer spike. A production engine requires a sustained security and compatibility team. |
| Full PDF.js-compatible rewrite in Rust | A new implementation would need its own license and security response. Reimplementing the public and de facto behavior does not transfer PDF.js's maintenance history. | The target is too broad. It includes parser recovery, fonts, color, image codecs, text, operators, annotations, forms, XFA, JavaScript boundaries, DOM behavior, save, and thousands of compatibility quirks. | Shared Rust/Wasm is possible in principle, but browser workers, range I/O, memory growth, and platform packaging still need separate adapters. A drop-in replacement would preserve the wrong API and its coupling. | Highest cost and longest uncertainty. Reject as the current plan. Revisit only after a narrow engine has earned a production corpus and a product commitment exists. |

### Details that matter in the comparison

#### Licensing

PDF.js is Apache-2.0. PDFium's source carries BSD-style header terms and Apache-2.0 license text, with notice obligations. MuPDF is AGPLv3 or commercial. Hayro's repository includes permissive license files, but permissive licensing does not compensate for missing viewer features. Every transitive codec, font, and native binary must be checked in the actual distributable, not just in the engine's root README.

#### Security and malformed files

The existing PDF.js process and its upstream security response are a major asset. A Rust or C++ engine is not safer by language choice alone. The replacement must fuzz parsers, image codecs, font handling, xref recovery, forms, and save output; isolate native work; enforce object, nesting, stream, and output limits; and publish a crash and security update process. EVB's current Rust policy already demonstrates the right shape with caps for encoded input, decompressed streams, object count, page count, nesting, xref revisions, and Wasm request output ([`load_policy.rs:8-16`](../../../native/pdf-page-ops/src/load_policy.rs#L8-L16), [`wasm.rs:15-109`](../../../native/pdf-page-ops/src/wasm.rs#L15-L109)).

#### Accessibility, text, and selection

A renderer that only returns pixels is not a viewer replacement. EVB's text layer, selection, search, links, keyboard behavior, and annotation focus order need text spans, transforms, reading order, and stable page-local identifiers. PDFium and MuPDF have text APIs. Hayro's upstream demo explicitly leaves selection and search out of scope. A pure-Rust engine must prove these results against PDF.js and user-visible behavior before it replaces any DOM layer.

#### Pure-Rust candidates in current source

Hayro is the pure-Rust candidate worth testing first. Its interpreter exposes paths, glyph runs, images, clipping, transparency, and marked-content events, which are useful raw inputs for a page result. Its current input type is still `Arc<dyn AsRef<[u8]>>`, a contiguous slice contract. A desktop adapter could satisfy that with a memory map and let the operating system page data on demand. An ordinary browser range source cannot satisfy it without changing the parser or materializing the complete file. See Hayro's current [`PdfData`](https://github.com/LaurenzV/hayro/blob/5a5f0e247c970df948505ee0bb36e2df2504bf86/hayro-syntax/src/data.rs#L13-L45). This makes Hayro a sensible desktop raster experiment, not proof of the proposed shared browser engine.

[zpdf v0.13.0](https://github.com/Xero-Team/zpdf/tree/2777fef85e6f4662551bea1bf0667bbbf19857e6) is another ambitious pure-Rust implementation. It began in May 2026, has broad feature claims, and publishes a veraPDF corpus report. Its native example reads the file into memory before `PdfDocument::open`, and its Wasm example opens `pdfBytes`; the corpus files and result TSVs referenced by the report are not present in the inspected checkout. See its [native and Wasm examples](https://github.com/Xero-Team/zpdf/blob/2777fef85e6f4662551bea1bf0667bbbf19857e6/README.md#quick-start) and [corpus report](https://github.com/Xero-Team/zpdf/blob/2777fef85e6f4662551bea1bf0667bbbf19857e6/tests/corpus-report.md). Treat it as a research comparison. Its age, whole-buffer examples, and currently unauditable published corpus result make it a weaker first candidate than Hayro or PDFium.

#### Forms, XFA, and JavaScript

These features have different security and compatibility costs. PDFium's README says JavaScript and XFA are enabled by default in its build, but EVB would still need to decide whether to expose them and how to isolate actions. MuPDF has form and widget APIs. A narrow EVB engine can initially report unsupported capabilities and leave these projections to PDF.js. Silent partial behavior is worse than an explicit fallback.

#### Printing and save

Printing has two independent paths. PDF.js renders pages and text, while the current printable-PDF path imports pages through `pdf-lib` and has browser input and canvas budgets ([`pdfPrint.ts:28-35`](../../../app/utils/pdfPrint.ts#L28-L35)). The blank `/Contents` failure belongs to the second path. A native engine will help only if EVB also changes the print assembler or validates the page dictionary before embedding.

PDFium exposes a custom save callback and incremental flags in [fpdf_save.h](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_save.h#L20-L73). MuPDF exposes save and journaling APIs. Existing EVB native code already has a more constrained append writer with rollback and exact-output checks ([`incremental.rs:25-216`](../../../native/pdf-page-ops/src/incremental.rs#L25-L216)). The first native milestone should use the writer EVB can test, not replace it merely because a candidate engine has a save function.

#### Browser Wasm and multi-gigabyte I/O

The Rust `wasm32-unknown-unknown` target has no ordinary filesystem implementation and does not provide native thread spawning. Its documented model requires explicit host imports. See the [Rust target support page](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html). Therefore the browser adapter should provide `read(offset, length)` and return bounded page results. It should not copy a multi-gigabyte file into one JavaScript `Uint8Array` as a condition of opening it.

MuPDF.js proves that a production-quality Rust-adjacent C library can be compiled to Wasm, but its public examples read whole buffers and require explicit object destruction. That is useful evidence for a prototype, not evidence that its current binding solves EVB's range and memory contract.

## 5. Recommended architecture

### The seam

Create one EVB-owned deep module that owns document identity, capabilities, page-local work, and engine errors. Its interface should be small enough that the rest of EVB cannot import PDF.js, PDFium, MuPDF, or lopdf types.

The exact names can follow the repository's TypeScript conventions, but the shape should be close to this:

```ts
interface IPdfEngine {
  open(source: TPdfSource, options: TPdfOpenOptions): Promise<IPdfDocument>;
}

interface IPdfDocument {
  readonly capabilities: TPdfEngineCapabilities;
  readonly pageCount: number;
  getPageInfo(pageIndex: number): Promise<TPdfPageInfo>;
  renderPage(request: TPdfRenderRequest): Promise<TPdfRasterResult>;
  getText(request: TPdfTextRequest): Promise<TPdfTextResult>;
  getPageObjects(request: TPdfPageObjectsRequest): Promise<TPdfPageObjects>;
  close(): Promise<void>;
}
```

The save writer should be a separate EVB-owned operation, because reading and publishing have different failure and transaction rules:

```ts
interface IPdfMutationWriter {
  stage(request: TPdfMutationRequest): Promise<TPdfStagedArtifact>;
  validate(artifact: TPdfStagedArtifact): Promise<TPdfValidationReceipt>;
}
```

The public types must use ordinary EVB data: checked numeric offsets or serialized `bigint` values, page indices, rectangles, text spans, image buffers, annotation records, capability flags, and typed errors. No `PDFDocumentProxy`, `PDFPageProxy`, `AnnotationEditorUIManager`, operator-list array, or native pointer can cross the seam.

This is not a second generic abstraction layer. It replaces the current leaked contract. The PDF.js adapter, native adapter, and any future Wasm adapter should implement this same seam, and temporary compatibility code should carry a removal condition.

### Source and lifetime rules

The source interface should make I/O explicit:

```ts
interface IPdfRangeSource {
  readonly length: bigint;
  read(offset: bigint, length: number, signal: AbortSignal): Promise<Uint8Array>;
}
```

The native implementation reads a file or file descriptor. The browser implementation reads HTTP ranges or a Blob. The Wasm implementation receives a host callback. All adapters must reject overflow, stale source identity, out-of-range reads, and aborted requests. The current browser source already checks source identity and bounds; preserve those invariants while removing the PDF.js-specific reader lifetime from the interface ([`browserPdfjsDocumentInit.ts:55-125`](../../../app/platform/browser-api/browserPdfjsDocumentInit.ts#L55-L125)).

The deep module should own page-handle lifetime and cancellation. A page result should be a value that can outlive the engine handle. The current bounded page cache and lease rules are a useful local model ([`pdfDocumentSource.ts:45-218`](../../../app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts#L45-L218)). The UI should not retain a raw page proxy.

### Adapters and fallbacks

Use these adapters in the first architecture:

1. **PDF.js browser adapter.** It maps existing `getPage`, render, text, annotation, and link calls to ordinary EVB values. Keep PDF.js DOM layers only where the browser requires them, and stop exporting its types. This adapter is the initial implementation, not a permanent permission to add new private calls.
2. **Native desktop adapter.** It runs behind an Electron utility process. Start with file-backed metadata, page geometry, bounded structural reads, and the existing Rust/qpdf mutation and validation path. Add raster and text only after a corpus test. Electron documents utility processes as child processes with Node.js and message-port communication in the [utility-process API](https://www.electronjs.org/docs/latest/api/utility-process). The [native-code guide](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron) confirms Rust can integrate as a native module, but the process boundary is safer for parser faults and cancellation.
3. **Optional Wasm adapter.** Compile only a proven page-local native component. Give it the range callback and bounded request/output protocol already present in [`wasm.rs:15-109`](../../../native/pdf-page-ops/src/wasm.rs#L15-L109). Do not make browser Wasm a prerequisite for the desktop proof.
4. **Explicit capability fallback.** If the native adapter reports unsupported XFA, a form action, a codec, or an annotation type, route that operation to PDF.js or show a typed limitation. Record the engine and capability in telemetry and tests. Do not silently mix two engines for the same page or annotation without an ownership rule.

### Annotation and DOM ownership

EVB's canonical annotation store should own annotation identity, text, geometry, page mapping, and dirty state. PDF.js's `AnnotationStorage` and editor objects should be adapters or temporary editing surfaces. The historical `useFreeTextResize` bridge and editor retry tracker should shrink as this ownership moves ([historical `useFreeTextResize.ts:605-646`](https://github.com/evb0110/evb-viewer/blob/ad3fa9b27658965de8c0e19a5f8f68fc1a1f4269/app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useFreeTextResize.ts#L605-L646), [historical `createAnnotationEditorLayerFailureTracker.ts:7-82`](https://github.com/evb0110/evb-viewer/blob/3fada5ea4826f921f50d2cd3e21181abd0657ff6/app/modules/pdf-viewer/runtime/rendering/createAnnotationEditorLayerFailureTracker.ts#L7-L82)). These former helper paths are no longer tracked at the current tree.

The browser may still use PDF.js's editor layer for a transition. It must receive and emit EVB annotation records through one transaction owner. The native engine should serialize those records to PDF dictionaries and appearance streams. That is the part of an EVB-specific engine that can be smaller than a general PDF editor.

### Validation corpus

The corpus must contain exact bytes and a declared expected result. At minimum it should include:

- The 882-page Zaliznyak fixture, about 722 MiB in the issue record, for open, thumbnails, text, FreeText, save, hard restart, and qpdf validation. [Issue #139](https://github.com/evb0110/evb-viewer/issues/139) records the annotation persistence case.
- The three-copy 2,646-page Zaliznyak fixture, about 2.17 GiB, for page count, placement, search, save, cancellation, and Linux event-loop behavior. Do not call it passed in this report. The cited number comes from the local issue and prior research context, not a run performed here.
- The 162.6 MiB damaged or non-linearized PDF in [issue #111](https://github.com/evb0110/evb-viewer/issues/111), with malformed xref recovery and first-page timing.
- PDFs with classic xref offsets around 10,000,000,000, xref streams, sparse files, multiple revisions, object streams, encrypted documents, and large embedded streams. Existing Rust code treats the classic xref offset boundary and checked `u64` handling explicitly ([`incremental.rs:1-11`](../../../native/pdf-page-ops/src/incremental.rs#L1-L11)).
- Fonts and text cases covering embedded and missing fonts, CMaps, vertical writing, ligatures, right-to-left text, rotated text, clipping, transparency, ICC color, JPEG, JPX, JBIG2, CCITT, and malformed image data.
- Annotation cases covering FreeText with popup notes, highlight, ink, stamps, links, widgets, rotated pages, crop boxes, page insertion, reorder, delete, and undo or redo.
- Forms, XFA, JavaScript actions, signatures, attachments, outlines, tagged structure, and accessibility trees. Record capability results even when the first native adapter falls back.
- Valid blank pages with no `/Contents`, because [issue #143](https://github.com/evb0110/evb-viewer/issues/143) shows that the print assembler must accept them.

The corpus should compare observable results, not internal operation arrays. Compare page dimensions and selected raster regions, text strings and quads, links and annotation records, saved-file validation, source-prefix identity, reopened page count, and user-visible accessibility behavior.

## 6. Decision gates and experiments

The following are proposed gates. They are not completed measurements.

### Gate 0, interface and baseline, one to two weeks, estimate

- Freeze a versioned EVB engine contract and capability matrix.
- Add a PDF.js adapter that returns EVB values, without adding a second renderer.
- Capture baseline timings, peak RSS, range bytes, first useful page, text results, raster samples, and save latency for the exact corpus.
- Add tests that fail if application code imports PDF.js proxy types or calls the editor manager outside the adapter.
- Record which forms, XFA, JavaScript, signatures, and annotation types EVB promises.

Pass condition: the product can run entirely on the PDF.js adapter and the new contract identifies every remaining PDF.js import. Stop and fix the ownership model if the contract requires operator lists or private editor handles.

### Gate 1, native read spike, two to four weeks, estimate

Implement a read-only native utility-process prototype against the 882-page, 2,646-page, and damaged-xref fixtures. Use an existing candidate or the smallest viable engine. Return page count, page boxes, one page raster, text spans, links, and typed password or malformed-file errors. Do not add forms or JavaScript in this gate.

Required measurements:

- Peak native RSS and renderer RSS versus source size.
- First useful raster and page navigation latency.
- Number and total size of reads for a page-local request.
- Cancellation latency after an in-flight read or render.
- Raster and text differences against the PDF.js baseline.
- Process survival after malformed input, cancellation, and repeated open/close.

Pass condition: the native path completes the declared page-local operations on every core fixture, its memory and I/O behavior does not scale as one JavaScript copy of the source, and all differences have an accepted explanation. Do not require pixel identity before defining a per-feature tolerance, but do require a reviewer-approved diff for every mismatch.

Stop condition: the candidate needs a full input buffer for the target path, cannot cancel or isolate a malformed file, has unexplained text or page-geometry differences, or cannot be packaged under an acceptable license.

### Gate 2, mutation and print, two to four weeks after Gate 1, estimate

- Route one EVB annotation transaction through the existing native writer.
- Reopen the result through both adapters.
- Test FreeText visible text and popup note persistence, blank pages without `/Contents`, page remap, crop, and undo or rollback.
- Run qpdf validation and the existing native append checks.
- Keep PDF.js rendering as the control while the native writer is evaluated.

Pass condition: no annotation disappears from the EVB store, the saved bytes reopen with the same page and annotation records, source prefix identity is preserved where promised, and publication remains atomic. A passing synthetic save is insufficient. The exact restarted Zaliznyak interaction path must be in the gate.

Stop condition: the writer requires full renderer serialization for common EVB mutations, loses popup or appearance semantics, or creates a path that cannot be validated before publication.

### Gate 3, product slice, four to eight weeks after Gate 2, estimate

Ship a hidden or opt-in desktop path for large-document open, page-local rendering, and EVB annotation save. PDF.js remains the fallback for forms, XFA, JavaScript, unsupported codecs, and unexplained fidelity cases. Run the exact fixture set on macOS and headless Linux. Add Windows once the file-access and packaging contract is stable.

Pass condition: the new path reduces the chosen large-file failure metric without increasing unresolved rendering, text, accessibility, or save regressions. It must be possible to disable the native capability at runtime without corrupting the document session.

Stop condition: the feature requires a second canonical annotation state, introduces more than one unbounded DOM pass, or makes failure recovery less explicit than the current PDF.js path.

### Success metrics

Before running the gates, record a baseline for each fixture and select target values. The minimum metric set is:

- First useful page time and page-to-page navigation time.
- Peak resident memory in renderer, utility process, and total application.
- Source bytes read before first useful page and for a page-local request.
- Save latency, output size, qpdf validation time, and restart/reopen result.
- Cancellation completion time and process survival after malformed input.
- Text exactness, text-quads overlap, link and annotation record equality, and agreed raster difference budgets.
- Accessibility checks for text selection, keyboard focus, annotation names, and page order.
- Capability fallback rate by document feature, with no silent fallback.

The thresholds are deliberately not invented here. EVB should choose them from current user-visible acceptance goals and the baseline run. The report has not run these benchmarks.

## 7. Staffing, time, and migration order

These are estimates with high uncertainty because PDF compatibility failures appear late in the corpus.

| Work | People | Estimate | Confidence |
| --- | --- | --- | --- |
| Interface, adapter, import audit, and baseline corpus | One senior TypeScript/Electron engineer with part-time PDF review | 1 to 2 weeks | Medium |
| Native read spike with corpus and crash isolation | One senior systems engineer plus one EVB engineer | 2 to 4 weeks | Low to medium |
| Selected production slice for desktop page-local work and EVB save | Two engineers plus focused QA and release support | 2 to 4 months | Low |
| EVB-owned common annotation editor and retirement of PDF.js save | Two to three engineers plus interaction QA | 4 to 9 months, partly parallel with the native slice | Low |
| EVB-specific pure-Rust read and render subset, without broad forms, XFA, or JavaScript parity | Three to five engineers with compatibility and security ownership | 18 to 36 months or more | Very low |
| Broad PDF.js-class replacement with forms, XFA, JavaScript, full annotation editing, accessibility, browser and desktop hosts, and continuous security response | Five to eight engineers as a sustained product team | 3 to 5 years or more, then ongoing maintenance | Very low |

These are order-of-magnitude estimates, not commitments. The last two rows are warnings against treating a Rust parser or raster prototype as a general PDF.js replacement. A mature native backend may shorten the read and render work. It does not remove EVB's editor, accessibility, browser, packaging, corpus, and security obligations.

### Concrete 30 to 60 day plan

**Days 1 to 10.** Freeze the capability matrix and `IPdfEngine` contract. Move PDF.js imports behind the adapter. Add import tripwires. Record baseline metrics on the 882-page fixture, the 2,646-page fixture, the damaged-xref fixture, blank pages, and annotation persistence. Document the product decision for forms, XFA, JavaScript, and signatures.

**Days 11 to 25.** Implement a native utility-process read spike. Test file-backed page geometry, one raster page, text spans, links, password errors, malformed xref recovery, cancellation, and crash isolation. Compare with PDF.js. Evaluate PDFium and one pure-Rust candidate against the same interface. Keep the result read-only.

**Days 26 to 40.** Route one EVB annotation transaction through the existing native append or staged writer. Verify FreeText popup semantics, blank-page printing, qpdf validation, source-prefix identity, hard restart, and Linux. Reduce PDF.js editor-manager calls where the new EVB store can own the state.

**Days 41 to 60.** Decide whether the native path earns an opt-in large-document slice. If it passes, add production telemetry, packaging, and explicit fallbacks. If it fails, keep the PDF.js adapter improvements, retain native save and qpdf work, and record the exact stop reason. Do not start a full rewrite because a renderer spike looks promising.

### Migration order

1. Remove PDF.js types from product contracts.
2. Keep PDF.js as the adapter used for browser rendering and compatibility.
3. Make EVB annotation state the only product authority.
4. Keep save and publication in the existing native transaction path, improving its input and capability checks.
5. Add native desktop file-backed page geometry and page-local rendering behind the same engine interface.
6. Add native text and search only after exact text and accessibility tests pass.
7. Add selected standard annotation display and editing.
8. Evaluate browser Wasm for proven page-local pieces.
9. Revisit forms, XFA, JavaScript, signatures, and a broader engine only after product commitments and corpus results justify them.

This order can reduce large-file memory and save pressure without changing browser behavior or forcing a coordinated rewrite of the viewer shell.

## Recommendation

Adopt the EVB-owned engine seam and the staged desktop-first plan. Keep PDF.js for the browser, existing feature coverage, and fallback behavior. Move PDF.js's types and private editor calls behind the seam. Continue using the existing native Rust and qpdf-backed save path for large files, with its bounded inputs, checked offsets, validation, and atomic publication. Build a read-only native prototype before selecting PDFium, MuPDF, or a pure-Rust renderer.

Do not choose MuPDF without a license decision. Do not choose PDFium without a build, thread, large-offset, callback, and packaging proof. Do not choose Hayro or another pure-Rust candidate because its README lists attractive features. Do not write a full PDF.js-compatible Rust clone. The right first engine is smaller: it owns the file-backed source, page-local result types, EVB annotation records, and mutation writer, while it explicitly delegates unsupported PDF features to PDF.js.

## Final verdict on the hypothesis

The user's hypothesis is directionally correct but too broad. PDF.js is responsible for a real large-document memory and save ceiling, and EVB's direct use of PDF.js editor internals creates avoidable coupling. The recent record also contains independent failures in EVB session state, DOM scheduling, Electron file publication, pdf-lib printing, and difficult PDF codecs. Replacing PDF.js wholesale would spend most of the project reproducing behavior that is not causing those failures.

A native Rust direction is viable if "Rust engine" means an EVB-owned service with narrow contracts and selected native capabilities. It is not viable as a near-term promise to replace PDF.js in every role. The decision should be earned by the corpus, measurements, and stop conditions above.

## Files and sources inspected

### Repository guidance and local research

- `/Users/evb/AGENTS.md`, `CLAUDE.md`, and the repository instructions supplied for this task.
- [`docs/internal/research/rust-pdf-engine-rewrite-feasibility-2026-08-30.md`](rust-pdf-engine-rewrite-feasibility-2026-08-30.md), treated as a starting point.
- [`docs/internal/research/pdf-engine-architecture-assessment-2026-08-30.md`](pdf-engine-architecture-assessment-2026-08-30.md) and [`docs/internal/research/pdfjs-dependency-cost-assessment-2026-08-30.md`](pdfjs-dependency-cost-assessment-2026-08-30.md), both read without editing.
- [`package.json`](../../../packages/i18n-app/package.json), [`app/services/pdfjs/runtimeLib.ts`](../../../app/services/pdfjs/runtimeLib.ts), [`app/services/pdfjs/pdfViewerFacade.ts`](../../../app/services/pdfjs/pdfViewerFacade.ts), [`app/types/pdfContracts.ts`](../../../app/types/pdfContracts.ts), [`app/platform/browser-api/browserPdfjsDocumentInit.ts`](../../../app/platform/browser-api/browserPdfjsDocumentInit.ts), and [`app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts`](../../../app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts).
- [`app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts`](../../../app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts), plus the historical [`classifyPdfSaveRoute.ts`](https://github.com/evb0110/evb-viewer/blob/266c40084f96636efdff0175d6d03e1677dc0cad/app/modules/pdf-viewer/runtime/save/classifyPdfSaveRoute.ts), [`annotationEditorCompatibility.ts`](https://github.com/evb0110/evb-viewer/blob/ad3fa9b27658965de8c0e19a5f8f68fc1a1f4269/app/services/pdfjs/annotationEditorCompatibility.ts), [`useFreeTextResize.ts`](https://github.com/evb0110/evb-viewer/blob/ad3fa9b27658965de8c0e19a5f8f68fc1a1f4269/app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useFreeTextResize.ts), and [`createAnnotationEditorLayerFailureTracker.ts`](https://github.com/evb0110/evb-viewer/blob/3fada5ea4826f921f50d2cd3e21181abd0657ff6/app/modules/pdf-viewer/runtime/rendering/createAnnotationEditorLayerFailureTracker.ts). These former paths are historical evidence only.
- [`app/utils/pdfPrint.ts`](../../../app/utils/pdfPrint.ts), [`docs/architecture/pdf-viewer-architecture.md`](../../architecture/pdf-viewer-architecture.md), [`docs/architecture/freetext-note-persistence.md`](../../architecture/freetext-note-persistence.md), and [`docs/internal/pdf-annotations-feature-audit-2026-08-22.md`](../pdf-annotations-feature-audit-2026-08-22.md).
- [`native/pdf-page-ops/src/lib.rs`](../../../native/pdf-page-ops/src/lib.rs), [`native/pdf-page-ops/src/wasm.rs`](../../../native/pdf-page-ops/src/wasm.rs), [`native/pdf-page-ops/src/incremental.rs`](../../../native/pdf-page-ops/src/incremental.rs), [`native/pdf-page-ops/src/load_policy.rs`](../../../native/pdf-page-ops/src/load_policy.rs), and [`native/pdf-page-ops/Cargo.toml`](../../../native/pdf-page-ops/Cargo.toml).
- [`electron/features/documents/main/documentSaveUtilityProcess.ts`](../../../electron/features/documents/main/documentSaveUtilityProcess.ts) and [`electron/features/documents/main/documentSaveUtilityProtocol.ts`](../../../electron/features/documents/main/documentSaveUtilityProtocol.ts).
- GitHub issue records [#81](https://github.com/evb0110/evb-viewer/issues/81), [#106](https://github.com/evb0110/evb-viewer/issues/106), [#111](https://github.com/evb0110/evb-viewer/issues/111), [#122](https://github.com/evb0110/evb-viewer/issues/122), [#132](https://github.com/evb0110/evb-viewer/issues/132), [#139](https://github.com/evb0110/evb-viewer/issues/139), [#141](https://github.com/evb0110/evb-viewer/issues/141), [#143](https://github.com/evb0110/evb-viewer/issues/143), [#146](https://github.com/evb0110/evb-viewer/issues/146), and [#149](https://github.com/evb0110/evb-viewer/issues/149).

### Primary external sources

- [PDF.js repository, README, and license](https://github.com/mozilla/pdf.js), [v5.7.284 chunked stream](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/chunked_stream.js), [xref recovery](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/xref.js), [worker save](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/core/worker.js), [display API](https://github.com/mozilla/pdf.js/blob/v5.7.284/src/display/api.js), and [current v6.3.289 release](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289).
- [PDFium README](https://pdfium.googlesource.com/pdfium/+/main/README.md), [license](https://pdfium.googlesource.com/pdfium/+/main/LICENSE), [public view API](https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h), and [save API](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_save.h).
- [Electron utility process](https://www.electronjs.org/docs/latest/api/utility-process), [native code and Electron](https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron), and [Electron multithreading guidance](https://www.electronjs.org/docs/latest/tutorial/multithreading).
- [Rust `wasm32-unknown-unknown` target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html).
- [MuPDF.js README and APIs](https://github.com/ArtifexSoftware/mupdf.js), [MuPDF.js license section](https://github.com/ArtifexSoftware/mupdf.js#license), and [MuPDF COPYING](https://github.com/ArtifexSoftware/mupdf/blob/master/COPYING).
- [Hayro repository and feature status](https://github.com/LaurenzV/hayro), [zpdf repository and current v0.13.0 source](https://github.com/Xero-Team/zpdf/tree/2777fef85e6f4662551bea1bf0667bbbf19857e6), and [lopdf FAQ and limitations](https://github.com/J-F-Liu/lopdf#frequently-asked-questions).

## Commands and verification

Read-only inspection used `git status --short`, `git log`, `rg --files`, `rg -n`, `sed`, `nl -ba`, and `wc`. GitHub evidence used `gh issue view` for the issue records above and `gh api` for PDF.js tags, the current release, repository metadata, and license metadata. The PDFium source and license were fetched read-only from its official Gitiles endpoints and decoded in memory for inspection.

No repository tests or benchmarks were run for this research report. The proposed metrics and gate thresholds are plans, not results.

After writing, the intended verification is:

```text
git diff --check --no-index /dev/null docs/internal/research/pdf-engine-strategy-assessment-2026-08-30.md
rg -n $'\\u2014|\\u201c|\\u201d|\\u2019' docs/internal/research/pdf-engine-strategy-assessment-2026-08-30.md
git status --short
```

The only repository file created or edited for this task is `docs/internal/research/pdf-engine-strategy-assessment-2026-08-30.md`. The three pre-existing untracked research drafts remain untouched. A clean reference clone of zpdf was created under `/Users/evb/oss-repos` for read-only source inspection.
