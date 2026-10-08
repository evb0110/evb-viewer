# Early-print fixtures

`breviary-1677-rubrics.jpg` is the top of the left column of the first page
("Rubricae generales Breviarii") of *Breviarium Novissimum Monasticum* (1677,
public domain), from the scan a user attached to a report that OCR read its
long s (ſ) as f. The 1931×3158 page was cropped to 880×960 pixels and turned
grayscale. The source PDF places the page at 72 ppi.

Every modern Latin-script model reads its long s as f (`fefto`, `Chrifti`,
`ufque`). Latin OCR must write `feſto`, `Chriſti` and `uſque`.

`breviary-1677-rubrics.lat.tsv` and `breviary-1677-rubrics.long-s.tsv` are the
TSV output of the pinned Tesseract 5.5 on that image with the app's
Latin-script options, read by `lat` and by the long-s models `ita_old+spa_old`.
