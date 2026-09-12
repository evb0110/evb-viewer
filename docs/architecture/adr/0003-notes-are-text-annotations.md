# ADR 0003: notes are /Text annotations

- Status: accepted (2026-08-30)
- Evidence: issue #151; `docs/architecture/freetext-note-persistence.md`;
  `native/pdf-page-ops/src/annotations.rs` (FreeText subtype writes);
  `app/modules/pdf-viewer/engine/annotations/pointNoteMarkerPolicy.ts`

## Context

EVB writes a note as a FreeText annotation with a blank appearance stream, a
marker rect no larger than 0.02 pt, and a Popup child. The shape exists only
because pdf.js's Popup reads `/Contents` from its parent, and a FreeText parent
would otherwise paint the note text on the canvas. Foreign viewers show
nothing where the note is: no icon, an invisible FreeText, and a Popup whose
parent has no visible marker. The 0.02 threshold and the blank-AP rules leak
into the store, the writer, the postconditions, and the e2e proofs.

ADR 0002 removes the reason. Once the annotation editor layer draws every
editable annotation from the canonical annotation store and the renderer skips
them, pdf.js's Popup behavior no longer constrains what the writer emits.

## Decision

A note is written as a `/Text` annotation (the PDF sticky note) with an icon
name, `/Contents`, `/T`, `/CreationDate`, `/M`, a rect the size of the icon,
and a Popup child. The writer never emits a FreeText for a note.

The reader accepts both forms. A FreeText+Popup marker that matches the old
policy (blank AP, marker rect at or below the threshold) is read as a note. The
writer rewrites such a marker as a `/Text` annotation the first time the user
edits that note; untouched markers stay as they are so a save changes nothing
the user did not touch.

## Consequences

- Acrobat Reader and macOS Preview show a note icon where EVB placed a note,
  which is the interop target of ADR 0002.
- The blank-AP stream, the marker threshold, and the pdf.js Popup workaround
  leave the writer once the reader-side recognition of old markers is the only
  remaining use of the threshold. That recognition may be deleted when no file
  from before this decision matters, which for an alpha with a small user
  circle is a judgment call the owner makes, not a scheduled removal.
- `docs/architecture/freetext-note-persistence.md` describes the superseded form and stays
  as history until the reader-side recognition is deleted.
- The `/Text` icon name is a writer default, not a canonical property; the
  editor does not offer icon choice.

## Revisit when

- pdf.js is asked to draw notes again (it is not, per ADR 0002).
- Users need icon choice or a note appearance that `/Text` cannot express.
