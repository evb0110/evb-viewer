# Leaf-edge fixtures

`prym-p00063-fore-edge-150dpi.png` is page 63 of Bergsträsser, *Neuaramäische
Märchen und andere Texte aus Ma'lūla* (1915, public domain), from the University
of Toronto scan `neuaramischem00berguoft` on the Internet Archive. The source
PDF places each 2060×3235 JPEG 2000 page at 72 ppi, so the page was resampled
from its measured ~420 dpi to 150 dpi.

The recto carries the book's brown fore-edge as a thin strip along its right
border. Automatic mode used to count that strip as independent color and keep
the whole text page as a color JPEG. A text page must resolve to B&W.

`scanedge-left-shadow.png` reproduces #1310 with an 800×1200, 300-DPI native
raster: paper is 222, a five-pixel scanner shadow runs from y=40 to y=1159 at
x=0..4 with values 132..168, and 24 lines of H-shaped glyphs start at x=18.
The automatic content box excludes the shadow, but the default 5-mm margins
bring it back into the rendered page. Cleanup must leave that physical edge
as paper and retain every nearby glyph. The regression also mirrors the page
for a right-edge shadow and checks both cropped and uncropped rendering.
