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
│   plus third-party: tesseract, poppler, qpdf, unpaper    │
└──────────────────────────────────────────────────────────┘
```

## The three roles, one owner each

[ADR 0002](docs/architecture/adr/0002-pdfjs-renders-rust-writes-evb-edits.md) is
the decision that shapes everything else. PDF.js is a read-only renderer and
never produces PDF bytes. The Rust `pdf-page-ops` crate is the only writer. The
app owns the canonical annotation state, and every other view of an annotation,
on the page, in the sidebar, in the written file, derives from it.

This is why a Rust rewrite of the renderer was rejected: the expensive,
correctness-critical half is writing valid PDFs across encryption, incremental
saves, and multi-gigabyte files, and that half is already native.

## Native crates

They are separate processes, not linked modules. Electron spawns them as CLI
sidecars and exchanges JSON envelopes over a versioned protocol, with a
handshake that refuses a binary older than the minimum the app expects. Two of
them also build to WebAssembly so the browser workspace can do the same work
without a desktop install.

| Crate | Owns | Scale |
| --- | --- | --- |
| `scan-cleanup` | The cleanup engine and its CLI: analysis, routing, binarization, dewarp, mixed raster content, manifest protocol | ~78k lines |
| `pdf-page-ops` | The PDF writer: page operations, annotation read and write, decryption, geometry, text shaping | ~49k lines |
| `pdf-image-combine` | Images to PDF, across bilevel, JBIG2, JPEG, JPEG 2000, and TIFF paths | ~12k lines |
| `jbig2-codec` | Lossless JBIG2 generic-region encode and decode, in the layout PDF readers expect | ~4.6k lines |
| `scan-primitives` | Deterministic image and geometry types shared by the imaging crates | ~4.5k lines |
| `pdf-search` | A persistent search sidecar over a memory-mapped index, with Unicode casefolding | ~3.4k lines |
| `evb-raster-io` | PNG encode and decode with explicit decode limits and DPI metadata | ~2.5k lines |
| `evb-native-support` | Shared error envelopes, bounded readers, and the generated protocol tables | ~2.1k lines |
| `protocol-fixtures` | Golden JSON fixtures pinning cross-version protocol compatibility | fixtures only |

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
and emits a text-only PDF layer. Finally qpdf splits the original, each text
layer is overlaid onto its original page, and the document is reassembled in
batches with per-page checkpoints so a long job can resume. The recognized text
also feeds the search index.

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

The module graph is enforced, not documented. `pnpm check:architecture` fails
the build on a violation. The rules worth knowing:

- `electron/**`, `packages/**`, and `landing/**` must not import `app/**`, and
  the reverse edges are blocked too. Nothing imports `scripts/**`.
- Packages are layered. Contracts and i18n-core are leaves; every other package
  may depend only on its declared targets.
- Cross-feature imports under `app/modules/**` and `electron/features/**` must
  go through a public entrypoint. A feature's `main/**` internals are private to
  that feature.
- `app/services/**` must not import `app/composables/**`.
- Deleted paths stay deleted: retired component and composable locations are
  blocked so they cannot quietly come back.

Dependency cycles, platform-capability composition, and the Sentry integration
boundary are checked by the same script.

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
