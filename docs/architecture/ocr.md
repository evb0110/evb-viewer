# OCR

EVB Viewer recognizes text with the bundled Tesseract engine and pinned
`tessdata_best` models. An OCR job runs in the main process on the shared job
registry: each page renders and recognizes under its own broker lease, and one
`pdf-page-ops ocr-text-layer` call writes the searchable layer for the whole
document. Saved PDFs, search, selection and DOCX export consume the resulting
logical text.

## Language models

Select the languages present in the document. The searchable picker keeps every
selected language and downloads missing models before recognition. Single-language
and multilingual recognition use the same pipeline and text-layer writer.

English and Russian are bundled for offline use. Other languages in
`packages/contracts/ocrLanguages.ts` download from the pinned `tessdata_best`
revision on first use. Downloads must match the registry's SHA-256 digest before
atomic publication into the profile's tessdata directory. Concurrent requests
share a download; canceling one request does not abort other waiters.

The packaged app seeds and repairs its models from bundled resources. It also
refreshes the bundled `pdf.ttf` at startup so a stale or damaged runtime font
cannot keep breaking searchable-PDF creation. Development uses the repository's
resources directory. Neither the model directory nor download origin is a
supported environment override in the app.

Serbian is advertised as Cyrillic. Its model asks Tesseract to load `srp_latn`
implicitly, so EVB explicitly excludes that unselected Latin recognizer. Four
clean Serbian pages had zero faithful character error with or without the Latin
model.

Model changes must update the registry, pinned digests, development resources
and packaging selection together. The resource generator checks those inputs.
Portuguese uses the upstream shared Portuguese model, including Brazilian
Portuguese.

### Long s

Every modern Latin-script model reads the long s (ſ) of books printed before
about 1800 as f. The early-print models `ita_old` and `spa_old` read it, but are
worse at the other letters, cannot write æ or œ, and adding a modern model to
them brings the f back, because Tesseract keeps the more confident reading. So
they are not offered as languages. A page whose languages are all Latin-script
is read with the selected models first. When at least 45% of its in-word f and
s are f (61% to 99% on the breviary, 8% to 27% on modern German and English
scans), `tesseractRunner` reads the raster again with `ita_old+spa_old`, aligns each
line with the first reading, and turns an f into ſ where the second reading has
ſ. The page keeps the first reading unless that changes at least a fifth of its
in-word f, so a misjudged modern page is left alone. On the 1677 breviary that
prompted it, Latin went from 6.4% character error and no long s to 4.1% with 38
of 43, against 5.8% for `ita_old+spa_old` alone.

An edit swaps one UTF-16 unit for another, so word boxes do not move. The page
data carries the edited words, and `ocr-text-layer` applies the same edits to
Tesseract's PDF before copying its text: Tesseract writes one `TJ` per
non-empty TSV word in order, except a word whose baseline has no length, so an
edit falls back to the nearest earlier word with its text. Edits persist in the
page checkpoint. The models download the first time a page needs them; when
they cannot, the page keeps its first reading and reports
`OCR_LONG_S_UNAVAILABLE`. Digests, downloads and installed state are per model.

## Recognition options

- `balanced` applies the EVB spacing settings and disables dictionaries for
  non-RTL recognition.
- `accurate`, displayed as "Use dictionaries", preserves Tesseract dictionaries.
  RTL models retain their native dictionary configuration in either profile.
- `poor-scan` selects clean preprocessing and adaptive thresholding.

Text layout defaults to Tesseract's automatic page layout. The popup also offers
single-block and sparse-text recognition. The shared agent contract rejects
segmentation modes that produce no recognized text or require an unbundled
orientation model.

Clean preprocessing uses `evb-scan-cleanup` with fixed pixel options. The pipeline
requires the original image dimensions and an invertible transform for deskewed
word positions. Unusable output falls back to the original raster and records a
per-page diagnostic. There is no unpaper fallback because its output cannot
supply the geometry needed to place selectable text over the original page.

## Engine

Every shipped platform builds Tesseract 5.5.3 and Leptonica 1.82.0 from
checksum-pinned source in the manually dispatched runtime-binaries workflow.
Each resulting archive is pinned in `scripts/runtimeBinaryManifest.ts`.
The packaged-tool smoke check rejects a 4.x engine, because the Poor scan profile
passes `thresholding_method`, which 4.x does not know. When Tesseract rejects a
parameter it still exits successfully, so the pipeline reports each rejected
parameter as a per-page warning instead of silently recognizing without it.

## Quality evidence

Run the production quality corpus with the bundled binaries:

```sh
pnpm run build:scan-cleanup
EVB_OCR_QUALITY_REQUIRED=1 EVB_SCAN_CLEANUP_PATH="$PWD/native/target/release/evb-scan-cleanup" node scripts/test-ocr-quality-corpus.mjs
```

Required mode includes degraded pages. Without `EVB_OCR_QUALITY_REQUIRED=1`,
set `EVB_OCR_QUALITY_DEGRADED=1` to include them. The language and degraded
corpora use the popup's default recognition options; set
`EVB_OCR_QUALITY_OPTIONS=poor-scan` to measure the Poor scan preset instead. Both
presets come from `packages/contracts/electronApiOcr.ts`, so the benchmark cannot
drift from what the popup runs. The benchmark reports faithful
NFC character and word error separately from compatibility normalization, and
measures raw recognition, PDF.js and Poppler extraction.
Search, DOCX export and the assistant read page text with `pdftotext`. A page
whose only text is an invisible OCR layer is read in recognition order instead:
column by column, one recognized line per line. On a skewed scan each OCR line
has a rotated baseline that Poppler's layout analysis breaks into short, often
reversed fragments, and only recent Poppler releases keep such lines whole in
`-raw` mode. So `pdf-page-ops ocr-text-visibility --with-evb-ocr-text` decodes
EVB's own layer from the Tesseract operators the writer keeps, and another
tool's layer is reread with `-raw`. Painted text keeps the layout order, because
some producers omit word spaces and leave them to the gaps the analysis
measures; `-raw` would join those words.

Confidence alone does not establish recognition quality. Inspect saved-PDF
text and real-app search and copying before accepting changes to text order.
