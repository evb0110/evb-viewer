# Document viewer architecture

The document viewer module owns the runtime shared by the PDF.js viewer,
native PDF preview, DjVu preview, scan cleanup, and workspace document panes.
It is a feature module because those callers need the same document-facing
contracts and lifecycle rules. The implementation lives under
`app/modules/document-viewer/`.

## Interface

Cross-module consumers import `app/modules/document-viewer/public.ts`. The
entrypoint exposes document page sources, page metrics, render leases,
thumbnail and search contracts, viewport and zoom calculations, opening-preview
state, and the document viewer runtime used to coordinate an active source.
The implementation files remain private to the module and its tests.

The PDF viewer owns PDF.js loading, PDF annotation editing, PDF serialization,
and PDF page rendering. It supplies those capabilities to the document viewer
page-source contract. The document viewer does not create PDF bytes and does
not own annotation state.

## Lifecycle ownership

One document viewer runtime owns the open document presentation, viewport
generation, opening preview, render ownership, and release ordering for a
mounted document source. A source returns a render lease for a page or
thumbnail. The caller releases that lease after the surface is no longer in
use, and the source settles any active render before it releases the underlying
resource.

`Opening preview` is the fast first paint while the authoritative renderer is
loading. The PDF viewer may provide its geometry and pixels, but the document
viewer owns the presentation state that decides when the preview can be
replaced.

## Boundary

The architecture checker enforces the public entrypoint for every app consumer.
The PDF.js import allowance follows the PDF page-source adapter at
`app/modules/document-viewer/source/`. No consumer may import a private file
from this module.
