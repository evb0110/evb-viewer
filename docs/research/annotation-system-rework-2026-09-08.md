# Annotation system rework, 2026-09-08

## Problem and scope

The annotation editor cutover left ordinary authoring unreliable. The reported
text flow lost focus, opened style controls over the page, hid the editing
frame, and omitted the text color in the sidebar. Follow-up recordings showed
that earlier text sizing and popup fixes had not resolved the interaction.

This review covers text boxes, notes, text markup, ink, geometric shapes,
placed images, annotation history, native persistence, and sidebar projection.
The user explicitly chose a visible text box throughout typing.

The implementation retains the ownership decisions in
[ADR 0002](../adr/0002-pdfjs-renders-rust-writes-evb-edits.md) and
[ADR 0003](../adr/0003-notes-are-text-annotations.md). The canonical store owns
annotation content, identity, geometry, history, and dirty state. PDF.js renders
document content. The native writer and parser own durable PDF mutation and
reopening. Unsupported foreign annotations remain read-only.

## Research findings

These findings were established against `efea01b3b` before implementation.
An executed reproduction is distinguished from a missing source-code path.

| Area | Evidence | Failure |
| --- | --- | --- |
| Text properties | Live DOM and source | A floating text properties panel remains visible after editing ends. Selection identity changes reopen it after a color change or commit. |
| Text frame | Recording, live DOM, CSS | Editing does not independently paint a frame. Selection handles disappear during editing, while the border depends on selection state. |
| Text layout | Source | Editable text wraps long words, while committed text can clip them. Reopened and manually sized boxes do not follow the creation autosizing policy. |
| Tool transitions | Source | A previously selected text box can receive the new Note tool's color. Escape can change the tool without cancelling the captured pointer gesture. |
| Rectangle and circle | Executed composable | Reverse drawing overwrites the starting anchor. Repeating the last pointer position collapses a dimension and discards the shape. |
| Resize | Source | Shapes display handles whose event handler accepts only text and images. Resize previews translate the old rectangle until release. |
| Markup and strokes | Source | Underline and strikeout use highlight rectangles. Shape opacity affects fill but not stroke. Thin strokes lack the earlier generous hit target. |
| Rotation | Source | The page renderer applies view rotation, but the annotation editor and inverse pointer mapping do not. Entity rotation is absent from selection geometry. |
| Sidebar | Seven failing actual-code probes | Text color is suppressed by note classification. Note colors, shape authors, and canonical identity are missing from projections. |
| Note windows | Failing actual-code probes | Clean window drafts ignore canonical undo and external updates. Plain runtime metadata does not make stacking and saving indicators reactive. |
| Save and undo | Executed store lifecycle | Undoing a saved edit restores a historical revision that the dirty predicate omits. A divergent subsequent edit can reuse the saved revision number. |
| Saved deletion | Executed acknowledgement and reparse | Reparse discards the clean deletion record and its undo history. Tests stopping before reparse miss the failure. |
| Imported shapes | Executed mapping and source | Reverse Line endpoints and endings are discarded. Polygon and PolyLine lose subtype and closure through Ink projection. |
| Unicode text | Native executable | Non-ASCII text is rejected by the bounded Helvetica appearance contract. Removing validation alone would produce an incorrect appearance stream. |
| Image authoring | Source | Image placement writes and reloads the document outside canonical create/update history. |
| Recovery | Source | Restoring a saved-deleted image needs its raster source. Restoring a note must also preserve its read-only replies. |
| Save verification | Source | Native postconditions omit shape semantics and placed-image geometry updates. |
| Acceptance tests | Test audit | Some helpers repair focus or inject DOM selection. Nine skipped lifecycle cases leave save, deletion, and undo behavior unproved. |

Integration testing found additional failures that isolated tests had missed.
The click following text creation could miss the new rectangle by floating-point
rounding, clear selection, and remove the empty draft. A real Electron trace
showed creation and focus on pointer release, followed by deletion on click.
Completed creation now consumes that gesture's click. The regression uses the
actual controller and component with the same pointer coordinates.

The armed Text tool also intercepted later caret clicks inside the current
editor and created a second box. The current editing target now takes priority.
Eight delayed typing and pointer-caret attempts pass in actual Electron, along
with two saves of a focused draft and a fresh-process reopen.

Image dragging stopped after its first movement because a watcher treated every
replacement preview object as a new placement. The component regression echoes
each rectangle update back through the parent, then requires all eight movement
events to reach the exact final position. The watcher now observes the values
that actually identify or cancel a placement.

The inline inspector also needed an explicit stretching layout for the slider.
Its previous column alignment reduced the track to minimum width. Real DOM
checks now measure the track and the plus/minus centers at two sidebar widths.

The acceptance helpers had separate defects. Hidden cached toolbars matched
before the visible toolbar, sidebar cards shared entity attributes with page
annotations, and fresh-process cleanup removed test-owned input PDFs. Helpers
now check visible hit targets and preserve saved fixtures outside session-owned
directories. They assert the focus produced by input rather than repair it.

A later trace caught the sidebar-tab helper clicking during its opening
transition. Its first click hit a note marker underneath the moving tab and
opened a note window over the requested text point. The helper now requires
three stable animation frames and a matching hit target before clicking. The
overlap test retains its original page coordinates and asserts that opening
the sidebar does not open a note window.

## Interaction contract

