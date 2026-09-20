# Viewer anchors, popups, and surface budgets

Status: accepted. The viewer keeps a fully visible current page as the page
indicator when possible, then chooses the most visible qualifying page with a
lower-page tie-break; resize, sidebar and split operations preserve the point
at the unobscured viewport center. An annotation note follows its marker, docks
inside the pane while its page remains visible, and hides with its open state
when that page leaves the pane so it cannot appear over an unrelated page.

The designated 2,000-page scanned-book acceptance fixture gets a 1 s feedback
target and the existing 10 s settlement target; these are EVB product budgets
rather than a PDF-rendering SLA. The supported surface is the existing 900 x 700
app-window baseline at effective UI scales 0.85–1.25. [PDF.js page-selection and
transform-origin logic](https://github.com/mozilla/pdf.js/blob/master/web/pdf_viewer.js)
supplies the page and anchor conventions, while [Acrobat's popup preferences](https://www.adobe.com/devnet-docs/acrobatetk/tools/PrefRef/Windows/Annots.html)
provide the edge-aligned and scroll-visible conventions. [Microsoft's UX
guidance](https://learn.microsoft.com/en-us/windows/win32/uxguide/vis-layout)
was considered for 800 x 600 but is not claimed as current support because this
runtime declares no minimum window size.

The note policy is implemented and has recorded Linux evidence for reachable
controls after zoom, following a sidebar relayout, and retaining text and open
state through hide/restore. The designated 2,000-page fixture has not yet been
measured, and the current runtime does not enforce a minimum window size.
