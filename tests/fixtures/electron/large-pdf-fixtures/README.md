# Local Large PDF Fixtures

This directory is reserved for local-only large PDF fixtures. Binary PDFs in this
directory are intentionally not committed because they are too large for the
repository and are only needed for opt-in regression coverage. The fixture-policy
unit suite enforces that only this README (`*.md`) ever lands here.

Two Electron e2e lanes cover large PDFs. Only the annotation-save lane reads a
fixture from here; its native-preview sibling generates its own oversized file
because the two lanes need opposite sides of the same size threshold.

## Annotation-save lane

`tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts` opens a large PDF,
preserves an existing FreeText note, then adds, saves, reopens, and verifies
another FreeText popup note. The default fixture it expects is:

```text
turkish-english-lexicon-letter-bookmarks.pdf
```

Run it with:

```sh
pnpm run test:e2e:electron:large
```

The resolver also supports these alternatives:

- Set `EVB_E2E_LARGE_PDF_FIXTURE` to an absolute path for the PDF.
- Place the same relative path under `.devkit/`, for example
  `.devkit/large-pdf-fixtures/turkish-english-lexicon-letter-bookmarks.pdf`.
- Set `EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1` to make a missing fixture fail the
  lane instead of skipping it. `pnpm run test:e2e:electron:large` sets it.

The checked-in fixture stays below the 512 MiB opening-preview threshold because
this lane tests annotation content, not the native first-paint bridge. Oversized
path-backed PDFs still finish in PDF.js and can use the same annotation surface.

Known local provenance is limited to the fixture filename and the audit note that
identifies this as a local-only large PDF fixture, about 172 MB, for the
opt-in large PDF annotation-save suite. The exact public download URL is not
recorded in this checkout. A replacement fixture should be a large PDF that opens
in the Electron viewer and preserves an existing FreeText note while allowing the
suite to add, save, reopen, and verify another FreeText popup note.

## Native opening-preview handoff lane

`tests/e2e/electron/largePdfNativePreview.e2e.test.ts` proves that the exact
production dictionary paints a native raster first and hands the same viewport
to PDF.js. It runs only when `EVB_EXACT_FIXTURE_PROFILE` stages that fixture.
The padded synthetic PDF below crosses the byte threshold but validates in
milliseconds, so PDF.js can legitimately paint before the native preview. A
handoff assertion against it measures that race, not the product contract.

The split-pane lifecycle lane still needs a PDF above the threshold, and only
the byte count decides that, so it needs *size*, not document content.

That lane provisions its own fixture with
`scripts/generate-large-pdf-e2e-fixture.mjs`, which writes a small pdf-lib
document and sparse-pads it to `PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES + 1 MiB`. It runs
in well under a second, costs a few hundred KiB of real disk, and is cached under
`.devkit/tmp/e2e-fixture-cache/`. The lane therefore cannot be handed an
undersized PDF, and it needs no local binary and no CI download step:

```sh
pnpm run test:e2e:electron:large
```

Generate one by hand only when inspecting the fixture:

```sh
node scripts/generate-large-pdf-e2e-fixture.mjs --output=/tmp/native-preview.pdf
```
