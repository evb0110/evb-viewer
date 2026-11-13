# Architecture

EVB Viewer is one Nuxt codebase rendered by two shells, an Electron desktop app
and a browser workspace. Rust sidecars and WebAssembly engines do the heavy
document work. This page is the map. The decisions behind it are in
[docs/architecture/adr](docs/architecture/adr).

```
┌──────────────────────────────────────────────────────────┐
│ Renderer (app/)                                          │
│   Nuxt 4 + Vue 3. Workspace shell, tabs, splits, panes.  │
│   PDF.js renders pages. Canonical annotation store.      │
└───────────────┬──────────────────────────────────────────┘
                │ typed IPC (packages/contracts)
┌───────────────▼──────────────────────────────────────────┐
│ Electron main (electron/)                                │
│   Feature services, job queues, resource governors,      │
│   document store, settings, updates.                     │
│   ├─ spawns native sidecars (CLI, JSON envelopes)        │
│   └─ hosts the MCP server (two listeners)                │
└───────────────┬──────────────────────────────────────────┘
                │ argv + stdin/stdout protocol
┌───────────────▼──────────────────────────────────────────┐
│ Native (native/, Rust)                                   │
│   scan-cleanup · pdf-page-ops · pdf-image-combine ·      │
│   pdf-search · jbig2-codec · evb-raster-io ·             │
│   scan-primitives · evb-native-support                   │
│   plus third-party: poppler, qpdf, djvulibre              │
└──────────────────────────────────────────────────────────┘
```

## The three roles, one owner each

[ADR 0002](docs/architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md) is
the decision that shapes everything else. PDF.js is a read-only renderer and
never produces PDF bytes. Each kind of write has one writer: the Rust
`pdf-page-ops` crate rewrites page trees (delete, extract, reorder, insert,
merge) into fresh files that copy stream data by byte range, appends
incremental edits (annotations, rotation, crop, bookmarks, page labels, the OCR
text layer) and lays out print sheets, qpdf optimizes and repairs whole files
on desktop, and `pdf-image-combine` writes pages from images. The
app owns the canonical annotation state, and every other view of an annotation,
on the page, in the sidebar, in the written file, derives from it.

This is why a Rust rewrite of the renderer was rejected: the expensive,
correctness-critical half is writing valid PDFs across encryption, incremental
saves, and multi-gigabyte files, and that half is already native.

The [page engine README](native/pdf-page-ops/README.md) describes its streaming
writer and verification, and lists the remaining qpdf uses.

## Documents and Save

[`packages/document-store`](packages/document-store/README.md) owns durability
on desktop, browser and extension. One directory per document holds its manifest,
revision files and unsaved drafts. The manifest is the only commit point.
Desktop uses the Node adapter; the browser uses OPFS through a dedicated storage
worker, with a Web Lock per document directory. IndexedDB retains browser file
handles and Recent Files metadata, not document bytes.

Save commits edits, checks the destination's size and modification time,
publishes the committed bytes and acknowledges that revision. Save As chooses
a destination without the external-change check. `pendingPublish` lets recovery
settle an interrupted publication. [ADR 0010](docs/architecture/adr/0010-document-store-manifest-is-the-commit-point.md)
records the durability decision.

`app/modules/workspace-shell/documentContext.ts` owns annotations, metadata,
history, Save, page operations, print and export once per document, outside a
view's mount. Linked views attach ports and keep their own page, selection,
tool and zoom. An action that needs view state takes it from its initiating view.

## Viewer resources

The PDF viewer has three owners:

- `pdfPageResources.ts` owns each page's requested and shown raster, quality,
  layer hydration and release. The shown raster stays until its successor
  publishes. Mounted slots and failure UI derive their state from this resource.
- `createViewportAuthority.ts` owns the placement transaction. Navigation,
  relayout, reload and restore resolve against the current layout through this
  owner; a newer gesture cancels an obsolete placement.
