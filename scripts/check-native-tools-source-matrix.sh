#!/bin/bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

platforms=("darwin" "win32" "linux")
arches=("x64" "arm64")

missing=0

check_file() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    echo "  MISSING $label: $path"
    missing=1
  else
    echo "  OK      $label: $path"
  fi
}

for platform in "${platforms[@]}"; do
  for arch in "${arches[@]}"; do
    tag="${platform}-${arch}"
    exe_suffix=""
    if [ "$platform" = "win32" ]; then
      exe_suffix=".exe"
    fi

    echo "== Checking $tag =="

    check_file "resources/tesseract/$tag/bin/tesseract$exe_suffix" "tesseract"
    check_file "resources/poppler/$tag/bin/pdftoppm$exe_suffix" "pdftoppm"
    check_file "resources/poppler/$tag/bin/pdftotext$exe_suffix" "pdftotext"
    check_file "resources/qpdf/$tag/bin/qpdf$exe_suffix" "qpdf"
    check_file "resources/djvulibre/$tag/bin/ddjvu$exe_suffix" "ddjvu"
    check_file "resources/djvulibre/$tag/bin/djvused$exe_suffix" "djvused"
  done
done

if [ ! -d "resources/tesseract/tessdata" ]; then
  echo "MISSING tessdata directory: resources/tesseract/tessdata"
  missing=1
elif ! find "resources/tesseract/tessdata" -maxdepth 1 -type f -name '*.traineddata' -print -quit | grep -q .; then
  echo "MISSING traineddata files in resources/tesseract/tessdata"
  missing=1
else
  echo "OK tessdata directory and traineddata files present"
fi

if [ "$missing" -ne 0 ]; then
  echo "Native tool source matrix check failed."
  exit 1
fi

echo "Native tool source matrix check passed."
