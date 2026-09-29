# Third-Party Notices

EVB Viewer bundles the following third-party native tools as platform
resources. Each component remains under its own license; the full license
texts are included in the `licenses/` directory alongside this file.

## Tesseract OCR

- Upstream: https://github.com/tesseract-ocr/tesseract
- License: Apache License 2.0 (`licenses/Apache-2.0.txt`)
- Bundled as: `tesseract/<platform>-<arch>` binaries and support libraries.

## Tesseract language models (tessdata_best)

- Upstream: https://github.com/tesseract-ocr/tessdata_best
- License: Apache License 2.0 (`licenses/Apache-2.0.txt`)
- Bundled as: `tesseract/tessdata/*.traineddata`.

## Tesseract PDF font

- Upstream: https://github.com/tesseract-ocr/tesseract
- License: Apache License 2.0 (`licenses/Apache-2.0.txt`)
- Bundled as: `tesseract/tessdata/pdf.ttf`.
- Exact source and SHA-256: `Tesseract-pdf-source.txt`.

## qpdf

- Upstream: https://github.com/qpdf/qpdf
- License: Apache License 2.0 (`licenses/Apache-2.0.txt`)
- Bundled as: `qpdf/<platform>-<arch>` binaries and support libraries.

## Poppler

- Upstream: https://poppler.freedesktop.org/
- License: GNU General Public License, version 2 or version 3
  (`licenses/GPL-2.0.txt`, `licenses/GPL-3.0.txt`)
- Bundled as: `poppler/<platform>-<arch>` binaries, support libraries, and
  the CMap/encoding data under `poppler/<platform>-<arch>/share`.

## DjVuLibre

- Upstream: https://djvu.sourceforge.net/
- License: GNU General Public License, version 2 or later
  (`licenses/GPL-2.0.txt`)
- Bundled as: `djvulibre/<platform>-<arch>` binaries and support libraries.

## Microsoft Visual C++ runtime (Windows)

- Upstream: https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist
- License: Microsoft Visual C++ Redistributable terms; redistributed
  unmodified as permitted for application-local deployment.
- Bundled as: `msvcp140*.dll`, `vcruntime140*.dll`, and `concrt140.dll` beside
  each Windows native tool that imports them.

## DejaVu Sans 2.37

- Upstream: https://github.com/dejavu-fonts/dejavu-fonts
- License: Bitstream Vera font license and DejaVu public-domain changes.
  The complete notice is in `licenses/DejaVu.txt`.
- Bundled as: the annotation editor font and font bytes in the native PDF writer.

## Source availability

Poppler and DjVuLibre are distributed under the GNU GPL. EVB Viewer bundles
unmodified upstream builds of these tools and invokes them as separate
processes. Their complete corresponding source code is available from the
upstream project pages listed above, and requests about the exact source of
the bundled builds can be filed at
https://github.com/evb0110/evb-viewer.
