# Large-PDF native incremental save

Date: 2026-08-25

Baseline: EVB Viewer commit [`243b8d81905770d19b6cb5355a390b3607e22885`](https://github.com/evb0110/evb-viewer/commit/243b8d81905770d19b6cb5355a390b3607e22885), lopdf 0.44.0

## Verdict

lopdf has no file-backed, memory-mapped, or random-access incremental loader. This is true in the installed 0.44.0 source and in upstream `main` at [`1e3d646ca249ebf1a6ff479278c07e9c0f9377a8`](https://github.com/J-F-Liu/lopdf/commit/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8). Version 0.44.0 is still the latest published release.

The least risky fix for EVB Viewer now is a separate 1 GiB encoded-file ceiling for the incremental mutation path, while retaining every existing decompression and structural bound. Large native mutations should also receive exclusive or weighted process admission. A cap increase without concurrency control leaves a straightforward memory-exhaustion path because Electron currently allows eight native child commands at once.

This is a bounded compatibility fix, not a memory-efficiency fix. lopdf retains the complete source PDF and copies stream payloads into the parsed document. The supplied 355,427,921-byte control file reached about 732 MB RSS, close to twice its encoded size. The 722,049,367-byte failing file should therefore be tested under realistic memory pressure before release.

The right longer-term repair is a `Read + Seek` incremental reader and an append-only writer that accepts verified prefix metadata. It should parse only the xref chain and objects needed by the requested mutation, then write the new revision at the existing file length. Memory mapping does not solve the current API mismatch and introduces a file-stability safety obligation.

## Measured validation

The release build saved a bookmark mutation to the 722,049,367-byte, 882-page source in 0.92 seconds. Peak resident memory was 1,495,433,216 bytes. The output grew by 493 bytes. Its first 722,049,367 bytes had the same SHA-256 digest as the source, `510f988b5a361af95fcd67ea20f1a47dba928c7416d509ff57895a4b77546278`.

`qpdf --check` reported no syntax or stream-encoding errors, retained the 882-page count, and found the appended xref stream linked to the original xref through `/Prev 722041678`. The repository's restricted PDF.js compatibility verifier rendered pages 1, 147, and 882 without a decoder failure and classified all three as compatible. Page 147 is the bookmark destination used in the reproduction.

An experimental loader that discarded base stream payloads reduced peak resident memory to 757,743,616 bytes. It was rejected because `lopdf::IncrementalDocument` would then contain an incomplete base `Document`, and a later mutation could clone a stream whose content had been removed. The shipped design keeps the complete parsed document and controls concurrency instead.

## Verified facts

### EVB Viewer rejects the file before parsing

The baseline uses a 512 MiB `MAX_ENCODED_PDF_BYTES` value for every native PDF load. `load_incremental_pdf_path` reads the whole file through that bound, parses the same byte slice, then gives ownership of the `Vec<u8>` to `IncrementalDocument`. See the baseline [`load_policy.rs`](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/native/pdf-page-ops/src/load_policy.rs#L8-L105).

The bounded reader checks metadata, reserves the declared length with `try_reserve_exact`, and reads at most one byte beyond the ceiling before rejecting growth or a stale size. It therefore protects the allocation, not merely the initial `stat`. See [`bounded_io.rs`](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/native/evb-native-support/src/bounded_io.rs#L27-L60).

Commit [`0291debf8d42cebf4a5231350b22f5b9827b0815`](https://github.com/evb0110/evb-viewer/commit/0291debf8d42cebf4a5231350b22f5b9827b0815) introduced the 512 MiB limit as part of a wider native resource-hardening change. Raising it globally would weaken that policy for unrelated rewrite operations. The exception should apply only to incremental mutation saves.

The append path seeds a temporary output with an exact copy of the input, asks lopdf to save the complete previous bytes plus the new revision, and discards lopdf's replayed prefix through `SkipWriter`. It then validates `/Prev`, `startxref`, the xref entries, and the appended object headers before keeping the result. See [`incremental.rs`](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/native/pdf-page-ops/src/incremental.rs#L3-L145) and [the append transaction](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/native/pdf-page-ops/src/incremental.rs#L218-L266).

### lopdf owns two large representations

`IncrementalDocument` contains three owned values: the original bytes as `Vec<u8>`, the parsed previous `Document`, and a new `Document` for the appended revision. `create_from` moves the complete source vector into the object. See the tagged [`IncrementalDocument` definition](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/incremental_document.rs#L4-L45).

Its path loader opens the file, reserves its full length, reads to EOF, parses from that vector, and retains the vector. `load_from` behaves the same way. See lopdf 0.44.0 [`reader.rs`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/reader.rs#L357-L387).

The parsed `Document` also owns PDF stream bodies. `Stream.content` is a `Vec<u8>`, and the parser copies each stream slice with `data.to_vec()`. Deferred stream lengths are later copied from the source buffer in the same way. See [`object.rs`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/object.rs#L20-L34), [`parser/mod.rs`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/parser/mod.rs#L341-L360), and [`reader.rs`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/reader.rs#L1080-L1102).

Incremental save writes the retained previous byte vector before writing new objects. EVB Viewer's `SkipWriter` avoids writing those bytes to disk twice, but it cannot release the vector because lopdf owns and reads it during `save_to`. See lopdf 0.44.0 [`writer.rs`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/writer.rs#L264-L343).

### The filter callback does not support ownership transfer

The documented filter type returns `Some((id, object))` to keep an object. The 0.44 reader treats that return value inconsistently. For normal xref objects it uses the callback only as an `Option` test, then continues to inspect and insert the original mutable input. For objects extracted from an `/ObjStm`, it feeds the callback into `filter_map` and inserts the returned object. See [`LoadOptions::filter`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/load_options.rs#L3-L12) and both paths in [`load_objects_raw`](https://github.com/J-F-Liu/lopdf/blob/v0.44.0/src/reader.rs#L990-L1042). Current upstream keeps the same asymmetry in [`reader.rs`](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/reader.rs#L982-L1049).

This makes `Some((id, std::mem::replace(object, Object::Null)))` incorrect. The returned original is dropped, lopdf sees `Null`, and `/ObjStm` extraction does not run. EVB's current `object.clone()` is wasteful but preserves the input under these semantics.

Returning `Some((id, Object::Null))` without mutating the input is also wrong. Normal objects survive because that path discards the tuple, but compressed objects become `Null` because the `/ObjStm` path honors it. There is no generally correct ownership-transfer callback because the callback receives no call-site context. The clean change is an upstream or vendored lopdf fix that uses one contract on both paths and consumes the returned tuple before it processes object streams.

After that reader fix, `std::mem::replace(object, Object::Null)` is preferable to stripping stream payloads. The reader can own the returned original and continue `/ObjStm` processing on it, while the callback leaves no second stream-sized clone. Until the reader consumes the return value on both paths, ownership transfer is unavailable.

### No newer lopdf release fixes the ownership model

[v0.44.0](https://github.com/J-F-Liu/lopdf/releases/tag/v0.44.0), published on 2026-07-10, is the latest release. Upstream `main` still declares 0.44.0 and retains the same `Vec<u8>` field and read-to-end loader. See [`Cargo.toml`](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/Cargo.toml#L13-L18), [`incremental_document.rs`](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/incremental_document.rs#L4-L45), and [`reader.rs`](https://github.com/J-F-Liu/lopdf/blob/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8/src/reader.rs#L368-L399).

Upstream issue [#554](https://github.com/J-F-Liu/lopdf/issues/554) proposes a separate lazy, random-access reader and reports large memory reductions in an external fork. It remains open and has no merged lopdf implementation. The older streaming request [#247](https://github.com/J-F-Liu/lopdf/issues/247) also remains open. A search of upstream source and issue and pull-request history found no file-backed `IncrementalDocument`, mmap backing, or merged `IndexedReader`.

## Design options

| Option | Memory and safety | Assessment |
| --- | --- | --- |
| Raise only the incremental encoded cap | Preserves lopdf's documented invariants and every EVB structural check. Peak memory remains roughly proportional to the source vector plus copied streams. | Acceptable now with a hard ceiling, real-file measurement, and large-job admission. Unsafe as a constant-only change. |
| Call `Document::load` or `load_from` | Both functions still read to EOF. They return only a parsed `Document`, so they cannot supply the original bytes required by `IncrementalDocument`. | Does not solve incremental save. |
| Move the filter input into its return value | The 0.44 reader discards the return value and stores the replaced input. | Incorrect. It also breaks object-stream extraction. |
| Return a dummy filter object | The normal-object path discards it, while the compressed-object path stores it. | Incorrect for PDFs with object streams. |
| Drop base stream objects or payloads through the filter | This can cut memory because current metadata, bookmark, note, shape, markup, and placed-image mutations read base dictionaries and create new streams. It leaves the parsed `Document` incomplete and conflicts with `create_from`'s requirement that bytes and document match. Future mutations may clone a missing stream. | Do not hide this inside `Document`. Introduce an explicit structural-base type and prove which objects it may omit. |
| Back the original bytes with `Mmap` | Removes the anonymous source `Vec`, but lopdf cannot accept an mmap as `IncrementalDocument` backing. Parsing still copies stream payloads. | Requires a lopdf API change and does not provide lazy parsing by itself. |
| Parse with `Read + Seek` and write only the new revision | Reads xrefs, page-tree objects, catalog, target annotations, and needed object streams on demand. It need not retain page image or content streams. | Best long-term design. More work, but its memory bound follows touched structure rather than encoded file size. |

### Resource implications of the immediate cap increase

The supplied successful control case used about 2.06 bytes of peak RSS per encoded byte. That ratio is evidence for this corpus, not a general upper bound. Object count, dictionary size, object streams, decompression, encryption state, and the largest individual stream all change the peak.

Electron's native runner admits up to eight commands at once. See [`runNativeCommand.ts`](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/electron/native-tools/runNativeCommand.ts#L50-L77). The mutation queue serializes one working copy, not every PDF in the application. Several large documents can therefore start separate processes. Eight near-1-GiB eager parses can exhaust the machine even though each process satisfies its local encoded-file limit.

Use one of these admission policies for inputs above 512 MiB:

1. Allow only one large PDF mutation process at a time.
2. Use weighted admission based on encoded bytes and a conservative measured multiplier. Refuse or queue work when the total reservation exceeds a fixed application budget.

The first rule is easier to reason about and is enough for this repair. Keep the existing two-minute mutation timeout and detached-process termination. A killed child writes only to a staged temporary file, while the append transaction rolls back a failed partial revision. See [`nativePdfMutationSaveHandlers.ts`](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/electron/features/documents/main/nativePdfMutationSaveHandlers.ts#L69-L70) and [its staged invocation](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/electron/features/documents/main/nativePdfMutationSaveHandlers.ts#L224-L264).

The 64 MiB per-stream decompression ceiling, 1,000,000-object limit, 100,000-page limit, nesting limit, and xref-revision limit must remain unchanged. A larger encoded file is not permission for larger decoded structures.

### Memory mapping

`memmap2::Mmap` dereferences to a byte slice, so lopdf's parser could read it after an API change. Current `IncrementalDocument::create_from` still requires `Vec<u8>`, which would copy the entire map and erase the benefit.

Every file-backed `memmap2` constructor is unsafe. The library warns that accessing a map after another process modifies the file can cause undefined behavior. File permissions and locks reduce the risk but do not remove it portably. See the pinned [`MmapOptions` safety contract](https://github.com/RazrFalcon/memmap2-rs/blob/a02e2a48a56f6d4708fbbfa3ab6dbbc27d717148/src/lib.rs#L135-L147).

EVB Viewer currently uses the same staged path as input and append output. An mmap design must map a private, stable snapshot, finish parsing, drop the mapping, revalidate file identity and length, and only then open the file for append. Keeping a live map while appending to or replacing the backing file is not an acceptable invariant. A safe random-access `Read + Seek` reader avoids this class of memory-safety risk.

### Targeted incremental parsing and writing

The long-term API should separate the previous revision's structure from its byte storage. It needs:

- A bounded xref-chain reader over `Read + Seek`.
- Lazy object resolution with a capped cache and the existing per-object-stream decompression limit.
- Explicit total limits for bytes read, objects resolved, pages traversed, nesting, xref revisions, and cached decoded bytes.
- A previous-revision descriptor containing the verified file length, final byte, xref start, trailer, xref type, maximum object id, and file identity.
- An append-only writer whose offset counter starts at the verified previous length and writes no prefix bytes.
- A final identity check on the already-open file handle before append, transactional rollback, `sync_all`, and the existing appended-xref validation.

Bookmark saves need the catalog, page tree, inherited page boxes and rotations, and the target page object ids. Page-label saves need the catalog and page count. Annotation mutations also need the touched page and annotation dictionaries. None of these operations needs every page image or content stream. The source paths that define those reads are [`catalog.rs`](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/native/pdf-page-ops/src/catalog.rs#L109-L133), [bookmark destinations](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/native/pdf-page-ops/src/catalog.rs#L190-L245), and [incremental bookmark construction](https://github.com/evb0110/evb-viewer/blob/243b8d81905770d19b6cb5355a390b3607e22885/native/pdf-page-ops/src/catalog.rs#L459-L500).

Upstream issue #554 is useful prior art for the reader shape, but its external implementation is not an upstream guarantee. EVB Viewer would need its own review, corpus comparison, malformed-input tests, and cross-platform file-identity handling.

## Recommendation

Ship the source fix in two steps.

First, restore this document class without weakening unrelated operations:

1. Add a 1 GiB encoded ceiling only to `load_incremental_pdf_path`.
2. Retain the existing 512 MiB ceiling for full rewrites and all current decoded and structural limits.
3. Serialize native mutation jobs whose input exceeds 512 MiB, or reserve them through a byte-weighted global admission gate.
4. Keep native `too-large` failures typed. Do not materialize the same oversized PDF in the renderer as a fallback.
5. Measure release-build time and peak RSS on the 722,049,367-byte, 882-page input. The operation must finish within the native timeout and leave enough headroom for Electron and the operating system.

Second, remove the eager memory multiplier through an explicit lopdf extension or a separate targeted reader. Prefer `Read + Seek` over mmap. Add an append-only writer that starts at a verified prefix length and never retains or replays the source bytes. Submit the filter-return bug upstream, make both reader paths consume the returned object, then use ownership transfer to remove EVB's clone. Do not strip stream payloads inside a supposedly complete `Document`.

## Rejected shortcuts

- Do not raise `MAX_ENCODED_PDF_BYTES` globally.
- Do not remove the 64 MiB decompression ceiling or structural preflight.
- Do not increase the renderer allocation guard to make fallback serialization possible.
- Do not use `mem::replace` in the current lopdf filter callback.
- Do not return a dummy filter object. It corrupts the in-memory representation of compressed objects now.
- Do not treat a read-only mmap as safe while its backing path can be appended, truncated, or replaced.
- Do not rewrite the full PDF for metadata-only edits. That discards the incremental-save property and makes memory and disk use worse.

## Test obligations

The immediate fix needs these checks before release:

- Unit tests proving that only the incremental policy receives the larger encoded ceiling and all other bounds are identical.
- Exact-boundary and one-byte-over tests for the new limit, including a file that grows after metadata inspection.
- A filter regression with an ordinary stream and an `/ObjStm`. It must prove the stream remains intact, the compressed objects load, and an attempted `mem::replace` implementation would fail.
- Existing hostile-input tests for decompression, objects, pages, nesting, xref widths, and revision chains under the incremental policy.
- An integration save on the 722,049,367-byte file for bookmarks and page labels. Verify the 882-page count, exact source-prefix preservation, `/Prev`, `startxref`, xref targets, final EOF, and reopen behavior.
- Peak-RSS and wall-time measurements for the 722 MB file and its 355 MB sibling in release builds. Record the machine memory and ensure the two-minute timeout has margin.
- Two simultaneous large-document requests. The second must queue or fail admission without starting another high-memory parser.
- Forced timeout, cancellation, allocation failure, and invalid append tests. The original and working copy must remain unchanged, and temporary output must be removable.
- Renderer tests proving a native decline for an oversized working copy does not call `getSourcePdfData`.

The targeted reader will also need corpus equivalence against eager lopdf for every object type the mutation code resolves, classic and stream xrefs, incremental chains, hybrid xrefs, object streams, malformed offsets, concurrent file replacement, and 32-bit offset conversion failures.

## Primary sources

- EVB Viewer baseline load policy and bounded reader at commit [`243b8d8`](https://github.com/evb0110/evb-viewer/commit/243b8d81905770d19b6cb5355a390b3607e22885).
- EVB Viewer resource-hardening commit [`0291debf8`](https://github.com/evb0110/evb-viewer/commit/0291debf8d42cebf4a5231350b22f5b9827b0815).
- Installed lopdf source: `/Users/evb/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/lopdf-0.44.0/src/`.
- lopdf [v0.44.0 source](https://github.com/J-F-Liu/lopdf/tree/v0.44.0) and current upstream commit [`1e3d646`](https://github.com/J-F-Liu/lopdf/commit/1e3d646ca249ebf1a6ff479278c07e9c0f9377a8).
- lopdf lazy-reader issue [#554](https://github.com/J-F-Liu/lopdf/issues/554) and streaming issue [#247](https://github.com/J-F-Liu/lopdf/issues/247).
- memmap2 safety documentation at commit [`a02e2a4`](https://github.com/RazrFalcon/memmap2-rs/blob/a02e2a48a56f6d4708fbbfa3ab6dbbc27d717148/src/lib.rs#L135-L147).