- `usePdfTextLayerRenderer.ts` owns one text-page record per mounted text-layer
  element, including its PDF.js text layer, structure tree, viewport and revision.
  A scale change updates that resource; a changed text source rebuilds it.

The raster scheduler admits and cancels demands under the shared surface budget.
A failed demand stays failed until the user requests Retry; it has no automatic
retry loop.

## Native crates

Electron spawns the runnable crates as CLI sidecars and exchanges JSON
envelopes; library crates supply their shared codecs, types and support code.
The binaries ship with the app they were built with, so there is no version negotiation: every binary carries a build ID
(a hash of the sources it links, from `scripts/native-build-id.mjs`), and a
development build refuses a binary whose ID differs from its own. The
scan-cleanup, pdf-page-ops and pdf-image-combine crates also build to
WebAssembly so the browser workspace can do the same work without a desktop
install.

| Crate | Owns |
| --- | --- |
| `scan-cleanup` | The cleanup engine, its CLI and its browser WASM build: analysis, routing, binarization, dewarp, mixed raster content, manifest protocol |
| `pdf-page-ops` | Streaming page structure, incremental edits, catalogs and print layout; annotation read and write, decryption, geometry, text shaping |
| `pdf-image-combine` | Image pages to PDF, across bilevel, JBIG2, JPEG, JPEG 2000, and TIFF paths |
| `jbig2-codec` | Lossless JBIG2 generic-region encode and decode, in the layout PDF readers expect |
| `scan-primitives` | Deterministic image and geometry types shared by the imaging crates |
| `pdf-search` | The desktop search engine: builds each document's text index and matches literal, whole-word and regex queries against it |
| `evb-raster-io` | PNG encode and decode with explicit decode limits and DPI metadata |
| `evb-native-support` | Shared CLI entry, error envelopes, and bounded readers |
| `protocol-fixtures` | Golden JSON fixtures both the Rust and TS decoders read |

The scan-cleanup sandbox boundary is deliberate: the sidecar receives its
allowed path root in argv rather than in the manifest it is processing, so a manifest cannot widen
its own access.

## Scan cleanup

One page moves through roughly twenty stages, from decode through analysis,
illumination and layout normalization, calibration, picture masking, mode
recommendation, spread splitting, deskew, cropping, rasterization,
binarization, post-processing, and finally render and write. The stage timings
struct is exhaustive on purpose: adding a stage fails to compile until every
accounting site handles it.

Auto binarization cuts each stroke between the paper and the ink core around
it, so text keeps its printed weight; Wolf and Sauvola run only when chosen
explicitly. Routing evidence is measured on the page's canonical analysis plane
so that changing the working render DPI cannot change it. Detection, preview
and final cleanup take that plane's DPI
from one function of the page alone: 150 DPI, never finer than the page's own
scan, and low enough for the raster to fit the cap every reader of it applies.

Poppler renders every page raster as PPM. Its PNG writer is fixed at maximum
compression, which costs a smooth scanned page tens of seconds, so a caller
that needs PNG gets the same pixels encoded by the app at the fastest level. What the engine is built for, and what it refuses, is written
down in [what scans work](docs/user/what-scans-work.md).

Desktop runs scan cleanup natively; the browser runs the same Rust engine as
`public/wasm/evb-scan-cleanup.wasm`, loaded by
`app/platform/browser-api/browserScanCleanupWasm.ts` in a worker.
`engine/document_analysis.rs` owns the document analysis sequence, layout
reconciliation, ink prior and alternate MediaBox analysis. Hosts supply the
rasters the sequence requests. Exact JSON analysis text crosses the boundary,
including signed zero. `engine/page_workflow.rs` owns page rendering and output
planes; native and WASM sinks publish the same engine output.

The renderer's detection session owns one map of page records; classifications,
recommendations and progress derive from it. Its preview session publishes one
frame value containing the result, presentation identity and cache key. Rust
protocol types generate `packages/contracts/scan-cleanup/nativeWire.generated.ts`;
`nativeProtocolV3.ts` validates native JSON at the boundary. See the
[package README](packages/scan-cleanup/README.md).

