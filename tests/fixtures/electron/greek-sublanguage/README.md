# Modern Greek with its Ancient Greek sub-language

`ell-registry-200ppi.png` is the top of the second clean Greek page, second
variant, of the OCR quality corpus (`scripts/ocrLanguageQualityFixtures.mjs`,
Noto Serif), rasterized on Linux at 200 ppi (PNM SHA-256
`65e3965a24e34e7e50b64369a95f5d81a4a8b5e08826113bf5afdb7c19e6c711`).
The crop is `1654x440+0+64`, converted to 8-bit grayscale PNG without
resampling. It holds seven lines of the corpus text, which uses modern
monotonic spelling.

`ell.traineddata` loads `grc` (`tessedit_load_sublangs grc`). In the desktop
app, reading with `ell` alone gives `περιφράφει` for `περιγράφει`, `καὶ` for
`και` and `τοὺς` for `τους` twice. With `grc` beside it, `περιγράφει` and `και`
are read as printed; one `τοὺς` remains.
