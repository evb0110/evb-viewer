# PDF diagnostics

## Generated PDF visual compatibility

Generated PDFs must pass the restricted artifact-preview compatibility
classifier as well as a reference renderer. The verifier first exercises a
synthetic JPX negative control, captures renderer warnings, compares every
requested page, and writes a human-viewable contact sheet:

```bash
pnpm run diag:verify-generated-pdf -- \
  --pdf /absolute/path/to/output.pdf \
  --artifact-dir .devkit/analysis/pdf-visual-verification
```

The default limit is 20 pages. Use a representative smoke extract; pass
`--allow-large` only for an intentional resource-exhaustion test. A successful
run writes `verification-ledger.json`. Pages that structurally carry JPX are
classified as `requires-jpx-consumer` when the deliberately no-WASM preview
cannot decode them; unexpected decoder warnings or blank JPX-free pages still
write `verification-failure.json` and exit non-zero.

The three PDF diagnostics are scenarios on `runPdfDiagnosticScenario.ts`, which owns
isolated Electron sessions, diagnostic trace buffers, timed sampling, optional frame
capture, artifact writes, and cleanup. Their package commands, acceptance thresholds,
and JSON schemas remain scenario-specific.

## Save-pipeline timing

The save timing diagnostic extends the existing hidden-session save-pipeline benchmark;
it does not maintain a separate harness. Run the benchmark entry point:

```bash
pnpm run benchmark:save-pipeline -- --fixture path/to/source.pdf --iterations 10 --output .devkit/analysis/save-pipeline.json
```

`--pdf` aliases `--fixture`, and `--out` aliases `--output`. Relative paths resolve
from the caller's working directory; the source must be a non-empty PDF. The benchmark builds the native page-operations tool and
Electron, then runs native FreeText and serialized-fallback saves at the configured low
and high tiers in isolated hidden sessions.

The top-level JSON retains the existing schema-version, generation time, fixture size,
warmup/iteration counts, clone mode, and scenario fields. It additionally records the
normalized `inputPath` and `outputPath`, a streaming fixture SHA-256, plus the synchronous
`hostProfile` snapshot and its effective `hostTier`. Each scenario retains its numeric `totalMs.samples`, p50/p95,
peak RSS, I/O and phase placeholders, byte counts, output SHA-256, and raw semantic-reopen
summary. Additive comparable semantic summaries ignore structural Popup companions and
prove that every output contains exactly one additional FreeText annotation. Each
scenario identifies the annotation action used for its route. Its additive
`iterationMeasurements` entries contain `iteration`, `timestamp`, `beforeBytes`,
`afterBytes`, `durationMs`, and peak RSS; the scenario also records the synchronous
profile effective for that hidden session and the source/working-output paths.

## Scan-cleanup release corpus

### Fold adjudication surfaces

The S4(d) fold comparison intentionally keeps two measurements separate. The
150-DPI, content-cropped ten-spread surface is an OCR/content-box residue-review
classifier; it is not the production-PDF metric from the historical untracked
VPS runner. The 300-DPI, intrinsic-canvas exemplars directly measure how much
fold-side source canvas remains on the right leaf. Exact source hashes, DPI,
render options, and OCR thresholds live in
`fold-adjudication-recipe.json`. The residue classifier also pins the canonical
`eng` model from `packages/contracts/ocrLanguages.ts`, verifies the tracked
`tessdata-best` file under `resources/tesseract/tessdata`, and passes that model
directory to Tesseract explicitly.

Render the pinned sources from both refs with the recorded protocol-v3 options,
then measure the four manifest trees:

```bash
python3 scripts/diagnostics/fold-adjudication.py \
  --main-fold-manifest .devkit/analysis/s4d-rescue/fold-corpus/main/manifest.json \
  --branch-fold-manifest .devkit/analysis/s4d-rescue/fold-corpus/branch/manifest.json \
  --main-exemplar-manifest .devkit/analysis/s4d-rescue/fold300/main/manifest.json \
  --branch-exemplar-manifest .devkit/analysis/s4d-rescue/fold300/branch/manifest.json \
  --out .devkit/analysis/s4d-rescue/fold-adjudication.json
```

On Windows PowerShell, run the same measurement with the Python launcher:

