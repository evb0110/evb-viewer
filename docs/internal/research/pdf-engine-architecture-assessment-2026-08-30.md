# PDF engine architecture assessment

> **Status (2026-08-30): superseded by [ADR 0002](../../architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md) and wayfinder map #150.**
> Its defect table and "five views of an annotation" analysis stand. Corrections
> from review: hayro does support password-protected files
> (`Pdf::new_with_password`, hayro-syntax `pdf.rs`); the plan's order (PDFium
> spike before EVB annotation ownership) was rejected because the evidence puts
> the bugs in the editor seam, not the raster.

Research date: 2026-08-30

Scope: whether PDF.js is the main cause of EVB Viewer's recurring PDF problems, and whether a native Rust replacement is a sensible response

Status: architecture assessment. No implementation or benchmark was performed for this note.

## Decision

The suspicion is directionally right but too broad.

PDF.js imposes a real ceiling on EVB's largest documents. Current upstream code still reserves a JavaScript byte array whose length equals the complete range-backed document. Its save implementation still supplies the complete original byte array to the incremental writer. EVB's patched 5.7.284 build works around these assumptions for reading and refuses unsafe range-backed materialization and saving. This is a durable reason to move large desktop PDF work out of PDF.js.

PDF.js is not the direct cause of most recent EVB defects. The inspected issue history contains many EVB-owned failures in document identity, viewport ownership, save transactions, file witnesses, dense page collections, layout, and synchronization between the PDF.js editor layer and EVB's canonical annotations. A different parser or renderer would leave those failures intact unless the rewrite also fixes state ownership and the module seams.

I would not approve a literal PDF.js rewrite in Rust. I would approve a desktop-first native page-engine program behind an EVB-owned interface. Keep PDF.js as the browser adapter and compatibility fallback at first. Keep the existing qpdf-backed structural reader and checked-`u64` Rust writer for bounded saves. Test mature renderers behind the native adapter before EVB commits to writing fonts, graphics, color, image decoding, and malformed-file recovery itself.

Pure Rust remains a possible long-term implementation choice. It is not the right initial commitment.

## What current upstream proves