## OCR

Desktop and browser use the same pinned Tesseract and Leptonica WebAssembly
engine and the shared job in `packages/ocr-core`. Hosts supply raster, engine
pool and text-layer writer ports. Desktop renders with Poppler and preprocesses
with native scan cleanup; the browser uses PDF.js and scan-cleanup WASM.
`pdf-page-ops` writes the recognized text into the PDF. Search, text export and
the assistant read that layer; the search index is a revision-bound cache.

`packages/contracts/ocrLanguages.ts` owns model digests and the
`OCR_MODEL_SUBLANGUAGES` table. Download, packaging and engine mounts use the
same dependency closure. English and Russian are bundled; other models download
from the pinned `tessdata_best` revision and are verified before use.
[OCR](docs/architecture/ocr.md) owns the engine, model and recognition details.

## The assistant and MCP

One tool implementation serves two listeners, both bound to loopback.

- The **embedded assistant** runs one of the configured provider instances
  (Codex or Claude, each with its own executable, home, arguments and
  environment) as a child process restricted to EVB's tools, talking to a
  private server on a random port behind a bearer token.
- **External MCP** starts a fixed-port server for outside clients such as Claude
  Code or Cursor.

Both default to off, as separate settings. Requests carry a window and tab id,
and resources are addressed by `evb://` URIs that include document identity and
revision, so an agent is bound to one document in one window and a stale
revision is rejected rather than silently applied.
[ADR 0004](docs/architecture/adr/0004-assistant-is-optional-with-provider-adapters.md)
records why the providers are thin adapters over shared chat, tool, and
persistence code, and why the runtime never loads on ordinary startup;
[ADR 0008](docs/architecture/adr/0008-assistant-runs-provider-instances.md)
records why it runs provider instances on their own logins, with per-instance
status that never holds the panel.

## The Chrome extension

`packages/chrome-extension` packages the browser workspace as Chrome's viewer
for PDF and DjVu. Its service worker redirects a top-level PDF or DjVu response
to the extension's viewer page, a client-only build of the same workspace, which
fetches the document and opens it as a dropped file. Anything it cannot open
goes back to Chrome. The extension adds no document code of its own: whatever
the browser workspace can do, the extension does.
[Its README](packages/chrome-extension/README.md) covers the build, the
permissions and the rules an extension page imposes.

## Boundaries

The module graph is enforced, not documented. `pnpm run check:architecture`
runs dependency-cruiser import-boundary and cycle checks. The
rules worth knowing:

- `electron/**`, `packages/**`, and `landing/**` must not import `app/**`, and
  the reverse edges are blocked too. Nothing imports `scripts/**`.
- Packages are layered. Contracts and i18n-core are leaves; every other package
  may depend only on its declared targets.
- Cross-feature imports under `app/modules/**` and `electron/features/**` must
  go through a public entrypoint. A feature's `main/**` internals are private to
  that feature.
- `app/services/**` must not import `app/composables/**`.
- Component directories contain Vue SFCs only, and PDF composables stay in
  feature modules.

OxLint enforces defect checks and documented source-level invariants, including
platform-capability composition. Its small JS plugin handles invariants that
need an AST; `.oxlintrc.json` selects native rules. See
[ADR 0009](docs/architecture/adr/0009-lint-runs-on-oxlint.md).

## Where things live

```text
app/          Shared Nuxt renderer: viewer, workspace shell, modules
electron/     Main process: features, native-tool runners, MCP server
native/       Rust crates and the macOS print-dialog helper
packages/     Contracts, document store, OCR, PDF and scan-cleanup code, Chrome extension
server/       SSR routes for the browser build
landing/      Separate Nuxt site: downloads, docs, marketing
resources/    Bundled native binaries and OCR language data
scripts/      Build, packaging, release, and diagnostics
tests/        Unit, integration, and Electron end-to-end coverage
```
