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

### Early print

Books printed before about 1800 set the long s (ſ), the æ and œ ligatures and
a ct ligature that no Latin-script language model has seen: Latin reads ſ as f
or l, æ as z or x, and ct as é, & or a lone c. Two other pinned models read
what it misses: `ita_old` reads ſ and grave accents, `fra` reads æ and œ.
Every ſ, æ and œ they read on the 1677 breviary that prompted this was right.

A page whose languages are all Latin-script is read with the selected models
first. When at least 45% of its in-word f and s are f (61% to 99% on the
breviary, 8% to 27% on modern German and English scans), `tesseractRunner`
reads the raster again: the selected models writing hOCR with each letter's
box and alternatives, then `ita_old` and `fra`. `earlyPrintReading` aligns
each of their lines with the first reading's and:

- writes ſ where `ita_old` read it, or ranked it second at 40 or more (59-85
  under a printed ſ it read as f, at most 23 under a printed f);
- writes æ and œ where `fra` read them, and a grave where `ita_old` read one
  over a letter the selected model saw accented or in a word of four letters
  or more (`ita_old` puts graves on bare short words: `Sì` for `Si`);
- in a word outside the dictionary, changes a letter both other models read
  otherwise; they share some misreadings (`codem` for `eodem`), so a word the
  dictionary knows keeps its letters;
- decodes a word outside the dictionary from the selected model's own letter
  alternatives and the known confusions (ct for é or &, æ for z), at most
  three letters;
- restores a word space where a capital follows a small letter, or where the
  print shows a gap and every part, at most three, is a dictionary word.

The dictionary is the selected languages' own: their models' LSTM word lists,
read from the `.traineddata` files. Latin's list is web text that holds OCR of
old books, so words with an f no Latin word has (`fefto`, `poft`) are dropped
from it. The page keeps its first reading unless `ita_old` finds ſ under at
least a fifth of its in-word f, so a misjudged modern page is left alone.

Against a hand transcription of two breviary pages, `lat` alone read 72% and
70% of the words; the three models read 92% on both, losing one word `lat` had
right on each against 197 and 73 gained. Words with ſ went from none to 92% and
95%, with æ or œ from none to 89% and 100%, with ct from about a third to 91%
and 83%. Character error fell from 7.9% to 3.6%. An affected page takes
about four times as long: the selected model twice, then `ita_old` and `fra`.

The page data carries the edited words, and `ocr-text-layer` applies the same
edits to Tesseract's PDF before copying its text: Tesseract writes one `TJ`
per non-empty TSV word in order, except a word whose baseline has no length,
so an edit falls back to the nearest earlier word with its text. A word that
gains or loses glyphs keeps its box: the writer scales the word's `Tz` by the
old glyph count over the new. Edits persist in the page checkpoint. The models
download the first time a page needs them; when they cannot, the page keeps
its first reading and reports `OCR_EARLY_PRINT_UNAVAILABLE`. Digests, downloads
and installed state are per model.

### Page layout

`ocr-text-visibility --with-evb-ocr-text` returns an EVB layer's lines with
their text block, first and last glyph origins, baseline and size.
`readOcrLayerLayout` sets a page from them: blocks that span the gutter run across
the page, blocks on one side of it read in the same stretch form columns, and
blocks narrower than a tenth of the text are asides (the edge of a facing
page). A column's lines join into paragraphs: a block, an indent past the
neighbouring lines and the line before, or a line after a short one starts a
paragraph, and a line-end hyphen joins its word. DOCX export writes text
across the page as paragraphs and each run of columns as a borderless table of
one row, a cell per column: Quick Look and Pages ignore Word's section columns,
and a cell keeps each column's text beside the column it faces in print.

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