```powershell
py -3 scripts/diagnostics/fold-adjudication.py `
  --main-fold-manifest .devkit/analysis/s4d-rescue/fold-corpus/main/manifest.json `
  --branch-fold-manifest .devkit/analysis/s4d-rescue/fold-corpus/branch/manifest.json `
  --main-exemplar-manifest .devkit/analysis/s4d-rescue/fold300/main/manifest.json `
  --branch-exemplar-manifest .devkit/analysis/s4d-rescue/fold300/branch/manifest.json `
  --out .devkit/analysis/s4d-rescue/fold-adjudication.json
```

The runner rejects a mismatched source hash or render recipe, records the local
Tesseract version, reports every right-leaf signed OCR gap, and converts the
300-DPI main-to-branch canvas-width change to millimetres. A negative
`branchMinusMainMm` means that the branch removed fold-side canvas.

Copy `scan-cleanup-corpus-config.example.json` to the ignored
`.devkit/scan-cleanup-corpus.json` and replace each `pdfPath` with an absolute local
path. Build the staged release tools, then run:

```bash
pnpm run build:scan-cleanup
pnpm run build:pdf-image-combine
pnpm run diag:scan-cleanup-corpus-verify -- --keep-artifacts
```

Machine-local fixture entries may include `expectedModeDistribution` (counts by
final output page for `bw`, `grayscale`, `color`, and `mixed`) and
`expectedOutputBytes`. These local values override the checked-in expectation for
the same fixture ID, so private corpora can enforce regression expectations without
committing fixture paths or results.

Set `sha256` to a 64-character SHA-256 digest when a fixture must refer to one
exact external source. The verifier admits every source before invoking a native
tool, records `expectedSha256`, `actualSha256`, and `admissionStatus` in the
fixture and corpus reports, and fails on a missing required source or checksum
mismatch. Existing `optional: true` entries still skip an absent source. Use
`required: false` when an entry is optional without the legacy flag.

The Nabuco external lane is described by
`scripts/fixtures/scan-cleanup/nabuco-external-corpus.json`. It names the
external source, selected pages, settings, and checksum only; the PDF remains
outside the repository. Set `EVB_SCAN_CLEANUP_NABUCO_SOURCE_PDF` before using
that manifest.

The diagnostic detects each selected page's dominant source DPI with `pdfimages`,
rasterizes with `pdftoppm`, runs protocol-v3 auto analysis and final rendering,
combines the output with the release PDF combiner, and reports every mode, codec,
roundtrip, MediaBox, size, and timing assertion separately. Linguae fixtures are
optional: mark them with `"optional": true` and they are reported as skipped when
their absolute path is absent. The checked-in expectations cover the Luther p6–9
session fixture and Rome pages 1, 2, and 49.

## Standing scan-cleanup regression net

The standing loop is one non-Electron command. Create the ignored
`.devkit/scan-cleanup-regress.json` manifest with `corpora.acceptance2`,
`corpora.regress`, `corpora.canvas-trio`, and `corpora.headers2` config paths,
`cli.acceptance2` and `cli.linguae-layouts` source entries, and a `rome.source`
entry. Then run:

```bash
pnpm scan-cleanup:regress
```

It runs those four corpus configs, the 17-case
`rome-mode-matrix-corpus-config.json`, parity CLI conversions with stamped
word-loss audits, and Rome pages 46/49/52/56 rendered at 150 dpi. The private
manifest may provide an `environment` object for `${EVB_SCAN_CLEANUP_*}` tokens
used by the matrix config. A visually inspected, fixture-specific invented-ink
restoration can be capped without weakening text-loss or silhouette checks:

```json
{
  "cli": {
    "fixture-name": {
      "source": "/private/fixture.pdf",
      "wordLossBaseline": {
        "inventedInk": {
          "2": {
            "maxComponents": 1,
            "maxFraction": 0.017,
            "reason": "Source-supported header rule restored across scan gaps."
          }
        }
      }
    }
  }
}
```

The wrapper rejects unknown fields, flags on any unlisted page, over-cap
results, missing audit rows, and every text-loss or silhouette flag. Fixtures
without a baseline continue to run the audit with `--fail-on any`.
`pnpm scan-cleanup:regress -- --full` adds the release-only
`corpora.fullbook` gate; fullbook remains an explicit release-only fixture.
Evidence and the compact stdout table are written below the selected work
directory.

### Preview raster oracle

Run the preview/final parity diagnostic through its package entry point or the
equivalent direct Node invocation:

```bash
pnpm run diag:scan-cleanup-preview-harness -- \
  --source /absolute/source.pdf --pages 1,2,99 --out .devkit/analysis/preview-oracle --check
