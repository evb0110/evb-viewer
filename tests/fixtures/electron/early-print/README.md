# Early-print fixtures

`breviary-1677-rubrics.jpg` is the top of the left column of the first page
("Rubricae generales Breviarii") of *Breviarium Novissimum Monasticum* (1677,
public domain), from the scan a user attached to a report that OCR read its
long s (ſ) as f. The 1931×3158 page was cropped to 880×960 pixels and turned
grayscale. The source PDF places the page at 72 ppi.

`breviary-1677-rubrics.gt.txt` transcribes those lines as printed, with ſ, æ,
œ, ct and accents. Latin's own model reads the long s as f (`fefto`), æ as z
or x (`Pafchz`) and ct as é or & (`Defun&torum`).

`breviary-1677-rubrics.{lat,ita_old,fra}.hocr.gz` are the hOCR the pinned
Tesseract 5.5 writes for that image with the app's Latin-script options,
`hocr_char_boxes=1` and `lstm_choice_mode=2`, read by `lat`, `ita_old` and
`fra`. `breviary-1677-rubrics.dictionary.txt` holds the keys of `lat`'s word
list that reading those three looks up and finds.

`breviary-1677-page-1.layer-lines.json` is what `evb-pdf-page-ops
ocr-text-visibility --with-evb-ocr-text` reads from the OCR layer EVB wrote on
the whole first page: a title over two columns, with the edge of the facing
page at the right.

`eight-latin-words.traineddata` was built with Tesseract's `wordlist2dawg` and
`combine_tessdata` from eight words and `lat`'s LSTM unicharset; its network
is a placeholder byte.
