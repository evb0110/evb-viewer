# Viewer behavior contract

Status: draft, awaiting owner approval. Until approved, agents treat each
statement as the working expectation and report disagreement instead of editing
it. After approval, a change to a statement, an exception, or a tolerance needs
the owner.

This is the list of things that must always be true for a person using the
viewer. It is written in user terms so it can be checked without reading the
implementation. Real-app tests, the explorer and the dev-build monitor take
their expectations from here. See [fix evidence](../internal/agents/fix-evidence.md).

Each statement has an applicability condition. Outside it the statement is not
checked. "Settled" means no input for 500 ms, no pending navigation, and
`navigation-idle` observed. "During a transition" means between an input and the
next settled state.

Coordinates: document coordinates are positions relative to a page box; screen
coordinates are positions relative to the window. A statement says which one it
constrains.

## Reading position

**R1. The page indicator tells the truth.** Settled, continuous single-page
mode: the page number rendered in the toolbar is the page that covers the
vertical center of the viewport. In facing mode it is one of the pages of the
spread that covers the center. Not checked while a page is still being laid out
after open.

**R2. A deliberate navigation wins.** A click or key press on a navigation
target (toolbar page controls, a thumbnail, an outline or bookmark row, an
annotation row, a search result) reaches its target within 2 s and stays there,
even when it arrives during the inertial tail of a wheel gesture. Work started
before the navigation cannot move the viewport afterwards. A new deliberate
gesture after the navigation may move it.

**R3. Zoom, resize and sidebars keep the place.** Across a zoom change, a window
or pane resize, a sidebar open or close, a split, and a rotation, the document
point that was at the viewport's anchor stays within 8 px of where the mode
defines it should be. Fit modes re-fit; they do not jump to another page.
Exception: a fit mode change is itself a navigation to the fitted view of the
same page.

**R4. Reopening restores the place.** Reopening a document or restoring a
workspace returns to the same page, zoom mode and view mode.

## Layout

**L1. Fit modes fit.** Settled, fit-width: no horizontal scroll range. Settled,
fit-height or fit-page in paged mode: no vertical scroll range. Tolerance 1 px.

**L2. No blank reading surface.** Settled: every page that intersects the
viewport shows rendered content or, for at most 1 s after it entered the
viewport, its skeleton. During a transition a blank frame may last at most
250 ms.

**L3. Page geometry is stable.** Scrolling does not change the document height,
the gap between pages, or the document position of any page.

**L4. Chrome stays usable.** At any window size of at least 640 by 480: toolbar
controls do not overlap, sidebar text is not clipped mid-glyph, and a resize sash
stays visible while its panel is open or animating.

## Annotations

**A1. Marks stay on their content.** In document coordinates, a highlight,
underline, shape, stamp, text box or note icon keeps its position relative to
its page across scroll, zoom, resize, rotation and tab switches. On screen its
box lies inside its page box, except for a shape the user drew past the page edge.

**A2. A note window follows its page.** An open note window keeps its offset to
its anchor while the page scrolls or zooms, clamped to the visible pane. It never
sits over a different page than its anchor while the anchor is visible.

**A3. Destructive actions hit only their target.** Deleting or discarding a note
does not remove the highlight it is attached to unless the user chose that.
Undo restores exactly what the last action changed.

**A4. What is drawn can be saved.** Any annotation the UI let the user create
can be saved, and saving never fails for every later attempt because of one
annotation.

**A5. Round trip.** After save and reopen, every annotation is present with the
same type, page, geometry within 1 px at 100%, color, text and author. Foreign
annotations are preserved.

**A6. Lists match the page.** The comments sidebar lists every annotation on the
document once, and activating a row navigates to it (R2).

## Input

**I1. Every visible control responds.** A trusted click on an enabled, visible
control produces its visible effect within 1 s, or visible progress.

**I2. One active row.** A context menu shows at most one highlighted row, and
Enter activates the highlighted row only.

**I3. Selection survives.** Starting a text selection on top of a search or
annotation highlight selects the text under it.

## Lifecycle

**C1. Closing is clean.** Closing a tab or window at any moment, including during
a fling, a render, a save or an OCR run, produces no error toast, no crashed-tab
banner, no unhandled rejection, and leaves other tabs working.

**C2. No silent errors.** Ordinary use produces no console error and no
unhandled rejection. Known benign messages are listed in the checker's allowlist
with a reason each.

**C3. A failed tab recovers.** If a tab is isolated after a failure, opening a
document in it or in a new tab works.

## Open questions for the owner

1. R1: which page should the indicator show when two pages share the viewport
   equally, and in facing mode?
2. R3: which anchor should zoom keep, the viewport center or the pointer
   position, and does wheel zoom differ from toolbar zoom?
3. A2: when the anchor page scrolls out of view, should the note window hide,
   dock to the pane edge, or stay?
4. L2: are the 1 s skeleton and 250 ms blank-frame bounds acceptable on large
   scanned books?
5. R2: is 2 s the right bound for a 2,000-page document?
