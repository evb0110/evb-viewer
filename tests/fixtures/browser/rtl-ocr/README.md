These public synthetic scans retain the EVB OCR layers from the browser OCR
acceptance run. Page 1 contains `السلام عليكم` and `اللغة العربية جميلة`.
Page 2 contains `הַקְדְשָה וְהַטְהֶרֶה`. PDF.js splits their RTL OCR words into
glyph items; the pointed Hebrew also exposes marks before their base letters.
Neither source has painted page text beyond its scanned image.

Regenerate the two-page fixture with `node tests/fixtures/browser/rtl-ocr/generate.mjs`.
The recipe checks the retained source hashes and fixes PDF timestamps. It copies
pages without flattening or recreating their text. All three PDFs together are
smaller than 200 KB. The sources are retained so regeneration needs no OCR engine,
fonts, network or private evidence directory.

`pointed-hebrew-scan.png` is an image-only Mac raster of
`tests/fixtures/electron/semtext/short-hebrew.pdf` at PDF.js scale 3. Its 163 opaque
colors are stored losslessly in a PNG palette, preserving every source pixel.
The Hebrew OCR UI test opens this PNG through the shared file chooser, runs OCR,
saves and reopens the PDF, then searches
for the exact pointed word `הַקְדְשָה`. Fixed pixels avoid host-specific font
antialiasing changing Tesseract's recognition of the sheva.