```

or, equivalently, without the package script (POSIX shells only — the
pnpm form above is the cross-platform invocation):

```bash
node scripts/diagnostics/scan-cleanup-preview-harness.mjs \
  --source /absolute/source.pdf --pages 1,2,99 --out .devkit/analysis/preview-oracle --check
```

### Representative rendered oracle

The representative audit renders a source PDF and cleaned PDF at low DPI,
infers the source-to-output page mapping, and checks page count, retained ink,
geometry, paired-leaf alignment and scale, plus local component survival:

```bash
pnpm run diag:scan-cleanup-representative-audit -- \
  --source /absolute/source.pdf \
  --cleaned /absolute/cleaned.pdf \
  --out .devkit/analysis/representative-audit.json
```

or, equivalently, without the package script (POSIX shells only — the
pnpm form above is the cross-platform invocation):

```bash
TSX_TSCONFIG_PATH=tsconfig.scripts.json node \
  scripts/diagnostics/scan-cleanup-representative-audit.mjs \
  --source /absolute/source.pdf \
  --cleaned /absolute/cleaned.pdf \
  --out .devkit/analysis/representative-audit.json
```

`component-survival` counts connected source and cleaned components in 24
placement-aligned horizontal bands at the existing 100-DPI scale render, on a
grid capped at 1,200,000 cells. A band with fewer than five source components
is recorded as unmeasured, never as a pass; a page with fewer than 20 total
measured source components is likewise unmeasured. A measured band violates
when cleaned output loses more than 20% of its source components. Paired-leaf
alignment compares signed top deltas, so a
direction reversal cannot pass, and also rejects a uniform vertical shift over
15% of page height. The latter check is intentionally coarse because source
and cleaned canvas margins may legitimately differ.

The report prominently records unmeasured pair counts and fractions for
`component-survival`, `leaf-misalignment`, and `leaf-scale-mismatch`. More than
30% unmeasured pairs in any applicable class produces `measurement-collapse`
and exit code 2. Ordinary oracle violations use exit code 1; a fully covered,
violation-free audit uses exit code 0.

### Retired ad-hoc checks

The unreferenced `scan-cleanup-forced-mode-audit.py` replay was deleted. Its
forced BW/grayscale diagnostic role is replaced by the standing regress
corpora, the 17-case binarization/crop matrix, and the stamped CLI word-loss
audits. `scan-cleanup-artifact-audit.py` remains because the corpus harness,
release verifier, and unit tests reference it; `scan-cleanup-synthetic-audit.py`
remains because the packaged release verifier references it. No other
scan-cleanup diagnostic under this directory was clearly superseded, so no
other deletion was made.

Grayscale and color scan-cleanup outputs use plain `image-jpeg` records because
their raster is already at final DPI; unlike `photo-jpeg`, this does not apply
another PPI cap. Mixed pages use `layered-jpeg`: a quality-85 tonal background
for grayscale or quality 87 for RGB under a full-render-DPI 1-bit text mask.
Pages backed by a measured source raster render on that source grid. A binary
page without a measurable raster uses a 600-DPI synthesis floor; per-mode pixel
and dimension limits still cap oversized pages.
The background is capped at source DPI
(`min(source DPI, render DPI)`), so synthetic resolution is not spent on
invented picture detail. Final-stencil pixels use
paper fill in the tonal layer; pixels excluded from the stencil by picture-mask
dilation retain source tone so content cannot disappear from both layers. The
existing 3 mm distance feather still blends picture-mask boundaries without
preserving dark text ghosts. The combiner keeps the lossless Flate candidate
whenever it is smaller.

The July 2026 MRC follow-up changed the `rome-selected` three-page corpus
expectation from 3,247,404 B to 2,135,347 B. Luther p6–9 remains byte-identical
at 727,236 B; the Rome reduction comes from page 49 moving from a flattened
mixed JPEG to a JPEG background plus JBIG2 text stencil.

The now-retired universal supersampling/content-coverage policy changed `rome-selected` from
2,135,347 B to 2,795,244 B. Luther p6–9 remained byte-identical at 727,236 B.
Under that policy, Rome page 49 carried a 720-DPI stencil over its unchanged 360-DPI background;
the standalone page changed from 287,787 B to 941,353 B because the full-resolution
stencil and non-stencil source tones are retained.

## Scan-cleanup rendered acceptance metrics

Photo fidelity is measured from rendered pages, not extracted MRC image layers.
Supply photo bounding boxes on a known coordinate grid (the Rome acceptance ledger
uses 120 dpi); the diagnostic renders every requested PDF page at 360 dpi, maps the
source box through that conversion's recorded affine deskew/crop transform and
matched-canvas placement, and rectifies the candidate pixels back onto the source
box grid. It records near-white fraction, mean luminance, and per-16-pixel-tile
near-white deltas. An optional reference PDF adds reference columns and labeled
`source | reference | output` crops:

```bash
pnpm run diag:scan-cleanup-rendered-metrics -- photos \
  --source /absolute/path/to/source.pdf \
  --reference /absolute/path/to/previous-cleaned.pdf \
  --reference-summary /absolute/path/to/reference-conversion-summary.json \
  --output /absolute/path/to/candidate-cleaned.pdf \
  --output-summary /absolute/path/to/candidate-conversion-summary.json \
  --boxes /absolute/path/to/photo-boxes.csv \
  --csv .devkit/analysis/photo-metrics.csv \
  --crops .devkit/analysis/photo-crops
