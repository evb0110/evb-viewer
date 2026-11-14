# PDF page operations

The Rust PDF writer used by desktop as a sidecar and by the browser as
WebAssembly. PDF.js renders; this crate writes document changes, as
[ADR 0002](../../docs/architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md)
defines.

## Page structure

`pdf_source.rs` indexes cross-reference sections and reads reachable objects
through a random-access source. `page_structure_edit.rs` selects and remaps the page
and document graphs. `pdf_writer.rs` writes a fresh PDF, renumbering objects,
copying stream data by byte range and writing each real number an edit kept
as its source spelled it. Path operations stream from file to
file; in the browser the host lends the engine its files, which it reads by
range, and the output file it writes.

Delete, extract, reorder, insert and merge use this engine. Split uses the
crate's separate split writer. Inserted pages retain their source labels. Widgets retain appearances; safe fields are
carried into the destination, while source document attachments and JavaScript
are not imported. Output verification reopens the result and compares its objects and stream
boundaries with the planned output, checks reachable references and the page
tree, and samples the ends of copied streams. It does not decode every image
stream.

On desktop the engine writes directly to the next revision file in the
[document store](../../packages/document-store/README.md); its manifest commits
only after output verification and the host's page-count check.

## Incremental changes

`incremental.rs` applies annotation, rotation, page-label and bookmark mutations
through one implementation for every writer. OCR text layers and print layout
also live in this crate. The desktop structural reader can use bundled libqpdf
for object projections and qpdf JSON for its large-file fallback. Page-structure
rewrites use their own reader and verifier.

The browser appends through `pdf_source.rs`: its skeleton becomes the
`IncrementalDocument` base, every stream it left in the file is unavailable
until read, and the streams a change reuses (stamp images, original FreeText
appearances, page contents the OCR layer rewrites, appearances the annotation
parse snapshots) are read by range under their caps. The storage worker runs
the engine on the document's own file: it appends past the committed bytes,
reads the revision back to check it, and the store commits it with `extend`.
Annotation parse, catalog and OCR visibility reads take the document by range
the same way. An encrypted base is refused from its index before any object is
read; the open unlocks such a file into a plaintext rewrite first.

## Remaining qpdf uses

The application retains qpdf for whole-file optimization, repair and
normalization; conformance checks and page counts; image-export subsets;
DjVu conversion joins; and scan-cleanup joins, validation and MRC mask
dictionaries. The desktop incremental reader also uses qpdf for structural
objects and annotation streams. Crop and crop removal keep the host's strict qpdf
structure gate; streaming page-structure outputs use their own verification.
Browser qpdf WASM serves normalization, validation and conversion paths.
