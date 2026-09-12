# Xlarge document path architecture

Date: 2026-08-27

Status: decision record and source ratchet for desktop path-backed document flows.

## Boundary

Desktop document APIs take a path or another file-backed document reference. They return a path, or bounded chunks no larger than 8 MiB. A whole-document JavaScript value is an explicitly small compatibility exception, not the transport for an xlarge document.

The open-path performance policy allows at most 16 MiB for normal in-memory PDF compatibility work and 4 MiB under the low-memory profile. The surrounding transports have their own bounds:

- `DEFAULT_DOCUMENT_READ_CHUNK_BYTES` is 4 MiB.
- `PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES` is 8 MiB.
- `IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES` is 16 MiB.
- Blob-backed PDF.js loading and browser whole-value reads are limited to 16 MiB. Larger browser records remain range-backed in 4 MiB chunks.
- The annotation index uses 4 MiB chunks.
- The embedded-shape index lets the renderer request 512 KiB at a time. A native JSONL line may be at most 4 MiB.
- Desktop PDF.js compatibility search uses 1 MiB range windows and a 16 MiB input classifier. Larger files use page-bounded Poppler extraction.

These numbers bound a transfer, a compatibility operation, or decoded work. They do not cap an encoded path-backed PDF. The native loader uses `MAX_ENCODED_PDF_BYTES = 512 MiB` to choose eager lopdf loading or the qpdf structural reader. The threshold alone does not reject a path, although the loader returns a typed `too-large` error if the required qpdf reader is unavailable. `PDF_PATH_LOAD_POLICY.max_pages` is `None`; `MAX_BYTE_INPUT_PDF_PAGES = 100_000` belongs only to the byte-input policy. A 100,000-page limit is not a valid path-backed product cap. Path loading still enforces structural safety budgets, including at most 1,000,000 PDF objects and a 512 MiB qpdf JSON sidecar. A PDF with many objects per page can therefore hit a structural budget even though no rule rejects its encoded size or page count directly.