EVB pins `pdfjs-dist` 5.7.284. The current PDF.js checkout inspected for this note was upstream commit [`abc6d413c`](https://github.com/mozilla/pdf.js/commit/abc6d413c572b4d71b8898d691813e53ccd83b3a), twelve commits after tag 6.3.289.

The important large-file assumptions remain upstream:

- [`ChunkedStream`](https://github.com/mozilla/pdf.js/blob/abc6d413c572b4d71b8898d691813e53ccd83b3a/src/core/chunked_stream.js#L28-L34) constructs `new Uint8Array(length)` for a range-backed document. Range loading reduces bytes fetched, but it does not make the core address space sparse.
- [`ChunkedStreamManager.sendRequest`](https://github.com/mozilla/pdf.js/blob/abc6d413c572b4d71b8898d691813e53ccd83b3a/src/core/chunked_stream.js#L284-L314) collects every response chunk for one request and concatenates them before delivery.
- [`SaveDocument`](https://github.com/mozilla/pdf.js/blob/abc6d413c572b4d71b8898d691813e53ccd83b3a/src/core/worker.js#L794-L820) visits every page and returns `stream.bytes` even when nothing changed.
- The incremental writer receives [`originalData: stream.bytes`](https://github.com/mozilla/pdf.js/blob/abc6d413c572b4d71b8898d691813e53ccd83b3a/src/core/worker.js#L870-L883).

An upgrade from 5.7.284 to 6.3.289 may fix individual rendering and editor bugs. It does not remove EVB's large-file allocation or save ceiling.

EVB's 1,358-line patch to the built standard and legacy bundles changes these exact paths. It replaces the dense chunk buffer with stored chunks, splits large range requests, adds bounded damaged-xref recovery, supports multi-part range delivery, and rejects `GetData` and `SaveDocument` on range-backed sources. The patch also carries editor, text-layer, and image-mask changes. Some of those lines duplicate the same implementation in the standard and legacy bundles, but the maintenance liability is still real. Upgrades must rebase changes inside PDF.js worker and display internals.

## What PDF.js causes, and what it merely touches

The useful distinction is between an engine limit, integration coupling, and an EVB defect.

| Problem class | Representative evidence | Would replacing PDF.js fix it? |
| --- | --- | --- |
| Dense range-backed allocation and whole-byte-array save | Current upstream `ChunkedStream` and `SaveDocument`; EVB's bounded-range patch and native-save refusal | Yes, if the replacement uses file-backed or sparse range access and a bounded writer |
| Damaged, non-linearized file forces near-complete recovery reads | [Issue #111](https://github.com/evb0110/evb-viewer/issues/111) recorded 99.385 percent of a 162.6 MiB file requested before `getDocument` resolved | Partly. Another engine may recover faster, but damaged-xref reconstruction can require a complete scan in any implementation |
| Custom range transport races and teardown | [Issue #141](https://github.com/evb0110/evb-viewer/issues/141) exercised EVB's patched transport in a Node worker | A new engine removes this particular integration, but it needs its own cancellation, stale-session, and range-delivery contract |
| PDF.js editor state disagrees with canonical annotations or durable objects | [Issue #100](https://github.com/evb0110/evb-viewer/issues/100), [#125](https://github.com/evb0110/evb-viewer/issues/125), and [#139](https://github.com/evb0110/evb-viewer/issues/139) | Only if EVB also establishes one annotation owner. Swapping renderers while retaining multiple editor states reproduces the same class of bug |
| Stale sidebar, fit-mode page jumps, and viewport disagreement | [Issue #106](https://github.com/evb0110/evb-viewer/issues/106) traced the defect to EVB's ordering and interaction epoch | No |
| Save, Save As, sidecar, journal, rollback, and external-edit consistency | [Issue #122](https://github.com/evb0110/evb-viewer/issues/122) and [#146](https://github.com/evb0110/evb-viewer/issues/146) | No. These are host transaction and filesystem problems |
| Dense page layout, thumbnail scroll limits, and outline truncation | [Issue #132](https://github.com/evb0110/evb-viewer/issues/132) | No. These collections belong to EVB and Chromium layout |
| Blank page fails facing-page print embedding | [Issue #143](https://github.com/evb0110/evb-viewer/issues/143) traced it to `pdf-lib` | No |
| Nine-second FreeText placement stall | [Issue #149](https://github.com/evb0110/evb-viewer/issues/149) was fixed by bounding EVB's `collectEditorCommentSummaries` scan to materialized annotation pages | No |
| Truncated arithmetic data in EVB's Rust JBIG2 codec | [Issue #81](https://github.com/evb0110/evb-viewer/issues/81) | No |

The pattern is uncomfortable but useful. PDF.js is both a hard limit and a complexity multiplier. It is not a universal root cause.

The annotation problems are the best example. EVB can have all of these at once:

1. A live PDF.js editor and its private identity.
2. PDF.js `annotationStorage` state.
3. An EVB canonical annotation entity and undo history.
4. A projected native mutation.
5. A durable PDF object after save and reopen.

Keeping those five views synchronized is harder than parsing a `/FreeText` dictionary. A native renderer will not help unless EVB reduces the number of authorities.

## EVB does not need all of PDF.js

EVB does not need the complete upstream reference viewer, its controls, localization, presentation mode, or every form and scripting feature. It already owns the application shell, page virtualization, navigation, print planning, save transactions, OCR, page operations, and much of annotation policy.

The needed subset is still substantial:

- file-backed and range-backed open, passwords, page count, boxes, rotation, and labels;
- rasterization with fonts, CMaps, JPEG, JPEG 2000, JBIG2, CCITT, masks, ICC color, transparency, blend modes, patterns, clipping, Type 3 fonts, and malformed-file recovery;
- page-local text with Unicode, bidi ordering, ligatures, character geometry, selection offsets, and search geometry;
- outlines, destinations, links, permissions, and the static annotations EVB displays;
- cancellation, cache limits, stale-session fencing, and process recovery;
- round-trip behavior for FreeText, highlight, stamp or placed image, ink, popup notes, and deletion;
- native incremental mutation with checked 64-bit offsets and fail-closed validation.

Features that can remain on a compatibility path include XFA, PDF JavaScript, rich form editing, signature workflows, multimedia, and uncommon annotation types. EVB should report unsupported capabilities rather than silently flatten or discard them.

The hard part of PDF.js is inside the subset EVB needs. Fonts, page interpretation, text geometry, images, color, and malformed documents dominate renderer compatibility. Deleting the upstream viewer UI does not make that work small.

Current coupling confirms this. Seventy-eight production files directly import `pdfjs-dist` or one of its subpaths. `app/types/pdfContracts.ts` re-exports `PDFDocumentProxy` and `PDFPageProxy`, so the apparent project contract is still a PDF.js contract. Runtime probes require `AnnotationLayer`, `AnnotationEditorLayer`, `AnnotationEditorUIManager`, `DrawLayer`, `TextLayer`, seven editor modes, twelve editor parameters, and thirteen UI-manager methods. EVB also patches or intercepts editor behavior that PDF.js does not expose as a stable product interface.

## The architecture I recommend

Use shared EVB semantics, not one mandatory implementation on every host.

```text
Vue viewer, virtualization, viewport and interaction state
  |
  +-- EVB page-engine session
  |     |
  |     +-- PDF.js adapter for browser and compatibility fallback
  |     |
  |     +-- native utility-process adapter for desktop
  |             renderer and text backend behind Rust-owned IPC
  |
  +-- EVB canonical annotation module
        |
        +-- EVB-owned DOM or SVG editor overlay
        |
        +-- canonical mutations
               |
               +-- existing qpdf structural reader and checked-u64 Rust writer
```

The page-engine interface should be deep and small. Callers need document identity, page information, bounded raster output, page-local text and navigation data, cancellation, and close. They should not receive `PDFDocumentProxy`, `PDFPageProxy`, PDF.js operator arrays, native pointers, or renderer-specific editor objects.

Durable mutation should remain a separate module. A renderer's save function is not the owner of EVB's working-copy promotion, external-edit witness, sidecar revision, journal, rollback, or reopen verification. The existing native writer has already proved that an append-only, checked-`u64` path can save the real 882-page fixture without replaying the source bytes. Replacing that with a renderer's generic `saveToBuffer` would be a regression.

Interactive annotations deserve their own migration. Make the EVB canonical store the sole owner of selection, editor identity, geometry, undo, and dirty state. PDF.js can remain the static page and text renderer while EVB removes `AnnotationEditorUIManager` as a second authority. This change targets more observed annotation failures than a parser rewrite does, and it lowers the feature burden on every future native engine.

Do not put Rust page boxes into production while PDF.js still owns the corresponding raster and text geometry unless a complete page result is proven consistent. Mixed partial ownership creates another synchronization problem. The first production native slice should be a coherent read-only page vertical: open, geometry, render, text, links, static annotations, cancellation, and close.

## Backend choices

### PDFium

PDFium is the first permissive mature renderer I would test. Its [public embedder interface](https://pdfium.googlesource.com/pdfium/) is intended to remain stable, and its project runs unit, embedder, corpus, JavaScript, and pixel tests. Chromium coverage includes its fuzzers. The public API exposes rendering, text, annotations, custom reads, and incremental save flags.

It also has sharp constraints for EVB:

- PDFium says its public calls are not thread-safe. A single-threaded utility-process owner fits that rule.
- The current [`FPDF_FILEACCESS`](https://pdfium.googlesource.com/pdfium/+/main/public/fpdfview.h) uses `unsigned long` for file length and offsets. That is 32 bits on Windows. A direct path loader may behave differently, but files beyond 4 GiB require an exact Windows proof before adoption.
- [`FPDF_SaveAsCopy`](https://pdfium.googlesource.com/pdfium/+/main/public/fpdf_save.h) exposes an incremental flag through a sequential writer callback. EVB must measure whether it copies source bytes, how it handles multi-gigabyte inputs, and whether it preserves the current append transaction. Do not assume that "incremental" means bounded in-place append.
- PDFium is C++, so Rust provides ownership, IPC, error conversion, and host integration rather than memory safety inside the renderer.

### MuPDF

MuPDF is the strongest turnkey technical candidate. The official [MuPDF.js](https://github.com/ArtifexSoftware/mupdf.js/) wraps the C engine in WebAssembly and exposes rendering, structured text, search, annotations, page operations, journaling, and save. This makes it a useful comparison even if EVB only adopts a native build.

The license requires a deliberate product decision. MuPDF.js is AGPL-3.0 or commercial. Its examples also open complete buffers, so browser range behavior and large-file memory must be proved rather than inferred from WebAssembly support.

### Hayro and a pure Rust stack

[Hayro](https://github.com/LaurenzV/hayro) is the most credible pure Rust renderer to spike today. It has separate syntax, interpretation, raster, SVG, JPEG 2000, JBIG2, CCITT, PostScript, and CMap crates. It has moved far enough that dismissing pure Rust outright would be unfair.

Hayro still calls itself experimental and work in progress. It names unsupported rendering cases and says performance has not yet been a focus. Its demo explicitly omits text selection, search, annotations, and forms. That makes it a valuable differential renderer and a poor production commitment until EVB's corpus says otherwise.

`lopdf` remains useful for bounded structural work and writing, but its retained document model is not a large-file renderer. EVB's current policy of using it for smaller inputs and switching to qpdf-backed stream-free structure for large paths is sound.

### Writing a renderer from scratch

Reject this as the initial plan. Rust removes many memory-safety failures. It does not supply font substitution, CMaps, graphics interpretation, color management, decompression limits, malformed-file recovery, or a compatibility corpus. A home-grown renderer also becomes a security product. Rust prevents use-after-free in safe code; it does not prevent decompression bombs, recursive object graphs, oversized rasters, or CPU denial.

## A staged decision, not a rewrite project

### Stage 0: make the comparison trustworthy

Build one engine conformance harness around EVB's existing fixtures and contracts. It should compare page count, geometry, raster output, text and UTF-16 offsets, links, outlines, static annotations, cancellation, memory, and errors. Keep each mismatch as a fixture and diagnosis, not a loose visual judgment.

Include the 882-page and 2,646-page Zaliznyak files, the damaged 1,859-page dictionary from issue #111, sparse files beyond 4 GiB and 10 billion bytes, encrypted documents, mixed page boxes, unusual fonts, JPEG 2000, JBIG2, ICC color, transparency, Type 3 fonts, forms, and malformed but accepted inputs.

### Stage 1: run a native read-only spike

Test PDFium and one other backend. Use MuPDF if licensing evaluation is acceptable, otherwise use Hayro. Put each behind the same Rust-owned utility-process protocol. Do not integrate it into normal saves or annotation editing.

The spike must answer:

- Can it open the exact files without memory proportional to source size?
- Can it render first, middle, and final pages with acceptable pixel and geometry differences?
- Can its text results preserve EVB's search and selection contracts?
- Does cancellation stop queued work and free page buffers?
- Does a renderer crash leave the main app recoverable?
- Can every signed platform package and launch the backend?
- Can Windows open the 2.17 GiB fixture and a valid file above 4 GiB?

This is likely a two-to-four-week engineering spike for one mature backend and one pure Rust comparison, not a production rewrite estimate.

### Stage 2: remove PDF.js types from the viewer seam

Make the existing PDF.js path the first adapter to EVB-owned document and page values. Replace direct `PDFDocumentProxy`, `PDFPageProxy`, and editor-manager dependencies only when the native adapter needs the same call site. Do not add a forest of pass-through interfaces.

### Stage 3: establish one annotation owner

Move the supported interactive tools to the canonical EVB overlay and compile canonical changes into the existing native mutation path. Keep PDF.js or the native engine responsible for static page content, text, links, and unsupported compatibility features.

### Stage 4: switch desktop reads by capability

Enable the native engine for measured document classes. Keep explicit fallback telemetry. Do not silently retry through PDF.js after a native parse, render, or text mismatch, because that hides compatibility gaps and can reintroduce the large-file allocation path.

### Stage 5: reconsider browser WebAssembly

Only after the desktop interface and corpus are stable should EVB decide whether sharing a Rust or C-backed engine with the browser pays for itself. The browser can remain on PDF.js much longer. Requiring one engine everywhere now couples the desktop solution to WebAssembly memory, range I/O, binary size, startup, hosting headers, and browser save output before those constraints have earned their cost.

## Go or no-go criteria

Proceed beyond the spike only if one backend meets all of these conditions:

- source-size-independent memory on the exact large fixtures;
- checked offsets and working Windows behavior beyond the present 2 GiB class, including an explicit result above 4 GiB;
- acceptable raster and text agreement on EVB's corpus, with named unsupported features;
- bounded cancellation and process recovery;
- no renderer main-thread work proportional to page count;
- reproducible macOS, Windows x64, Windows ARM64, Linux x64, and Linux ARM64 packaging;
- a clear license EVB can satisfy;
- no regression in the staged-file save transaction or checked-`u64` writer;
- enough deleted PDF.js coupling to justify the new native build and security burden.

If PDFium or MuPDF passes rendering and text but fails large-save semantics, use it only as the page engine. If Hayro passes rasterization but lacks text and annotations, keep it as a comparison until its missing capabilities or EVB-owned replacements are ready. If no backend passes, continue the current hybrid and deepen the bounded native operations that already solve measured problems.

## Bottom line

PDF.js is the wrong long-term core for EVB's largest desktop documents. That part of the concern is correct and is visible in current upstream source, not merely in old EVB bugs.

The radical project should be framed as "make PDF.js one replaceable adapter and make EVB own document and annotation semantics." It should not be framed as "port PDF.js to Rust."

The practical target is a native desktop page engine owned through Rust, a mature renderer selected by evidence, EVB-owned annotation editing, and the existing bounded native writer. Browser replacement can wait. A pure Rust renderer may eventually win that backend slot, but EVB should make it earn the decision on the exact corpus rather than funding a multi-year compatibility rewrite on faith.
