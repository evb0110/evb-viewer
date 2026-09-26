# Architecture

EVB Viewer is one Nuxt codebase rendered by two shells, an Electron desktop app
and a browser workspace, sitting on a set of Rust sidecar processes that do the
heavy document work. This page is the map. The decisions behind it are in
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
│   working copies, settings, updates.                     │
│   ├─ spawns native sidecars (CLI, JSON envelopes)        │
│   └─ hosts the MCP server (two listeners)                │
└───────────────┬──────────────────────────────────────────┘
                │ argv + stdin/stdout protocol
┌───────────────▼──────────────────────────────────────────┐
│ Native (native/, Rust)                                   │
│   scan-cleanup · pdf-page-ops · pdf-image-combine ·      │
│   pdf-search · jbig2-codec · evb-raster-io ·             │
│   scan-primitives · evb-native-support                   │
│   plus third-party: tesseract, poppler, qpdf, djvulibre  │
└──────────────────────────────────────────────────────────┘
```

## The three roles, one owner each

[ADR 0002](docs/architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md) is
the decision that shapes everything else. PDF.js is a read-only renderer and
never produces PDF bytes. Each kind of write has one writer: qpdf restructures
whole files on desktop, the Rust `pdf-page-ops` crate appends incremental edits
(annotations, rotation, crop, bookmarks, page labels, the OCR text layer) and
lays out print sheets, and `pdf-image-combine` writes pages from images. The
app owns the canonical annotation state, and every other view of an annotation,
on the page, in the sidebar, in the written file, derives from it.

This is why a Rust rewrite of the renderer was rejected: the expensive,
correctness-critical half is writing valid PDFs across encryption, incremental
saves, and multi-gigabyte files, and that half is already native.

## Native crates

They are separate processes, not linked modules. Electron spawns them as CLI
sidecars and exchanges JSON envelopes. The binaries ship with the app they were
built with, so there is no version negotiation: every binary carries a build ID
(a hash of the sources it links, from `scripts/native-build-id.mjs`), and a
development build refuses a binary whose ID differs from its own. Two of
them also build to WebAssembly so the browser workspace can do the same work
without a desktop install.

| Crate | Owns | Scale |
| --- | --- | --- |
| `scan-cleanup` | The cleanup engine and its CLI: analysis, routing, binarization, dewarp, mixed raster content, manifest protocol | ~78k lines |
| `pdf-page-ops` | Incremental edits, catalogs, and print layout; annotation read and write, decryption, geometry, text shaping | ~49k lines |
| `pdf-image-combine` | Image pages to PDF, across bilevel, JBIG2, JPEG, JPEG 2000, and TIFF paths | ~10k lines |
| `jbig2-codec` | Lossless JBIG2 generic-region encode and decode, in the layout PDF readers expect | ~4.6k lines |
| `scan-primitives` | Deterministic image and geometry types shared by the imaging crates | ~4.5k lines |
| `pdf-search` | The desktop search engine: builds each document's text index and matches literal, whole-word and regex queries against it | ~1.1k lines |
| `evb-raster-io` | PNG encode and decode with explicit decode limits and DPI metadata | ~2.5k lines |
| `evb-native-support` | Shared CLI entry, error envelopes, and bounded readers | ~2k lines |
| `protocol-fixtures` | Golden JSON fixtures both the Rust and TS decoders read | fixtures only |

The sandbox boundary is deliberate: the sidecar receives its allowed path root
in argv rather than in the manifest it is processing, so a manifest cannot widen
its own access.

## Scan cleanup

One page moves through roughly twenty stages, from decode through analysis,
illumination and layout normalization, calibration, picture masking, mode
recommendation, spread splitting, deskew, cropping, rasterization,
binarization, post-processing, and finally render and write. The stage timings
struct is exhaustive on purpose: adding a stage fails to compile until every
accounting site handles it.

Binarization picks a route per page. Otsu handles flat, evenly lit text, Wolf
handles local contrast and illumination evidence, and Sauvola handles heavy
illumination deviation with thin strokes. The routing decision is made on a
canonical 150 DPI analysis plane so that changing the working render DPI cannot
change the route. What the engine is built for, and what it refuses, is written
down in [what scans work](docs/user/what-scans-work.md).

## OCR

Poppler renders each page to a raster through the same renderer scan cleanup
uses, with explicit pixel and dimension caps. An optional preprocessing pass
handles poor scans. Tesseract then runs per page against `tessdata-best` models
and emits a text-only PDF layer, which is checkpointed per page so a long job
can resume. Finally `pdf-page-ops ocr-text-layer` writes every recognized page
into the original as one incremental revision: it removes previous OCR text
from each page and maps the Tesseract page into the page view, including
rotation and the preprocessing inverse. That text layer is the only store of
the recognized text: search, text export and the assistant read it from the
PDF, and the search index is a cache rebuilt whenever the document revision
changes.

English and Russian are bundled. The other 28 languages download from a pinned
upstream revision and are verified by SHA-256 before use.

## The assistant and MCP

One tool implementation serves two listeners, both bound to loopback.

- The **embedded assistant** runs its provider in a sandboxed child process with
  an isolated home directory, talking to a private server on a random port
  behind a bearer token.
- **External MCP** starts a fixed-port server for outside clients such as Claude
  Code or Cursor.

Both default to off, as separate settings. Requests carry a window and tab id,
and resources are addressed by `evb://` URIs that include document identity and
revision, so an agent is bound to one document in one window and a stale
revision is rejected rather than silently applied.
[ADR 0004](docs/architecture/adr/0004-assistant-is-optional-with-provider-adapters.md)
records why the providers are thin adapters over shared chat, tool, and
persistence code, and why the runtime never loads on ordinary startup.

## Boundaries

The module graph is enforced, not documented. `pnpm run check:architecture`
runs ESLint import-boundary zones and dependency-cruiser cycle checks. The
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

Platform-capability composition and other source-level policies are ESLint
rules in the existing custom plugin.

## Where things live

```text
app/          Shared Nuxt renderer: viewer, workspace shell, modules
electron/     Main process: features, native-tool runners, MCP server
native/       Rust crates and the macOS print-dialog helper
packages/     Contracts, i18n, release selection, shared scan-cleanup code
server/       SSR routes for the browser build
landing/      Separate Nuxt site: downloads, docs, marketing
resources/    Bundled native binaries and OCR language data
scripts/      Build, packaging, release, and diagnostics
tests/        Unit, integration, and Electron end-to-end coverage
```
