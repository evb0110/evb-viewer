# PDF search-result match scrolling

Research date: 2026-09-02

Status: implementation research and regression fix.

## Reported behavior

The recording shows a search-result click moving the PDF viewer to the result
page while the selected match remains outside the zoomed page viewport. This
is most visible when a result is below the first match on a page.

The recording is 27.650 seconds, 3776x2100, at 60 fps. Later result clicks
reach distant pages while the viewer is highly zoomed. The target page renders,
but the match position is not the click target.

## Click path

The sidebar emits the result index through `PdfSidebar` and
`DocumentWorkspace`. `createWorkspacePdfSearchResultNavigation` previously
submitted a page-only search navigation request and then selected the result.
The selection incremented `currentResultNavigationId`, which caused
`usePdfRendererSearchController` to submit a second request after the first
request had already started.

The search result retains `words`, `pageWidth`, `pageHeight`, and `rotation`.
`createPdfSearchMatchScroller` turns the selected words into a normalized
marker rectangle and sends it to the PDF viewport authority. The authority
waits for page metrics, mounts the target page, waits for the search text layer,
and resolves the marker against the current page rectangle. With a centered
rectangle request, the vertical target is:

```text
pageContentTop + markerCenterY * pageHeight - viewportHeight / 2
```

The authority clamps that value to the document and target-page bounds. It
also uses the current rendered page rectangle, so zoom, page gaps, virtualized
pages, and segmented scrolling do not require a second coordinate calculation
in the search layer.

## Root cause

The workspace adapter split one user action into two competing navigation
intents. The first intent had only a page, so it could place the viewport at
the page start. The exact-match intent was reactive and could be superseded
after the first intent had applied.

This was a routing bug, not a search-index geometry bug. The exact marker
algorithm and the viewport authority already implement the required one-write
placement once the selected result is current.

## Fix

Result activation now selects the result only. The PDF renderer search watcher
remains the sole owner of search-result viewport navigation. It computes the
selected match marker before submitting the single semantic `{page, markerRect}`
request, which the authority centers after the target page is ready.

No raw `scrollTop` write, polling loop, second DOM correction, rotation rewrite,
or viewport-authority change was added.

## Verification

The regression unit test asserts that workspace result activation does not
submit an intermediate page navigation and performs only result selection.
The existing search-scroller test asserts one centered marker request with
normalized word geometry. Focused navigation, geometry, workspace, and search
tests pass, as do the changed-file ESLint check and repository typecheck.

The attached large-document recording was inspected locally. No copy of the
external Haspelmath fixture was added to the repository.
