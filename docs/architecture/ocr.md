# OCR

EVB Viewer recognizes text with the bundled Tesseract engine and pinned
`tessdata_best` models. The OCR worker owns recognition, word geometry and
searchable-PDF assembly. Saved PDFs, search, selection and DOCX export consume
the resulting logical text.

## Language models

Select the languages present in the document. The searchable picker keeps every
selected language and downloads missing models before recognition. Single-language
and multilingual recognition use the same worker and text-layer writer.

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

Clean preprocessing uses `evb-scan-cleanup` with fixed pixel options. The worker
requires the original image dimensions and an invertible transform for deskewed
word positions. Unusable output falls back to the original raster and records a
per-page diagnostic. There is no unpaper fallback because its output cannot
supply the geometry needed to place selectable text over the original page.

## Engine

Every platform bundles Tesseract 5. Linux builds 5.5.3 from the pinned source in
`scripts/bundle-tools-linux.sh` and publishes it as a pinned runtime archive.
The packaged-tool smoke check rejects a 4.x engine, because the Poor scan profile
passes `thresholding_method`, which 4.x does not know. When Tesseract rejects a
parameter it still exits successfully, so the worker reports each rejected
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
Confidence alone does not establish recognition quality. Inspect saved-PDF
text and real-app search and copying before accepting changes to text order.
