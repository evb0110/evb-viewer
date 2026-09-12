# Formats, runtimes, and languages

What EVB Viewer opens, what it writes, which languages it reads, and which
capabilities need the desktop app.

## Runtime Matrix

| Capability | Desktop (`/electron`) | Browser (`/`) |
| --- | --- | --- |
| PDF viewing/editing | Yes | Yes |
| PDF + image combine | Yes | Yes |
| DjVu viewing/conversion | Yes | Yes |
| OCR + searchable PDF | Yes | No |
| Auto-updates | Packaged macOS arm64 only | No |
| Tabs, splits, recent files | Yes | Yes |

## Supported Formats

### Open / Import

- PDF: `.pdf`
- DjVu: `.djvu`, `.djv`
- Image-to-PDF inputs: `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.bmp`, `.webp`, `.gif`
- Desktop image insertion also supports file and clipboard-based image workflows through the app menu

### Export

- PDF
- DOCX
- PNG
- JPG
- TIFF / multi-page TIFF

### OCR Languages

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

### UI Locales

- English
- Russian
- French
- German
- Spanish
- Italian
- Portuguese
- Dutch
