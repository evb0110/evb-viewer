# Formats, runtimes, and languages

What EVB Viewer opens, what it writes, which languages it reads, and which
capabilities need the desktop app.

## Runtime Matrix

| Capability | Desktop (`/electron`) | Browser (`/`) |
| --- | --- | --- |
| PDF viewing/editing | Yes | Yes |
| PDF + image combine | Yes | Yes |
| DjVu viewing/conversion | Yes | Yes |
| OCR + searchable PDF | Yes | Yes, with the limits under [Browser OCR](#browser-ocr) |
| Auto-updates | Packaged macOS arm64 and standalone Windows x64/ARM64 | No |
| Tabs, splits, recent files | Yes | Yes |

## Supported Formats

### Open / Import

- PDF: `.pdf`
- DjVu: `.djvu`, `.djv`
- Image-to-PDF inputs: `.png`, `.jpg`, `.jpeg`, `.jp2`, `.tif`, `.tiff`, `.bmp`, `.webp`, `.gif`
- JPEG 2000 (`.jp2`): 8-bit grayscale or RGB without transparency. Original compressed bytes are preserved in the PDF.
- Desktop image insertion also supports file and clipboard-based image workflows through the app menu

### Export

- PDF
- DOCX
- PNG
- JPG
- TIFF / multi-page TIFF

### OCR Languages

Select one or more languages present in the document. OCR uses all selected
language models during recognition, so select only the languages the pages
actually contain. Each extra model gives Tesseract another way to misread a word.

Pages that mix several right-to-left scripts are the weakest case. Arabic, Hebrew
and Syriac selected together measured about 5% character error on clean
synthetic pages, against under 1.3% for any single language. Recognizing such a
document one script at a time gives better text.

English and Russian work offline out of the box. Other supported models download on
demand the first time they are selected:

- English
- French
- Spanish
- Portuguese
- Italian
- Dutch
- German
- Polish
- Czech
- Slovak
- Hungarian
- Romanian
- Swedish
- Danish
- Norwegian
- Finnish
- Croatian
- Indonesian
- Vietnamese
- Turkish
- Greek
- Ancient Greek
- Kurdish (Kurmanji)
- Russian
- Ukrainian
- Bulgarian
- Serbian (Cyrillic)
- Arabic
- Hebrew
- Syriac
- Latin

Books printed before about 1800 use the long s (ſ), the æ and œ ligatures and
a ct ligature, which modern models misread. Choose the language of the text as
usual: when a page in a Latin-script language reads like early print, OCR reads
it again with early-print models and the language's dictionary, and writes ſ,
æ, œ and ct as printed. Those models download the first time a page needs
them, and such a page takes about four times as long. The text keeps the long
s; search matches it with an ordinary s, so `festum` finds `feſtum`.

DOCX export keeps the layout of an OCR'd page: a page set in two columns
exports as two columns side by side, in a borderless table, with the lines of
each paragraph joined.

### Browser OCR

The browser workspace recognizes text with the same Tesseract version, models
and settings as the desktop app, running inside the page; the document never
leaves the device. Its differences:

- Languages: English, Russian, French, German, Portuguese (including
  Brazilian), Spanish, Dutch and Italian. Other languages need the desktop app.
- Each language model (4 to 15 MB) downloads from GitHub's copy of the
  upstream models the first time it is used, which tells GitHub which language
  was chosen, and stays in the browser's storage afterwards.
- Documents up to 16 MB. Larger documents need the desktop app for now.
- No image cleanup: Poor scan uses its recognition setting on the page as
  scanned, and inverted (light on dark) pages are not straightened out first.
- Early-print reading (ſ, æ, œ) is desktop-only for now.
- The browser draws the page with a different renderer than the desktop app,
  so on difficult scans a few words can come out differently.
- The browser needs WebAssembly SIMD (Chrome 91, Firefox 89, Safari 16.4 or
  later) and storage for the models; a private window may not allow it.

### UI Locales

- English
- Russian
- French
- German
- Spanish
- Italian
- Portuguese
- Dutch