For a desktop path above the small-input classifier, native or worker failure must become a typed capability error or a typed source-access omission. The caller must not retry by reading the whole PDF in JavaScript. The annotation path records `unreadable-source` when its native index cannot serve the path. The native combine path reports `PdfCombineCapabilityError` in strict mode. See [nativeErrors.ts](../../../packages/contracts/nativeErrors.ts), [pdfCombineErrors.ts](../../../electron/image/pdfCombineErrors.ts), and the [historical `preparePdfAnnotationNameRead.ts`](https://github.com/evb0110/evb-viewer/blob/ad3fa9b27658965de8c0e19a5f8f68fc1a1f4269/app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/preparePdfAnnotationNameRead.ts). The former annotation-name helper path is no longer tracked at the current tree.

## Verified fixture and structural measurement

The verified stress fixture is 2,168,527,413 bytes and has 2,646 pages. The recorded qpdf structural pass produced 7,890,472 bytes, finished in 0.52 seconds, and used about 53 MB RSS. The pass used qpdf JSON v2 with stream data omitted:

```text
qpdf --suppress-recovery \
  --json-output=2 \
  --json-key=qpdf \
  --json-stream-data=none \
  --decode-level=none \
  input.pdf > structural.json
```

This is a structural-read measurement. It is not evidence that a complete PDF byte array is safe to allocate. Encoded image and content streams stay on disk. The structural sidecar still needs object, string, nesting, timeout, and retained-memory limits.

The qpdf approach follows the earlier EVB Viewer incremental-save decision in [the multi-GiB save record](./multi-gib-native-incremental-save-2026-08-26.md). qpdf's [JSON format](https://qpdf.readthedocs.io/en/stable/json.html) documents the `qpdf` object section and the `--json-stream-data=none` mode. qpdf's [CLI exit-status rules](https://qpdf.readthedocs.io/en/stable/cli.html#exit-status) remain part of admission. A warning or recovery result is not a clean structural basis for mutation.

## Static ratchet

[The historical `xlargeDocumentPathArchitecture.test.ts`](https://github.com/evb0110/evb-viewer/blob/f7fbdcfa9a79636e27490ee527831fa74b07d237/tests/unit/architecture/xlargeDocumentPathArchitecture.test.ts) walks the production source roots `app`, `electron`, and `packages`. It inventories direct whole-document call sites, skips browser modules, and classifies image reads and generated one-page OCR sidecars separately. The test compares discovered module and primitive keys with the reviewed allowlist. A new key fails. A changed occurrence count fails. Empty, duplicate, missing, and stale entries fail. The test is historical evidence and is no longer tracked at this path.

The current allowlist has 24 exact module/primitive entries covering 30 call occurrences.

| Primitive | Entries | Occurrences |
| --- | ---: | ---: |
| `readDocumentBytes` | 4 | 7 |
| `PDFDocument.load` | 13 | 15 |
| PDF.js `getData` | 1 | 1 |
| PDF.js `saveDocument` | 1 | 1 |
| `fs.readFile` | 5 | 6 |
| `fs.readFileSync` | 0 | 0 |
| `Blob/File.arrayBuffer` | 0 | 0 |

The allowlist is debt inventory, not permission to add another whole-document call. Each entry still records a maximum-byte classifier, the reason the call remains, and the condition that removes it.

### `readDocumentBytes`, 4 entries and 7 occurrences

- `app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient.ts`, 2 occurrences.
- `app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest.ts`, 1 occurrence.
- `app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization.ts`, 2 occurrences.
- `app/modules/workspace-shell/composables/useWorkspaceSplitPayload.ts`, 2 occurrences.

The open-path call in `createDocumentOpenFlow.ts` is not an inventory entry. It checks the file size and passes `maxBytes: maxInMemoryPdfBytes` before reading.

### `PDFDocument.load`, 13 entries and 15 occurrences

- `app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage.ts`, 1 occurrence.
- `app/modules/pdf-viewer/engine/pdf-bookmark-serialization/rewriteBookmarks.ts`, 1 occurrence.
- `app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.ts`, 1 occurrence.
- `app/modules/pdf-viewer/engine/pdf-serialization-operations/deleteEmbeddedAnnotation.ts`, 1 occurrence.
- `app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits.ts`, 1 occurrence.
- `app/modules/pdf-viewer/engine/pdf-serialization-operations/updateEmbeddedAnnotationText.ts`, 1 occurrence.
- `app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings.ts`, 1 occurrence.
- `app/utils/stripPdfEncryption.ts`, 1 occurrence.
- `electron/features/page-ops/main/cropLocal.ts`, 2 occurrences.
- `electron/image/pdfCombineShared.ts`, 1 occurrence.
- `electron/image/pdfConversion.ts`, 1 occurrence.
- `packages/pdf-core/loadPdfStructure.ts`, 1 occurrence.
- `packages/pdf-core/pdfPrintLayout.ts`, 2 occurrences.

The browser PDF-lib operations under `app/platform/browser/` and `app/platform/browser-api/` are explicit browser exceptions. The generated one-page sidecars in `electron/ocr/worker/pdfAssembler.ts` remain outside this inventory.

### PDF.js `getData` and `saveDocument`, 2 entries and 2 occurrences

- `app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage.ts`, `getData`, 1 occurrence.
- `app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts`, `saveDocument`, 1 occurrence.

### `fs.readFile`, 5 entries and 6 occurrences

- `electron/features/page-ops/main/cropLocal.ts`, 2 occurrences.
- `electron/image/pdfCombineShared.ts`, 1 occurrence.
- `electron/image/pdfConversion.ts`, 1 occurrence.
- `electron/image/tryCreatePdfFromInputPathsNative.ts`, 1 occurrence.
- `electron/image/tryCreatePdfWithNativeImageCombiner.ts`, 1 occurrence.

The inventory includes input reads and byte-returning reads of generated PDF output. It excludes text reads with explicit UTF-8 encoding, direct range reads, image inputs, and generated previews. The removed DjVu export read and the removed print-handoff load/read are intentionally absent. They must not return as allowlist entries.

## Native shape-index fail-closed path

The path importer checks `isNativeEmbeddedShapeIndexSource(path)` first and calls `importEmbeddedShapeAnnotationsFromNativePath`. That branch contains no `readDocumentBytes`, `path-start`, or `path-chunk` transport. The native service runs `evb-pdf-page-ops(embedded-shape-index)` with qpdf, writes a sidecar, and exposes `readPdfEmbeddedShapeIndexChunk`, `cancelPdfEmbeddedShapeIndex`, and `releasePdfEmbeddedShapeIndex`. The renderer fallback remains an explicitly classified compatibility route.

This is the shape-index boundary used by the architecture test. The test no longer treats the old renderer path-chunk worker as the native xlarge route.

## Explicit false positives

The scanner does not treat every `readFile` as a PDF read. It proves these classes remain separate:

- Raster and image inputs in `electron/djvu/buildOptimizedPdf.ts`, `electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu.ts`, `electron/features/image-export/main/export.ts`, and `electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal.ts`.
- JPEG and PNG preview outputs in `electron/features/documents/main/nativePdfPreview.ts`, `electron/features/djvu/main/pagePreview.ts`, and `electron/features/scan-cleanup/createScanCleanupPreviewService.ts`.
- Image input reads in `electron/image/pdfCombineShared.ts`, alongside its separate PDF input read.
- Generated one-page source and OCR PDFs in `electron/ocr/worker/pdfAssembler.ts`. Each sidecar crosses the 16 MiB pdf-lib trust boundary before assembly.
- Blob reads for placed images and captured page images in the renderer.
- The OCR model response buffer in `electron/ocr/languageModels.ts`.
- Browser document and print buffers under the browser platform modules and the browser-only `app/utils/pdfPrint.ts`.

A new call in one of these classes still needs source-shape review. The test pins representative patterns so an image or sidecar read cannot silently become a document read.

## Valid safety budgets

These budgets protect decoded work, transport, temporary files, or cancellation. They are not encoded-byte or path-page product caps:

- The default document reader uses 4 MiB range chunks. Persistence uses 8 MiB frames. Direct binary IPC uses 16 MiB. The annotation index uses 4 MiB chunks. The shape index uses 512 KiB renderer pulls and 4 MiB native JSONL lines.
- Serialized persistence has no fixed document-total ceiling. It accepts safe-integer totals and bounds each frame, active session count, sender ownership, revision, and accumulated byte arithmetic.
- Browser search has no encoded document-size admission cap. It reads range-backed records on demand while retaining page-result, decoded-text, cache, and cancellation budgets.
- PDF.js desktop compatibility search uses a 1 MiB range window and switches at 16 MiB. Poppler limits one page's extracted text to `PDFTOTEXT_MAX_PAGE_BYTES = 8 MiB`. OCR text visibility uses a 16 MiB page budget and 4 MiB stream windows.
- Print raster work uses `PRINT_RASTER_CHUNK_PAGES = 50`, `PRINT_RASTER_MAX_PAGES = 100`, and `PRINT_RASTER_MAX_TOTAL_PIXELS = 64,000,000` for the raster job. These protect rendered work; they do not reject an encoded path at a page count.
- qpdf structural parsing bounds the JSON sidecar at 512 MiB, estimated retained structure at 256 MiB, one object at 64 MiB, one object at 1,000,000 JSON elements, diagnostics at 1 MiB, and runtime at 110 seconds. The native shape sidecar has a separate 256 MiB bound.
- Native PDF loading bounds decoded streams at 64 MiB, object count at 1,000,000, structural nesting at 256, and cross-reference revisions at 4,096. Its path policy leaves `max_pages` unset.
- Stable path identity, source length, revision token, append offset, rollback checks, abort signals, cancellation groups, and stale-sidecar cleanup protect the mutation and temporary-file lifetimes.

The byte-input compatibility policy still tests the 100,000-page admission rule. The path-backed policy deliberately accepts a declared count above that rule. The distinction matters. A structural or scratch limit can reject abusive input without turning an encoded page count into a product ceiling.

## Current compatibility debt and exact guards

The remaining entries are compatibility operations. Their guards must stay local to the operation, and their callers must not use them for an xlarge path:

- Embedded-shape renderer fallback uses `EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES = 96 MiB`. The native qpdf shape-index branch bypasses this fallback. Removing the two `readDocumentBytes` and the matching `PDFDocument.load` is the follow-up once the fallback returns a typed capability result.
- Serialization worker transfer uses the shared 16 MiB compatibility budget and copies in 8 MiB steps. Its reload helper rejects native document references with `NativePdfSaveRequiredError` before calling `readDocumentBytes`.
- `usePdfSerialization.ts` and split-payload compatibility reads use the shared 16 MiB classifier. Native references fail closed before those reads. Dirty native split capture clones the native mutation projection into a disposable path-backed snapshot. Document persistence no longer exposes a working-copy whole-byte reader and adopts native saves as revision-bound path state.
- The renderer annotation, bookmark, edit, encryption, print-layout, and structure helpers accept caller-owned `Uint8Array` values and have no helper-local maximum-byte classifier. Desktop path callers must use the native path operation or remain explicitly small.
- `electron/image/pdfConversion.ts` keeps `PDF_COMBINE_SMALL_MEMORY_MAX_INPUT_BYTES` at 512 MiB per input, `PDF_COMBINE_SMALL_MEMORY_MAX_TOTAL_INPUT_BYTES` at 1 GiB, `PDF_COMBINE_SMALL_MEMORY_MAX_OUTPUT_BYTES` at 512 MiB, and `PDF_COMBINE_LOCAL_FALLBACK_MAX_TOTAL_BYTES` at 16 MiB. These belong to the in-memory compatibility and worker-startup fallback routes.
- `electron/image/pdfCombineShared.ts` defaults to 512 MiB per input, 500 pages, 250 TIFF frames, 80,000,000 image pixels, and 512 MiB output. These are JS image/PDF combine resource limits, not the strict file-backed xlarge route.
- `electron/features/page-ops/main/cropLocal.ts` keeps two `readFile` calls and two `PDFDocument.load` calls as a small-input compatibility fallback. `nativeCrop.ts` checks the working-copy size before this path and throws a typed capability error above 16 MiB. Page geometry uses the same native-first boundary and returns the compact native result without entering this fallback. Remove these calls when native crop and geometry no longer need the compatibility route.
- `electron/image/tryCreatePdfWithNativeImageCombiner.ts` bounds native input at 4,096 MiB and byte-returning output through `NATIVE_PDF_IMAGE_COMBINE_MAX_OUTPUT_BYTES`, defaulting to 512 MiB from `EVB_PDF_COMBINE_MAX_OUTPUT_MB`. The remaining `readFile` exists only because this API returns bytes instead of retaining the validated output path.
- `electron/image/tryCreatePdfFromInputPathsNative.ts` uses `FILE_BACKED_NATIVE_ASSEMBLER_MAX_PAGES = Number.MAX_SAFE_INTEGER` and, in strict file-backed mode, `maxOutputBytes = Number.MAX_SAFE_INTEGER`. Its memory compatibility mode keeps the 500-page default, the 10,000-page environment ceiling, and the 512 MiB output limit. The remaining `readFile` is the byte-returning compatibility API, not a path-backed product cap.

The next cleanup pass should remove each entry when the caller retains a path, consumes bounded continuing chunks, or receives a typed capability error. Raising a compatibility ceiling is not a cleanup and must not be used to admit a path-backed xlarge document.

## Acceptance evidence

The focused static gate passed on 2026-08-27 with five tests and one file:

```text
pnpm exec vitest run --project unit-static-architecture tests/unit/architecture/xlargeDocumentPathArchitecture.test.ts --reporter verbose
```

The gate checks the current 24-entry, 30-occurrence inventory; the 4 MiB, 8 MiB, 16 MiB, and native shape-index transport contracts; the native annotation and shape fail-closed branches; typed combine errors; and source-shaped false-positive exclusions. `git diff --check` and the scoped ESLint command are the final text and style checks for this note.

Two isolated Electron acceptance lanes passed against the exact fixtures. They did not touch the default development session.

- The original Zaliznyak PDF was 722,176,299 bytes and 882 pages. Mixed toolbar note plus two ordinary FreeText annotations saved and reopened in 47.437 seconds. The ordinary FreeText-only case saved and reopened in 30.805 seconds.
- The three-copy fixture was exactly 2,168,527,413 bytes and 2,646 pages. The full acceptance test passed in 102.375 seconds. Initial open took 328 ms. Rendering pages 1, 1,323, and 2,646 took 299.3 ms, 783.4 ms, and 818.8 ms. Native save took 29.755 seconds. Fresh renderer reload took 4.860 seconds. The final native annotation index took 2.429 seconds.
- The 2.17 GB run verified six baseline annotations, two distinct ordinary FreeText objects, one toolbar FreeText object, and its Popup after reload. Structural qpdf checks verified all three inserted texts. The largest renderer heartbeat gap was 2.152 seconds against a 3 second budget. Renderer heap deltas were 246,332,328 and 263,831,636 bytes against a 512 MiB budget. The largest recorded IPC payload was 1,975 bytes.

The acceptance run exercises these boundaries:

1. Desktop open, save, annotation indexing, page operations, search, OCR, print, and combine flows keep xlarge input path-backed or chunked.
2. Native and worker failures do not retry through `readDocumentBytes`, PDF.js `getData`, `PDFDocument.load`, or an unbounded PDF `readFile`.
3. The native qpdf path preserves source identity, checked offsets, append-tail validation, cancellation, and reopen checks without allocating the encoded source as one JavaScript value.
4. Browser buffers, image reads, UTF-8 metadata, and one-page OCR sidecars stay outside the document inventory through source-shaped exclusions.
