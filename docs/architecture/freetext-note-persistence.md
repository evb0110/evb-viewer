# FreeText Note Persistence

> **Status (2026-08-30): superseded by [ADR 0003](adr/0003-notes-are-text-annotations.md).**
> New notes are written as `/Text` annotations. This document describes the
> FreeText+Popup marker form that the reader still recognizes and the writer
> rewrites on first edit; it stays as history for that recognition code.

> Why sticky note text disappears on save/reopen, and why the fix works the way it does.

## The Core Constraint

PDF.js `PopupAnnotation` reads `/Contents` from its **parent** annotation dict, not from the Popup's own dict. For FreeText sticky notes, the parent is the FreeText annotation. This is hardcoded in PDF.js and cannot be changed without forking the library.

This creates an impossible tension:

- **FreeText needs `/Contents` cleared** — because FreeText renders `/Contents` as visible text on the canvas via its AP (appearance) stream. A sticky note marker should not show a text block on the page.
- **Popup needs `/Contents` intact** — because Popup reads it from the FreeText parent to display the note text in the popup window.

You cannot satisfy both requirements by manipulating `/Contents` alone.

## Why Previous Approaches Failed

### Clearing /Contents to ZWS (zero-width space)

Setting `/Contents` to `\u200B` prevented canvas text rendering, but also destroyed the Popup's text source. The Popup opened empty because it read ZWS from the parent.

### Writing text to the Popup dict only

Useless — PDF.js ignores the Popup's own `/Contents` and always reads from the parent. The Popup still opened empty.

### Skipping /Contents update for FreeText+Popup annotations

This preserved text on first save, but on reopen PDF.js would re-read the original (stale) `/Contents`, overwriting any edits made in the note window.

## Why the Blank AP Stream Works

The solution replaces the FreeText annotation's **AP stream** (not `/Contents`) with a blank Form XObject — a zero-area drawing that renders nothing on the canvas.

This resolves the tension because:
- `/Contents` keeps the real note text → Popup reads it correctly
- The blank AP stream overrides FreeText's visual rendering → nothing appears on the canvas
- `updateAnnotationTextByRef` can safely write text to the FreeText `/Contents` dict, since the blank AP prevents it from showing on the page

## Why the Rect Must Be Rewritten

The annotation sync layer classifies FreeText annotations as "point-like note markers" only when they have a linked Popup and both normalized dimensions are ≤ 0.02. The boundary is inclusive: `0.02` is a marker, while `0.020001` is not.

`pointNoteMarkerPolicy.ts` owns that threshold and the `isPointNoteMarkerSizedRect` predicate. Import classification, the comments list, the editor marker resolver, the page marker view model and the save pipeline all call it, and nothing else may hold the constant. The comparison adds a rounding tolerance of `Number.EPSILON * 16`. A rect authored at exactly the threshold lands a few ulps above it once a PDF rect is divided by the page box, and without the tolerance the list would call such a note a marker while the save pipeline shrank it.

The lower bound is strict: both sides must be greater than zero. A zero or negative side is degenerate geometry, not a very small marker — it cannot be drawn, hit-tested or dragged. `toMarkerRectFromPdfRect` already expands a genuinely zero-area annotation rect to the `0.0016` anchor size on import, so the only rects that reach the predicate at zero are malformed, and the save pipeline rewrites them to a usable anchor instead of preserving them. The rotated round trip holds at 0°, 90°, 180° and 270°: a point-note anchor imported from a PDF rect stays classified as a marker and saves back to the rect it came from.

Larger third-party FreeText annotations remain FreeText content and are never converted into app note markers. PDF.js saves the app's note-anchor rects at editor size (e.g. 7×20 points), which is too large to pass this check. Without rect rewriting, an app-created note would not be recognized as a marker on reopen.

## Why ZWS Must Be Stripped

Legacy saves (from the broken ZWS-clearing approach) left `\u200B` or BOM `\uFEFF` in `/Contents`. The legacy-ingestion boundary strips these invisible characters before text enters the canonical annotation store:

1. **Annotation sync text selection** — To decide whether the FreeText's text is "truly empty" (should fall through to popup text) vs "has real content". Without stripping, `"\u200B"` counts as non-empty and gets chosen over the popup's real text.

Canonical note text is revisioned and can become empty only through an explicit newer `setNoteText(id, '')` command. The former note-window stale-empty heuristic is intentionally gone.

## Why annotationCursorMode Needs the Note Window Count

When note windows are open, the PDF.js annotation editor layer must remain active. If `annotationCursorMode` returns `false`, the editor layer deactivates, destroying the backing editors that the note windows reference. The `hasOpenAnnotationNotes` bridge ensures the cursor mode stays active as long as any note window is open.

## Why Size Reduction Is Telemetry

pdf-lib performs a full re-serialize when saving, so a large size reduction is recorded as telemetry but is not itself proof of corruption. Structural validation and semantic reopen verification are authoritative; the former 50% guard no longer throws or silently substitutes old bytes.

## Save Pipeline Order

`rewriteFreeTextNoteRects` (blank AP + rect shrink) must run **before** `rewriteEmbeddedNoteTexts` (text updates). The blank AP makes it safe to write text to `/Contents` — without it, the text would render on the canvas.

## Key Files

| File | Responsibility |
|------|---------------|
| `app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization.ts` | Orchestrates the save pipeline order |
| `app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits.ts` | Runs FreeText rect rewriting before embedded text updates |
| `app/modules/pdf-viewer/engine/serialization/pdf-serialization-free-text/applyFreeTextNoteRects.ts` | Blank AP stream + rect rewrite during save |
| `app/modules/pdf-viewer/engine/serialization/pdf-serialization-free-text/applyNewFreeTextNoteAnnotations.ts` | Replays newly-created FreeText note markers |
| `app/modules/pdf-viewer/engine/serialization/pdf-serialization-embedded-notes/applyEmbeddedNoteTextUpdates.ts` | Applies note text updates during full serialization |
| `app/modules/pdf-viewer/engine/pdf-serialization-comments/updateAnnotationTextByRef.ts` | Writes note text to FreeText `/Contents` for targeted updates |
| `app/modules/pdf-viewer/runtime/annotations/useAnnotationSync.ts` | ZWS stripping when selecting text source |
| `app/modules/pdf-viewer/engine/annotations/domain/annotationEntity.ts` | Canonical ZWS/BOM normalization before store commands |
| `app/modules/pdf-viewer/engine/annotations/annotation-rules/pointNoteMarkerPolicy.ts` | The single point-note marker size threshold and predicate |
