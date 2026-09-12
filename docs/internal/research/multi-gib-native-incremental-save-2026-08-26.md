# Multi-GiB native incremental PDF saves

Date: 2026-08-26

Baseline: EVB Viewer commit [`59d6f4aad40d29ff181f0526abb638a3285b6305`](https://github.com/evb0110/evb-viewer/commit/59d6f4aad40d29ff181f0526abb638a3285b6305), lopdf 0.44.0, qpdf 12.3.2

This is the follow-up to [the 2026-08-25 large-PDF investigation](./large-pdf-native-incremental-save-2026-08-25.md). That work restored a 722,049,367-byte document under a bounded 1 GiB compatibility policy. The design below removes source size as an admission rule. Its memory and temporary storage bounds follow the PDF's structural metadata and the size of the appended revision instead of the size of its image and content streams.

## Recommendation

Use the bundled qpdf executable as a file-backed structural parser, then write the appended revision with a small EVB-owned `u64` writer. Keep the two components separate.

The first production version should run qpdf once against EVB's private staged copy and write qpdf JSON v2 to a managed sidecar file:

```text
qpdf --suppress-recovery \
  --json-output=2 \
  --json-key=qpdf \
  --json-stream-data=none \
  --decode-level=none \
  input.pdf > structural.json
```

Parse the sidecar incrementally. Retain only structural PDF objects and enforce explicit metadata, object, page, nesting, and output bounds while parsing. Do not capture JSON on stdout or deserialize the whole sidecar into one `String` or `Value`.

The append writer must start its checked `u64` offset counter at the verified source length. It should serialize only changed and new indirect objects, followed by a cross-reference stream with eight-byte offset fields, `/Prev`, `startxref`, and `%%EOF`. It must not replay the source bytes and must not call lopdf's current incremental writer.

This is the smallest sound architecture because EVB already bundles and resolves qpdf on every supported desktop platform. It avoids a new native library ABI, an unsafe memory map, and a substantial unmerged lazy-reader fork. It also leaves the mutation model in Rust, where the existing semantic checks and rollback transaction already live.

## Implemented and measured result

The production implementation follows this split. Files up to the existing 512 MiB eager-reader ceiling keep the old lopdf path. Larger incremental saves run the bundled qpdf with recovery disabled and stream data omitted. The JSON sidecar contains only the `qpdf` object section. Rust admits one raw indirect-object envelope at a time before materializing it, with a 64 MiB per-object byte cap, one-million-element cap, 256 MiB estimated retained-memory cap, and 512 MiB sidecar cap. The retained estimate charges 64 bytes per JSON value plus key and string bytes before conversion to lopdf objects. qpdf inputs must leave one million object IDs available for the bounded mutation set. The loader refuses attempts to rewrite an omitted base stream. A 110-second watchdog and independent one-MiB diagnostics cap kill the child on runaway output or time. The next native save removes matching abandoned sidecars older than ten minutes, covering hard process-tree kills where Rust destructors cannot run.

The packaged qpdf 12.3.2 help text lists parser nesting and container flags, but that executable rejects those flags at runtime. The implementation therefore does not pass them. qpdf's own strict parser, JSON recursion limit, one-million-object and 100,000-page checks, sidecar bounds, diagnostics bounds, and watchdog remain active. Recovery and warning-success are disabled.

The append writer records absolute offsets while it serializes changed objects. It keeps classic xref output while every new offset fits the ten-digit field, then switches to `/W [1 8 2]` xref streams. A classic PDF that crosses 10,000,000,000 bytes gets a catalog `/Version /1.5` override in the same revision. The append handle uses normal read/write access and seeks to the verified source length before writing. This matters on Windows because Rust's append mode removes `FILE_WRITE_DATA`, even when `write(true)` is also set, which would break rollback truncation. Platform-neutral unit tests cover both sides of 4 GiB and ten billion bytes plus `u64` overflow. Three public-binary sparse tests cover a 5.27 GiB classic-xref input, a 10.55 GiB xref-stream input, and the classic-to-stream transition at the ten-billion-byte boundary. All three pass qpdf's strict check after mutation. The terminal reader anchors `startxref` before the final `%%EOF` and rejects non-whitespace trailing data. The DjVu bookmark route mutates its private copy in place and publishes that copy only after success, avoiding a full byte comparison between two multi-GiB seeds under the command timeout.

The 882-page dictionary used in the original report measured 722,167,887 bytes on 2026-08-26. After the review fixes, the final release-build save took 1.20 seconds, appended 635 bytes, and used 27,115,520 bytes peak RSS in the Rust process. The separate qpdf structural pass took 0.36 seconds, used 20,742,144 bytes peak RSS, and wrote 2,908,198 structural JSON bytes. The saved prefix matched the source SHA-256 byte-for-byte. qpdf reported 882 pages, the new bookmark resolved to page 1, the ten-page compatibility audit passed, and the EVB Viewer dev app rendered pages 1 and 147 in its configured PDF.js surface.

## The 1 GiB cap is not the only blocker

The current incremental load policy reads the complete source into a `Vec<u8>` and admits at most 1 GiB. See [`load_policy.rs`](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/native/pdf-page-ops/src/load_policy.rs#L8-L95). lopdf's `IncrementalDocument` retains that vector beside the parsed document, and its path loader reads the file to EOF. These behaviors remain in the [0.44.0 `IncrementalDocument`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/incremental_document.rs#L4-L45) and [0.44.0 loader](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/reader.rs#L357-L387). Current upstream at [`1e3d646ca249ebf1a6ff479278c07e9c0f9377a8`](https://github.com/J-F-Liu/lopdf/commit/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8) keeps the same eager model in [`incremental_document.rs`](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/incremental_document.rs#L4-L45) and [`reader.rs`](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/reader.rs#L368-L399).

There is also a hard writer correctness problem at 4 GiB. lopdf 0.44.0 represents a normal xref entry's byte offset as [`u32`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/xref.rs#L26-L32). Its writer casts `bytes_written` to `u32` when it records each object, and casts `startxref` to `u32` when it creates an xref stream. See [`writer.rs`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/writer.rs#L387-L403) and [the indirect-object writer](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/writer.rs#L559-L574). The cast truncates an offset at `2^32`; it does not return an error. Current upstream retains the [`u32` xref entry](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/xref.rs#L26-L32), [`startxref` cast](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/writer.rs#L422-L436), and [object-offset cast](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/writer.rs#L602-L616).

Removing EVB's read cap while keeping this writer would therefore turn a memory failure into possible output corruption. The new path must replace both the eager reader and the offset-limited writer.

Classic cross-reference table entries reserve ten decimal digits for the byte offset. They cannot represent an object beginning at byte 10,000,000,000 or later. ISO 32000 permits cross-reference streams to choose the byte width of each field with `/W`, and incremental xref sections or streams contain entries only for objects changed in that revision. The newest trailer or xref stream links to the preceding xref with `/Prev`. See ISO 32000-1 sections 7.5.4, 7.5.6, and 7.5.8 in the [official PDF 1.7 specification](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf).

Use `/W [1 8 2]` for EVB's new type 0 and type 1 entries. Eight bytes carry the checked `u64` object offset, while two bytes carry the generation number. Do not generate compressed objects in the appended revision. If the input declares a version older than PDF 1.5, rewrite the catalog in the append and set `/Version /1.5`. ISO 32000-1 section 7.5.2 allows a PDF 1.4 or later catalog version to override the header, and section 7.5.8 defines xref streams for PDF 1.5 and later.

## What the current mutation code actually needs

The existing `PdfObjectSource` interface returns borrowed objects and resolves references through the complete lopdf document. See [`types.rs`](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/native/pdf-page-ops/src/types.rs#L91-L125). A file-backed source cannot promise those borrows after cache eviction. Refactor this interface around owned or reference-counted structural objects, or build a bounded immutable `StructuralBaseRevision` before mutation planning.

That type should contain:

- the header version, final trailer, latest xref offset, maximum object ID, source length, final source byte, and stable file identity;
- catalog, page-tree, page, target annotation, and related structural dictionaries and arrays needed by the requested mutation;
- generation numbers and the original object IDs for every object that may be replaced;
- no encoded content, image, font, embedded-file, or other base stream payload.

Bookmark mutations need the catalog and page destinations. Page labels need the catalog and page count. Annotation mutations need the touched page and annotation dictionaries plus inherited page geometry and rotation. Placed-image mutations create new bounded JPEG streams from sidecar payloads. None of these operations needs the existing page content or image bytes. The current implementation paths are visible in [catalog mutation](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/native/pdf-page-ops/src/catalog.rs), [annotation mutation](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/native/pdf-page-ops/src/notes.rs), and [placed-image mutation](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/native/pdf-page-ops/src/placed_images.rs).

Stream omission must be explicit in the type system. Never convert qpdf's stream dictionary with omitted data into `lopdf::Stream { content: Vec::new() }`. That object looks complete, and later code could clone it into a new revision and silently replace real source data with an empty stream. A base stream object should expose its dictionary and identity through a distinct `UnavailableBaseStream` representation. Any request for its payload should return a typed refusal.

## Why qpdf is the parser

qpdf opens a file through a seekable `FileInputSource` and loads PDF objects only when needed. Its public API documents the lazy behavior in [`QPDF::processFile`](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/include/qpdf/QPDF.hh#L65-L97), and its implementation uses [`FileInputSource`](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/libqpdf/QPDF.cc#L211-L223). That source performs positional seek and read operations in [`FileInputSource.cc`](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/libqpdf/FileInputSource.cc#L87-L114). qpdf defines file offsets as signed `long long`, not a 32-bit platform `long`, in [`Types.h`](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/include/qpdf/Types.h#L27-L32).

qpdf JSON version 2 is an unambiguous representation of PDF objects. With `--json-stream-data=none`, it includes stream dictionaries but omits stream data. It also reports `maxobjectid`, including dangling indirect references, so a writer can choose a new object ID without capturing an ID that was referenced but absent. See the qpdf [JSON format definition](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/manual/json.rst#L30-L56), [stream omission](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/manual/json.rst#L198-L211), and [`maxobjectid` contract](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/manual/json.rst#L177-L196).

The qpdf manual is precise about the remaining memory cost. qpdf does not load the complete PDF file, but JSON export eventually retains the decoded object structure after it visits every object. It never needs the full encoded file or every large stream payload in memory. Writing JSON to a file with stream data set to `none` avoids a second in-memory JSON representation. See the [large-file JSON notes](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/manual/json.rst#L797-L813).

This means the first implementation is scalable with respect to multi-GiB image and content streams, but not unbounded. A PDF can still contain abusive structural metadata or an oversized decoded object stream. EVB must enforce the resource policy below and run qpdf as a contained child process.

The executable is already a packaged native resource in [`nativeResourceManifest.ts`](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/scripts/nativeResourceManifest.ts#L219-L229), with platform bundle scripts for [macOS](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/scripts/bundle-pdf-tools-macos.sh), [Windows](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/scripts/bundle-tools-windows.sh), and [Linux](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/scripts/bundle-tools-linux.sh).

### CLI first, library bridge later

The CLI sidecar is the smallest initial change. It has process startup and JSON I/O costs, but those costs do not grow with encoded stream bytes when stream data is omitted. It also keeps qpdf failures outside the Rust mutation process.

If structural sidecars or startup time become the measured bottleneck, replace only this boundary with a narrow qpdf C or C++ bridge. The C API accepts a callback that receives JSON in blocks and a `wanted_objects` list, as shown by [`qpdf_write_json`](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/include/qpdf/qpdf-c.h#L376-L402). A bridge can walk the page tree lazily and emit only requested objects. It adds ABI packaging, native build, crash isolation, and signing work, so it should follow measurement rather than precede the first scalable save path.

qpdf itself cannot supply the append writer. Its upstream TODO still lists incremental output as unimplemented and says current output folds prior revisions into a rewritten file. See qpdf's [incremental-update TODO](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/TODO.md#L302-L330). `QPDFWriter` writes to a new file, pipeline, or caller buffer and does not expose an append-revision mode. See [`QPDFWriter.hh`](https://github.com/qpdf/qpdf/blob/dfd251125cadb59fe04836f9197c3ef94f99cf55/include/qpdf/QPDFWriter.hh#L104-L141).

## Append writer contract

Introduce two explicit values:

```text
BaseRevisionDescriptor
  source_length: u64
  previous_startxref: u64
  pdf_version
  trailer
  max_object_id: u32
  last_byte
  stable_file_identity
  structural_objects

AppendPlan
  replaced_objects
  new_objects
  expected_semantics
```

The writer should follow this sequence:

1. Open the private staged file for read and write without changing its path.
2. Recheck stable identity, length, final byte, and latest `startxref` against `BaseRevisionDescriptor`.
3. Seek to `source_length`. Add one line break only if the source does not already end in PDF whitespace.
4. Serialize each changed or new indirect object. Record its checked absolute `u64` position and original generation.
5. Serialize a new xref-stream object. Its `/Index` covers only the emitted entries and the xref object, `/Size` covers the highest known object ID plus one, `/Prev` is the preceding xref offset, and its trailer keys preserve `/Root`, `/Info`, and `/ID` when present.
6. Write the absolute xref-stream offset after `startxref`, then `%%EOF`.
7. Flush and sync. Run append-tail validation and semantic validation. On any failure, truncate back to the prior `u64` length and sync the rollback.

All position arithmetic must use checked `u64`. Refuse a file only when an offset cannot be represented by the host filesystem or a downstream validator. qpdf's signed 64-bit `qpdf_offset_t` makes `i64::MAX` the practical compatibility ceiling for this design. That is a representation limit, not an arbitrary product limit.

The writer may be an EVB module adapted from lopdf's object serializer, with the applicable license notice, but it must not retain lopdf's xref types or `usize` counters. Keep it small and append-specific. It needs every object syntax variant that mutations can emit, exact PDF name and string escaping, stream length handling, deterministic dictionary output, and short-write propagation. Differential fixtures should compare its emitted objects with qpdf and lopdf before it is trusted.

The current transaction is a useful base. It appends to the staged path, syncs, reads only the appended tail for validation, and truncates a failed revision. See [`incremental.rs`](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/native/pdf-page-ops/src/incremental.rs#L3-L145) and [the append call and validator](https://github.com/evb0110/evb-viewer/blob/59d6f4aad40d29ff181f0526abb638a3285b6305/native/pdf-page-ops/src/incremental.rs#L218-L340). Convert its authoritative `previous_len`, `previous_xref_start`, skip count, and validator positions from `usize` to `u64`. The new writer removes `SkipWriter` because no source prefix is replayed.

## Resource and security policy

Do not replace 1 GiB with another encoded source-size constant. Use these independent bounds:

- Retain the existing 1,000,000-object, 100,000-page, 256-level nesting, 4,096-revision, 128-reference, and 64 MiB decoded-stream policies in EVB's mutation layer. These remain limits on structure and decoding, not on the PDF's encoded byte length.
- Set maximum bytes for one structural object, all retained structural objects, the qpdf JSON sidecar, and the appended revision. Use typed resource-limit errors.
- Run qpdf with recovery disabled. Exit status 3 means warnings unless `--warning-exit-0` is used, so do not use that option. Refuse mutation when qpdf repaired or warned about the source. qpdf documents these exit codes and controls in its [CLI manual](https://qpdf.readthedocs.io/en/stable/cli.html#exit-status).
- Keep qpdf's default parser protections and set EVB's nesting and container policies explicitly through qpdf's global parser options where the packaged version supports them. qpdf documents its parser limits in the [CLI option reference](https://qpdf.readthedocs.io/en/stable/cli.html#advanced-control-options).
- qpdf's CLI exposes parser nesting and container limits but no exact decoded-stream byte ceiling. Put the child under a wall-clock timeout, cancellation, output-size monitor, and hard process memory budget. On Windows, Job Objects provide process memory limits in Microsoft's [`JOBOBJECT_EXTENDED_LIMIT_INFORMATION`](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information). Use the corresponding tested launcher containment on macOS and Linux. Treat a resource kill as a typed refusal and delete the sidecar.
- Reject encrypted input before planning. The append writer does not implement PDF encryption or update encrypted strings and streams. Do not pass a password to qpdf and then append unencrypted objects.
- Allocate new IDs from checked `maxobjectid + 1`. Preserve generation numbers for replacements. Reject overflow and duplicate IDs.
- Keep mutation payload caps, including image sidecars, independent of source length. The base PDF being large is not permission for an unbounded new revision.
- Preflight temporary storage. Copy-on-write cloning is cheap only when the filesystem supports it. Windows and Linux installations may need the full source size plus sidecar and append space.
- Admit one large structural parse at a time until measurements justify a weighted global budget. Replace encoded-byte weighting later with observed structural sidecar size and child peak RSS.

EVB already mutates a private staged copy and serializes work for a working path. Preserve that invariant. A stable private handle plus identity and length checks immediately before append is stronger and cheaper than hashing a multi-GiB prefix for every metadata save. If a future caller can expose the staged file to another writer, use a streaming prefix hash or create a new immutable clone before parsing.

## Cross-platform implications

The design uses ordinary seek and read operations and avoids mmap. qpdf's offset type is signed 64-bit across the supported C++ targets. Rust should still test conversion at every OS API boundary, because `usize` is not an on-disk offset type and JavaScript `number` cannot exactly represent every `u64` value.

Packaged qpdf parity now matters to saves, not only validation. Pin the same JSON major version and required CLI options in each platform bundle. At startup or packaging time, smoke-test `--json-output=2`, `--json-stream-data=none`, `--decode-level=none`, and `--suppress-recovery`. Keep Unicode and long-path tests on Windows. Verify arm64 and x64 resource resolution separately.

Sparse files are useful for offset tests on filesystems that preserve holes, but the current staged-copy path may materialize a sparse source on some platforms. Unit-test large logical offsets with a seekable fake writer everywhere, and reserve full sparse-file integration for platforms and CI workers that prove sparse-copy behavior first.

## Options considered

| Option | Evidence | Decision |
| --- | --- | --- |
| Raise or remove lopdf's input cap | The eager source `Vec`, copied stream bodies, and `u32` xref offsets remain. | Reject. It still consumes memory proportional to source bytes and becomes incorrect beyond 4 GiB. |
| mmap plus lopdf | lopdf cannot accept mmap backing for `IncrementalDocument`, and parsing still copies stream payloads. Every file-backed `memmap2` constructor is unsafe when the backing file may be modified. See the [`memmap2` safety contract](https://github.com/RazrFalcon/memmap2-rs/blob/a02e2a48a56f6d4708fbbfa3ab6dbbc27d717148/src/lib.rs#L135-L147). | Reject. It adds a file-stability memory-safety obligation without creating lazy object parsing. |
| qpdf parser plus qpdf writer | qpdf is lazy and 64-bit, but incremental writing is still an upstream TODO. | Use qpdf only for structural parsing. |
| qpdf CLI JSON plus EVB `u64` appender | Stream data can be omitted, JSON can be written to disk, qpdf is already bundled, and the append remains small. | Recommended first production architecture. |
| qpdf C or C++ selective bridge plus EVB appender | `qpdf_write_json` supports callback output and selected objects. | Good optimization after measurements. It is not needed to remove the encoded-size ceiling. |
| lopdf `IndexedReader` fork | lopdf issue [#554](https://github.com/J-F-Liu/lopdf/issues/554) tracks an external lazy random-access reader, but no implementation is merged. The external [`indexed_reader` branch](https://github.com/kkollsga/lopdf/tree/30f8f3173cf4faba37e7d38212773ebb186fb6f8/src/indexed_reader) is substantial and requires a separate malformed-input and cache audit. | Worth upstream collaboration, not the smallest delivery path. |
| PDFium | PDFium exposes incremental save flags in [`fpdf_save.h`](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_save.h), but its public custom file access uses `unsigned long` for file length and positions in [`fpdfview.h`](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdfview.h). Microsoft's x64 ABI keeps `long` at 32 bits, as shown in its [x64 type table](https://learn.microsoft.com/en-us/cpp/build/x64-software-conventions?view=msvc-170#scalar-types). PDFium's public bookmark API in [`fpdf_doc.h`](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_doc.h) is read-oriented, while annotation mutation is available in [`fpdf_annot.h`](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_annot.h). | Not a cross-platform drop-in for EVB's bookmark, page-label, and annotation set. It also adds a large new native build. |
| MuPDF | MuPDF has `pdf_save_document`, `do_incremental`, `pdf_can_be_saved_incrementally`, file-backed open, and object-cache minimization in its [public C API](https://mupdf.readthedocs.io/en/latest/_static/generated/c/html/pdf_2document_8h_source.html). | Technically capable, but MuPDF is offered under AGPL or a commercial license according to [Artifex](https://artifex.com/licensing/). Do not adopt it without an explicit licensing decision. |

## Test strategy

### Offset and writer tests

- Start the fake output counter at `2^32 - 1`, `2^32`, `9,999,999,999`, and `10,000,000,000`. Assert exact object offsets, `/Prev`, absolute `startxref`, and `/W [1 8 2]` bytes.
- Exercise a counter near `i64::MAX` and `u64::MAX`. Every addition and conversion must return an error before writing when it would overflow or leave qpdf's supported range.
- Cover sparse object IDs, nonzero generations, replacement plus new object mixes, multiple `/Index` ranges, empty optional trailer keys, and a catalog `/Version /1.5` override.
- Force every short write, flush failure, sync failure, validation failure, and rollback failure. A successful rollback restores the exact prior length.
- Differentially parse emitted object syntax and xref streams with qpdf. Reopen with PDF.js and the native validator.

### Structural parser tests

- Cover classic xref tables, xref streams, hybrid references, object streams, long incremental `/Prev` chains, dangling references, sparse IDs, nonzero generations, indirect lengths, binary names and strings, and valid unreferenced objects.
- Cover cyclic page trees, cyclic references, excessive nesting, excessive object and page counts, malformed xref offsets, qpdf warnings, recovery attempts, encrypted files, and oversized decoded object streams.
- Prove stream data is absent from the sidecar and cannot be requested through `StructuralBaseRevision`. A mutation that tries to copy a base stream must fail before append.
- Feed JSON in tiny chunks. Enforce per-object, aggregate structural, and sidecar limits without collecting the complete JSON document in memory.
- Kill qpdf on timeout, cancellation, memory budget, and sidecar growth. Confirm the source and staged PDF are unchanged and the managed sidecar is removed.

### Large-file integration tests

- Create sparse valid PDFs with logical lengths just above 4 GiB and 10,000,000,000 bytes, with the final indirect object and xref near EOF. Verify bookmarks, page labels, annotation edits, and placed-image mutations.
- Assert the complete source prefix remains byte-for-byte identical and the output grows only by the bounded append. Validate `/Prev`, xref entries, `startxref`, `%%EOF`, page count, destination mapping, annotations, and catalog entries.
- Run `qpdf --check`, EVB's append-tail validator, semantic changed-object validation, and restricted PDF.js rendering on the first, a changed middle, and the final page.
- Re-run the measured 722,049,367-byte, 882-page file. Record qpdf child peak RSS, Rust peak RSS, sidecar bytes, append bytes, and wall time. The expected improvement is bounded memory independent of its encoded page streams, not a fixed RSS ratio.
- Test same-path replacement, file growth, shrink, replacement, stale identity, disk full, cancellation, and crash between append, sync, validation, and promotion.
- Run packaged-resource smoke tests on macOS arm64 and x64, Windows x64 and arm64, and every supported Linux architecture. Include Unicode paths and Windows long paths.

## Delivery order

1. Add the `u64` append writer and fake-offset tests while the current reader remains behind the 1 GiB policy. Do not expose larger inputs yet.
2. Add the qpdf structural sidecar and `StructuralBaseRevision`. Differentially test planned mutations against the eager lopdf path on the existing corpus.
3. Convert append validation and rollback positions to `u64`. Add strict source-identity checks and the resource policy.
4. Enable the new path for files above the eager threshold. Keep the current path as a temporary comparison lane for smaller files.
5. Remove the arbitrary incremental encoded-size ceiling only after the over-4-GiB and 10-GB sparse integrations pass on supported filesystems and packaged qpdf parity is verified.

The key rule is simple: file size may be huge, structure may not be unbounded, and every absolute PDF offset must stay 64-bit from parse through validation.
