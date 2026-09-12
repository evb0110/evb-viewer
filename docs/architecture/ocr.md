# OCR Notes

EVB Viewer keeps Tesseract as the default OCR backend and uses `tessdata-best`
models from `resources/tesseract/tessdata`. The near-term quality work should
improve the wrapper profile, language ordering, page rendering, and optional
preprocessing before adding another engine.

PaddleOCR or hosted/local vision models may become optional future backends, but
they should not replace Tesseract until they have a repeatable quality,
offline/privacy, packaging, and searchable-PDF story.

## Language Models

English and Russian are bundled for offline use. Every other language in the
canonical OCR registry is downloaded from the pinned `tessdata_best` revision on
first use, verified by SHA-256, and stored in the app's user-data tessdata
directory. Development resources contain every registered model, but packaging
filters continue to ship only English and Russian.

Any language-model change must update the canonical OCR registry, pinned model
metadata, development resources, and packaging selection together. The OCR
resource generator (`pnpm run generate:build-artifacts`, whose OCR step is
`scripts/generateElectronBuilderResources.ts`) enforces agreement between the
registry, development resources, and bundled packaging selection. Pinned download
metadata is verified separately by its policy tests.

The current on-demand expansion covers widely used Latin and Cyrillic languages.
Portuguese also serves Brazilian Portuguese because upstream has one Portuguese
model.

Follow-up candidates are Persian (`fas`, with an Arabic-script quality caveat),
Catalan (`cat`), Slovenian (`slv`), Estonian (`est`), Latvian (`lav`),
Lithuanian (`lit`), Macedonian (`mkd`), and Belarusian (`bel`). CJK
(`jpn`, `chi_sim`, `chi_tra`, `kor`) and Indic (`hin`, `tha`) support is deferred
until the contracts include their script categories and OCR validation covers
vertical models such as `jpn_vert` plus representative benchmarks.

## Profile Benchmark

Run the manual profile benchmark when tuning OCR options:

```bash
pnpm run diag:ocr-profile-benchmark -- tests/fixtures/electron/test-scanned.pdf --pages 1 --languages eng
```

Use `--dry-run` to validate the selected tools, tessdata models, pages, and
profile matrix without rendering or running OCR.

The script renders selected PDF pages to PNG, or uses PNG/JPEG/TIFF inputs
directly, then compares the app-exposed profiles:

- `balanced`: current EVB language ordering, spacing, and dictionary settings
- `accurate`: EVB ordering and spacing while preserving Tesseract dictionaries
- `poor-scan`: balanced settings plus `unpaper` cleanup and adaptive thresholding

By default, the benchmark also runs the internal `stock` comparison baseline:
Tesseract without EVB wrapper options. Internal baselines are not app-exposed
quality profiles.

Artifacts are written under `.devkit/tmp/ocr-profile-benchmark/<timestamp>/`.
Start with `summary.csv` for a quick comparison and keep `summary.ndjson` for
automation. The minimum useful metrics are `text_length`, `word_count`,
`mean_confidence`, `median_confidence`, `preprocessing_result`, and
`runtime_ms`; inspect per-run TSV, logs, rendered images, preprocessed images,
and `parsed-text.txt` before accepting a profile change.

Higher confidence with similar or better text length is usually a good sign.
Lower runtime only matters when text quality does not regress for the document
class being tuned.