```

The boxes CSV requires `page` and either `bbox` or `bbox_at_box_dpi`, with the
box encoded as `left,top,right,bottom`. Defaults are `--box-dpi 120`,
`--render-dpi 360`, `--tile-size 16`, and `--tile-limit 0.05`. Summary arguments
default to `<pdf>.summary.json`; an explicit summary is useful when a reference PDF
was renamed after conversion. Non-affinely dewarped pages are rejected because a
rectangular affine crop cannot identify the same physical pixels on those pages.

Stroke consistency is measured from the exact embedded full-resolution text mask.
For each page, the diagnostic parses a page-scoped `pdfimages -list`, selects the
unique `bpc=1`/`jbig2` row at the highest mask DPI, extracts that row by its local
stream index, decodes it with `jbig2dec` (including `/JBIG2Globals` when present),
and reports black coverage and one-pixel MaxFilter erosion survival:

```bash
pnpm run diag:scan-cleanup-rendered-metrics -- strokes \
  --pdf /absolute/path/to/candidate-cleaned.pdf \
  --pages 60-80 --exclude 67,71 \
  --csv .devkit/analysis/stroke-metrics.csv
```

The photo command requires Poppler and Pillow. The stroke command additionally
requires `jbig2dec`. Ambiguous same-resolution JBIG2 masks are an error instead of
being resolved with a largest-image heuristic.

For a substitution-safety audit, ask the conversion CLI to retain only a bounded
set of raw foreground masks immediately before the PDF combiner symbol-codes them:

```bash
pnpm scan-cleanup:convert -- --source /absolute/source.pdf --out /absolute/output.pdf \
  --parity --diagnostic-evidence-dir .devkit/analysis/symbol-evidence \
  --diagnostic-mask-pages 12,18,24,30
pnpm run diag:scan-cleanup-rendered-metrics -- symbol-safety \
  --pdf /absolute/output.pdf \
  --manifest .devkit/analysis/symbol-evidence/raw-mask-manifest.json \
  --csv .devkit/analysis/symbol-safety.csv
