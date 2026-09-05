# ADR 0002: pdf.js renders, Rust writes, EVB edits

- Status: accepted (2026-08-30)
- Evidence: issues #139, #111, #143, #149; commit history since 2026-06
  (556 fix commits: scan-cleanup 89, pdf 41, ci 25, e2e 23, annotations 18,
  save 15; 1 of 71 issues attributable to pdf.js itself);
  `docs/research/rust-pdf-engine-rewrite-feasibility-2026-08-30.md`,
  `docs/research/pdf-engine-architecture-assessment-2026-08-30.md`,
  `docs/research/pdfjs-dependency-cost-assessment-2026-08-30.md`,
  `docs/research/pdf-engine-strategy-assessment-2026-08-30.md`

## Context

The project suspected pdf.js of causing most of its hard bugs and considered
replacing it with a Rust engine. Four assessments and a review of the issue
and commit record disagree with the suspicion. Rendering caused one issue
(#111, range-request volume, already fixed). The bugs cluster in two seams
pdf.js does not own: its annotation editor, which insists on being the sole
owner of annotation state and forces EVB to mirror it (7,047 lines of bridge,
debounced sync, IoU matching, NaN recovery, retry timers, #139), and the save
path, which has four routes and three writers (pdf.js `saveDocument`, pdf-lib,
Rust page-ops) with different memory models (15 save fixes since June, #143
from pdf-lib `embedPages`). The large-file memory model was a real pdf.js
limit and is already neutralized by the sparse `ChunkedStream` patch.

## Decision

Three roles, one owner each (terms in `CONTEXT.md`):

- The **renderer** is pdf.js, read-only: raster, text layer, and static
  display of annotations of non-editable types (links, widgets, unknown
  subtypes). The 16 logical edits in `patches/pdfjs-dist@5.7.284.patch`
  move to a source fork of pdf.js built into `pdfjs-dist` by this repo; the
  fork rebases to the current upstream major only after the editor cutover.
- The **writer** is `native/pdf-page-ops` (native and wasm), the only
  producer of PDF bytes and, since issue #160, the only parser of editable
  annotations into the store on open; pdf.js `getAnnotations()` feeds the
  renderer's static display only. `pdfjs-save-document`, `pdfjs-materialize`, and
  pdf-lib as a writer are retired. Decryption of the working copy moves into
  the writer so encrypted input is no longer refused. Browser saves above the
  wasm request cap tell the user to use the native app.
- The **annotation editor layer** is EVB-owned Vue over the canonical
  annotation store. pdf.js `AnnotationEditorUIManager`, `AnnotationStorage`
  as a state owner, and the bridge under
  `app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/` are deleted.
  Every annotation of an editable type (text box, highlight, note, stamp,
  shape) is drawn by the editor layer from the store at all times, whatever
  authored it; the renderer skips them through the existing render
  `operationsFilter` and a filtered `AnnotationLayer` list (issue #153 found
  `noView` only works under `ENABLE_STORAGE`, with side effects). An
  annotation of
  an editable type the store cannot represent stays renderer-drawn and
  read-only.

Product scope fixed with the decision: prompt for a user password on open;
save unencrypted with a one-time notice; images from file picker and
clipboard are the only stamps; replies on foreign notes are shown and
preserved, not authored; undo covers annotations only; forms stay
display-only; the poppler opening preview is untouched. Cutover is a single
replacement on `main` without a feature flag; the app is in alpha and
breakage during the effort is accepted.

## Considered options

- Full Rust engine (PDFium, MuPDF, hayro, own parser): rejected. The bugs are
  in ownership seams a new engine would not remove; estimates run 18 months
  to 5 years; MuPDF's AGPL is unsuitable; PDFium's `FPDF_FILEACCESS` uses
  32-bit lengths on Windows; hayro is a one-maintainer project with MSRV 1.92
  against our 1.89 toolchain.
- Own the editor layer per type behind a flag (strangler): rejected. It keeps
  two owners on one page for the whole migration, which is the defect class
  being removed.
- Renderer draws foreign annotations until first edit: rejected in favor of
  store-drawn for all editable types, because the priority is identical
  appearance before save, after save, and after reopen; a foreign annotation
  looking somewhat different from Acrobat is acceptable, looking different
  from itself across a save is not.

## Consequences

- `app/types/pdfContracts.ts` stops re-exporting `PDFDocumentProxy` and
  `PDFPageProxy`; the 26 importers take an EVB type or the pdf.js type
  directly, never through a contracts barrel.
- Highlight geometry comes from the renderer's text content, the same source
  as on-screen selection; `text_layer.rs` remains for search and native
  flows.
- Interop target: annotations EVB writes open, display reasonably alike, and
  stay editable in Acrobat Reader and macOS Preview, and the reverse for
  those apps' editable-type annotations. Checked by hand at milestones; qpdf
  and pdf.js re-open checks are the automated proxy. No pixel rule.
- Every temporary bridge between old and new ownership must state its removal
  condition, per the repository design rules.

The EVB PDF.js renderer is consumed from the committed local tarball in
`vendor/pdfjs-dist/`. It is built from the exact public fork commit recorded in
that directory's `provenance.json`, verified before installation, and never
published to npm. The complete package remains outside shipped web and
Electron output. Only copied runtime workers, fonts, CMaps, Wasm, ICC assets,
and sanitized viewer assets cross that boundary. Human legal review remains
required for the fork notices and bundled third-party inventory.

## Revisit when

After the cutover and writer consolidation, a renderer-attributable defect
class remains with issue evidence (fidelity, speed, or memory) that the
source-fork patch cannot address. Only then open a renderer-replacement map,
and evaluate hayro and PDFium side by side on that evidence.
