# Repeated search match navigation

The September 5 recording uses the 383-page Haspelmath and Sims PDF, the query
`lezgian`, and 380% zoom. Selecting different sidebar results repeatedly returns
the viewport to section 1.3 on physical page 23. The recording also contains a
blank transition. The earlier final-result sidebar regression does not exercise
this alternating sequence.

## Reproduction

The Electron regression alternates physical page 23's two occurrences with
pages 81, 82, and 83. It uses pointer clicks after checking hit targets and checks
selected text geometry after navigation settles. The fixture remains external;
the ordinary test path uses the existing generated search PDF.

Before the fix, returning from page 83 to page 23's second match left the current
highlight 715.6 pixels above the viewport center. A separate run selected the
first occurrence but marked the second, 281.9 pixels below the center.

## Ownership of pending navigation

The sidebar selects a result. The renderer's search controller submits one
semantic navigation request containing the selected page, text range, and
page-local occurrence. The viewport authority mounts the destination, waits for
text readiness, resolves the DOM range, and writes the final position.

A ResizeObserver notification can arrive while the destination is hydrating.
The resize lifecycle captures a semantic anchor from the outgoing viewport and
passes it to `submitViewportStateIntent('resize', {anchor})`. Previously, an
explicit anchor disabled inheritance of pending navigation. The resize then
cancelled the search and committed its captured page position without the text
range or text readiness requirement.

The failing trace recorded the search waiting for page 23's text layer, followed
by a resize intent with no inherited navigation and a write at scrollTop 61785.5.
The selected word was outside the viewport. No second click was necessary to
trigger the competing request.

Resize now inherits the pending semantic destination even when the lifecycle
supplies an outgoing anchor. Explicit pointer-centered zoom retains its own
precedence. Resize previews defer while navigation owns the viewport, so they
cannot add an intermediate jump. A deferred preview must also remain distinct
from unavailable geometry, which otherwise triggers the rerender coordinator's
page-only fallback.

## Highlight identity

Native search and PDF.js can assemble whitespace differently. On page 23,
the backend range for the first result is 363 through 370. Navigation resolves it to
the first rendered `Lezgian`, near normalized coordinates 0.091, 0.242.
The previous highlighting fallback instead selected the rendered occurrence
nearest the backend offsets, marking the second `Lezgian` at 0.840, 0.362.
The scroll position itself remained equal to the authority's applied position.

When backend results are ordered and rendered occurrence counts agree, the page-local occurrence
index supplies the identity across different text offsets. Offset-distance
fallback remains relevant when the two extractions have different match counts.

The resolver also needs the count agreement before choosing an occurrence over
an apparently valid offset. An offset can land on a different identical word.
Comparing the extracted word alone cannot establish its identity.

Count agreement authorizes replacing an otherwise valid native range. It does
not disable the existing occurrence fallback when the native range cannot map.
For unequal counts, the resolver still tries the valid native range first and
then the legacy rendered occurrence. Returning only a page position in that
case would remove working navigation for PDFs with extraction differences.
Range validation also respects the search's case-sensitive setting.

## Horizontal placement

The page 23 to page 83 trace applied scrollLeft 73.5, then the active-spread width
clamp reset it to zero. The target row fit inside the viewport, but the initial
calculation used the larger scrollWidth contributed by other pages. Removing
the horizontal scrollbar also delivered an ambient resize. That resize repeated
the settled vertical position rather than adding a second vertical jump.

Navigation must apply the target row's width constraint before committing its
position. Facing layouts use the whole target row, so a narrow individual page
does not disable scrolling across a wider spread. The Electron regression counts
one semantic match placement and requires any ambient resize to repeat the same
coordinates.

## Regression requirements

- An anchored resize during delayed text readiness retains the exact search
  target and produces one final viewport write.
- A deferred resize preview cannot issue a page-only fallback.
- Equal-count text extractions with shifted offsets mark the selected occurrence.
- Real pointer selections alternate near and distant results at 380% zoom.
  The selected highlight must remain visible and centered after settling, match
  the clicked text, and paint highlight pixels in the measured rectangle.
- The existing last-result sidebar visibility and hit-testing regression remains
  part of the same Electron suite.

## Virtual page handoff

The generated 241-page fixture exposed another failure at 380% zoom. Navigation
placed page 241's first match at scrollTop 726983. During the following Vue DOM
update, the browser reduced scrollTop to 674678 and the viewer reported page
223. The final scrollHeight was 730154, so the final document extent was valid.
Three independent replays produced the same coordinates.

The disjoint navigation window collapses into the new visible window after
placement. Removing the old pages can trigger layout before the spacer update
finishes. The browser sees a temporarily shorter document and clamps scrollTop.
Stable spacer keys do not prevent this intermediate layout.

A test-only fixed-height experiment made the complete sequence pass. The
production fix derives the physical scroll height from layout metrics and
preserves that extent with an absolute, non-interactive track pseudo-element.
It does not change page flow or add another scroll. The extent follows zoom,
resets in paged mode, and respects the existing physical segment limit for
very large documents. The generated fixture then passed without the experiment.