The properties editor is an inline section of the annotation sidebar. An armed
creation tool shows its defaults. Select mode shows properties for the selected
annotation. Merely committing or moving an annotation does not open another
popup or change keyboard focus.

One document-level interaction controller owns active text editing and the
active pointer operation. Changing tools commits text once, cancels an unfinished
pointer operation, clears the old selection, and arms the requested tool.
Escape cancels the current operation before changing selection or tool state.
Note placement returns to Select immediately and leaves the new note open for
typing. Notes do not inherit the repeat setting from other tools. Other tools
return to Select unless Keep active is enabled. A text operation completes when
the draft commits.

The text frame remains visible while typing. The caret stays inside it. Editing
and committed text use the same font and wrapping rules. A deliberate manual
width remains meaningful when the content grows. Selection handles describe the
same geometry the annotation renders, including rotation.

Pointer operations retain an immutable starting point and original geometry.
The preview and committed result use the same calculated geometry. Page and view
rotation use matching display and inverse input transforms.

Sidebar cards and note windows derive content and colors from canonical state.
An unmodified note draft follows undo and external edits. An unsaved local draft
is preserved until the user commits or cancels it. Window placement, stacking,
saving status, and errors are reactive UI state.

Keyboard focus and annotation selection have separate meanings. Focus must move
to a usable control when editing removes its input element. This follows the
[W3C keyboard interface guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/).
Any composite toolbar must implement the navigation associated with its role,
as described in the [W3C toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/).

## Persistence contract

Every semantic change must appear in the next save plan, including undo after
saving and an edit made after undo. Save acknowledgement and reparsing cannot
erase valid annotation history. Restoring a saved deletion recreates the logical
annotation with a current PDF identity and all supported content.

Shape projection preserves ordered endpoints, line endings, subtype, closure,
stroke, fill, and opacity. Text appearance must preserve supported Unicode text
visually and through extraction. Native validation must check requested output
semantics before publication. A parser round trip alone does not prove that a
PDF appearance paints correctly.

## Acceptance and publication evidence

The full unit run passed 1,319 files and 11,363 tests, with four unrelated
existing skips. Full lint, Vue, and workspace TypeScript checks passed. The required
affected scan-cleanup oracles passed. Late integration fixes receive focused
regressions and another final verification pass. The final native source passes
331 tests, formatting, and strict Clippy.

The combined Electron run passed 20 of 21 scenarios, including all three text
controls cases and the complete 11-variant drawing, shape, and markup matrix.
The sole failure was the sidebar-tab helper misclick described above. After
that test-only correction, the original overlap case and all three text controls
pass together in a four-case rerun. No application
source changed after the combined run. The matrix covers authoring, style
changes, movement, resize, deletion and undo, native save, and fresh-process
reopen. Image acceptance compares exact decoded pixels across JPEG and PNG
preview encodings.

The actual 383-page Haspelmath and Sims book passed hidden Electron acceptance
at a 1,869 by 1,018 viewport and 292% fit-width zoom. The test uses a copied PDF,
a 100 ms pointer press, a one-second delay before typing, a visible compact
frame, real pointer caret placement, and matching green page/sidebar colors.
Native save and a fresh Electron process preserved exactly one matching
FreeText annotation and its color. The original book was not modified.

Independent Poppler rendering checked supported Unicode and all 16 cardinal
page/text rotation combinations. A sparse 513 MiB PDF passed two incremental
Unicode saves in 648 ms and 656 ms, reused one embedded font, and preserved the
entire original file prefix. Native PNG alpha and JPEG appearance checks also
passed independent rendering and qpdf validation.

CodeRabbit's full request exceeded its 150-file limit. The review was divided
by directory without enabling paid credits. Findings are assessed against
tests and ownership rules. Snapshot-capture errors deliberately keep notes
read-only; swallowing those errors would lose reply recovery on saved-delete
undo. Active-page unmount already clears gesture offsets centrally, with a
new regression covering unrelated-page unmount as well.

The second review found real persistence defects. Saving another annotation
could unnecessarily rewrite a clean raster image. Image finalization could use
a newer view rotation than the placement draft. Recovered PDF streams could
retain a stale Length. All three now have focused regressions. History cleanup
also releases every command if one release callback throws, preserving the
original replay error.

Actual save, undo, and redo exposed a separate highlight defect. The native
writer blended the authored RGB with white and also wrote an opacity value.
Reparsing therefore changed the color and made a restored saved state look
dirty. The writer now preserves RGB and applies opacity once. The same Electron
test now preserves identity and returns the document to a clean state after
redo.

The separate scan-cleanup line-budget gate was already over budget on the base
commit. Its native and total counts exceed their baselines by 3,401 production
lines. This annotation change does not increase that allowance. Stale tests
for moved scan source and bootstrap behavior were repaired without changing
production scan code or its baseline.

Known limits remain explicit. Unsupported font glyphs fail validation. Imported
non-cardinal FreeText stays read-only. PNG decoding normalizes samples to eight
bits; ICC color-management fidelity was not established. PDF text extraction
may apply directional wrappers and visual ordering to RTL text, while the
annotation's Contents retains the original text.

The acceptance matrix requires real pointer and keyboard authoring, a visible
typing frame, matching page and sidebar colors, every markup subtype, reverse
shape drags, live resize previews, rotation, notes and images, mixed history,
saved-deletion undo, save and hard reopen, and a large-document pass. Test code
must not repair focus or synthesize application state to make these interactions
pass. Saved PDF text also requires an independent renderer and extraction check.
