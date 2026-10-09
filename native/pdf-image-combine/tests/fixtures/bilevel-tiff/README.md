1-bit TIFF frames of two 61x40 test patterns (`expected-1.pbm`,
`expected-2.pbm`), written by libtiff 4.5 (`ppm2tiff`, `tiffcp -c g4|g3|g3:2d:fill|packbits`,
`-f lsb2msb`, `tiffset` for Orientation 6 and 204x98 dpi) and ImageMagick 6
(`-define tiff:photometric=min-is-black` for the BlackIsZero frames).
`expected-1-orient6.pbm` is `g4-orient6.tif` after `convert -auto-orient`.
`modified-huffman.tif` (Compression 2, BlackIsZero) is Pillow 10.2 with libtiff:
`Image.open("expected-1.pbm").save(..., compression="tiff_ccitt", dpi=(300, 300))`.
libtiff decodes every frame to its expected pattern.