## Verification

- `pnpm validate:iteration` passed lint, both type checks, and 609 tests across
  55 related unit files.
- The complete Electron search-match suite passed on the supplied 383-page PDF
  at 380% zoom, including the seven alternating pointer selections.
- The same suite passed on the generated 241-page fixture. Its repeated
  selections include multiple occurrences on the last page at 380% zoom.
- Both Electron runs check highlight geometry after settling, painted highlight
  pixels, pointer hit targets, and one semantic placement per selection.

## Highlight color handoff follow-up

The 09:57 recording showed two remaining transition defects. The outgoing
current match changed from orange to yellow before departure. Some destination
pages also appeared before their orange current highlight. The earlier
regression checked settled geometry and could not detect these frames.

The strengthened Electron regression samples every animation frame around each
pointer selection. Before the fix it recorded pre-commit frames with no orange
highlight on either the outgoing or destination page.

Highlight refresh followed the sidebar's requested selection immediately and
ran in animation-frame slices. Navigation waited for the target text layer but
did not coordinate that selection change with the viewport write. The renderer
now retains a separate painted selection until the viewport authority enters
its synchronous `applying` phase. It refreshes the previous and destination
pages in that same turn, before the scroll write, and invalidates older refresh
slices. Other search results remain yellow after the handoff.

The request carries the search navigation ID through resize absorption, so a
newer same-page occurrence cannot inherit an older request's highlight commit.
Clearing search cancels search-owned navigation while preserving destinations
from other controls. Tests cover delayed readiness, same-page duplicate
selection, supersession, and clearing the query.

The full Electron search-match suite passed on both the supplied 383-page PDF
and generated 241-page fixture at 380% zoom. Each repeated pointer selection
checks every sampled frame for premature outgoing demotion or missing orange
on arrival, as well as the existing settled geometry and single-scroll checks.

Follow-up validation passed both type checks, affected lint, 489 related unit
tests across 49 files, and the dead-code and duplication gates. CodeRabbit
completed its review with two trivial suggestions and no correctness findings.
The existing refresh scheduling and the explicit OCR test setup were retained.

## Fresh-start recording at 11:41

The previous color-handoff verification was incomplete. Its animation-frame
monitor checked whether a current-highlight element existed. It did not check
ancestor opacity or capture compositor pixels during the transition. A current
highlight inside an invisible text layer therefore passed the test.

The new recording contains four gaps without an orange highlight in the PDF
viewport. Pixel analysis measured gaps of about 220 to 380 ms. Attaching to the
user's running dev Electron process reproduced the same failure with real
pointer clicks between PDF pages 22 and 81. The source included the earlier fix.
The viewport was 1869 by 1018 CSS pixels at device scale factor 2 and 380% PDF
zoom.

The diagnostic capture combined existing viewport-authority events with DOM
mutation records, animation-frame geometry and computed ancestor styles,
ResizeObserver measurements, and CDP screencast frames. All four clicks failed
the painted-pixel check. Of 58 captured frames, 34 had no orange pixels in the
PDF viewport even though the current-highlight element retained its orange
background and opacity 1.

The hidden parent was `.text-layer`. The `pdfViewer--resize-transition` class
set its opacity to zero. Navigation between pages with different rendered
widths admitted or removed the horizontal scrollbar. The outer viewer rectangle
stayed constant while its client height alternated between 896 and 881 pixels.
The resize lifecycle treated this 15-pixel change at fixed scale as a full
resize, hid the text layer, and scheduled a redundant raster/layer rebuild.

A temporary, single-variable experiment in the running app kept text-layer
opacity at 1 during the resize transition. The same four clicks then had zero
missing-orange frames out of 59. The experiment was removed after capture.

The source repair distinguishes a viewport-size change from a fit-scale change.
At unchanged scale, with no pending scale-changing resize burst, it submits the
semantic resize intent to the viewport authority. That controller retains the
pending search destination and updates visible render demand. It does not hide
or invalidate the already valid canvas and text layers. Existing scale-changing
resize behavior and pending-burst ownership remain intact.

Opt-in render tracing now records `resize-observer-render-decision`, including
old/new client dimensions, whether scale changed, the pending navigation page,
and whether existing layers are preserved. `resize-layer-visibility-transition`
records each show/hide signal with its source and token. These join the existing
navigation and render events in the same timestamped trace buffer.

The strengthened Electron regression failed on the old source with three
zero-orange compositor frames. With the fix, its fresh-process replay passed
11 pointer selections. The ten monitored transitions retained orange in all
67 captured compositor frames. Both full Electron suites then passed, on the
supplied PDF and the generated 241-page document. The checks retain duplicate
occurrence identity, hit testing, settled centering, and single-placement
assertions.

Both type checks, affected lint, 391 related unit tests across 37 files, and the
dead-code and duplication gates passed. The existing workspace-host setup test
now loads its compiled Vue dependency graph before timing the setup assertion;
cold transform work had exceeded its five-second test timeout. CodeRabbit's
initial review requested one stronger destination assertion, which was added to
the scrollbar regression with a valid 383-page fixture model.
