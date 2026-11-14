# Damaged recovery fixtures

Original synthetic PDFs authored for EVB Viewer, distributed under the repository's MIT license. No third-party document content is included. Both pages contain only Helvetica text, `First page` and `Second page`.

- `healthy.pdf`: two-page control with a conventional xref table.
- `object-identity.pdf`: identical structure, except the xref entry for object 7 points to a header declaring object 99. The catalog reaches this object through `/ViewerPreferences`; PDF.js can display both pages, append admission accepts the terminal xref, but the strict page editor refuses it as `corrupt-xref`. qpdf can reconstruct it without changing the page sequence.
- `invalid-fields.pdf`: two-page form source. `/Fields` contains direct Null, integer, boolean, name and string values, an indirect Null, and one valid text-field dictionary (`Retained`, value `value`). Insertion must retain the valid field and drop every non-dictionary entry.

These intentionally invalid bytes must not be normalized when copying fixtures.
