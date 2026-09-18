# Viewer behavior contract

Status: draft, awaiting owner approval. A statement marked **open** depends on a
product decision listed at the end; it is not a blocking expectation until the
owner decides. Agents treat the other statements as working expectations and
report disagreement instead of editing them. After approval, a change to a
statement, an exception, or a tolerance needs the owner.

This is the list of things that must be true for a person using the viewer. It
is written in user terms so it can be checked without reading the
implementation. Real-app tests, the dev-build monitor and later the explorer take
their expectations from here. See [fix evidence](../internal/agents/fix-evidence.md).

## Definitions

- **Applicability.** Every statement names when it applies. Outside that
  condition it is reported as not applicable, never as passed.
- **Settled.** No input for 500 ms, no pending navigation, and the app's
  navigation-idle signal observed. Settling has its own timeout: a viewer that
  does not settle within 10 s has failed, and checking is not skipped. UI
  readiness and page rendering completion are separate conditions.
- **Units.** CSS pixels of the unobscured document viewport: the pane area not
  covered by toolbars, sidebars or overlay scrollbars. Allow 1 px for device
  pixel rounding.
- **Document coordinates** are positions normalized to a page box after its
  rotation and crop. **Screen coordinates** are positions in the window.
- **Two-observation statements** compare two settled observations and need the
  checker to remember the previous one.

## Reading position

**R1. The page indicator names a visible page.** Settled: the page number
rendered in the toolbar is a page that intersects the viewport by at least a
quarter of the smaller of page height and viewport height. In facing mode either
page of a visible spread qualifies. Which of two visible pages it names is
**open**.

**R2. A deliberate navigation wins.** A click or key press on a navigation
target (toolbar page controls, a thumbnail, an outline or bookmark row, an
annotation row, a search result) is acknowledged within 1 s and the destination
is visible and aligned as that control defines once settled. Work that started
before the navigation cannot move the viewport afterwards, including the
inertial tail of a wheel gesture. A new deliberate gesture after the navigation
may move it. Latency bounds are stated per fixture and environment. Synthetic
wheel events do not prove coverage of native macOS inertia; that needs a
recorded hands-on check.

**R3. Zoom, resize and sidebars keep the place.** Two observations. Across a
toolbar zoom, a window or pane resize, a sidebar open or close, and a split, the
document point at the operation's anchor stays at the anchor, within the
measured rounding tolerance of that operation. Toolbar zoom anchors the viewport
center; pointer zoom anchors the pointer; rotation maps the anchor through the
page transform. Exceptions: the anchor is clamped at a document boundary; a fit
mode re-fits and keeps the same page. The anchor for each operation is **open**
until confirmed.

**R4. Reopening restores the place.** When restoration is enabled and the
document identity is unchanged, reopening a document or restoring a workspace
returns to the same page, zoom mode and view mode. An explicit reset is not a
restore.

## Layout

**L1. Fit modes fit the current page.** Settled. Fit-width: no horizontal scroll
range when no page intersecting the viewport is wider than the current page or
spread; in a mixed-size document a wider neighbor may overflow. Fit-height and
fit-page: in paged mode the current page or spread has no vertical scroll range.
Margins and a classic scrollbar's width are part of the available area.

**L2. No unexplained blank surface.** Settled: every page intersecting the
viewport is rendered, or shows explicit loading or error feedback. A genuinely
blank page is valid, so this asserts render readiness, not pixel content. Time
bounds are **open** until measured on large scanned books.

**L3. Layout corrections keep the reading anchor.** Page geometry may be
discovered progressively, so document height may change. While it does, the
visible reading anchor of R3 does not move.

**L4. Chrome stays reachable.** At any supported window size and UI scale:
essential controls are reachable directly or through an overflow menu, text may
truncate with an ellipsis but is not cut mid-glyph, and a resize sash is
reachable while its panel is open.

## Annotations

**A1. Marks stay on their content.** Two observations: an annotation's position
normalized to its page box does not change across scroll, zoom, resize, rotation
and tab switches unless it was edited. One observation: its box intersects its
own page's box and its center lies within that box expanded by 24 px. Strokes,
decorations and shapes drawn past the page edge may extend outside.

**A2. A note window follows its anchor.** One observation: an open note window
lies inside the visible pane. Two observations: when the anchor is visible both
times and the window is not clamped to a pane edge, the window moved by the same
screen delta as its anchor, scaled by any zoom change. What happens when the
anchor leaves the viewport is **open**.

**A3. Destructive actions hit only their target.** Deleting or discarding acts
on the item the user chose, with per-type semantics: discarding a note attached
to a highlight keeps the highlight unless the user chose to remove both. Undo
restores the last undoable transaction in its scope.

**A4. What is drawn can be saved.** For advertised editable formats and
documents that permit it, any annotation the UI let the user create can be
saved. A failure names the problem, keeps the user's work, and allows correction
and retry; one annotation never blocks every later save.

**A5. Round trip.** After save and reopen, every supported annotation keeps its
type, page, geometry in document units within declared normalization, color,
text, author, replies and appearance. Unsupported foreign annotations are
preserved; that is checked on the saved data, not on screen.

**A6. Lists match the document.** The comments sidebar lists each supported
annotation once under the active filters, grouping and reply rules, and
activating a row navigates to it (R2).

## Input

**I1. Visible controls respond.** A trusted click on an enabled, hit-testable,
unobscured control is acknowledged within 1 s: its effect, visible progress, or
defined feedback when the action is a no-op. Acknowledgement and completion are
separate.

**I2. One active row per menu level.** A context menu level shows at most one
highlighted row, and Enter activates only an enabled highlighted row.

**I3. Selection survives highlights.** In text-selection mode, on selectable
text, starting a selection on top of a search or annotation highlight selects
the text under it, unless an explicit editing gesture takes precedence.

## Documents and tabs

**T1. Tabs are isolated.** Work, failure or closing in one tab does not change
the page, zoom, annotations, or responsiveness of another.

**T2. Unsaved work is protected.** Closing a tab, a window or the app with
unsaved changes asks first, and a crash or forced quit leaves recoverable work.

**T3. Output is complete and usable.** A saved or exported file opens in this
viewer and in a stock reader, with all pages and the saved annotations.

## Lifecycle

**C1. Closing is clean.** Closing a tab or window at any moment, including during
a fling, a render, a save or an OCR run, corrupts nothing, loses no accepted edit
and does not disturb other tabs. Cancellation feedback, an unsaved-changes prompt
and a genuine save error are allowed. An error toast or crashed-tab banner caused
only by cancelled work is not.

**C2. Diagnostics policy.** With well-formed documents, ordinary use produces no
console error and no unhandled rejection. Malformed input may produce
diagnostics. An allowlist entry matches a narrow signature and states its reason.

**C3. A failed tab recovers.** After a tab is isolated by a failure, opening a
known-good document in it or in a new tab works. Reopening the corrupt document
need not succeed.

## Open questions for the owner

1. R1: which page should the indicator name when two pages are visible, and in
   facing mode?
2. R3: confirm the anchors: viewport center for toolbar zoom, pointer for wheel
   and pinch zoom, and what resize and sidebar toggles should hold still.
3. A2: when the anchor page leaves the viewport, should the note window hide,
   dock to the pane edge, or stay?
4. L2 and R2: acceptable time bounds on a 2,000-page scanned book.
5. L4: the supported minimum window size and UI scale range.
