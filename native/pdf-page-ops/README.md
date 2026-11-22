# PDF page operations

The Rust PDF writer used by desktop as a sidecar and by the browser as
WebAssembly. PDF.js renders; this crate writes document changes, as
[ADR 0002](../../docs/architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md)
defines.

## Page structure

`pdf_source.rs` indexes cross-reference sections and reads reachable objects
through a file-backed random-access source on both platforms. Offsets and
committed lengths stay `u64`, including an incremental update's `/Prev`.
Unread streams are unavailable, never empty; a consumer must read their bytes
by range before using them. The first occurrence of a duplicate dictionary
key wins. One object holds at most two million values, and one read at most
twenty million. Unchanged real numbers
keep their source spelling, including in object streams and inherited page
boxes.

`page_structure_edit.rs` selects and remaps the page and document graphs.
`pdf_writer.rs` writes a fresh PDF, renumbering objects and copying stream data
by byte range. Delete, extract, reorder, insert and merge use this engine.
Browser structure edits run in the page-ops worker, which owns the new output
file's sync access handle. The host copies stream ranges between the engine's
write and verification requests. Whole PDFs do not cross into WASM memory for
these edits. Split uses the crate's separate split writer.

Every page edit, including rotation, crop and crop removal, uses
`PageTreeResolver::validated` to number pages. A leaf that is not a page,
appears twice or contradicts the declared counts refuses as `invalid-request`:
a repair must not silently renumber a damaged tree. Rotation validates the
tree through the index before its append reads the document.

An encrypted source with a per-stream `/Crypt` filter other than Identity is
refused. An Identity stream is retained without that filter only when the
decrypting reader left its bytes unchanged. Inserted pages with readable source
labels keep them; unlabelled pages join the destination range. Widgets retain
appearances and shared widgets stay single field members. AcroForm `/Fields`
entries that do not resolve to dictionaries are dropped. Source attachments and
JavaScript are not imported; an unchanged main outline stays as written.

Output verification reopens the result, compares objects and stream boundaries
with the planned output, checks reachable references and the page tree, and
samples copied stream ends. It does not decode every image stream. The
[document store](../../packages/document-store/README.md) commits the revision
only after verification and the host's page-count check.

## Incremental changes

`incremental.rs` applies annotation, rotation, page-label and bookmark mutations
through the shared mutation implementation. OCR text layers and print layout
also live in this crate. These saves, and the annotation parse, annotation and
shape indexes, catalog and OCR visibility reads, open the document through the
same indexed `pdf_source.rs` reader as page structure, by file on desktop and
by range in the browser. Its skeleton becomes the `IncrementalDocument` base;
its page tree must yield its first and last pages. Reused streams, such as
stamp images and appearances, the appearances of FreeText labels being edited
and OCR page contents, are read by range under their caps. An undo can name a
stamp image the trailer no longer reaches; the base reads it through the same
index. A save reports the pages it changed, with the pages of every annotation
threaded to a changed one, and of each annotation threaded to one on a page
it re-reads, so the viewer re-reads only those.

Desktop appends to a staged copy, or in place to a working copy the host
protects, and verifies the written revision before it publishes. The browser
storage worker appends to the document's own file, reads back the written
revision to verify it, and returns a receipt. The store commits the appended
length with `extend`; releasing an uncommitted receipt cuts its tail. An
encrypted append base is refused from its index; open unlocks it into a
plaintext rewrite first. Orphan pages are outside the document the viewer
displays: a delete changes only what the catalog page tree reaches.

## Repair and qpdf

Append admission at open applies the eager loader's rules and the indexed
reader's. Damage either one refuses as `corrupt-xref`, such as an xref entry
that points at another object, is repairable: the host rewrites the file with
qpdf before anything edits it. When a page edit refuses the edited revision as
`corrupt-xref`, its host runs one qpdf rewrite, commits it as an internal
revision and retries the edit once.
A second failure restores the revision the edit began on and reports the
failure. Damaged page trees and damage in inserted inputs are `invalid-request`
and do not trigger repair. Browser repair stays within qpdf WASM's input limit.

The application retains qpdf for whole-file optimization, repair and
normalization; desktop conformance checks and page counts; image-export subsets;
DjVu conversion joins; and scan-cleanup joins, validation and MRC mask
dictionaries. Image recompression and replacement, overlay text, split
navigation, page geometry and print appearances still load eagerly, or through
qpdf's structural view above the eager ceiling. Crop and crop removal keep the
host's strict qpdf structure gate; page-structure outputs use the engine's
verification. Browser qpdf WASM serves normalization, validation and
conversion paths.