```

The checker extracts each exact final image stream, supplies `/JBIG2Globals` to
`jbig2dec`, normalizes only mask polarity, and requires pixel-exact equality with
the retained PBM. Exact equality is stricter than the encoder's component-level
substitution policy. The conversion summary also retains every page's final and
tier-1 layout verdict so a page-limited conversion can audit the full detection
pass without keeping its raster workspace.

## Scan-cleanup stroke-weight studies

Two one-off measurement scripts back the stroke-weight closure numbers quoted in
`docs/internal/scan-cleanup/audit-2026-08-14/SYNTHESIS.md` and the process ledger. They were
written inside untracked `.devkit` analysis directories, which made those numbers
impossible to recompute from a clone; they are tracked here so the numbers can be
reproduced. Their corpora, renders, OCR caches, and image outputs stay untracked —
every script takes the artifact root as its first argument, and that root is the only
place any of them writes. The sole read outside it is `make_crops.py` looking up a bold
system font for its panel labels (override with `DIAG_CROP_FONT`).

`analyze-word-weight.mjs` is the word-granularity study (the "1,691 matched words"
figure). It expects `renders/output`, `renders/source`, and
`conversion-evidence/native` under the artifact root, shells out to
`tesseract <page>.png stdout -l eng --psm 3 tsv` for per-word boxes (cached under
`ocr/`), and writes `word-weight-results.json` plus comparison crops:

```bash
node scripts/diagnostics/analyze-word-weight.mjs /absolute/path/to/artifact-root
```

`measure_components.py` is its component-granularity replacement — the one that can
see a single bold letter inside a word, which the word-mean statistic averages away.
The fixture shape is hard-coded to the study's corpus: 10 scanned source pages at
`source/source299-01.png` … `source299-10.png`, and one directory per variant
(`current`, `rescue-off`, `wolf`, `smoothing-off`) holding `<variant>.pdf.summary.json`
plus 20 rendered leaves `leaf-01.png` … `leaf-20.png` — two leaves per source page,
left then right. OCR comes from pre-generated TSVs at `ocr/current-leaf-NN.tsv`, one per
leaf, read but never produced by the script. The original study's `tesseract` flags for
those TSVs are not recorded in its logs; use the word-study invocation above
(`-l eng --psm 3 tsv`) as the reference recipe. Output is line, component, and per-leaf
metrics under `metrics/`. `make_crops.py` is the companion crop renderer and imports the
alignment helpers, so both must stay in the same directory:

```bash
python3 scripts/diagnostics/measure_components.py /absolute/path/to/artifact-root
python3 scripts/diagnostics/make_crops.py /absolute/path/to/artifact-root
```

Both Python scripts require Pillow. Tracking them changed only their portability, not
their measurements: the artifact root became an argument instead of the script's own
directory, `metrics/` and `crops/` are created on demand, the label font is looked up
across platforms instead of assuming a macOS path, and non-finite metrics serialize as
`null` instead of the bare `NaN` token that strict JSON readers reject.

## Navigation blink trace

Use the blink trace for blank frames, delayed skeletons, or canvas/skeleton flicker:

```bash
pnpm run diag:pdf-navigation-blink-trace -- --scroll-mode continuous --pdf /path/to/source.pdf --out .devkit/pdf-navigation-blink-trace.json
```

The PDF defaults to `EVB_DIAGNOSTIC_PDF_PATH`, then
`.devkit/manual-pdf-fixtures/page-jump-source.pdf`. Add `--video` or
`--video-dir <dir>` for timestamped JPEG frames, `trace.mp4`, and
`contact-sheet.jpg`. Capture uses CDP screencasting and falls back to Puppeteer
screenshots; ffmpeg artifacts are optional. The JSON preserves `video.artifactPaths`
and `summary.frameAnalysis`; `skeletonAfterCanvasObserved` identifies a skeleton seen
after canvas ownership.

The trace defaults to `--scroll-mode continuous`. Use `--scroll-mode paged`
to cover non-continuous navigation. Setup fails before the click loop if the
toolbar state does not match the requested scroll mode, fit-height zoom, and
single-page layout.

## Skeleton navigation scenarios

Run the high-zoom next-page, toolbar direct-jump, and rapid next-to-last scenarios:

```bash
EVB_E2E_NAVIGATION_PDF_PATH=/path/to/navigation-source.pdf pnpm run diag:pdf-skeleton-navigation
```

The path falls back through `EVB_DIAGNOSTIC_PDF_PATH` to
`.devkit/manual-pdf-fixtures/navigation-source.pdf`. Outputs remain:

- `.devkit/girgas-page-navigation-skeleton-diagnostics.json`
- `.devkit/girgas-page-500-input-skeleton-diagnostics.json`
- `.devkit/girgas-rapid-next-to-last-skeleton-diagnostics.json`

## Arnold PDF open

Run the open, settle, scroll, and high-zoom acceptance scenario with:

```bash
EVB_E2E_ARNOLD_PDF_PATH=/path/to/arnold-grammar.pdf pnpm run diag:arnold-pdf-open
```

The default fixture is `.devkit/manual-pdf-fixtures/arnold-grammar.pdf`. Artifacts
remain `.devkit/arnold-pdf-open-diagnostics.json` and
`.devkit/arnold-pdf-open-console.log`.
